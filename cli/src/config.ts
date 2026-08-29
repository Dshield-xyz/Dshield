import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface DshieldConfig {
  rpcUrl: string;
  networkPassphrase: string;
  poolId: string;
  complianceId: string;
  usdcCode: string;
  usdcIssuer: string;
  /** Signing key for transactions this CLI submits (S… secret seed). */
  secretKey: string;
  /** USDC issuer secret, used only to auto-fund a deposit on test networks. */
  issuerSecret: string;
  /** External signer command: receives base64 XDR on stdin, prints signed XDR. */
  signWith: string;
  /** Directory holding the local keyfile and note store (default ~/.dshield). */
  home: string;
}

/** Raw option bag from commander's global flags. */
export interface CliOverrides {
  rpc?: string;
  networkPassphrase?: string;
  pool?: string;
  compliance?: string;
  usdcCode?: string;
  usdcIssuer?: string;
  secretKey?: string;
  issuerSecret?: string;
  signWith?: string;
  home?: string;
  envFile?: string;
}

const DEFAULTS = {
  rpcUrl: "http://localhost:8000/soroban/rpc",
  networkPassphrase: "Standalone Network ; February 2017",
} as const;

/** Minimal `.env`-style parser: `KEY=value` lines, `#` comments, no interpolation. */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Walk up from `start` looking for a deployed frontend env file
 * (`frontend/.env.local`), which `just deploy` writes with the live pool /
 * compliance IDs and network config. Consuming it lets the CLI target a local
 * or testnet deployment with zero flags. Returns the parsed map, or {}.
 */
function loadFrontendEnv(explicit?: string): Record<string, string> {
  if (explicit) {
    return existsSync(explicit)
      ? parseDotenv(readFileSync(explicit, "utf8"))
      : {};
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "frontend", ".env.local");
    if (existsSync(candidate)) return parseDotenv(readFileSync(candidate, "utf8"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

function firstNonEmpty(...values: (string | undefined)[]): string {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return "";
}

/**
 * Resolve the effective configuration. Precedence, highest first:
 *   CLI flags > DSHIELD_* env vars > ~/.dshield/config.json >
 *   frontend/.env.local (deployment output) > built-in defaults.
 */
export function loadConfig(overrides: CliOverrides = {}): DshieldConfig {
  const home = resolve(
    firstNonEmpty(overrides.home, process.env.DSHIELD_HOME) ||
      join(homedir(), ".dshield"),
  );

  const feEnv = loadFrontendEnv(overrides.envFile || process.env.DSHIELD_ENV_FILE);

  let fileCfg: Partial<DshieldConfig> = {};
  const cfgPath = join(home, "config.json");
  if (existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Partial<DshieldConfig>;
    } catch {
      // A malformed config file shouldn't hard-fail every command; ignore it.
    }
  }

  // A secret in a keyfile is the CLI's own wallet convention (distinct from the
  // browser wallet-kit flow): a single S… line at ~/.dshield/key.
  let keyfileSecret = "";
  const keyfile = join(home, "key");
  if (existsSync(keyfile)) {
    keyfileSecret = readFileSync(keyfile, "utf8").trim();
  }

  return {
    rpcUrl: firstNonEmpty(
      overrides.rpc,
      process.env.DSHIELD_RPC_URL,
      fileCfg.rpcUrl,
      feEnv.NEXT_PUBLIC_RPC_URL,
      DEFAULTS.rpcUrl,
    ),
    networkPassphrase: firstNonEmpty(
      overrides.networkPassphrase,
      process.env.DSHIELD_NETWORK_PASSPHRASE,
      fileCfg.networkPassphrase,
      feEnv.NEXT_PUBLIC_NETWORK_PASSPHRASE,
      DEFAULTS.networkPassphrase,
    ),
    poolId: firstNonEmpty(
      overrides.pool,
      process.env.DSHIELD_POOL_ID,
      fileCfg.poolId,
      feEnv.NEXT_PUBLIC_POOL_CONTRACT_ID,
    ),
    complianceId: firstNonEmpty(
      overrides.compliance,
      process.env.DSHIELD_COMPLIANCE_ID,
      fileCfg.complianceId,
      feEnv.NEXT_PUBLIC_COMPLIANCE_CONTRACT_ID,
    ),
    usdcCode: firstNonEmpty(
      overrides.usdcCode,
      process.env.DSHIELD_USDC_CODE,
      fileCfg.usdcCode,
      feEnv.NEXT_PUBLIC_USDC_CODE,
      "USDC",
    ),
    usdcIssuer: firstNonEmpty(
      overrides.usdcIssuer,
      process.env.DSHIELD_USDC_ISSUER,
      fileCfg.usdcIssuer,
      feEnv.NEXT_PUBLIC_USDC_ISSUER,
    ),
    secretKey: firstNonEmpty(
      overrides.secretKey,
      process.env.DSHIELD_SECRET_KEY,
      fileCfg.secretKey,
      keyfileSecret,
      feEnv.NEXT_PUBLIC_DEV_SECRET_KEY,
    ),
    issuerSecret: firstNonEmpty(
      overrides.issuerSecret,
      process.env.DSHIELD_ISSUER_SECRET,
      fileCfg.issuerSecret,
      feEnv.USDC_ISSUER_SECRET,
    ),
    signWith: firstNonEmpty(
      overrides.signWith,
      process.env.DSHIELD_SIGN_WITH,
      fileCfg.signWith,
    ),
    home,
  };
}
