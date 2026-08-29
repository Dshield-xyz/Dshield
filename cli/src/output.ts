/**
 * Output helper. Progress/status lines go to stderr so stdout carries only the
 * command's result — clean for piping and for `--json`. In JSON mode the human
 * lines are suppressed and the result is emitted as a single JSON object.
 */
export class Output {
  constructor(private readonly json: boolean) {}

  get isJson(): boolean {
    return this.json;
  }

  /** A progress/status line (stderr; suppressed in JSON mode). */
  step(message: string): void {
    if (!this.json) process.stderr.write(message + "\n");
  }

  /** The command's final result: human text on stdout, or the data as JSON. */
  result(human: string, data: unknown): void {
    if (this.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    } else {
      process.stdout.write(human + "\n");
    }
  }
}
