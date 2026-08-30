import { spawnSync } from "node:child_process";
import * as StellarSdk from "@stellar/stellar-sdk";
import type { DshieldConfig } from "./config";

/**
 * The CLI's local wallet — deliberately distinct from the browser's
 * Stellar-Wallets-Kit flow. A transaction is signed one of two ways:
 *
 *  - a local keypair (S… seed from --secret-key / DSHIELD_SECRET_KEY /
 *    ~/.dshield/key / config), for scripting and CI; or
 *  - an external signer command (`--sign-with`), which receives the unsigned
 *    transaction as base64 XDR on stdin and must print the signed XDR on
 *    stdout. This is the hardware-wallet / air-gapped passthrough: point it at
 *    a `stellar tx sign`-style helper or a Ledger bridge and the seed never
 *    touches this process.
 */
export interface Wallet {
  publicKey: string;
  sign(xdr: string): Promise<string>;
}

export function loadWallet(config: DshieldConfig): Wallet {
  if (config.signWith) {
    const publicKey = config.secretKey
      ? StellarSdk.Keypair.fromSecret(config.secretKey).publicKey()
      : requirePublicKeyForExternalSigner(config);
    return {
      publicKey,
      async sign(xdr: string): Promise<string> {
        return runExternalSigner(config.signWith, xdr);
      },
    };
  }

  if (!config.secretKey) {
    throw new Error(
      "No signing key configured. Provide one with --secret-key <S…>, the " +
        "DSHIELD_SECRET_KEY env var, a ~/.dshield/key file, or use --sign-with " +
        "<command> for a hardware / external signer.",
    );
  }

  let keypair: StellarSdk.Keypair;
  try {
    keypair = StellarSdk.Keypair.fromSecret(config.secretKey.trim());
  } catch {
    throw new Error("Configured signing key is not a valid Stellar secret (S…) seed.");
  }

  return {
    publicKey: keypair.publicKey(),
    async sign(xdr: string): Promise<string> {
      const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, config.networkPassphrase);
      tx.sign(keypair);
      return tx.toXDR();
    },
  };
}

/** A keypair for the USDC issuer, used only to auto-fund deposits on test nets. */
export function loadIssuerKeypair(config: DshieldConfig): StellarSdk.Keypair | null {
  if (!config.issuerSecret) return null;
  try {
    return StellarSdk.Keypair.fromSecret(config.issuerSecret.trim());
  } catch {
    throw new Error("Configured issuer secret is not a valid Stellar secret (S…) seed.");
  }
}

function requirePublicKeyForExternalSigner(config: DshieldConfig): string {
  // With an external signer and no seed here, we still need the source account's
  // public key to build the transaction. Accept it via DSHIELD_PUBLIC_KEY.
  const pk = process.env.DSHIELD_PUBLIC_KEY || "";
  if (!pk) {
    throw new Error(
      "--sign-with needs the source account public key. Set DSHIELD_PUBLIC_KEY=G… " +
        "(or also pass --secret-key to derive it).",
    );
  }
  return pk;
}

function runExternalSigner(command: string, xdr: string): string {
  const result = spawnSync(command, {
    input: xdr,
    shell: true,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `External signer (${command}) failed: ${result.stderr?.trim() || `exit ${result.status}`}`,
    );
  }
  const signed = (result.stdout || "").trim();
  if (!signed) {
    throw new Error(`External signer (${command}) produced no signed XDR on stdout.`);
  }
  return signed;
}
