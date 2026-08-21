import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLogger, requestCorrelationId, withCorrelationId } from "./logger";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("requestCorrelationId", () => {
  it("returns a UUIDv4 when no x-request-id header is present", () => {
    const headers = new Headers();
    const id = requestCorrelationId(headers);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("returns the x-request-id header value when valid", () => {
    const headers = new Headers({ "x-request-id": "my-trace-001" });
    expect(requestCorrelationId(headers)).toBe("my-trace-001");
  });

  it("rejects an x-request-id that is too long and generates a UUID", () => {
    const headers = new Headers({ "x-request-id": "x".repeat(200) });
    const id = requestCorrelationId(headers);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("handles null headers gracefully", () => {
    const id = requestCorrelationId(null);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe("createLogger", () => {
  it("emits a JSON log line on info()", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("test-route", "corr-123");

    log.info("hello world", { key: "value" });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0][0]);
    expect(line.route).toBe("test-route");
    expect(line.correlationId).toBe("corr-123");
    expect(line.level).toBe("info");
    expect(line.msg).toBe("hello world");
    expect(line.fields).toEqual({ key: "value" });
    expect(line.ts).toBeDefined();
  });

  it("emits to console.error on error()", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger("test-route", "corr-456");

    log.error("something broke", { error: "timeout" });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0][0]);
    expect(line.level).toBe("error");
    expect(line.msg).toBe("something broke");
    expect(line.fields).toEqual({ error: "timeout" });
  });

  it("omits fields when none are provided", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("test-route", "corr-789");

    log.info("no fields");

    const line = JSON.parse(spy.mock.calls[0][0]);
    expect(line.msg).toBe("no fields");
    expect(line.fields).toBeUndefined();
  });

  it("emits to console.warn on warn()", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = createLogger("test-route", "corr-000");

    log.warn("caution");

    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0][0]);
    expect(line.level).toBe("warn");
  });
});

describe("withCorrelationId", () => {
  it("attaches x-request-id header to the response", () => {
    const response = new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const decorated = withCorrelationId(response, "trace-999");
    expect(decorated.headers.get("x-request-id")).toBe("trace-999");
  });
});