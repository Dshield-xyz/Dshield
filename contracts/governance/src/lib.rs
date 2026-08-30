#![no_std]

//! A minimal timelock for privileged operations elsewhere in DShield (pool
//! verifier/admin changes, compliance disclosure-VK rotation). The admin
//! queues a call (target contract, function, args) with a configurable
//! delay; anyone can execute it once the delay has elapsed, and the admin
//! can cancel it any time before that. Gated contracts trust this
//! contract's address as the sole caller of their privileged entry points,
//! so a change can only take effect after the queue/delay/execute path.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short, Address,
    Bytes, Env, InvokeError, Symbol, Val, Vec as SorobanVec,
    xdr::FromXdr,
};

#[contract]
pub struct GovernanceContract;

#[contracterror]
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum GovernanceError {
    AlreadyInitialized = 1,
    NotAuthorized = 2,
    NotFound = 3,
    TooEarly = 4,
    AlreadyExecuted = 5,
    AlreadyCancelled = 6,
    ExecutionFailed = 7,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CallStatus {
    Pending,
    Executed,
    Cancelled,
}

// `args` is stored as XDR bytes rather than `Vec<Val>` directly: `Val` is a
// raw host handle valid only within the current invocation's context, so it
// cannot be embedded in a contracttype that outlives that context. Storing
// the XDR encoding round-trips exactly and lets `execute` reconstruct the
// original arguments in a later transaction.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueuedCall {
    pub target: Address,
    pub function: Symbol,
    pub args: Bytes,
    pub eta: u64,
    pub status: CallStatus,
}

#[contractevent(topics = ["call_queued"])]
pub struct CallQueuedEvent<'a> {
    pub id: u32,
    pub target: &'a Address,
    pub function: &'a Symbol,
    pub eta: &'a u64,
}

#[contractevent(topics = ["call_executed"])]
pub struct CallExecutedEvent {
    pub id: u32,
}

#[contractevent(topics = ["call_cancelled"])]
pub struct CallCancelledEvent {
    pub id: u32,
}

fn key_admin() -> Symbol {
    symbol_short!("admin")
}
fn key_delay() -> Symbol {
    symbol_short!("delay")
}
fn key_next_id() -> Symbol {
    symbol_short!("nextid")
}
fn key_call_prefix() -> Symbol {
    symbol_short!("call")
}

// Bounded config plus per-call entries; extend TTL on every state-mutating
// call so nothing silently expires between a queue and its execution.
const BUMP_THRESHOLD: u32 = 17_280; // ~1 day of ledgers
const BUMP_AMOUNT: u32 = 518_400; // ~30 days of ledgers

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
}

