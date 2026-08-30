import * as StellarSdk from "@stellar/stellar-sdk";
import type { DshieldConfig } from "./config";
import type { Wallet } from "./wallet";

// A dummy read-only source account for simulate-only view calls. Its sequence
// number is never consumed because the transaction is never submitted.
const VIEW_ACCOUNT = "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH";

// Must not exceed the pool contract's MAX_PAGE_SIZE (contracts/pool/src/lib.rs).
const COMMITMENTS_PAGE_SIZE = 100;

export function getServer(config: DshieldConfig): StellarSdk.rpc.Server {
  return new StellarSdk.rpc.Server(config.rpcUrl, { allowHttp: true });
}

/** Simulate a contract method and return its raw ScVal result, or null on failure. */
export async function queryContract(
  config: DshieldConfig,
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[] = [],
): Promise<StellarSdk.xdr.ScVal | null> {
  const server = getServer(config);
  const contract = new StellarSdk.Contract(contractId);
  const account = new StellarSdk.Account(VIEW_ACCOUNT, "0");

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simulated = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(simulated)) return null;
  if (!StellarSdk.rpc.Api.isSimulationSuccess(simulated)) return null;
  return simulated.result?.retval ?? null;
}

/** Build + simulate + assemble a contract-call transaction, ready to sign. */
export async function buildContractCall(
  config: DshieldConfig,
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
  sourcePublicKey: string,
): Promise<StellarSdk.Transaction> {
  const server = getServer(config);
  const account = await server.getAccount(sourcePublicKey);
  const contract = new StellarSdk.Contract(contractId);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simulated = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
    throw new Error(`Simulation failed: ${simulated.error}`);
  }
  return StellarSdk.rpc.assembleTransaction(tx, simulated).build();
}

/** Submit a signed transaction and wait for it to leave the pending state. */
export async function submitTransaction(
  config: DshieldConfig,
  signedXdr: string,
): Promise<string> {
  const server = getServer(config);
  const tx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, config.networkPassphrase);
  const response = await server.sendTransaction(tx);

  if (response.status === "ERROR") {
    throw new Error(`Transaction submission failed: ${response.status}`);
  }

  let result = await server.getTransaction(response.hash);
  while (result.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1000));
    result = await server.getTransaction(response.hash);
  }
  if (result.status === "FAILED") {
    throw new Error("Transaction failed on-chain.");
  }
  return response.hash;
}

/** Convenience: build with the wallet's account, sign via the wallet, submit. */
export async function invoke(
  config: DshieldConfig,
  wallet: Wallet,
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
): Promise<string> {
  const tx = await buildContractCall(config, contractId, method, args, wallet.publicKey);
  const signed = await wallet.sign(tx.toXDR());
  return submitTransaction(config, signed);
}

// ── Pool views ───────────────────────────────────────────────────────────

/** The pool's current Merkle root as a 0x-prefixed 32-byte hex string, or null. */
export async function getRoot(
  config: DshieldConfig,
  poolId: string,
): Promise<string | null> {
  const val = await queryContract(config, poolId, "get_root");
  if (!val) return null;
  const bytes = StellarSdk.scValToNative(val) as Buffer;
  return "0x" + Buffer.from(bytes).toString("hex").padStart(64, "0");
}

/**
 * Full ordered commitment list from the pool's storage (the authoritative
 * source for rebuilding the Merkle tree). Pages until a short page ends it.
 * Returns null — never a partial list — if any page fails.
 */
export async function fetchCommitments(
  config: DshieldConfig,
  poolId: string,
): Promise<string[] | null> {
  const commitments: string[] = [];
  let start = 0;
  for (;;) {
    const result = await queryContract(config, poolId, "get_commitments_page", [
      StellarSdk.nativeToScVal(start, { type: "u32" }),
      StellarSdk.nativeToScVal(COMMITMENTS_PAGE_SIZE, { type: "u32" }),
    ]);
    if (!result) return null;
    const native = StellarSdk.scValToNative(result) as unknown;
    if (!Array.isArray(native)) return null;
    for (const buf of native) {
      const bytes = Buffer.from(buf as Uint8Array);
      commitments.push("0x" + bytes.toString("hex").padStart(64, "0"));
    }
    if (native.length < COMMITMENTS_PAGE_SIZE) break;
    start += native.length;
  }
  return commitments;
}

