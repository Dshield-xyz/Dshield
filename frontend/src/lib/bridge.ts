/**
 * Cross-chain bridge withdrawal utilities for DShield.
 *
 * NOTE: unused and not wired into any page. PR #167 added this alongside the
 * contract's bridge scaffolding (contracts/pool/src/lib.rs) and bridge_tests.rs,
 * but never a `withdraw_bridge` entry point or a `poseidon2` module with the
 * 3-argument hash this file expects -- neither side of the feature has ever
 * built. Left in place, unexported from the app, for whoever picks the
 * feature back up; see the matching NOTE on `bridge_tests` in the contract.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { poseidon2 } from "./poseidon";

export enum ChainId {
  Ethereum = 1,
  Polygon = 2,
  Arbitrum = 3,
  Optimism = 4,
  Base = 5,
}

export const CHAIN_NAMES: Record<ChainId, string> = {
  [ChainId.Ethereum]: "Ethereum",
  [ChainId.Polygon]: "Polygon",
  [ChainId.Arbitrum]: "Arbitrum",
  [ChainId.Optimism]: "Optimism",
  [ChainId.Base]: "Base",
};

/**
 * Compute the destination hash that the bridge withdrawal circuit commits to.
 *
 * CRITICAL: This encoding MUST match the bridge adapter contract's
 * `compute_destination_hash` function exactly, or the pool will reject
 * valid proofs.
 *
 * For EVM chains (Ethereum, Polygon, etc.):
 * - Destination is a 20-byte address (0x-prefixed hex string)
 * - Split into 10 + 10 bytes
 * - Right-align each in 32-byte buffer (big-endian)
 * - Hash: Poseidon2(chain_id, left_part, right_part)
 *
 * @param chainId - Destination chain identifier
 * @param destination - Recipient address on destination chain (0x-prefixed for EVM)
 * @returns Hex-encoded destination hash (0x-prefixed, 32 bytes)
 */
export async function computeDestinationHash(
  chainId: ChainId,
  destination: string,
): Promise<string> {
  // Validate and normalize EVM address
  if (
    chainId === ChainId.Ethereum ||
    chainId === ChainId.Polygon ||
    chainId === ChainId.Arbitrum ||
    chainId === ChainId.Optimism ||
    chainId === ChainId.Base
  ) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(destination)) {
      throw new Error(`Invalid EVM address: ${destination}`);
    }

    const addrBytes = destination.slice(2); // Remove 0x prefix
    const leftBytes = addrBytes.slice(0, 20); // First 10 bytes
    const rightBytes = addrBytes.slice(20, 40); // Last 10 bytes

    // Right-align in 32-byte buffers (big-endian)
    const leftPadded = "0".repeat(44) + leftBytes; // 22 zero bytes + 10 data bytes
    const rightPadded = "0".repeat(44) + rightBytes;

    // Chain ID as 32-byte big-endian
    const chainIdHex = chainId.toString(16).padStart(8, "0"); // 4-byte u32
    const chainIdPadded = "0".repeat(56) + chainIdHex; // 28 zero bytes + 4 data bytes

    // Poseidon2(chain_id, left_part, right_part)
    const hash = await poseidon2([
      "0x" + chainIdPadded,
      "0x" + leftPadded,
      "0x" + rightPadded,
    ]);

    return hash;
  }

  throw new Error(`Unsupported chain ID: ${chainId}`);
}

/**
 * Encode destination address for Soroban contract call.
 *
 * For EVM chains: return raw 20-byte buffer (no 0x prefix).
 *
 * @param chainId - Destination chain
 * @param destination - Address string (0x-prefixed for EVM)
 * @returns Buffer ready for Soroban Bytes parameter
 */
export function encodeDestination(
  chainId: ChainId,
  destination: string,
): Buffer {
  if (
    chainId === ChainId.Ethereum ||
    chainId === ChainId.Polygon ||
    chainId === ChainId.Arbitrum ||
    chainId === ChainId.Optimism ||
    chainId === ChainId.Base
  ) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(destination)) {
      throw new Error(`Invalid EVM address: ${destination}`);
    }
    return Buffer.from(destination.slice(2), "hex");
  }

  throw new Error(`Unsupported chain ID: ${chainId}`);
}

/**
 * Validate destination address format for a specific chain.
 *
 * @param chainId - Target chain
 * @param destination - Address to validate
 * @returns true if valid, false otherwise
 */
export function validateDestination(
  chainId: ChainId,
  destination: string,
): boolean {
  try {
    encodeDestination(chainId, destination);
    return true;
  } catch {
    return false;
  }
}

/**
 * Estimate bridge withdrawal time for a given chain.
 *
 * These are rough estimates for common bridge protocols:
 * - Wormhole: ~15-20 minutes (requires guardian signatures)
 * - CCTP: ~10-15 minutes (requires Circle attestation)
 * - Optimistic bridges: 1-7 days (fraud proof window)
 *
 * @param chainId - Destination chain
 * @returns Estimated time in human-readable format
 */
export function estimateBridgeTime(chainId: ChainId): string {
  // Conservative estimates assuming Wormhole or CCTP
  switch (chainId) {
    case ChainId.Ethereum:
      return "15-20 minutes";
    case ChainId.Polygon:
      return "10-15 minutes";
    case ChainId.Arbitrum:
    case ChainId.Optimism:
    case ChainId.Base:
      return "10-15 minutes";
    default:
      return "Unknown";
  }
}

/**
 * Get a user-friendly description of what bridging to a chain entails.
 *
 * @param chainId - Destination chain
 * @returns Description string
 */
export function getBridgeDescription(chainId: ChainId): string {
  const chainName = CHAIN_NAMES[chainId];
  const time = estimateBridgeTime(chainId);
  return `Bridge to ${chainName} (ETA: ${time}). Funds will arrive at your ${chainName} address after the bridge protocol confirms the transfer.`;
}

/**
 * Format destination address for display.
 *
 * @param destination - Full address
 * @returns Shortened format (e.g., "0x742d...bEb")
 */
export function formatDestination(destination: string): string {
  if (destination.startsWith("0x") && destination.length === 42) {
    return `${destination.slice(0, 6)}...${destination.slice(-4)}`;
  }
  return destination;
}
