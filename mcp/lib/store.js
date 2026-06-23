// Tiny disk-backed JSON store shared across the stdio and HTTP transports.
//
// The dispatch queue and runtime registry must be visible to BOTH processes:
//   • the stdio MCP server (index.js) that Claude Code / Cursor / pi spawn, and
//   • the HTTP transport (http-server.js) that `phewsh mcp serve` runs.
//
// They are separate OS processes, so in-memory Maps don't work — a job
// enqueued by the web (HTTP process) would be invisible to the harness
// (stdio process). We persist to ~/.phewsh/bridge/*.json instead, matching the
// file-based pattern the rest of ~/.phewsh/ already uses. Phase 3 swaps this
// for Supabase; until then, disk is the honest shared substrate.
//
// Writes are atomic (temp file + rename) and every mutation is a
// read-modify-write, which is good enough for local, single-user, low-write
// same-machine coordination. It is not a concurrent database.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const BRIDGE_DIR = join(homedir(), ".phewsh", "bridge");

function ensureDir() {
  if (!existsSync(BRIDGE_DIR)) mkdirSync(BRIDGE_DIR, { recursive: true });
}

export function readStore(name, fallback) {
  const file = join(BRIDGE_DIR, name);
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

export function writeStore(name, data) {
  ensureDir();
  const file = join(BRIDGE_DIR, name);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

/** Read, mutate via fn, write back. Returns whatever fn returns. */
export function mutateStore(name, fallback, fn) {
  const data = readStore(name, fallback);
  const result = fn(data);
  writeStore(name, data);
  return result;
}