export async function isNullifierUsed(
  config: DshieldConfig,
  poolId: string,
  nullifierHashHex: string,
): Promise<boolean> {
  const val = await queryContract(config, poolId, "is_nullifier_used", [
    StellarSdk.xdr.ScVal.scvBytes(
      Buffer.from(nullifierHashHex.replace(/^0x/, ""), "hex"),
    ),
  ]);
  return !!val && StellarSdk.scValToNative(val) === true;
}

export async function getCommitmentIndex(
  config: DshieldConfig,
  poolId: string,
  commitmentHex: string,
): Promise<number | null> {
  const val = await queryContract(config, poolId, "get_commitment_index", [
    StellarSdk.xdr.ScVal.scvBytes(
      Buffer.from(commitmentHex.replace(/^0x/, ""), "hex"),
    ),
  ]);
  if (!val) return null;
  const index = StellarSdk.scValToNative(val) as number | null | undefined;
  return typeof index === "number" ? index : null;
}

// ── USDC (test asset) helpers ──────────────────────────────────────────────

export function getUsdcAsset(config: DshieldConfig): StellarSdk.Asset | null {
  if (!config.usdcIssuer) return null;
  return new StellarSdk.Asset(config.usdcCode, config.usdcIssuer);
}

export function getUsdcSacId(config: DshieldConfig): string | null {
  const asset = getUsdcAsset(config);
  return asset ? asset.contractId(config.networkPassphrase) : null;
}

export async function usdcBalance(
  config: DshieldConfig,
  address: string,
): Promise<bigint> {
  const sac = getUsdcSacId(config);
  if (!sac) return BigInt(0);
  const val = await queryContract(config, sac, "balance", [
    StellarSdk.nativeToScVal(address, { type: "address" }),
  ]);
  if (!val) return BigInt(0);
  return BigInt(StellarSdk.scValToNative(val) as string | number);
}

/** True if `address` already trusts the test USDC asset (probed via the SAC). */
export async function hasUsdcTrustline(
  config: DshieldConfig,
  address: string,
): Promise<boolean> {
  const sac = getUsdcSacId(config);
  if (!sac) return true;
  const result = await queryContract(config, sac, "balance", [
    StellarSdk.nativeToScVal(address, { type: "address" }),
  ]);
  return result !== null;
}

/** Establish a USDC trustline for the wallet if missing. No-op without a USDC asset. */
export async function ensureUsdcTrustline(
  config: DshieldConfig,
  wallet: Wallet,
): Promise<void> {
  const asset = getUsdcAsset(config);
  if (!asset) return;
  if (await hasUsdcTrustline(config, wallet.publicKey)) return;

  const server = getServer(config);
  const account = await server.getAccount(wallet.publicKey);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(StellarSdk.Operation.changeTrust({ asset }))
    .setTimeout(60)
    .build();

  const signed = await wallet.sign(tx.toXDR());
  await submitTransaction(config, signed);
}

/**
 * Mint `amount` stroops of test USDC to `to`, signed by the configured issuer
 * key. Only usable on test networks where the CLI holds the issuer secret; the
 * browser app routes this through a server-side faucet instead.
 */
export async function mintUsdc(
  config: DshieldConfig,
  issuer: StellarSdk.Keypair,
  to: string,
  amount: bigint,
): Promise<string> {
  const sac = getUsdcSacId(config);
  if (!sac) throw new Error("No USDC asset configured — cannot mint.");
  const tx = await buildContractCall(
    config,
    sac,
    "mint",
    [
      StellarSdk.nativeToScVal(to, { type: "address" }),
      StellarSdk.nativeToScVal(amount, { type: "i128" }),
    ],
    issuer.publicKey(),
  );
  const signed = StellarSdk.TransactionBuilder.fromXDR(
    tx.toXDR(),
    config.networkPassphrase,
  );
  signed.sign(issuer);
  return submitTransaction(config, signed.toXDR());
}
