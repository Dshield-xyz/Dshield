import { randomUUID } from "crypto";

/**
 * Structured server-side logger for API route handlers.
 *
 * Every log line is emitted as a single JSON object with a stable schema so
 * log aggregators (Splunk, Loki, CloudWatch, …) can parse it without custom
 * rules, and every request carries a correlation ID (`x-request-id`) that ties
 * the client-reported error back to the server-side log lines for the same
 * request.
 *
 * Usage:
 *   import { createLogger, requestCorrelationId } from "@/lib/logger";
 *   export async function POST(req: NextRequest) {
 *     const correlationId = requestCorrelationId(req.headers);
 *     const log = createLogger("faucet", correlationId);
 *     log.info("request received", { address });
 *     ...
 *     log.error("faucet failed", { message });
 *   }
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export interface StructuredLogEntry {
  ts: string; // ISO-8601 UTC
  level: LogLevel;
  route: string;
  correlationId: string | null;
  msg: string;
  fields?: LogFields;
}

/** Parse an incoming `x-request-id` (or generate a fresh UUIDv4). */
export function requestCorrelationId(headers: Headers | null | undefined): string {
  const incoming = headers?.get("x-request-id");
  if (incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming)) {
    return incoming;
  }
  return randomUUID();
}

function emit(entry: StructuredLogEntry): void {
  const line = JSON.stringify(entry);
  if (entry.level === "error") {
    // eslint-disable-next-line no-console
    console.error(line);
  } else if (entry.level === "warn") {
    // eslint-disable-next-line no-console
    console.warn(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

export interface Logger {
  route: string;
  correlationId: string | null;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export function createLogger(route: string, correlationId?: string | null): Logger {
  const base: Omit<StructuredLogEntry, "level" | "msg" | "fields"> = {
    ts: new Date().toISOString(),
    route,
    correlationId: correlationId ?? null,
  };

  const log = (level: LogLevel) => (msg: string, fields?: LogFields) => {
    const entry: StructuredLogEntry = {
      ...base,
      ts: new Date().toISOString(),
      level,
      msg,
    };
    if (fields && Object.keys(fields).length > 0) {
      entry.fields = fields;
    }
    emit(entry);
  };

  return {
    route,
    correlationId: base.correlationId,
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  };
}

/**
 * Attach the correlation ID to a JSON response so the client can report it
 * back when filing a bug ("my request failed — x-request-id: <id>").
 */
export function withCorrelationId(
  response: Response,
  correlationId: string,
): Response {
  response.headers.set("x-request-id", correlationId);
  return response;
}