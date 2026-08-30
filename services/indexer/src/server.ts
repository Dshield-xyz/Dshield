/**
 * Minimal HTTP/JSON API for the standalone indexer. Deliberately built on
 * Node's built-in `http` module rather than a framework — the surface is
 * four read-only GET routes, which doesn't warrant an extra dependency.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Hash2 } from "@dshield/core";
import type { CommitmentStore } from "./store.js";
import { buildProof, buildRoot } from "./tree.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createIndexerServer(store: CommitmentStore, hash2: Hash2) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, store, hash2).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: CommitmentStore,
  hash2: Hash2,
): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    res.end();
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      poolId: store.poolId,
      leafCount: store.leafCount,
      spentNullifierCount: store.spentNullifierCount,
    });
    return;
  }

  if (url.pathname === "/commitments") {
    sendJson(res, 200, {
      poolId: store.poolId,
      count: store.leafCount,
      commitments: store.commitments,
    });
    return;
  }

  if (url.pathname === "/root") {
    const root = await buildRoot(hash2, store.commitments);
    sendJson(res, 200, {
      poolId: store.poolId,
      leafCount: store.leafCount,
      root,
    });
    return;
  }

  const proofMatch = url.pathname.match(/^\/proof\/(\d+)$/);
  if (proofMatch) {
    const leafIndex = Number(proofMatch[1]);
    if (leafIndex >= store.leafCount) {
      sendJson(res, 404, {
        error: `leaf index ${leafIndex} has not been indexed (tree has ${store.leafCount} leaves)`,
      });
      return;
    }
    const proof = await buildProof(hash2, store.commitments, leafIndex);
    sendJson(res, 200, {
      poolId: store.poolId,
      leafIndex,
      ...proof,
    });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}
