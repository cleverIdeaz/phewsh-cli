#!/usr/bin/env node

/**
 * PHEWSH MCP — HTTP transport. LEGACY / COMPATIBILITY INFRASTRUCTURE.
 *
 * STATUS: this transport predates the binding contract and is kept for
 * compatibility only. New work belongs on `phewsh serve`, which is the bound
 * execution path: it requires a paired host grant and a project-scoped grant,
 * resolves the project against the machine's own registry, re-verifies the live
 * git origin, binds a human-reviewed action contract, and pins the branch and
 * commit the run was approved against.
 *
 * This server has none of that and cannot acquire most of it: its project list
 * comes from `loadProjects()` — a cloud cache plus one project minted from the
 * server's own cwd — not from the machine registry, so there is no repository
 * path, no remote, and therefore no branch or HEAD to bind. What it CAN prove
 * is that a caller named an existing project exactly, and that is now required.
 *
 * It also does not execute anything. `./lib/dispatch-queue.js` imports no
 * child_process; a packet accepted here runs inside whichever harness polls
 * `/next`. Binding the identity is what keeps that harness able to check the
 * repository, branch, HEAD and authority for itself before it acts.
 *
 * `isAllowedRequest` is an Origin check. It is a browser boundary, never
 * authentication and never project authorization — see ../lib/cors.js.
 *
 * Exposes the coordination layer to the intent web app (and any other HTTP
 * client). Lives on 127.0.0.1:7483 by default — the same default port as
 * `phewsh serve` — matching what intent/app/src/lib/mcp-bridge.ts expects.
 *
 * Endpoints:
 *   GET  /health           → { status, runtimes, version }
 *   POST /dispatch         → enqueue a packet against an EXACT projectId,
 *                            returns { jobId, status, projectId }
 *   GET  /status/:jobId    → polling endpoint for job state
 *   GET  /result/:jobId    → final result (kept after done for grace period)
 *   GET  /jobs             → list recent dispatches (for /mcp web page)
 *   GET  /receipts         → merged proof trail: sessions + results + jobs
 *   GET  /next?runtime=X   → HTTP harness: pull next job for a runtime
 *   POST /jobs/:id/complete → HTTP harness: report completion
 *
 * Shares all storage logic with the stdio transport via ./lib/handlers.js
 * and ./lib/dispatch-queue.js — both transports see the same projects,
 * sessions, results, and dispatch queue.
 */

import { createServer } from "http";
import { URL } from "url";

import { readFileSync } from "fs";
import { join } from "path";
import corsPolicy from "../lib/cors.js";
import receiptsData from "../lib/receipts-data.js";

import {
  loadProjects, recordResult, recordSession, updateLocalStatusMd,
} from "./lib/handlers.js";
import { resolveExactProject, McpProjectError } from "./lib/resolve-project.js";
import * as runtimes from "./lib/runtime-registry.js";
import * as queue from "./lib/dispatch-queue.js";

const { corsHeaders, isAllowedRequest } = corsPolicy;
const { gatherReceipts } = receiptsData;

