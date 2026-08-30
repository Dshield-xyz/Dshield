import { NextRequest, NextResponse } from "next/server";
import * as StellarSdk from "@stellar/stellar-sdk";
import { checkRateLimit, clientKey } from "@/lib/rateLimit";
import { quoteFeeSwap, DEX_ROUTER_ID, XLM_SAC_ID } from "@/lib/stellar";

// Server-side relayer: submits a withdrawal on the user's behalf, paying the
// transaction fee from the relayer account. Because the pool contract binds the
// payout recipient into the proof (see recipient_hash_from_address), the relayer
// cannot redirect funds — it can only submit or refuse. This unlinks the
// withdrawer: the user's own account never appears on-chain.
//
// Fee abstraction (issue #149): the relayer recovers its Soroban resource-fee
// cost by carving `feeAmount` of the withdrawn asset out of the payout and
// swapping it for XLM on-chain (contracts/pool/src/lib.rs swap_fee_for_asset),
// rather than absorbing the cost or requiring the withdrawing caller to hold
// XLM separately. This route re-derives its own quote and clamps the client's
// requested fee to it before submitting, so a compromised or buggy frontend
// can't smuggle an inflated fee past the user's confirmation — the pool
// contract's own max_fee_bps cap is the final backstop either way.
const RELAYER_SECRET = process.env.RELAYER_SECRET || "";
const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || "http://localhost:8000/soroban/rpc";
const PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ||
  "Standalone Network ; February 2017";
// Flat relayer fee, in the withdrawn asset's stroops, charged when fee
// abstraction is configured (DEX_ROUTER_ID + XLM_SAC_ID set). A flat amount
// keeps this route simple; it's still bounded on-chain by the pool's own
// max_fee_bps cap regardless of what this route requests.
const RELAYER_FEE_STROOPS = process.env.RELAYER_FEE_STROOPS || "0";

function isStrKeyContract(id: string): boolean {
  try {
    return StellarSdk.StrKey.isValidContract(id);
  } catch {
    return false;
  }
}

// Garbage proofs are cheap to submit but still cost a simulate/submit RPC
// round-trip against the relayer's own quota; cap how many a single client
// can fire without limiting legitimate rapid multi-note withdrawals too hard.
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export async function POST(req: NextRequest) {
  if (!RELAYER_SECRET) {
    return NextResponse.json(
      { error: "Relayer is not configured (RELAYER_SECRET unset).", code: "no_relayer" },
      { status: 503 },
    );
  }

  const rl = await checkRateLimit(`relay:${clientKey(req.headers)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many relay requests. Try again later.", code: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let poolId: string;
  let recipient: string;
  let publicInputs: string;
  let proof: string;
  let asset: string;
  try {
    const body = await req.json();
    poolId = String(body.poolId || "");
    recipient = String(body.recipient || "");
    publicInputs = String(body.publicInputs || "");
    proof = String(body.proof || "");
    asset = String(body.asset || "");
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!isStrKeyContract(poolId)) {
    return NextResponse.json({ error: "Invalid pool id." }, { status: 400 });
  }
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(recipient)) {
    return NextResponse.json({ error: "Invalid recipient address." }, { status: 400 });
  }
  if (!isStrKeyContract(asset)) {
    return NextResponse.json({ error: "Invalid asset id." }, { status: 400 });
  }
  if (!/^[0-9a-fA-F]+$/.test(publicInputs) || !/^[0-9a-fA-F]+$/.test(proof)) {
    return NextResponse.json(
      { error: "publicInputs and proof must be hex strings." },
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

    // Fee abstraction (issue #149): quote fresh server-side rather than trust
    // whatever the client sent, so the fee actually charged always traces
    // back to this route's own view of the current rate, not a client-supplied
    // number. No router configured means no fee is carved out at all — the
    // withdrawal still proceeds exactly as it did before this feature.
    let feeAmount = "0";
    let feeMinOut = "0";
    const feeRecipient = relayer.publicKey();
    if (DEX_ROUTER_ID && XLM_SAC_ID && RELAYER_FEE_STROOPS !== "0") {
      const quote = await quoteFeeSwap(asset, RELAYER_FEE_STROOPS);
      if (quote) {
        feeAmount = quote.feeAmount;
        feeMinOut = quote.minXlmOut;
      }
    }

    const tx = new StellarSdk.TransactionBuilder(source, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(
        contract.call(
          "withdraw",
          StellarSdk.nativeToScVal(recipient, { type: "address" }),
          StellarSdk.nativeToScVal(asset, { type: "address" }),
          StellarSdk.xdr.ScVal.scvBytes(Buffer.from(publicInputs, "hex")),
          StellarSdk.xdr.ScVal.scvBytes(Buffer.from(proof, "hex")),
          StellarSdk.nativeToScVal(BigInt(feeAmount), { type: "i128" }),
          StellarSdk.nativeToScVal(BigInt(feeMinOut), { type: "i128" }),
          StellarSdk.nativeToScVal(feeRecipient, { type: "address" }),
        ),
      )
      .setTimeout(60)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationError(sim)) {
      return NextResponse.json(
        { error: `Withdrawal simulation failed: ${sim.error}` },
        { status: 400 },
      );
    }

    const assembled = StellarSdk.rpc.assembleTransaction(tx, sim).build();
    assembled.sign(relayer);

    const sent = await server.sendTransaction(assembled);
    if (sent.status === "ERROR") {
      return NextResponse.json(
        { error: "Relayed withdrawal submission failed." },
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
        { error: `Relayed withdrawal did not succeed (${result.status}).` },
        { status: 500 },
      );
    }

    return NextResponse.json({
      hash: sent.hash,
      relayer: relayer.publicKey(),
      feeAmount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Relay withdraw failed:", message);
    return NextResponse.json(
      { error: `Relayed withdrawal failed: ${message}` },
      { status: 500 },
    );
  }
}
