// Token + formatting helpers. The implementations live in the shared
// @dshield/core package so the app and the `dshield` CLI agree on decimals, the
// symbol, and how stroop <-> USDC conversions round. Re-exported here to keep
// the app's existing `@/lib/format` imports working.
export * from "@dshield/core/format";
