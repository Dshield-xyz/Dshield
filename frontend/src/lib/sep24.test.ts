import { describe, expect, it, vi } from "vitest";
import { createInteractiveDeposit, discoverAnchor, getSep24Transaction } from "./sep24";
const toml = 'TRANSFER_SERVER_SEP0024 = "https://anchor.example/sep24"';
const response = (body: unknown) => ({ ok: true, text: async () => String(body), json: async () => body }) as Response;
describe("SEP-24 client", () => {
  it("discovers the anchor", async () => expect(await discoverAnchor("anchor.example", vi.fn().mockResolvedValue(response(toml)))).toBe("https://anchor.example/sep24"));
  it("creates an interactive deposit", async () => { const fetcher = vi.fn().mockResolvedValueOnce(response(toml)).mockResolvedValueOnce(response({ id: "tx_1", url: "https://anchor.example/pay" })); await expect(createInteractiveDeposit({ homeDomain: "anchor.example", assetCode: "USDC", account: "GABC", fetcher })).resolves.toEqual({ id: "tx_1", url: "https://anchor.example/pay" }); });
  it("reads status", async () => { const fetcher = vi.fn().mockResolvedValueOnce(response(toml)).mockResolvedValueOnce(response({ id: "tx_1", status: "completed" })); await expect(getSep24Transaction({ homeDomain: "anchor.example", id: "tx_1", fetcher })).resolves.toMatchObject({ status: "completed" }); });
});
