import { NextRequest, NextResponse } from "next/server";
import * as StellarSdk from "@stellar/stellar-sdk";
import { checkRateLimit, clientKey } from "@/lib/rateLimit";

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
  // Play money only. A faucet on mainnet would either mint a real asset or
  // hand out real funds, so the route is closed there regardless of how the
  // issuer secret is configured — a misconfigured deploy fails safe.
  if (PASSPHRASE === StellarSdk.Networks.PUBLIC) {
    return NextResponse.json(
      { error: "The faucet is disabled on mainnet." },
      { status: 403 },
    );
  }

  if (!ISSUER_SECRET) {
    return NextResponse.json(
      { error: "Faucet is not configured (USDC_ISSUER_SECRET unset)." },
      { status: 503 },
    );
  }

  const rl = await checkRateLimit(`faucet:${clientKey(req.headers)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many faucet requests. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let address: string;
  let amount: bigint;
  // Which asset to mint. The pool can shield several, but this faucet only
  // holds one issuer key, so a request for anything else is refused rather
  // than silently topping the wallet up in the wrong token.
  let requestedAsset: string;
  try {
    const body = await req.json();
    address = String(body.address || "");
    amount = BigInt(body.amount ?? "0");
    requestedAsset = String(body.asset || "");
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!StellarSdk.StrKey.isValidEd25519PublicKey(address)) {
    return NextResponse.json(
      { error: "Invalid recipient address." },
      { status: 400 },
    );
  }
  if (amount <= BigInt(0)) {
    return NextResponse.json({ error: "Amount must be positive." }, { status: 400 });
  }
  if (amount > MAX_AMOUNT) {
    amount = MAX_AMOUNT;
  }

  try {
    const server = new StellarSdk.rpc.Server(RPC_URL, {
      allowHttp: RPC_URL.startsWith("http://"),
    });
    const issuer = StellarSdk.Keypair.fromSecret(ISSUER_SECRET);
    const sacId = new StellarSdk.Asset(USDC_CODE, issuer.publicKey()).contractId(
      PASSPHRASE,
    );

    if (requestedAsset && requestedAsset !== sacId) {
      return NextResponse.json(
        { error: "No faucet is available for that asset." },
        { status: 503 },
      );
    }

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
      // Most commonly the recipient has no USDC trustline yet.
      return NextResponse.json(
        { error: `Faucet simulation failed: ${sim.error}` },
        { status: 400 },
      );
    }

    const assembled = StellarSdk.rpc.assembleTransaction(tx, sim).build();
    assembled.sign(issuer);

    const sent = await server.sendTransaction(assembled);
    if (sent.status === "ERROR") {
      return NextResponse.json(
        { error: "Faucet transaction submission failed." },
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
        { error: `Faucet transaction did not succeed (${result.status}).` },
        { status: 500 },
      );
    }

    return NextResponse.json({ hash: sent.hash, amount: amount.toString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Faucet failed:", message);
    return NextResponse.json(
      { error: `Faucet failed: ${message}` },
      { status: 500 },
    );
  }
}