#[contractimpl]
impl GovernanceContract {
    /// `delay_seconds` is the minimum wait between queuing a call and being
    /// able to execute it. Fixed at construction: changing it later would
    /// let the admin shorten the window on calls already in flight, which
    /// defeats the point of a visibility window.
    pub fn __constructor(env: Env, admin: Address, delay_seconds: u64) -> Result<(), GovernanceError> {
        if env.storage().instance().has(&key_admin()) {
            return Err(GovernanceError::AlreadyInitialized);
        }
        env.storage().instance().set(&key_admin(), &admin);
        env.storage().instance().set(&key_delay(), &delay_seconds);
        env.storage().instance().set(&key_next_id(), &0u32);
        Ok(())
    }

    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&key_admin())
    }

    pub fn get_delay(env: Env) -> u64 {
        env.storage().instance().get(&key_delay()).unwrap_or(0)
    }

    fn load_admin(env: &Env) -> Result<Address, GovernanceError> {
        env.storage()
            .instance()
            .get(&key_admin())
            .ok_or(GovernanceError::NotAuthorized)
    }

    fn call_key(id: u32) -> (Symbol, u32) {
        (key_call_prefix(), id)
    }

    /// Queues `target.function(args)` to become executable after the
    /// configured delay. `args` is the XDR encoding of a `Vec<Val>` (the
    /// Soroban contract macro rejects a bare `Vec<Val>` as a function
    /// parameter, since `Val` is only meaningful within the invocation that
    /// produced it — callers build this with `args.to_xdr(&env)`). Returns
    /// the id used to execute or cancel it.
    pub fn queue(
        env: Env,
        target: Address,
        function: Symbol,
        args: Bytes,
    ) -> Result<u32, GovernanceError> {
        let admin = Self::load_admin(&env)?;
        admin.require_auth();
        bump_instance(&env);

        let id: u32 = env
            .storage()
            .instance()
            .get(&key_next_id())
            .unwrap_or(0u32);
        let delay: u64 = env.storage().instance().get(&key_delay()).unwrap_or(0);
        let eta = env.ledger().timestamp().saturating_add(delay);

        let call = QueuedCall {
            target: target.clone(),
            function: function.clone(),
            args,
            eta,
            status: CallStatus::Pending,
        };
        env.storage().instance().set(&Self::call_key(id), &call);
        env.storage().instance().set(&key_next_id(), &(id + 1));

        CallQueuedEvent {
            id,
            target: &target,
            function: &function,
            eta: &eta,
        }
        .publish(&env);

        Ok(id)
    }

    /// Executes a queued call once its delay has elapsed. Callable by
    /// anyone (not just the admin) once the timelock has run, since the
    /// point of the window is that the change happens on schedule and
    /// isn't gated behind the admin remembering to press a second button.
    pub fn execute(env: Env, id: u32) -> Result<(), GovernanceError> {
        bump_instance(&env);
        let key = Self::call_key(id);
        let mut call: QueuedCall = env
            .storage()
            .instance()
            .get(&key)
            .ok_or(GovernanceError::NotFound)?;

        match call.status {
            CallStatus::Executed => return Err(GovernanceError::AlreadyExecuted),
            CallStatus::Cancelled => return Err(GovernanceError::AlreadyCancelled),
            CallStatus::Pending => {}
        }

        if env.ledger().timestamp() < call.eta {
            return Err(GovernanceError::TooEarly);
        }

        let args = SorobanVec::<Val>::from_xdr(&env, &call.args)
            .map_err(|_| GovernanceError::ExecutionFailed)?;
        env.try_invoke_contract::<(), InvokeError>(&call.target, &call.function, args)
            .map_err(|_| GovernanceError::ExecutionFailed)?
            .map_err(|_| GovernanceError::ExecutionFailed)?;

        call.status = CallStatus::Executed;
        env.storage().instance().set(&key, &call);

        CallExecutedEvent { id }.publish(&env);

        Ok(())
    }

    /// Cancels a pending call before it executes. Admin-only: this is the
    /// safety valve if a queued change turns out to be wrong or malicious
    /// before it takes effect.
    pub fn cancel(env: Env, id: u32) -> Result<(), GovernanceError> {
        let admin = Self::load_admin(&env)?;
        admin.require_auth();
        bump_instance(&env);

        let key = Self::call_key(id);
        let mut call: QueuedCall = env
            .storage()
            .instance()
            .get(&key)
            .ok_or(GovernanceError::NotFound)?;

        match call.status {
            CallStatus::Executed => return Err(GovernanceError::AlreadyExecuted),
            CallStatus::Cancelled => return Err(GovernanceError::AlreadyCancelled),
            CallStatus::Pending => {}
        }

        call.status = CallStatus::Cancelled;
        env.storage().instance().set(&key, &call);

        CallCancelledEvent { id }.publish(&env);

        Ok(())
    }

    pub fn get_call(env: Env, id: u32) -> Option<QueuedCall> {
        env.storage().instance().get(&Self::call_key(id))
    }
}

