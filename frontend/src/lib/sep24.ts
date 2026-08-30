/** Browser client for SEP-1 discovery and SEP-24 interactive deposits. */
export type Sep24Transaction = { id: string; status: string; amount_in?: string; amount_out?: string; more_info_url?: string; [key: string]: unknown };
export type Sep24Session = { id: string; url: string };

function parseToml(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/^\s*([A-Z0-9_]+)\s*=\s*["']([^"']+)["']/gim)].map((m) => [m[1].toUpperCase(), m[2]]));
}
export async function discoverAnchor(homeDomain: string, fetcher: typeof fetch = fetch): Promise<string> {
  const domain = homeDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!domain) throw new Error("SEP-24 anchor home domain is not configured.");
  const res = await fetcher(`https://${domain}/.well-known/stellar.toml`);
  if (!res.ok) throw new Error("The on-ramp's configuration could not be loaded.");
  const server = parseToml(await res.text()).TRANSFER_SERVER_SEP0024;
  if (!server) throw new Error("This on-ramp does not advertise SEP-24 support.");
  return server.replace(/\/$/, "");
}
export async function createInteractiveDeposit(input: { homeDomain: string; assetCode: string; account: string; callbackUrl?: string; fetcher?: typeof fetch }): Promise<Sep24Session> {
  const fetcher = input.fetcher ?? fetch;
  const server = await discoverAnchor(input.homeDomain, fetcher);
  const body = new URLSearchParams({ asset_code: input.assetCode, account: input.account });
  if (input.callbackUrl) body.set("callback", input.callbackUrl);
  const res = await fetcher(`${server}/transactions/deposit/interactive`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const data = await res.json().catch(() => ({})) as Partial<Sep24Session> & { error?: string };
  if (!res.ok || !data.id || !data.url) throw new Error(data.error || "The on-ramp could not start a deposit.");
  return { id: data.id, url: data.url };
}
export async function getSep24Transaction(input: { homeDomain: string; id: string; fetcher?: typeof fetch }): Promise<Sep24Transaction> {
  const fetcher = input.fetcher ?? fetch;
  const server = await discoverAnchor(input.homeDomain, fetcher);
  const res = await fetcher(`${server}/transaction?id=${encodeURIComponent(input.id)}`);
  const data = await res.json().catch(() => ({})) as Sep24Transaction & { error?: string };
  if (!res.ok || !data.id) throw new Error(data.error || "The on-ramp status could not be loaded.");
  return data;
}
export const SEP24_COMPLETE_STATUSES = new Set(["completed"]);
export const SEP24_FAILURE_STATUSES = new Set(["error", "expired", "refunded"]);
