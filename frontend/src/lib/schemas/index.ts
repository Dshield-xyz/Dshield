import { z } from "zod";

/**
 * Shared Zod schemas for the faucet, register-kyc, and relay-withdraw API routes.
 * These are imported by both the server-side route handlers and the frontend
 * callers so that request/response shapes are defined in exactly one place.
 */

// ── Faucet ───────────────────────────────────────────────────────────────────

export const FaucetRequest = z.object({
  address: z.string().min(1, "address is required"),
  amount: z.string().regex(/^\d+$/, "amount must be a non-negative integer string"),
});

export type FaucetRequestType = z.infer<typeof FaucetRequest>;

export const FaucetResponse = z.object({
  hash: z.string(),
  amount: z.string(),
});

// ── Register KYC ─────────────────────────────────────────────────────────────

export const RegisterKycRequest = z.object({
  kycHash: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "kycHash must be exactly 64 hex characters (32 bytes)"),
});

export type RegisterKycRequestType = z.infer<typeof RegisterKycRequest>;

export const RegisterKycResponse = z.object({
  hash: z.string(),
});

// ── Relay Withdraw ───────────────────────────────────────────────────────────

export const RelayWithdrawRequest = z.object({
  poolId: z.string().min(1, "poolId is required"),
  recipient: z.string().min(1, "recipient is required"),
  publicInputs: z.string().regex(/^[0-9a-fA-F]+$/, "publicInputs must be a hex string"),
  proof: z.string().regex(/^[0-9a-fA-F]+$/, "proof must be a hex string"),
});

export type RelayWithdrawRequestType = z.infer<typeof RelayWithdrawRequest>;

export const RelayWithdrawResponse = z.object({
  hash: z.string(),
  relayer: z.string(),
});

// ── Error response ───────────────────────────────────────────────────────────

export const ErrorResponse = z.object({
  error: z.string(),
  code: z.string().optional(),
});