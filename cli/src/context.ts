import { loadConfig, type CliOverrides, type DshieldConfig } from "./config";
import { NoteStore } from "./store";
import { Output } from "./output";

/** Everything a command needs that isn't its own options: config, note store, output. */
export interface Context {
  config: DshieldConfig;
  store: NoteStore;
  out: Output;
}

/** Build a command context from commander's parsed global options. */
export function makeContext(globalOpts: CliOverrides & { json?: boolean }): Context {
  const config = loadConfig(globalOpts);
  return {
    config,
    store: new NoteStore(config.home),
    out: new Output(!!globalOpts.json),
  };
}