// Version comes from the phewsh package this server ships inside — never hardcode it.
const VERSION = (() => {
  try {
    const pkgPath = join(new URL(".", import.meta.url).pathname, "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const DEFAULT_PORT = 7483;
const DEFAULT_HOST = "127.0.0.1";

// ─── HTTP helpers ───────────────────────────────────────────────────────────

function json(req, res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsHeaders(req),
  });
  res.end(JSON.stringify(body));
}

function text(req, res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain", ...corsHeaders(req) });
  res.end(body);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = "";
    req.on("data", c => { chunks += c; if (chunks.length > 1_000_000) reject(new Error("Body too large")); });
    req.on("end", () => {
      if (!chunks) return resolve({});
      try { resolve(JSON.parse(chunks)); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

// ─── Route handlers ─────────────────────────────────────────────────────────

function handleHealth(req, res) {
  const connected = runtimes.list();
  json(req, res, 200, {
    status: "ok",
    runtimes: connected,
    version: VERSION,
    projects: loadProjects().length,
  });
}

async function handleDispatch(req, res) {
  try {
    const body = await readJsonBody(req);

    // BINDING FIRST, before shape validation and before anything is queued.
    //
    // This endpoint used to accept an executable packet that named no project
    // at all, and file the result under the literal string "web". An executable
    // request without a project identity is not a valid Phewsh request, so the
    // refusal is deliberate and breaking rather than a compatibility shim.
    //
    // `project_id` is accepted alongside `projectId` because the MCP tool
    // surface is snake_case while this transport is camelCase. Both resolve
    // through the SAME rule — an alias is a spelling, never a second gate.
    let project;
    try {
      project = resolveExactProject(loadProjects(), body.projectId ?? body.project_id);
    } catch (err) {
      if (err instanceof McpProjectError) {
        return json(req, res, err.status || 400, { error: err.message });
      }
      throw err;
    }

    if (!body.packet || !body.packet.objective) {
      return json(req, res, 400, { error: "Missing packet.objective" });
    }

    // Auto-register the target runtime as "expected" so /health reflects
    // pending work even if the harness hasn't pinged in yet.
    if (body.runtimeId) {
      runtimes.register({
        id: body.runtimeId,
        label: body.runtimeId,
        transport: "expected",
      });
    }

    const job = queue.enqueue({
      actionId: body.actionId,
      runtimeId: body.runtimeId || null,
      packet: body.packet,
      // The RESOLVED id, never the string the caller sent. Everything after
      // this point reads the project from the job.
      projectId: project.id,
    });

    // Filed under the project that was actually resolved. "web" told a reader
    // nothing except that an HTTP client was involved.
    recordSession(body.runtimeId || "web", project.id, "dispatch_enqueued", {
      jobId: job.jobId,
      actionId: job.actionId,
      boundProjectId: project.id,
      taskSummary: body.packet?.objective?.task?.slice(0, 120),
    });

    json(req, res, 200, { jobId: job.jobId, status: job.status, projectId: project.id });
  } catch (err) {
    json(req, res, 400, { error: err.message });
  }
}

function handleStatus(req, res, jobId) {
  const job = queue.getStatus(jobId);
  if (!job) return json(req, res, 404, { error: "Job not found" });
  const { packet, ...rest } = job;
  json(req, res, 200, rest);
}

function handleResult(req, res, jobId) {
  const job = queue.getStatus(jobId);
  if (!job) return json(req, res, 404, { error: "Job not found" });
  if (job.status !== "done" && job.status !== "error") {
    return json(req, res, 202, { status: job.status, message: "Job not yet complete" });
  }
  json(req, res, 200, {
    jobId: job.jobId,
    status: job.status,
    result: job.result,
    error: job.error,
    completedAt: job.updatedAt,
  });
}

function handleReceipts(req, res, url) {
  // The web gets the same merged trail, but handoff events are deliberately
  // redacted to counts/verdicts/routes. Full paths and hashes stay in the 0600
  // local receipt and are available only through the local CLI.
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
  const projectFilter = url.searchParams.get("project") || null;
  const kindFilter = url.searchParams.get("kind") || null;
  json(req, res, 200, gatherReceipts({ project: projectFilter, kind: kindFilter, limit, publicView: true, cwd: process.cwd() }));
}

function handleJobsList(req, res, url) {
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
  const statusFilter = url.searchParams.get("status") || undefined;
  const jobs = queue.list({ limit, status: statusFilter }).map(j => {
    const { packet, ...rest } = j;
    return {
      ...rest,
      summary: packet?.objective?.task?.slice(0, 140) || null,
    };
  });
  json(req, res, 200, { jobs });
}

function handleNextForRuntime(req, res, url) {
  const runtimeId = url.searchParams.get("runtime") || req.headers["x-phewsh-runtime"];
  if (!runtimeId) return json(req, res, 400, { error: "Missing ?runtime= or X-Phewsh-Runtime header" });

  runtimes.register({ id: runtimeId, label: runtimeId, transport: "http" });

  const job = queue.nextForRuntime(runtimeId);
  if (!job) return json(req, res, 204, null);

  queue.markExecuting(job.jobId, runtimeId, "Picked up by HTTP harness");
  json(req, res, 200, { jobId: job.jobId, actionId: job.actionId, packet: job.packet });
}

async function handleJobComplete(req, res, jobId) {
  try {
    const body = await readJsonBody(req);
    const { success = true, result = "", issues, agentId, projectId } = body;

    const job = queue.getStatus(jobId);
    if (!job) return json(req, res, 404, { error: "Job not found" });

    // The identity comes from the JOB, never from the completion body.
    //
    // A binding is only worth as much as its last consumer. This handler used
    // to file evidence under whatever `projectId` the reporter sent (or "web"),
    // so a run bound to A could be recorded against B by whoever reported it
    // finished — the same substitution the dispatch gate now refuses, one step
    // later. A body that names a DIFFERENT project is a conflict a human should
    // see, not something to quietly overwrite.
    const boundProjectId = job.projectId || null;
    if (projectId && boundProjectId && projectId !== boundProjectId) {
      return json(req, res, 409, {
        error: "That completion names a different project than the job was bound to.",
      });
    }
    if (!boundProjectId) {
      // Only reachable for a job queued before this endpoint required a
      // binding. Untraceable evidence is worse than a refused report.
      return json(req, res, 409, {
        error: "That job carries no project binding and predates this contract. Dispatch it again.",
      });
    }

    const updated = success
      ? queue.complete(jobId, result)
      : queue.fail(jobId, new Error(issues || result || "Failed"));

    recordResult({
      projectId: boundProjectId,
      taskId: job.packet?.id || jobId,
      result,
      success,
      issues,
      agentId,
      reportedAt: new Date().toISOString(),
    });

    recordSession(agentId, boundProjectId, "task_complete", {
      taskId: job.packet?.id || jobId,
      boundProjectId,
      success,
      result: result?.slice(0, 200),
    });

    if (boundProjectId === "local") {
      // Resolved from the JOB's bound id, not from the reporter — and passed as
      // a resolved project, so the write is gated on identity rather than on a
      // string comparison against a magic name.
      try {
        updateLocalStatusMd(
          resolveExactProject(loadProjects(), boundProjectId),
          success, (result || "").split("\n")[0] || "Task completed", agentId,
        );
      } catch (error) {
        if (!(error instanceof McpProjectError)) throw error;
      }
    }

    if (agentId) runtimes.touch(agentId);

    json(req, res, 200, { jobId, status: updated.status });
  } catch (err) {
    json(req, res, 400, { error: err.message });
  }
}

// ─── Server ─────────────────────────────────────────────────────────────────

export function startHttpServer({ port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
  const server = createServer(async (req, res) => {
    if (!isAllowedRequest(req)) {
      return json(req, res, 403, { error: "Origin not allowed" });
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;

    try {
      if (req.method === "GET" && pathname === "/health") return handleHealth(req, res);
      if (req.method === "POST" && pathname === "/dispatch") return await handleDispatch(req, res);
      if (req.method === "GET" && pathname.startsWith("/status/")) {
        const jobId = pathname.slice("/status/".length);
        return handleStatus(req, res, jobId);
      }
      if (req.method === "GET" && pathname.startsWith("/result/")) {
        const jobId = pathname.slice("/result/".length);
        return handleResult(req, res, jobId);
      }
      if (req.method === "GET" && pathname === "/jobs") return handleJobsList(req, res, url);
      if (req.method === "GET" && pathname === "/receipts") return handleReceipts(req, res, url);
      if (req.method === "GET" && pathname === "/next") return handleNextForRuntime(req, res, url);
      if (req.method === "POST" && pathname.match(/^\/jobs\/[^/]+\/complete$/)) {
        const jobId = pathname.split("/")[2];
        return await handleJobComplete(req, res, jobId);
      }
      if (req.method === "GET" && pathname === "/") {
        return text(req, res, 200, `PHEWSH MCP HTTP transport v${VERSION}\nEndpoints: /health /dispatch /status/:id /result/:id /jobs /receipts /next /jobs/:id/complete\n`);
      }
      return json(req, res, 404, { error: `No route for ${req.method} ${pathname}` });
    } catch (err) {
      console.error("[http]", err);
      return json(req, res, 500, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} already in use. Stop the other process or set PHEWSH_MCP_PORT.`));
      } else reject(err);
    });
    server.listen(port, host, () => {
      console.log(`PHEWSH MCP HTTP transport listening on http://${host}:${port}`);

      // Browsers resolve "localhost" to ::1 first on dual-stack machines, so
      // an IPv4-only listener gets shadowed by any stale process on the IPv6
      // side. Mirror onto ::1 (still loopback-only) so the web app always
      // reaches THIS server. Best effort — no IPv6 is fine.
      if (host === DEFAULT_HOST) {
        const mirror = createServer((req, res) => server.emit("request", req, res));
        mirror.on("error", () => { /* ::1 unavailable or taken — IPv4 still serves */ });
        mirror.listen(port, "::1");
      }

      resolve(server);
    });
  });
}

// Run directly when invoked as a script.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.PHEWSH_MCP_PORT || `${DEFAULT_PORT}`, 10);
  const host = process.env.PHEWSH_MCP_HOST || DEFAULT_HOST;
  startHttpServer({ port, host }).catch((err) => {
    console.error("Failed to start HTTP transport:", err.message);
    process.exit(1);
  });
}
