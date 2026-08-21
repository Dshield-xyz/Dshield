import { NextRequest, NextResponse } from "next/server";
import * as StellarSdk from "@stellar/stellar-sdk";
import { checkRateLimit, clientKey } from "@/lib/rateLimit";
import {
  createLogger,
  requestCorrelationId,
  withCorrelationId,
} from "@/lib/logger";

// Server-only faucet: mints test USDC to a recipient using the issuer secret.
// The secret lives ONLY in this server route (env var without a NEXT_PUBLIC_
// prefix), so it is never shipped to the browser bundle.
const ISSUER_SECRET = process.env.USDC_ISSUER_SECRET || "";
const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || "http://localhost:8000/soroban/rpc";
const PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ||
  "Standalone Network ; February 2017";
const USDC_CODE = process.env.NEXT_PUBLIC_USDC_CODE || "USDC";

// Cap a single faucet request (1,000,000 USDC in 7-decimal stroops) so the
// route can't be used to mint absurd amounts.
const MAX_AMOUNT = BigInt("10000000000000");

// The faucet mints real (if test) tokens on every call; without a limit an
// automated client could spam it indefinitely.
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export async function POST(req: NextRequest) {
  const correlationId = requestCorrelationId(req.headers);
  const log = createLogger("faucet", correlationId);

  if (!ISSUER_SECRET) {
    log.warn("issuer secret not configured");
    return withCorrelationId(
      NextResponse.json(
        { error: "Faucet is not configured (USDC_ISSUER_SECRET unset)." },
        { status: 503 },
      ),
      correlationId,
    );
  }

  const rl = checkRateLimit(`faucet:${clientKey(req.headers)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) {
    log.warn("rate limited", { retryAfterSeconds: rl.retryAfterSeconds });
    return withCorrelationId(
      NextResponse.json(
        { error: "Too many faucet requests. Try again later." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      ),
      correlationId,
    );
  }

  let address: string;
  let amount: bigint;
  try {
    const body = await req.json();
    address = String(body.address || "");
    amount = BigInt(body.amount ?? "0");
  } catch {
    log.warn("invalid request body");
    return withCorrelationId(
      NextResponse.json({ error: "Invalid request body." }, { status: 400 }),
      correlationId,
    );
  }

  if (!StellarSdk.StrKey.isValidEd25519PublicKey(address)) {
    log.warn("invalid recipient address", { address: address.slice(0, 8) });
    return withCorrelationId(
      NextResponse.json(
        { error: "Invalid recipient address." },
        { status: 400 },
      ),
      correlationId,
    );
  }
  if (amount <= BigInt(0)) {
    log.warn("non-positive amount", { amount: amount.toString() });
    return withCorrelationId(
      NextResponse.json({ error: "Amount must be positive." }, { status: 400 }),
      correlationId,
    );
  }
  if (amount > MAX_AMOUNT) {
    log.info("amount clamped to max", { original: amount.toString(), clamped: MAX_AMOUNT.toString() });
    amount = MAX_AMOUNT;
  }

  log.info("faucet request started", { address: address.slice(0, 8), amount: amount.toString() });

  try {
    const server = new StellarSdk.rpc.Server(RPC_URL, {
      allowHttp: RPC_URL.startsWith("http://"),
    });
    const issuer = StellarSdk.Keypair.fromSecret(ISSUER_SECRET);
    const sacId = new StellarSdk.Asset(USDC_CODE, issuer.publicKey()).contractId(
      PASSPHRASE,
    );

    const source = await server.getAccount(issuer.publicKey());
    const contract = new StellarSdk.Contract(sacId);
    const tx = new StellarSdk.TransactionBuilder(source, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(
        contract.call(
          "mint",
          StellarSdk.nativeToScVal(address, { type: "address" }),
          StellarSdk.nativeToScVal(amount, { type: "i128" }),
        ),
      )
      .setTimeout(60)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationError(sim)) {
      log.warn("simulation failed", { error: sim.error });
      return withCorrelationId(
        NextResponse.json(
          { error: `Faucet simulation failed: ${sim.error}` },
          { status: 400 },
        ),
        correlationId,
      );
    }

    const assembled = StellarSdk.rpc.assembleTransaction(tx, sim).build();
    assembled.sign(issuer);

    const sent = await server.sendTransaction(assembled);
    if (sent.status === "ERROR") {
      log.error("transaction submission failed", { hash: sent.hash });
      return withCorrelationId(
        NextResponse.json(
          { error: "Faucet transaction submission failed." },
          { status: 500 },
        ),
        correlationId,
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
      log.error("transaction did not succeed", { status: result.status, tries });
      return withCorrelationId(
        NextResponse.json(
          { error: `Faucet transaction did not succeed (${result.status}).` },
          { status: 500 },
        ),
        correlationId,
      );
    }

    log.info("faucet request succeeded", { hash: sent.hash, amount: amount.toString() });
    return withCorrelationId(
      NextResponse.json({ hash: sent.hash, amount: amount.toString() }),
      correlationId,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("faucet failed", { message });
    return withCorrelationId(
      NextResponse.json(
        { error: `Faucet failed: ${message}` },
        { status: 500 },
      ),
      correlationId,
    );
  }
}
