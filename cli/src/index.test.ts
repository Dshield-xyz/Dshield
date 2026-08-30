import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildProgram } from "./index";

/**
 * Drive the real command tree without spawning a process. exitOverride turns
 * `--help`/`--version`/parse errors into thrown CommanderErrors instead of
 * killing the test runner; stdout/stderr are captured.
 */
async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; error?: unknown }> {
  let stdout = "";
  let stderr = "";
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    });

  const program = buildProgram();
  // exitOverride must be set on every command in the tree — commander invokes
  // process.exit on the *sub*command for a parse error, and it isn't inherited.
  const overrideAll = (cmd: import("commander").Command): void => {
    cmd.exitOverride();
    cmd.commands.forEach(overrideAll);
  };
  overrideAll(program);
  program.configureOutput({
    writeOut: (s) => {
      stdout += s;
    },
    writeErr: (s) => {
      stderr += s;
    },
  });

  let error: unknown;
  try {
    await program.parseAsync(["node", "dshield", ...args]);
  } catch (err) {
    error = err;
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout, stderr, error };
}

describe("dshield CLI parsing", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("lists all top-level commands in --help", async () => {
    const { stdout } = await runCli(["--help"]);
    expect(stdout).toContain("deposit");
    expect(stdout).toContain("withdraw");
    expect(stdout).toContain("notes");
    expect(stdout).toContain("compliance");
  });

  it("prints the version", async () => {
    const { stdout } = await runCli(["--version"]);
    expect(stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it("exposes the notes subcommands", async () => {
    const { stdout } = await runCli(["notes", "--help"]);
    expect(stdout).toContain("list");
    expect(stdout).toContain("export");
    expect(stdout).toContain("import");
  });

  it("requires --amount on deposit", async () => {
    const { error } = await runCli(["deposit"]);
    // exitOverride throws a CommanderError for the missing required option.
    expect(error).toBeTruthy();
    expect(String((error as Error).message)).toMatch(/amount/i);
  });

  it("rejects a non-positive deposit amount (offline validation)", async () => {
    const { stderr } = await runCli(["deposit", "--dry-run", "--amount", "0"]);
    expect(stderr).toMatch(/greater than zero/i);
    expect(process.exitCode).toBe(1);
  });
});
