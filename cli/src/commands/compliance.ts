import { writeFileSync } from "node:fs";
import {
  computeReportIdentity,
  formatReportText,
  type ComplianceReport,
} from "@dshield/core/report";
import { parseNote, type ShieldedNote } from "@dshield/core/notes";
import type { Context } from "../context";
import { fetchCommitments, isNullifierUsed } from "../stellar";

export interface DiscloseOptions {
  note?: string;
  commitment?: string;
  out?: string;
  /** Skip all chain reads; report only the note-integrity check. */
  offline?: boolean;
}

/**
 * Build and print a compliance report for a note — the CLI equivalent of the
 * app's Compliance page. It recomputes the commitment/nullifier from the note
 * (shared @dshield/core logic) and confirms deposit + withdrawal status against
 * the pool's authoritative on-chain state. It never embeds the note itself, so
 * the report is safe to hand to an auditor.
 */
export async function discloseCommand(
  opts: DiscloseOptions,
  ctx: Context,
): Promise<void> {
  const { config, store, out } = ctx;

  let note: ShieldedNote | undefined;
  if (opts.note) {
    const parsed = parseNote(opts.note);
    if (!parsed) throw new Error("Could not parse the provided note string.");
    note = parsed;
  } else if (opts.commitment) {
    note = store.find(opts.commitment);
    if (!note) throw new Error(`No stored note with commitment ${opts.commitment}.`);
  } else {
    throw new Error("Specify a note with --note <string> or --commitment <hex>.");
  }

  const poolId = note.poolId || config.poolId;
  if (!poolId) throw new Error("No pool configured for this note (pass --pool <C…>).");

  out.step("Re-deriving the note's commitment and nullifier…");
  const { commitment, nullifierHash, integrityOk } = await computeReportIdentity(note);

  let depositConfirmed = false;
  let leafIndex: number | null = null;
  let withdrawn = false;

  if (!opts.offline) {
    out.step("Confirming deposit and withdrawal status on-chain…");
    const commitmentClean = commitment.replace(/^0x/, "").toLowerCase();
    const chainCommitments = await fetchCommitments(config, poolId);
    if (chainCommitments) {
      const idx = chainCommitments.findIndex(
        (c) => c.replace(/^0x/, "").toLowerCase() === commitmentClean,
      );
      if (idx >= 0) leafIndex = idx;
    }
    depositConfirmed = leafIndex !== null;
    withdrawn = await isNullifierUsed(config, poolId, nullifierHash);
  }

  const report: ComplianceReport = {
    network: config.networkPassphrase,
    poolId,
    commitment,
    nullifierHash,
    integrityOk,
    depositConfirmed,
    leafIndex,
    withdrawn,
    // Transaction-hash links come from RPC event history; the CLI reports the
    // authoritative contract-view facts and leaves tx links to the web app.
    depositTx: null,
    withdrawTx: null,
    generatedAt: Date.now(),
  };

  const text = formatReportText(report);
  if (opts.out) {
    writeFileSync(opts.out, text + "\n");
    out.step(`Report written to ${opts.out}`);
  }

  out.result(text, report);
}
