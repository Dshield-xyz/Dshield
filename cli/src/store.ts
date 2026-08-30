import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PENDING_LEAF_INDEX, type ShieldedNote } from "@dshield/core/notes";

/**
 * A plain-JSON note store on disk, the CLI analogue of the browser app's
 * localStorage. The note is the only key to shielded funds, so this file is
 * sensitive: it lives under ~/.dshield (0700) and holds every nullifier/secret.
 */
export class NoteStore {
  private readonly path: string;

  constructor(home: string) {
    if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
    this.path = join(home, "notes.json");
  }

  all(): ShieldedNote[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(parsed) ? (parsed as ShieldedNote[]) : [];
    } catch {
      return [];
    }
  }

  private write(notes: ShieldedNote[]): void {
    writeFileSync(this.path, JSON.stringify(notes, null, 2) + "\n", { mode: 0o600 });
  }

  /** Add a note. Returns false (and does nothing) if its commitment is already stored. */
  add(note: ShieldedNote): boolean {
    const notes = this.all();
    if (notes.some((n) => n.commitment === note.commitment)) return false;
    notes.push(note);
    this.write(notes);
    return true;
  }

  private update(commitment: string, patch: Partial<ShieldedNote>): void {
    const notes = this.all().map((n) =>
      n.commitment === commitment ? { ...n, ...patch } : n,
    );
    this.write(notes);
  }

  setLeafIndex(commitment: string, leafIndex: number): void {
    this.update(commitment, { leafIndex });
  }

  markSpent(commitment: string): void {
    this.update(commitment, { spent: true });
  }

  /** Notes worth spending now: unspent, settled leaf index, non-zero value. */
  active(): ShieldedNote[] {
    return this.all().filter(
      (n) => !n.spent && n.leafIndex >= 0 && BigInt(n.amount || "0") > BigInt(0),
    );
  }

  /** Notes saved but not yet tied to a real leaf index. */
  pending(): ShieldedNote[] {
    return this.all().filter((n) => !n.spent && n.leafIndex < 0);
  }

  find(commitment: string): ShieldedNote | undefined {
    const clean = commitment.replace(/^0x/, "").toLowerCase();
    return this.all().find(
      (n) => n.commitment.replace(/^0x/, "").toLowerCase() === clean,
    );
  }

  get filePath(): string {
    return this.path;
  }
}

export { PENDING_LEAF_INDEX };
