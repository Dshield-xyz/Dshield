/**
 * The assets this deployment's pool can shield, resolved from the chain.
 *
 * The pool keeps an admin-managed allow-list and shields every asset on it over
 * one shared tree and nullifier set, so the app reads that list rather than
 * hardcoding a token. Nothing here falls back to "probably USDC": shielding
 * into the wrong asset would mint a note the pool will never pay out, so a
 * failure to read the allow-list surfaces as an error the user can retry.
 *
 * Native XLM is just another entry on the list — it reaches the pool through
 * its Stellar Asset Contract like any SEP-41 token. The only difference the app
 * has to care about is that holding XLM needs no trustline, which
 * {@link AssetInfo.native} carries.
 */
"use client";

import {
  fetchPoolAssets,
  resolveAsset as resolveAssetCore,
  type AssetInfo,
} from "@dshield/core/assets";
import { formatUnits, fromBaseUnits, toBaseUnits } from "@dshield/core/format";
import { useEffect, useState } from "react";
import { getChainConfig, getPoolId } from "./stellar";

export type { AssetInfo };

/**
 * In-flight/settled allow-list lookup, shared by every caller.
 *
 * Memoised on the promise rather than the result so the several components that
 * need the asset list on first paint issue one RPC round trip between them, not
 * one each. Cleared on failure so a retry actually retries.
 */
let assetsPromise: Promise<AssetInfo[]> | null = null;

/** Reads the pool's allow-list, caching the result for the session. */
export function loadPoolAssets(): Promise<AssetInfo[]> {
  if (!assetsPromise) {
    assetsPromise = fetchPoolAssets(getChainConfig(), getPoolId()).then(
      (assets) => {
        if (assets.length === 0) assetsPromise = null; // allow a retry
        return assets;
      },
      (err) => {
        assetsPromise = null;
        throw err;
      },
    );
  }
  return assetsPromise;
}

/** Drops the cached allow-list, so the next read hits the chain again. */
export function refreshPoolAssets(): void {
  assetsPromise = null;
}

export interface UseAssetsResult {
  assets: AssetInfo[];
  loading: boolean;
  /** Set when the allow-list could not be read at all. */
  error: string;
  reload: () => void;
}

/**
 * Subscribes a component to the pool's supported assets.
 *
 * Returns an empty list while loading and on failure — a caller must not treat
 * "no assets yet" as "this pool takes anything", which is why every deposit
 * path also checks the chosen asset is actually on the list before building a
 * note.
 */
export function useAssets(): UseAssetsResult {
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    loadPoolAssets()
      .then((list) => {
        if (cancelled) return;
        setAssets(list);
        if (list.length === 0) {
          setError("This pool has no supported assets configured.");
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAssets([]);
        setError(
          err instanceof Error
            ? `Could not read the pool's supported assets: ${err.message}`
            : "Could not read the pool's supported assets.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return {
    assets,
    loading,
    error,
    reload: () => {
      refreshPoolAssets();
      setNonce((n) => n + 1);
    },
  };
}

/**
 * The asset a note is denominated in. Notes store their asset's contract
 * address, so this is a lookup; a note whose asset has since been de-listed
 * still renders with safe defaults rather than crashing the list it is in.
 */
export function resolveAsset(assets: AssetInfo[], contractId: string): AssetInfo {
  return resolveAssetCore(assets, contractId);
}

/** Anything carrying the asset address a note is denominated in. */
interface AssetBearing {
  asset: string;
}

export interface NoteFormatter {
  /** The asset `note` is denominated in. */
  assetOf: (note: AssetBearing) => AssetInfo;
  /** Renders `units` in `note`'s own asset and precision, e.g. "1.5 XLM". */
  showNote: (note: AssetBearing, units: string | number | bigint) => string;
  /** Bare figure in `note`'s precision, for prefilling an input. */
  bareNote: (note: AssetBearing, units: string | number | bigint) => string;
  /** Parses a typed amount at `note`'s precision into base units. */
  parseForNote: (note: AssetBearing, amount: string) => string;
  assets: AssetInfo[];
}

/**
 * Formats and parses amounts against whichever asset each note holds.
 *
 * Every page that shows note values needs the same four operations, and every
 * one of them is wrong if it assumes a fixed precision: a 6-decimal token
 * rendered at 7 shows every balance ten times too small, and an amount parsed
 * at the wrong scale produces a note the pool will not pay out.
 */
export function useNoteFormatter(): NoteFormatter {
  const { assets } = useAssets();
  const assetOf = (note: AssetBearing) => resolveAsset(assets, note.asset);
  return {
    assets,
    assetOf,
    showNote: (note, units) => {
      const a = assetOf(note);
      return formatUnits(units, a.symbol, a.decimals);
    },
    bareNote: (note, units) => fromBaseUnits(units, assetOf(note).decimals),
    parseForNote: (note, amount) => toBaseUnits(amount, assetOf(note).decimals),
  };
}
