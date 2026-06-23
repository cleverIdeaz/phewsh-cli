// Disk-backed registry of harnesses currently connected to this coordination
// layer. A harness registers itself when it first calls phewsh_start over
// stdio, or when it announces itself to /dispatch or /next over HTTP.
//
// State lives in ~/.phewsh/bridge/runtimes.json so the stdio transport (where
// harnesses register) and the HTTP transport (whose /health the intent web app
// polls for the "live session" pill) — two separate processes — see the same
// list. See ./store.js for why this can't be an in-memory Map.

import { readStore, mutateStore } from "./store.js";

const FILE = "runtimes.json";
const EMPTY = { runtimes: {} }; // id -> entry

// A harness only pings us when it calls an MCP tool, and a working session can
// sit idle between tool calls. 5 minutes keeps an active session's "live" pill
// green between calls while still aging out a harness that has truly gone away.
const HEARTBEAT_STALE_MS = 5 * 60_000;

export function register({ id, label, transport, agentId }) {
  if (!id) return null;
  const now = new Date().toISOString();
  return mutateStore(FILE, { ...EMPTY }, (store) => {
    const existing = store.runtimes[id];
    const entry = {
      id,
      label: label || existing?.label || id,
      transport: transport || existing?.transport || "unknown",
      agentId: agentId || existing?.agentId || null,
      connectedAt: existing?.connectedAt || now,
      lastSeenAt: now,
    };
    store.runtimes[id] = entry;
    return { ...entry };
  });
}

export function touch(id) {
  mutateStore(FILE, { ...EMPTY }, (store) => {
    const entry = store.runtimes[id];
    if (entry) entry.lastSeenAt = new Date().toISOString();
  });
}

export function unregister(id) {
  mutateStore(FILE, { ...EMPTY }, (store) => {
    delete store.runtimes[id];
  });
}

export function list() {
  // Prune stale entries on read, persisting the pruned set so a server that
  // never registers anyone still ages out departed runtimes.
  const cutoff = Date.now() - HEARTBEAT_STALE_MS;
  return mutateStore(FILE, { ...EMPTY }, (store) => {
    for (const [id, entry] of Object.entries(store.runtimes)) {
      if (new Date(entry.lastSeenAt).getTime() < cutoff) delete store.runtimes[id];
    }
    return Object.values(store.runtimes).map(r => ({
      id: r.id,
      label: r.label,
      connected: true,
      transport: r.transport,
      agentId: r.agentId,
      connectedAt: r.connectedAt,
    }));
  });
}

// Exposed for tests / introspection without the prune-write side effect.
export function peek() {
  const store = readStore(FILE, { ...EMPTY });
  return Object.values(store.runtimes);
}
