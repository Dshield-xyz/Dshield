import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { serializeNote, serializeNotes, parseNotes } from "@dshield/core/notes";
import { formatAmount, truncateMiddle } from "@dshield/core/format";
import type { Context } from "../context";

export function notesListCommand(ctx: Context): void {
  const { store, out } = ctx;
  const notes = store.all();

  if (notes.length === 0) {
    out.result("No notes stored yet. Make a deposit or import a note.", { notes: [] });
    return;
  }

  const rows = notes.map((n) => {
    const status = n.spent
      ? "spent"
      : n.leafIndex < 0
        ? "pending"
        : BigInt(n.amount || "0") === BigInt(0)
          ? "empty"
          : "active";
    return { commitment: n.commitment, amount: n.amount, status, leafIndex: n.leafIndex, poolId: n.poolId };
  });

  const human = rows
    .map(
      (r) =>
        `${truncateMiddle(r.commitment, 10, 8).padEnd(20)} ${formatAmount(r.amount).padEnd(16)} ${r.status.padEnd(8)} leaf #${r.leafIndex}`,
    )
    .join("\n");

  out.result(`${rows.length} note(s):\n${human}`, { notes: rows });
}

export function notesExportCommand(
  opts: { out?: string },
  ctx: Context,
): void {
  const { store, out } = ctx;
  const notes = store.all();
  const blob = serializeNotes(notes);

  if (opts.out) {
    writeFileSync(opts.out, blob);
    out.result(`Exported ${notes.length} note(s) to ${opts.out}`, {
      exported: notes.length,
      path: opts.out,
    });
  } else {
    // The blob itself is the result — print it verbatim to stdout.
    process.stdout.write(blob);
  }
}

export function notesImportCommand(input: string, ctx: Context): void {
  const { store, out } = ctx;

  // `input` is either a path to a backup file or an inline note string.
  const text = existsSync(input) ? readFileSync(input, "utf8") : input;
  const parsed = parseNotes(text);
  if (parsed.length === 0) {
    throw new Error("No valid DShield notes found in the input.");
  }

  const addedNotes = parsed.filter((note) => store.add(note));
  const added = addedNotes.length;
  const skipped = parsed.length - added;

  out.result(
    `Imported ${added} note(s), skipped ${skipped} already present.` +
      (added > 0 ? `\n${addedNotes.map(serializeNote).join("\n")}` : ""),
    { added, skipped, total: parsed.length },
  );
}
