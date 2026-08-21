import { NextRequest, NextResponse } from "next/server";
import * as StellarSdk from "@stellar/stellar-sdk";
import { timingSafeEqual } from "crypto";
import {
  createLogger,
  requestCorrelationId,
  withCorrelationId,
} from "@/lib/logger";

const ADMIN_SECRET = process.env.COMPLIANCE_ADMIN_SECRET || "";
// Registering a KYC hash grants "compliance-verified" status, so this route
// must not be callable by an arbitrary visitor (anyone could pick their own
// preimage, hash it, and self-register). Requires a server-only shared
// secret sent as the x-admin-key header; only whoever runs the admin/KYC
// intake flow should know it.
const KYC_ADMIN_API_KEY = process.env.KYC_ADMIN_API_KEY || "";
const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || "http://localhost:8000/soroban/rpc";
const PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ||
  "Standalone Network ; February 2017";
const COMPLIANCE_CONTRACT_ID =
  process.env.NEXT_PUBLIC_COMPLIANCE_CONTRACT_ID || "";

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function POST(req: NextRequest) {
  const correlationId = requestCorrelationId(req.headers);
  const log = createLogger("register-kyc", correlationId);

  if (!ADMIN_SECRET) {
    log.warn("compliance admin secret not configured");
    return withCorrelationId(
      NextResponse.json(
        { error: "KYC registration is not configured (COMPLIANCE_ADMIN_SECRET unset)." },
        { status: 503 },
      ),
      correlationId,
    );
  }
  if (!COMPLIANCE_CONTRACT_ID) {
    log.warn("compliance contract not configured");
    return withCorrelationId(
      NextResponse.json(
        { error: "Compliance contract not configured." },
        { status: 503 },
      ),
      correlationId,
    );
  }
  if (!KYC_ADMIN_API_KEY) {
    log.warn("KYC admin API key not configured");
    return withCorrelationId(
      NextResponse.json(
        { error: "KYC registration is not configured (KYC_ADMIN_API_KEY unset)." },
        { status: 503 },
      ),
      correlationId,
    );
  }

  const presented = req.headers.get("x-admin-key") || "";
  if (!presented || !timingSafeStringEqual(presented, KYC_ADMIN_API_KEY)) {
    log.warn("unauthorized kyc registration attempt");
    return withCorrelationId(
      NextResponse.json({ error: "Unauthorized." }, { status: 401 }),
      correlationId,
    );
  }

  let kycHashHex: string;
  try {
    const body = await req.json();
    kycHashHex = String(body.kycHash || "");
  } catch {
    log.warn("invalid request body");
    return withCorrelationId(
      NextResponse.json({ error: "Invalid request body." }, { status: 400 }),
      correlationId,
    );
  }

  if (!/^[0-9a-fA-F]{64}$/.test(kycHashHex)) {
    log.warn("invalid kycHash format", { length: kycHashHex.length });
    return withCorrelationId(
      NextResponse.json(
        { error: "kycHash must be exactly 64 hex characters (32 bytes)." },
        { status: 400 },
      ),
      correlationId,
    );
  }

  log.info("kyc registration started", { kycHashPrefix: kycHashHex.slice(0, 8) });

  try {
    const server = new StellarSdk.rpc.Server(RPC_URL, {
      allowHttp: RPC_URL.startsWith("http://"),
    });
    const admin = StellarSdk.Keypair.fromSecret(ADMIN_SECRET);
    const contract = new StellarSdk.Contract(COMPLIANCE_CONTRACT_ID);

    const kycHashScVal = StellarSdk.xdr.ScVal.scvBytes(
      Buffer.from(kycHashHex, "hex"),
    );

    const source = await server.getAccount(admin.publicKey());
    const tx = new StellarSdk.TransactionBuilder(source, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(contract.call("register_kyc", kycHashScVal))
      .setTimeout(60)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationError(sim)) {
      log.warn("simulation failed", { error: sim.error });
      return withCorrelationId(
        NextResponse.json(
          { error: `Simulation failed: ${sim.error}` },
          { status: 400 },
        ),
        correlationId,
      );
    }

    const assembled = StellarSdk.rpc.assembleTransaction(tx, sim).build();
    assembled.sign(admin);

    const sent = await server.sendTransaction(assembled);
    if (sent.status === "ERROR") {
      log.error("transaction rejected by network", { hash: sent.hash });
      return withCorrelationId(
        NextResponse.json(
          { error: "KYC registration transaction rejected by the network." },
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
      log.error("kyc registration did not succeed on-chain", { status: result.status, tries });
      return withCorrelationId(
        NextResponse.json(
          { error: `KYC registration failed on-chain (${result.status}).` },
          { status: 500 },
        ),
        correlationId,
      );
    }

    log.info("kyc registration succeeded", { hash: sent.hash });
    return withCorrelationId(
      NextResponse.json({ hash: sent.hash }),
      correlationId,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("kyc registration failed", { message });
    return withCorrelationId(
      NextResponse.json(
        { error: `KYC registration failed: ${message}` },
        { status: 500 },
      ),
      correlationId,
    );
  }
}
