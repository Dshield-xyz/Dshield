/**
 * Persistent local cache of the pool's commitment set and event-scan
 * progress. This is a convenience cache, not a source of truth — see the
 * README's trust model section. Losing this file just means the next sync
 * rescans from the configured start ledger; it holds nothing that isn't
 * independently re-derivable from chain state.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { EventScanCursor } from "@dshield/core";

const ZERO_LEAF = "0x" + "00".repeat(32);

interface StoreData {
  poolId: string;
  /** Commitments in leaf-index order; unseen indices hold the zero leaf. */
  commitments: string[];
  /** Nullifier hashes seen in withdraw events, for the /health summary. */
  spentNullifiers: string[];
  depositCursor?: string;
  depositStartLedger: number;
  withdrawCursor?: string;
  withdrawStartLedger: number;
}

export class CommitmentStore {
  private readonly filePath: string;
  private data: StoreData;

  constructor(filePath: string, poolId: string) {
    this.filePath = filePath;
    this.data = CommitmentStore.load(filePath, poolId);
  }

  private static load(filePath: string, poolId: string): StoreData {
    if (existsSync(filePath)) {
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as StoreData;
      // A store from a different pool deployment must not be reused — its
      // commitments belong to a different tree entirely.
      if (raw.poolId === poolId) return raw;
    }
    return {
      poolId,
      commitments: [],
      spentNullifiers: [],
      depositStartLedger: 1,
      withdrawStartLedger: 1,
    };
  }

  save(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  setCommitment(leafIndex: number, commitment: string): void {
    while (this.data.commitments.length <= leafIndex) {
      this.data.commitments.push(ZERO_LEAF);
    }
    this.data.commitments[leafIndex] = commitment;
  }

  addSpentNullifier(nullifierHash: string): void {
    if (!this.data.spentNullifiers.includes(nullifierHash)) {
      this.data.spentNullifiers.push(nullifierHash);
    }
  }

  get poolId(): string {
    return this.data.poolId;
  }

  get commitments(): readonly string[] {
    return this.data.commitments;
  }

  get leafCount(): number {
    return this.data.commitments.length;
  }

  get spentNullifierCount(): number {
    return this.data.spentNullifiers.length;
  }

  isNullifierSpent(nullifierHash: string): boolean {
    return this.data.spentNullifiers.includes(nullifierHash);
  }

  get depositCursor(): EventScanCursor {
    return {
      cursor: this.data.depositCursor,
      startLedger: this.data.depositStartLedger,
    };
  }

  setDepositCursor(cursor: EventScanCursor): void {
    this.data.depositCursor = cursor.cursor;
    this.data.depositStartLedger = cursor.startLedger;
  }

  get withdrawCursor(): EventScanCursor {
    return {
      cursor: this.data.withdrawCursor,
      startLedger: this.data.withdrawStartLedger,
    };
  }

  setWithdrawCursor(cursor: EventScanCursor): void {
    this.data.withdrawCursor = cursor.cursor;
    this.data.withdrawStartLedger = cursor.startLedger;
  }
}
