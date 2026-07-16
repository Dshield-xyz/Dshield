import { describe, it, expect, vi, afterEach } from "vitest";

const VALID_G = "GABZWK2YLPOGBEOZT6VOCID6ROSSZGPSLAEPCTWIBGAJDHISO6DFKYYZ";

// The route reads USDC_ISSUER_SECRET at module load, so reload per scenario.
async function loadRoute(secret?: string) {
  vi.resetModules();
  if (secret === undefined) delete process.env.USDC_ISSUER_SECRET;
  else process.env.USDC_ISSUER_SECRET = secret;
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = "Standalone Network ; February 2017";
  process.env.NEXT_PUBLIC_USDC_CODE = "USDC";
  return (await import("./route")).POST;
}

// Minimal NextRequest stand-in — the handler calls req.json() and
// req.headers.get(...) (for rate-limit keying).
const req = (body: unknown, ip = "1.2.3.4") =>
  ({
    json: async () => body,
    headers: { get: (k: string) => (k.toLowerCase() === "x-forwarded-for" ? ip : null) },
  }) as never;

describe("/api/faucet validation", () => {
  it("503 when the issuer secret is not configured", async () => {
    const POST = await loadRoute(undefined);
    const res = await POST(req({ address: VALID_G, amount: "1" }));
    expect(res.status).toBe(503);
  });

  it("400 on an invalid recipient address", async () => {
    const POST = await loadRoute("Sxxx-dummy-secret");
    const res = await POST(req({ address: "not-an-address", amount: "1" }));
    expect(res.status).toBe(400);
  });

  it("400 on a non-positive amount", async () => {
    const POST = await loadRoute("Sxxx-dummy-secret");
    const res = await POST(req({ address: VALID_G, amount: "0" }));
    expect(res.status).toBe(400);
  });
});

describe("/api/faucet rate limiting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("429s a single IP after 5 requests within the window", async () => {
    const POST = await loadRoute("Sxxx-dummy-secret");
    // Each of these fails with 400 (invalid address, deliberately, to avoid
    // needing a real RPC), but the rate limiter counts the attempt regardless.
    for (let i = 0; i < 5; i++) {
      const res = await POST(req({ address: "not-an-address", amount: "1" }, "9.9.9.9"));
      expect(res.status).toBe(400);
    }
    const sixth = await POST(req({ address: "not-an-address", amount: "1" }, "9.9.9.9"));
    expect(sixth.status).toBe(429);
  });

  it("does not rate-limit a different IP", async () => {
    const POST = await loadRoute("Sxxx-dummy-secret");
    for (let i = 0; i < 5; i++) {
      await POST(req({ address: "not-an-address", amount: "1" }, "8.8.8.8"));
    }
    const res = await POST(req({ address: "not-an-address", amount: "1" }, "7.7.7.7"));
    expect(res.status).toBe(400); // not 429
  });

  it("returns 429 with a Retry-After header equal to the window in seconds", async () => {
    const POST = await loadRoute("Sxxx-dummy-secret");
    const ip = "9.9.9.9";
    for (let i = 0; i < 5; i++) {
      const res = await POST(req({ address: "not-an-address", amount: "1" }, ip));
      expect(res.status).toBe(400);
    }
    const blocked = await POST(req({ address: "not-an-address", amount: "1" }, ip));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("600");
  });

  it("resets the bucket and allows a new request after the window elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    const POST = await loadRoute("Sxxx-dummy-secret");
    const ip = "9.9.9.9";
    for (let i = 0; i < 5; i++) {
      await POST(req({ address: "not-an-address", amount: "1" }, ip));
    }
    expect((await POST(req({ address: "not-an-address", amount: "1" }, ip))).status).toBe(429);
    vi.advanceTimersByTime(10 * 60 * 1000);
    const unblocked = await POST(req({ address: "not-an-address", amount: "1" }, ip));
    expect(unblocked.status).toBe(400); // allowed again, still fails validation
  });
});
