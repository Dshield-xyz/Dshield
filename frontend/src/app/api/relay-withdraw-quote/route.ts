import { NextRequest, NextResponse } from "next/server";
import * as StellarSdk from "@stellar/stellar-sdk";
import { quoteFeeSwap, queryContract, DEX_ROUTER_ID, XLM_SAC_ID } from "@/lib/stellar";

// Read-only pre-flight for the withdraw page: shows the effective relayer fee
// (in the asset the user actually holds) before they sign, per issue #149's
// acceptance criteria. Uses the same flat fee and DEX router config as the
// relay-withdraw route so the number shown here matches what withdraw will
// actually charge; no secret key needed since nothing is submitted.
const RELAYER_FEE_STROOPS = process.env.RELAYER_FEE_STROOPS || "0";

function isStrKeyContract(id: string): boolean {
  try {
    return StellarSdk.StrKey.isValidContract(id);
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  if (!DEX_ROUTER_ID || !XLM_SAC_ID || RELAYER_FEE_STROOPS === "0") {
    return NextResponse.json({ feeAmount: "0", expectedXlmOut: "0", minXlmOut: "0" });
  }

  let poolId: string;
  try {
    const body = await req.json();
    poolId = String(body.poolId || "");
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!isStrKeyContract(poolId)) {
    return NextResponse.json({ error: "Invalid pool id." }, { status: 400 });
  }

  const tokenVal = await queryContract(poolId, "get_token");
  const tokenId = tokenVal ? (StellarSdk.scValToNative(tokenVal) as string) : null;
  if (!tokenId) {
    return NextResponse.json({ feeAmount: "0", expectedXlmOut: "0", minXlmOut: "0" });
  }

  const quote = await quoteFeeSwap(tokenId, RELAYER_FEE_STROOPS);
  return NextResponse.json(quote ?? { feeAmount: "0", expectedXlmOut: "0", minXlmOut: "0" });
}
