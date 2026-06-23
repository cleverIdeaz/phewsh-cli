// Disk-backed dispatch queue. The web app POSTs /dispatch → we enqueue a job
// and return a jobId. The web app polls /status/:jobId. When a connected
// harness completes the task (via stdio's phewsh_complete_task, or via HTTP
// /jobs/:id/complete), the matching job resolves.
//
// State lives in ~/.phewsh/bridge/jobs.json so the stdio transport (which the
// harness speaks to) and the HTTP transport (which the web speaks to) — two
// separate processes — see the same queue. See ./store.js for why.
//
// Phase 3 will move this to Supabase for multi-device + audit history.

import { randomUUID } from "crypto";
import { readStore, writeStore, mutateStore } from "./store.js";

const FILE = "jobs.json";
const EMPTY = { jobs: {} }; // jobId -> Job

const MAX_HISTORY = 200;
const TERMINAL_LINGER_MS = 5 * 60_000; // keep terminal jobs visible to slow pollers

/**
 * @typedef {object} Job
 * @property {string} jobId
 * @property {string} actionId
 * @property {string|null} runtimeId
 * @property {object} packet
 * @property {"queued"|"executing"|"done"|"error"} status
 * @property {string} [statusText]
 * @property {number} [progress]
 * @property {string} [result]
 * @property {string} [error]
 * @property {string} createdAt
 * @property {string} updatedAt
 */

function prune(store) {
  const ids = Object.keys(store.jobs);
  if (ids.length <= MAX_HISTORY) return;
  const cutoff = Date.now() - TERMINAL_LINGER_MS;
  for (const id of ids) {
    const job = store.jobs[id];
    const terminal = job.status === "done" || job.status === "error";
    if (terminal && new Date(job.updatedAt).getTime() < cutoff) {
      delete store.jobs[id];
    }
    if (Object.keys(store.jobs).length <= MAX_HISTORY) return;
  }
}

export function enqueue({ actionId, runtimeId, packet }) {
  const jobId = randomUUID();
  const now = new Date().toISOString();
  /** @type {Job} */
  const job = {
    jobId,
    actionId: actionId || jobId,
    runtimeId: runtimeId || null,
    packet,
    status: "queued",
    statusText: "Queued for next runtime pickup",
    progress: 0,
    createdAt: now,
    updatedAt: now,
  };
  mutateStore(FILE, { ...EMPTY }, (store) => {
    store.jobs[jobId] = job;
    prune(store);
  });
  return job;
}

export function getStatus(jobId) {
  const store = readStore(FILE, { ...EMPTY });
  return store.jobs[jobId] || null;
}

export function getByTaskId(taskId) {
  const store = readStore(FILE, { ...EMPTY });
  return Object.values(store.jobs).find(j => j.packet?.id === taskId) || null;
}

export function updateStatus(jobId, patch) {
  return mutateStore(FILE, { ...EMPTY }, (store) => {
    const job = store.jobs[jobId];
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    return { ...job };
  });
}

export function markExecuting(jobId, runtimeId, statusText) {
  return updateStatus(jobId, {
    status: "executing",
    runtimeId: runtimeId || null,
    statusText: statusText || "Runtime picked up the job",
    progress: 25,
  });
}

export function complete(jobId, result) {
  return updateStatus(jobId, {
    status: "done",
    result: typeof result === "string" ? result : JSON.stringify(result, null, 2),
    statusText: "Complete",
    progress: 100,
  });
}

export function fail(jobId, error) {
  return updateStatus(jobId, {
    status: "error",
    error: error?.message || String(error),
    statusText: "Failed",
    progress: 100,
  });
}

/**
 * Resolve a job by its packet.id — used when stdio's phewsh_complete_task
 * fires and we want to mirror the result into the HTTP-side polling state.
 */
export function completeByTaskId(taskId, { success, result, issues }) {
  const job = getByTaskId(taskId);
  if (!job) return null;
  if (success) return complete(job.jobId, result);
  return fail(job.jobId, new Error(issues || result || "Task reported as failed"));
}

/**
 * The next queued job for a runtime — used by harnesses pulling work over
 * stdio (phewsh_next_task) or HTTP (/next). A job with no runtimeId is
 * claimable by anyone; a targeted job only by its runtime.
 */
export function nextForRuntime(runtimeId) {
  const store = readStore(FILE, { ...EMPTY });
  const ordered = Object.values(store.jobs).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const job of ordered) {
    if (job.status !== "queued") continue;
    if (job.runtimeId && job.runtimeId !== runtimeId) continue;
    return job;
  }
  return null;
}

export function list({ limit = 50, status } = {}) {
  const store = readStore(FILE, { ...EMPTY });
  const all = Object.values(store.jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const filtered = status ? all.filter(j => j.status === status) : all;
  return filtered.slice(0, limit);
}
