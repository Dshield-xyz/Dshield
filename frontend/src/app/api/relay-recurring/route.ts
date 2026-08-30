import { NextRequest, NextResponse } from "next/server";
import * as StellarSdk from "@stellar/stellar-sdk";
import { checkRateLimit, clientKey } from "@/lib/rateLimit";

// Server-side relayer for pre-authorized recurring withdrawals.
//
// Unlike relay-withdraw (which takes a fresh ZK proof each time), this route
// requires no proof: the authorization was proved once during `authorize_recurring`.
// The relayer just calls `withdraw_recurring(auth_commitment, payout)` with the
// committed parameters.
//
// The pool contract enforces all bounds:
//   - payout ≤ auth.max_amount
//   - period_secs elapsed since last withdrawal
//   - uses_remaining > 0
//   - not revoked
//
// Because the payout recipient is fixed on-chain, the relayer cannot redirect
// funds — it can only trigger or refuse. This makes it safe to expose without
// user-per-call authorization.
//
// Scheduling: this route is intended to be called by a cron job (Vercel Cron,
// GitHub Actions, or any scheduler) rather than directly by users. The cron
// job should call POST /api/relay-recurring for every active auth it knows
// about; the contract will reject calls that arrive too early (PeriodNotElapsed)
// harmlessly, so an over-eager scheduler is safe.

const RELAYER_SECRET = process.env.RELAYER_SECRET || "";
const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || "http://localhost:8000/soroban/rpc";
const PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ||
  "Standalone Network ; February 2017";

function isStrKeyContract(id: string): boolean {
  try {
    return StellarSdk.StrKey.isValidContract(id);
  } catch {
    return false;
  }
}

// Recurring trigger calls are cheaper than proof submissions but still cost
// a simulate/submit round-trip; cap them per client to prevent abuse.
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// Error codes the contract returns for expected non-error conditions.
// We map these to 200 responses so the scheduler doesn't treat them as failures.
const BENIGN_CONTRACT_ERRORS = [
  "PeriodNotElapsed", // too early — not a failure, just a no-op
  "AuthExhausted",    // all occurrences consumed — authorization is done
  "AuthRevoked",      // owner revoked — stop scheduling this auth
];

export async function POST(req: NextRequest) {
  if (!RELAYER_SECRET) {
    return NextResponse.json(
      { error: "Relayer is not configured (RELAYER_SECRET unset).", code: "no_relayer" },
      { status: 503 },
    );
  }

  const rl = await checkRateLimit(
    `relay-recurring:${clientKey(req.headers)}`,
    RATE_LIMIT,
    RATE_WINDOW_MS,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many relay requests. Try again later.", code: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let poolId: string;
  let authCommitment: string;
  let payout: string;
  try {
    const body = await req.json();
    poolId = String(body.poolId || "");
    authCommitment = String(body.authCommitment || "");
    payout = String(body.payout || "0");
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!isStrKeyContract(poolId)) {
    return NextResponse.json({ error: "Invalid pool id." }, { status: 400 });
  }
  if (!/^[0-9a-fA-F]{64}$/.test(authCommitment)) {
    return NextResponse.json(
      { error: "authCommitment must be a 64-char hex string (32 bytes)." },
      { status: 400 },
    );
  }

  let payoutI128: bigint;
  try {
    payoutI128 = BigInt(payout);
    if (payoutI128 <= BigInt(0)) throw new Error("payout must be positive");
  } catch {
    return NextResponse.json(
      { error: "payout must be a positive integer (base units)." },
      { status: 400 },
    );
  }

  try {
    const server = new StellarSdk.rpc.Server(RPC_URL, {
      allowHttp: RPC_URL.startsWith("http://"),
    });
    const relayer = StellarSdk.Keypair.fromSecret(RELAYER_SECRET);
    const source = await server.getAccount(relayer.publicKey());
    const contract = new StellarSdk.Contract(poolId);

    const tx = new StellarSdk.TransactionBuilder(source, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(
        contract.call(
          "withdraw_recurring",
          StellarSdk.xdr.ScVal.scvBytes(Buffer.from(authCommitment, "hex")),
          StellarSdk.nativeToScVal(payoutI128, { type: "i128" }),
        ),
      )
      .setTimeout(60)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationError(sim)) {
      // Map known benign errors to a 200 with a status field so the
      // scheduler doesn't keep retrying unnecessarily.
      for (const benign of BENIGN_CONTRACT_ERRORS) {
        if (sim.error.includes(benign)) {
          return NextResponse.json({
            status: "skipped",
            reason: benign,
            relayer: relayer.publicKey(),
          });
        }
      }
      return NextResponse.json(
        { error: `Simulation failed: ${sim.error}` },
        { status: 400 },
      );
    }

    const assembled = StellarSdk.rpc.assembleTransaction(tx, sim).build();
    assembled.sign(relayer);

    const sent = await server.sendTransaction(assembled);
    if (sent.status === "ERROR") {
      return NextResponse.json(
        { error: "Recurring withdrawal submission failed." },
        { status: 500 },
      );
    }

    let result = await server.getTransaction(sent.hash);
    let tries = 0;
    while (result.status === "NOT_FOUND" && tries < 30) {
      await new Promise((r) => setTimeout(r, 1000));
      result = await server.getTransaction(sent.hash);
      tries++;
    }
    if (result.status !== "SUCCESS") {
      return NextResponse.json(
        {
          error: `Recurring withdrawal did not succeed (${result.status}).`,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      status: "executed",
      hash: sent.hash,
      relayer: relayer.publicKey(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Relay recurring failed:", message);
    return NextResponse.json(
      { error: `Recurring withdrawal failed: ${message}` },
      { status: 500 },
    );
  }
}
