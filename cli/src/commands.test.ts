import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "./index";
import { computeCommitment } from "@dshield/core/poseidon2";
import { parseNote, serializeNote } from "@dshield/core/notes";

let home: string;

function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((c: string | Uint8Array) => ((stdout += c.toString()), true));
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((c: string | Uint8Array) => ((stderr += c.toString()), true));

  const program = buildProgram();
  program.exitOverride();
  return program
    .parseAsync(["node", "dshield", "--home", home, ...args])
    .then(() => ({ stdout, stderr }))
    .finally(() => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dshield-cli-test-"));
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("deposit --dry-run", () => {
  it("mints a note whose commitment matches @dshield/core's computeCommitment", async () => {
    const { stdout } = await runCli(["--json", "deposit", "--dry-run", "--amount", "12.5"]);
    const result = JSON.parse(stdout);

    expect(result.dryRun).toBe(true);
    // 12.5 USDC = 125_000_000 stroops (7 decimals).
    expect(result.amount).toBe("125000000");

    const note = parseNote(result.note);
    expect(note).not.toBeNull();

    // The whole point of the shared package: the CLI's commitment is exactly
    // what core recomputes from the same secrets + amount.
    const expected = (
      await computeCommitment(note!.nullifier, note!.secret, note!.amount)
    ).replace(/^0x/, "");
    expect(note!.commitment).toBe(expected);
    expect(note!.commitment).toBe(result.commitment);
  });

  it("persists the note to the store so `notes list` sees it", async () => {
    await runCli(["--json", "deposit", "--dry-run", "--amount", "1"]);
    const stored = JSON.parse(readFileSync(join(home, "notes.json"), "utf8"));
    expect(stored).toHaveLength(1);
    expect(stored[0].amount).toBe("10000000");
    expect(stored[0].spent).toBe(false);
  });
});

describe("notes import / list / export", () => {
  it("imports an inline note, lists it, and exports it back", async () => {
    // Deposit dry-run to obtain a valid note string, then import it into a
    // fresh store.
    const { stdout: dep } = await runCli(["--json", "deposit", "--dry-run", "--amount", "3"]);
    const noteStr = serializeNote(parseNote(JSON.parse(dep).note)!);

    // New home for a clean store.
    home = mkdtempSync(join(tmpdir(), "dshield-cli-test-"));

    const { stdout: imp } = await runCli(["--json", "notes", "import", noteStr]);
    expect(JSON.parse(imp).added).toBe(1);

    // Re-importing the same note is a no-op (dedupe by commitment).
    const { stdout: imp2 } = await runCli(["--json", "notes", "import", noteStr]);
    expect(JSON.parse(imp2).added).toBe(0);
    expect(JSON.parse(imp2).skipped).toBe(1);

    const { stdout: list } = await runCli(["--json", "notes", "list"]);
    expect(JSON.parse(list).notes).toHaveLength(1);

    const { stdout: exp } = await runCli(["notes", "export"]);
    expect(exp.trim()).toBe(noteStr);
  });
});
