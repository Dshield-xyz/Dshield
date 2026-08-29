import { Command } from "commander";
import { makeContext } from "./context";
import { depositCommand } from "./commands/deposit";
import { withdrawCommand } from "./commands/withdraw";
import {
  notesListCommand,
  notesExportCommand,
  notesImportCommand,
} from "./commands/notes";
import { discloseCommand } from "./commands/compliance";

const VERSION = "0.1.0";

/**
 * Build the `dshield` command tree. Exported (rather than run inline) so tests
 * can drive it with `parseAsync` without spawning a process.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("dshield")
    .description(
      "Command-line client for DShield — script deposits, withdrawals, note " +
        "management and compliance reports against a Stellar/Soroban pool, no browser.",
    )
    .version(VERSION)
    // Global configuration. Any of these can also come from DSHIELD_* env vars,
    // ~/.dshield/config.json, or a repo's frontend/.env.local (see README).
    .option("--rpc <url>", "Soroban RPC URL")
    .option("--network-passphrase <phrase>", "Stellar network passphrase")
    .option("--pool <contractId>", "Shielded pool contract ID (C…)")
    .option("--compliance <contractId>", "Compliance contract ID (C…)")
    .option("--usdc-code <code>", "USDC asset code")
    .option("--usdc-issuer <issuer>", "USDC issuer address (G…)")
    .option("--secret-key <seed>", "Signing key (S… seed) for this wallet")
    .option("--issuer-secret <seed>", "USDC issuer secret, to mint test USDC when funding")
    .option("--sign-with <command>", "External signer: reads XDR on stdin, prints signed XDR")
    .option("--home <dir>", "Config + note store directory (default ~/.dshield)")
    .option("--env-file <path>", "Explicit frontend .env.local to read config from")
    .option("--json", "Emit machine-readable JSON on stdout");

  program
    .command("deposit")
    .description("Shield USDC into the pool and receive a private note")
    .requiredOption("--amount <usdc>", "Amount to deposit, in USDC (e.g. 10.5)")
    .option("--dry-run", "Build and save the note offline without touching the network")
    .action((opts, cmd) =>
      run(cmd, (ctx) => depositCommand(opts, ctx)),
    );

  program
    .command("withdraw")
    .description("Redeem a note (in full or in part) with a zero-knowledge proof")
    .option("--note <string>", "Serialized note to spend")
    .option("--commitment <hex>", "Commitment of a stored note to spend")
    .option("--to <address>", "Recipient G-address (default: your wallet)")
    .option("--amount <usdc>", "Partial amount in USDC (default: the whole note)")
    .action((opts, cmd) => run(cmd, (ctx) => withdrawCommand(opts, ctx)));

  const notes = program.command("notes").description("Manage locally stored notes");
  notes
    .command("list")
    .description("List stored notes and their status")
    .action((_opts, cmd) => run(cmd, (ctx) => notesListCommand(ctx)));
  notes
    .command("export")
    .description("Export all stored notes as a backup blob")
    .option("--out <file>", "Write to a file instead of stdout")
    .action((opts, cmd) => run(cmd, (ctx) => notesExportCommand(opts, ctx)));
  notes
    .command("import <input>")
    .description("Import notes from a backup file or an inline note string")
    .action((input, _opts, cmd) => run(cmd, (ctx) => notesImportCommand(input, ctx)));

  const compliance = program
    .command("compliance")
    .description("Compliance reporting for shielded notes");
  compliance
    .command("disclose")
    .description("Generate a verifiable compliance report for a note")
    .option("--note <string>", "Serialized note to report on")
    .option("--commitment <hex>", "Commitment of a stored note to report on")
    .option("--out <file>", "Also write the report text to a file")
    .option("--offline", "Only check note integrity; skip on-chain lookups")
    .action((opts, cmd) => run(cmd, (ctx) => discloseCommand(opts, ctx)));

  return program;
}

/**
 * Wrap a command body: build the context from global options, run it, and turn
 * any thrown error into a clean stderr message + non-zero exit (rather than an
 * unhandled-rejection stack trace).
 */
async function run(
  cmd: Command,
  body: (ctx: ReturnType<typeof makeContext>) => void | Promise<void>,
): Promise<void> {
  const globals = cmd.optsWithGlobals();
  const ctx = makeContext(globals);
  try {
    await body(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  }
}

// Only auto-run when invoked as a program, not when imported by tests.
const isEntrypoint =
  process.argv[1] !== undefined &&
  /(?:^|[\\/])(?:dshield\.mjs|index\.ts)$/.test(process.argv[1]);

if (isEntrypoint) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