/// Test-only stand-in for a governed contract like pool/compliance: a
/// single value settable only by whatever address the deployer names as its
/// "owner" (in real usage, the deployed governance contract's own address).
/// Exercising `execute()` against this — rather than a bare stub — proves
/// the cross-contract call, including its auth check, actually runs the way
/// pool/compliance's gated setters will.
#[cfg(test)]
mod setter_contract {
    use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol};

    #[contract]
    pub struct SetterContract;

    fn key_owner() -> Symbol {
        symbol_short!("owner")
    }
    fn key_value() -> Symbol {
        symbol_short!("value")
    }

    #[contractimpl]
    impl SetterContract {
        pub fn __constructor(env: Env, owner: Address) {
            env.storage().instance().set(&key_owner(), &owner);
        }

        pub fn set_value(env: Env, value: u32) {
            let owner: Address = env.storage().instance().get(&key_owner()).unwrap();
            owner.require_auth();
            env.storage().instance().set(&key_value(), &value);
        }

        pub fn get_value(env: Env) -> Option<u32> {
            env.storage().instance().get(&key_value())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use setter_contract::{SetterContract, SetterContractClient};
    use soroban_sdk::{
        testutils::{Address as TestAddress, Ledger},
        xdr::ToXdr,
        Address, Env, IntoVal,
    };

    fn no_args(env: &Env) -> Bytes {
        SorobanVec::<Val>::new(env).to_xdr(env)
    }

    fn set_value_args(env: &Env, value: u32) -> Bytes {
        let mut args: SorobanVec<Val> = SorobanVec::new(env);
        args.push_back(value.into_val(env));
        args.to_xdr(env)
    }

    fn setup(env: &Env, delay_seconds: u64) -> (Address, Address) {
        env.mock_all_auths();
        let admin = <Address as TestAddress>::generate(env);
        let gov_id = env.register(GovernanceContract, (admin.clone(), delay_seconds));
        (gov_id, admin)
    }

    #[test]
    fn test_constructor_stores_admin_and_delay() {
        let env = Env::default();
        let (gov_id, admin) = setup(&env, 3600);
        let client = GovernanceContractClient::new(&env, &gov_id);
        assert_eq!(client.get_admin(), Some(admin));
        assert_eq!(client.get_delay(), 3600);
    }

    #[test]
    fn test_queue_returns_sequential_ids() {
        let env = Env::default();
        let (gov_id, _admin) = setup(&env, 100);
        let client = GovernanceContractClient::new(&env, &gov_id);
        let target = <Address as TestAddress>::generate(&env);

        let id0 = client.queue(&target, &Symbol::new(&env, "noop"), &no_args(&env));
        let id1 = client.queue(&target, &Symbol::new(&env, "noop"), &no_args(&env));
        assert_eq!(id0, 0);
        assert_eq!(id1, 1);
    }

    #[test]
    fn test_queue_requires_admin_auth() {
        let env = Env::default();
        let admin = <Address as TestAddress>::generate(&env);
        let gov_id: Address = env.register(GovernanceContract, (admin.clone(), 100u64));
        let client = GovernanceContractClient::new(&env, &gov_id);
        let target = <Address as TestAddress>::generate(&env);

        // No mock_all_auths(): the admin's require_auth must fail without a
        // real or mocked signature.
        let result = client.try_queue(&target, &Symbol::new(&env, "noop"), &no_args(&env));
        assert!(result.is_err());
    }

    #[test]
    fn test_execute_before_delay_fails() {
        let env = Env::default();
        let (gov_id, _admin) = setup(&env, 1_000);
        let client = GovernanceContractClient::new(&env, &gov_id);
        let target = <Address as TestAddress>::generate(&env);

        let id = client.queue(&target, &Symbol::new(&env, "noop"), &no_args(&env));
        let result = client.try_execute(&id);
        assert_eq!(
            result.err().unwrap().unwrap(),
            GovernanceError::TooEarly
        );
    }

    #[test]
    fn test_execute_after_delay_succeeds_against_real_target() {
        // Exercise execute() against a real contract call, not a stub, so
        // the cross-contract invocation path (including the target's own
        // auth check against the governance contract's address) is
        // actually verified.
        let env = Env::default();
        let (gov_id, _admin) = setup(&env, 100);
        let client = GovernanceContractClient::new(&env, &gov_id);

        let setter_id = env.register(SetterContract, (gov_id.clone(),));
        let setter = SetterContractClient::new(&env, &setter_id);

        let args = set_value_args(&env, 42);
        let id = client.queue(&setter_id, &Symbol::new(&env, "set_value"), &args);

        env.ledger().with_mut(|l| l.timestamp += 200);

        client.execute(&id);

        let call = client.get_call(&id).unwrap();
        assert_eq!(call.status, CallStatus::Executed);
        assert_eq!(setter.get_value(), Some(42));
    }

    #[test]
    fn test_execute_twice_fails() {
        let env = Env::default();
        let (gov_id, _admin) = setup(&env, 100);
        let client = GovernanceContractClient::new(&env, &gov_id);

        let setter_id = env.register(SetterContract, (gov_id.clone(),));
        let args = set_value_args(&env, 42);

        let id = client.queue(&setter_id, &Symbol::new(&env, "set_value"), &args);
        env.ledger().with_mut(|l| l.timestamp += 200);
        client.execute(&id);

        let result = client.try_execute(&id);
        assert_eq!(
            result.err().unwrap().unwrap(),
            GovernanceError::AlreadyExecuted
        );
    }

    #[test]
    fn test_cancel_before_execution_prevents_execute() {
        let env = Env::default();
        let (gov_id, _admin) = setup(&env, 100);
        let client = GovernanceContractClient::new(&env, &gov_id);
        let target = <Address as TestAddress>::generate(&env);

        let id = client.queue(&target, &Symbol::new(&env, "noop"), &no_args(&env));
        client.cancel(&id);

        let call = client.get_call(&id).unwrap();
        assert_eq!(call.status, CallStatus::Cancelled);

        env.ledger().with_mut(|l| l.timestamp += 200);
        let result = client.try_execute(&id);
        assert_eq!(
            result.err().unwrap().unwrap(),
            GovernanceError::AlreadyCancelled
        );
    }

    #[test]
    fn test_cancel_requires_admin_auth() {
        let env = Env::default();
        let admin = <Address as TestAddress>::generate(&env);
        let gov_id: Address = env.register(GovernanceContract, (admin.clone(), 100u64));
        let client = GovernanceContractClient::new(&env, &gov_id);
        let target = <Address as TestAddress>::generate(&env);

        env.mock_all_auths();
        let id = client.queue(&target, &Symbol::new(&env, "noop"), &no_args(&env));

        env.set_auths(&[]);
        let result = client.try_cancel(&id);
        assert!(result.is_err());
    }

    #[test]
    fn test_cancel_unknown_id_fails() {
        let env = Env::default();
        let (gov_id, _admin) = setup(&env, 100);
        let client = GovernanceContractClient::new(&env, &gov_id);
        let result = client.try_cancel(&999);
        assert_eq!(result.err().unwrap().unwrap(), GovernanceError::NotFound);
    }

    #[test]
    fn test_execute_unknown_id_fails() {
        let env = Env::default();
        let (gov_id, _admin) = setup(&env, 100);
        let client = GovernanceContractClient::new(&env, &gov_id);
        let result = client.try_execute(&999);
        assert_eq!(result.err().unwrap().unwrap(), GovernanceError::NotFound);
    }

    #[test]
    fn test_cancel_after_execution_fails() {
        let env = Env::default();
        let (gov_id, _admin) = setup(&env, 100);
        let client = GovernanceContractClient::new(&env, &gov_id);

        let setter_id = env.register(SetterContract, (gov_id.clone(),));
        let args = set_value_args(&env, 42);

        let id = client.queue(&setter_id, &Symbol::new(&env, "set_value"), &args);
        env.ledger().with_mut(|l| l.timestamp += 200);
        client.execute(&id);

        let result = client.try_cancel(&id);
        assert_eq!(
            result.err().unwrap().unwrap(),
            GovernanceError::AlreadyExecuted
        );
    }

    #[test]
    fn test_execute_exactly_at_eta_succeeds() {
        let env = Env::default();
        let (gov_id, _admin) = setup(&env, 500);
        let client = GovernanceContractClient::new(&env, &gov_id);

        let setter_id = env.register(SetterContract, (gov_id.clone(),));
        let args = set_value_args(&env, 7);

        let id = client.queue(&setter_id, &Symbol::new(&env, "set_value"), &args);
        let call = client.get_call(&id).unwrap();

        env.ledger().with_mut(|l| l.timestamp = call.eta);
        client.execute(&id);

        let call = client.get_call(&id).unwrap();
        assert_eq!(call.status, CallStatus::Executed);
    }

    #[test]
    fn test_execute_rejects_wrong_caller_on_target() {
        // A call queued against a setter owned by someone other than this
        // governance contract must fail: the target's own require_auth is
        // what actually enforces "only the timelock may call this," so
        // execute() against a mis-owned target must not silently succeed.
        let env = Env::default();
        let (gov_id, _admin) = setup(&env, 100);
        let client = GovernanceContractClient::new(&env, &gov_id);

        let other_owner = <Address as TestAddress>::generate(&env);
        let setter_id = env.register(SetterContract, (other_owner,));
        let args = set_value_args(&env, 42);

        let id = client.queue(&setter_id, &Symbol::new(&env, "set_value"), &args);
        env.ledger().with_mut(|l| l.timestamp += 200);

        let result = client.try_execute(&id);
        assert_eq!(
            result.err().unwrap().unwrap(),
            GovernanceError::ExecutionFailed
        );
    }
}
