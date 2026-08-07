// phewsh serve — HTTP bridge server for live execution from the web UI
//
// Starts a local server that the PHEWSH web app connects to for live task
// execution. When running, the web UI shows a green "Live" indicator and
// "Run Live" buttons for every agent CLI installed on this machine —
// Claude Code, Codex, Gemini, Cursor Agent, OpenCode. PHEWSH is not a
// harness; it dispatches to the harnesses you already have, and every run
// leaves a receipt (~/.phewsh/ — see `phewsh receipts`).
//
// Usage:
//   phewsh serve              Start on default port (7483)
//   phewsh serve --port 8080  Start on custom port

const http = require('http');
const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { corsHeaders, isAllowedRequest, requestOrigin } = require('../lib/cors');
const { createGrantStore, GrantError } = require('../lib/capability-grants');
// The job-state contract. Translation lives at the boundary, not in the job
// records themselves, so serve.js keeps its own vocabulary. See lib/worker-state.js.
const workerState = require('../lib/worker-state');
const configFile = require('../lib/config-file');
const { containedPath } = require('../lib/truth-path');
const { boundedAppend } = require('../lib/bounded-output');

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const g = (s) => `\x1b[90m${s}\x1b[0m`;
const w = (s) => `\x1b[97m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

// ─── Configuration ─────────────────────────────────────────────────────────

function getPort() {
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return 7483;
}

// The project this worker serves = the directory it was started in. The
// normalized origin remote is the identity the claim path already verifies
// against (task.js repo-match); name alone is display, remote is truth.
function currentProject() {
  let remote = null;
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || null;
  } catch { /* not a git repo, or no origin — worker still serves the directory */ }
  return { name: path.basename(process.cwd()), remote };
}

// ─── Runtime Detection ─────────────────────────────────────────────────────

// Harness runners — shared table in lib/harnesses.js. PHEWSH is not a
// harness; it's the layer that dispatches to whichever harnesses you have.
// Detection is honest: a runtime is only "connected" if its binary is on PATH.
const { HARNESSES: RUNNERS, listHarnesses, harnessCapabilities } = require('../lib/harnesses');
const { resolveLocalClaim, resolveRunTarget, claimCommand, LocalClaimError, linkedCloudProjectId } = require('../lib/local-claim');

function detectRuntimes() {
  // Runtime discovery for every surface (.intent/architecture.md §"Capability
  // discovery"), so a shell need not keep its own harness list. For harnesses,
  // presence IS installation, so `connected` mirrors `installed` — the alias
  // existing web/Desktop readers have always used.
  const runtimes = harnessCapabilities().map((h) => ({ ...h, connected: h.installed }));

  // Two routes that are not harnesses. They carry ONLY what this node can
  // stand behind: it knows it will not execute either one (`headless: false`,
  // enforced above), and whether the route exists at all. Everything else —
  // `installed`, `models`, `briefing`, `auth`, `install` — is deliberately
  // ABSENT rather than false, because absent means "this node does not
  // assert it" and false would be a claim. `generic` in particular is a
  // browser-side inline route the node cannot observe: it does accept a model
  // preference, so reporting `models: false` here would be wrong.
  runtimes.push({
    id: 'human', label: 'You', role: 'decides & does',
    bestFor: 'judgment, approval, anything a machine should not decide',
    connected: true, headless: false,
  });
  runtimes.push({
    id: 'generic', label: 'AI Draft', role: 'drafts inline',
    bestFor: 'inline drafting in the browser, not on this machine',
    connected: false, headless: false,
  });

  return runtimes;
}

// ─── Job Queue ─────────────────────────────────────────────────────────────

const { gatherReceipts, recordSessionEvent, recordResultFile, recordRunReceipt, readRunReceipt, listRunReceipts } = require('../lib/receipts-data');
const { buildRunReceipt, observedChanges, gitStatusMap } = require('../lib/run-receipt');
const { buildClosureProposal, applyClosure, ClosureError } = require('../lib/closure');
const {
  buildActionContract,
  buildClaimContract,
  assertClaimUnchanged,
  claimExecutionDigest,
  captureCheckout,
  assertCheckoutUnmoved,
  executableInstructions,
  executionDigest,
} = require('../lib/action-contract');
const { serveProjects, projectId } = require('../lib/projects-index');
// The same writer `phewsh intent --init` uses. One definition of what project
// truth is, reached through two doors.
const { createPPS, writeGuardedViews } = require('../lib/pps');

const jobs = new Map();
const claimRuns = new Map();

// Proposals the ENGINE prepared, held by id. `/closure/decide` names one of
// these and never carries its own: the critic showed that trusting a
// client-supplied proposal let a caller skip the preview entirely and append
// any line it liked to decisions.md — including a claim that checks passed.
const closureProposals = new Map(); // proposalId → { proposal, projectId, createdAt }
const configuredProposalTtl = Number(process.env.PHEWSH_PROPOSAL_TTL_MS);
const PROPOSAL_TTL_MS = Number.isFinite(configuredProposalTtl) && configuredProposalTtl > 0
  ? configuredProposalTtl : 60 * 60 * 1000;

// Contracts the ENGINE composed, held by id, for exactly the same reason. A
// caller reviews one and then names it; it never sends one back.
const actionContracts = new Map(); // contractId → { contract, projectId, createdAt }
const configuredContractTtl = Number(process.env.PHEWSH_CONTRACT_TTL_MS);
const CONTRACT_TTL_MS = Number.isFinite(configuredContractTtl) && configuredContractTtl > 0
  ? configuredContractTtl : 30 * 60 * 1000;

function liveHeldEntry(store, id, ttlMs) {
  const held = store.get(id);
  if (!held) return null;
  if (Date.now() - held.createdAt <= ttlMs) return held;
  store.delete(id);
  return null;
}

function rememberContract(contract, projectId) {
  const contractId = crypto.randomBytes(12).toString('hex');
  actionContracts.set(contractId, { contract, projectId, createdAt: Date.now() });
  for (const [id, entry] of actionContracts) {
    if (Date.now() - entry.createdAt > CONTRACT_TTL_MS) actionContracts.delete(id);
  }
  return { contractId, contract };
}

/**
 * Refuse without publishing an internal failure's text.
 *
 * Errors the engine AUTHORED carry a `.status` and a message written for a person
 * to read. Anything else is an internal failure whose text is not ours to hand out:
 * an independent critic pulled the absolute repository path and this node's PID out
 * of a raw `fs` ENOENT here, while two sibling endpoints deliberately withhold
 * absolute paths. The detail still reaches the operator's own terminal, which is
 * the one place it belongs.
 */
function refuseSafely(req, res, error, where) {
  if (typeof error?.status === 'number') {
    return json(req, res, { error: error.message }, error.status);
  }
  console.log(`  ${yellow('\u2717')} ${where} failed: ${error?.message || error}`);
  return json(req, res, { error: 'That request could not be completed on this machine.' }, 500);
}

function rememberProposal(proposal, projectId) {
  // A proposalId is DERIVED from the receipt, the note and the baseline, so an
  // identical review produces an identical id. Overwriting the entry threw the
  // recorded decision away with it, and one extra HTTP call reopened a settled
  // judgement: reject, preview again, accept, and the declined line went into the
  // Record with no second human gesture. A decided review stays decided — and
  // keeps its original createdAt, so re-previewing cannot extend its TTL either.
  const decided = closureProposals.get(proposal.proposalId);
  if (decided?.decision) return proposal;
  closureProposals.set(proposal.proposalId, { proposal, projectId, createdAt: Date.now() });
  // Bound the store; a review nobody acted on within the hour is stale anyway.
  for (const [id, entry] of closureProposals) {
    if (Date.now() - entry.createdAt > PROPOSAL_TTL_MS) closureProposals.delete(id);
  }
  return proposal;
}

/**
 * Registered projects, each carrying its stable id. One list behind both what
 * `/health` publishes and what a dispatch resolves against, so a browser can
 * never be offered a project the run path would not accept.
 */
function registeredProjects() {
  return serveProjects().map((p) => ({ ...p, id: projectId(p.path) }));
}

/**
 * The single project-grant use gate.
 *
 * A project token binds a root + registered remote, not merely a path-derived
 * handle. Every endpoint that reads, runs, controls, or records work comes
 * through here so a repo re-pointed at the same path invalidates the grant
 * everywhere at once.
 */
function requireLiveProject(req, { projectId: wantedId, scope } = {}) {
  let project = null;
  const grant = grants.requireProject(projectToken(req), {
    projectId: wantedId,
    scope,
    ...callerOf(req),
    revalidate: (id) => {
      project = resolveRunTarget(id, registeredProjects());
      return project;
    },
  });
  return { grant, project };
}

function createJob(actionId, runtimeId, packet, project = null) {
  const jobId = crypto.randomUUID();
  jobs.set(jobId, {
    jobId,
    actionId,
    runtimeId,
    packet,
    // The resolved project this run is bound to, or null for an unbound
    // legacy dispatch that runs in the worker's own directory. Everything
    // downstream — working directory, evidence, receipt — reads it from here,
    // so a run cannot drift onto a different repo between steps.
    project,
    status: 'queued',
    statusText: 'Queued — waiting to execute',
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
  });
  // Work executed here must leave the same paper trail as the MCP path —
  // otherwise `phewsh receipts` has a blind spot for exactly the headline flow.
  // Evidence is filed under the project that ran: a run nobody can trace back
  // to a repository is not evidence.
  // NOTE the key: `projectId` is the receipt layer's existing grouping field
  // and holds the project NAME (receipts-data collectSessions reads it as
  // `project`). The stable id rides alongside as `boundProjectId` — writing it
  // over `projectId` would make these events unfindable by project.
  recordSessionEvent(runtimeId || 'web', project?.name || 'web', 'dispatch_enqueued', {
    jobId,
    actionId,
    boundProjectId: project?.id || null,
    boundProjectRemote: project?.remote || null,
    taskSummary: packet?.objective?.task?.slice(0, 120),
  });
  return jobId;
}

/**
 * Write the run's receipt — once, at its terminal state.
 *
 * Only what was observed: the tree delta around the run, timings, the route,
 * the contract the human reviewed, and integrity data for the output. The
 * output TEXT is deliberately not carried; it is the model's own account and
 * belongs in the result file, not in evidence.
 */
function writeRunReceipt(job, runner, treeBefore) {
  try {
    if (!job.project) return null; // unbound legacy dispatch — nothing to bind evidence to
    const treeAfter = gitStatusMap(job.project.path);
    const output = job.status === 'done' ? String(job.result || '') : '';
    const receipt = buildRunReceipt({
      receiptId: `r-${job.jobId.replace(/-/g, '').slice(0, 16)}`,
      jobId: job.jobId,
      projectId: job.project.name,
      boundProjectId: job.project.id,
      boundProjectRemote: job.project.remote || null,
      runtimeId: job.runtimeId,
      runtimeLabel: runner?.label || job.runtimeId,
      startedAt: job.startedAt || job.createdAt,
      endedAt: new Date().toISOString(),
      status: job.status,
      // Did the CALLER choose this project, or is it just where the worker
      // happens to be? Both are real; conflating them is not.
      boundByCaller: job.project?.boundByCaller === true,
      contract: job.contract || null,
      // Null when either snapshot is missing, which buildRunReceipt renders as an
      // explicit unknown. Empty arrays here used to make an unobserved run read
      // as "no files changed" in Ion and in the Record — the opposite claim.
      changes: observedChanges(treeBefore, treeAfter, job.project?.path || null),
      output: {
        bytes: Buffer.byteLength(output),
        sha256: output ? crypto.createHash('sha256').update(output).digest('hex') : null,
        // The node caps what a harness may hold in memory. Say so, or the hash
        // and byte count present part of the output as all of it.
        truncated: job.outputTruncated === true,
      },
    });
    recordRunReceipt(receipt);
    job.receiptId = receipt.receiptId;
    return receipt;
  } catch {
    return null; // a receipt that cannot be written must not take the run down
  }
}

// How long a harness gets to stop politely before it is killed outright.
const configuredCancelGrace = Number(process.env.PHEWSH_CANCEL_GRACE_MS);
const CANCEL_GRACE_MS = Number.isFinite(configuredCancelGrace) && configuredCancelGrace > 0
  ? configuredCancelGrace : 5000;

/**
 * Stop a running harness, and mean it.
 *
 * Two failures this replaces. `kill('SIGTERM')` signalled only the DIRECT child,
 * so anything the harness spawned kept running as an orphan — and agent harnesses
 * spawn plenty. And there was no escalation, so a process that ignores SIGTERM was
 * never stopped at all while the API reported the run cancelled.
 *
 * The harness is spawned detached, which puts it in its own process group, so a
 * negative pid signals the whole group. `cancelled` is not written here: only the
 * `close` handler observes exit, and that is the only honest place to claim it.
 */
function stopJobProcess(job) {
  const child = job.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;

  const signal = (sig) => {
    // The group first; fall back to the lone child if it has no group of its own.
    try { process.kill(-pid, sig); return true; } catch { /* no group */ }
    try { child.kill(sig); return true; } catch { return false; }
  };

  signal('SIGTERM');
  if (job.killTimer) clearTimeout(job.killTimer);
  job.killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      job.statusText = 'Cancelling — forcing stop…';
      signal('SIGKILL');
    }
  }, CANCEL_GRACE_MS);
  // Never hold the node open just to wait out a grace period.
  if (typeof job.killTimer.unref === 'function') job.killTimer.unref();
}

/**
 * The ONE way a job reaches a terminal state.
 *
 * Every terminal path has to leave the same three artifacts — a result file, a
 * session event, and a run receipt — because a person looking for what happened
 * should never find a job that ended and no evidence that it did. Four paths did
 * not: an unsupported runtime and an interactive-only one returned bare, a spawn
 * failure resolved with nothing at all, and a cancelled run left a receipt and a
 * session event but no result file. Only the ordinary exit was complete.
 *
 * `treeBefore` may be null — a run that never started never observed a tree, and
 * that becomes an honest unknown rather than "nothing changed".
 */
function finalizeJob(job, runner, treeBefore, { packet, eventType = 'task_complete' } = {}) {
  // Exactly once per job. `error` and `close` can both fire for one spawn, and
  // two finalizations would double-count the run in the evidence a person reads.
  if (job.finalized) return null;
  job.finalized = true;

  const success = job.status === 'done';
  const taskId = packet?.id || job.actionId || job.jobId;
  const projectId = job.project?.name || 'web';
  const identity = {
    boundProjectId: job.project?.id || null,
    boundProjectRemote: job.project?.remote || null,
  };
  try {
    recordResultFile({
      // Same identity as the run itself — the enqueue, the working directory,
      // the cancel, and the outcome all name one project.
      projectId,
      ...identity,
      taskId,
      result: success ? job.result : job.error,
      success,
      agentId: job.runtimeId,
      executor: 'phewsh-serve',
      reportedAt: new Date().toISOString(),
    });
    recordSessionEvent(job.runtimeId, projectId, eventType, {
      taskId,
      ...identity,
      success,
      result: String((success ? job.result : job.error) || '').slice(0, 200),
    });
  } catch { /* evidence that cannot be written must not take the run down */ }
  return writeRunReceipt(job, runner, treeBefore);
}

async function executeJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = 'executing';
  job.statusText = 'Starting execution...';

  const { runtimeId, packet } = job;

  const runner = RUNNERS[runtimeId];
  if (!runner) {
    job.status = 'error';
    job.error = `Runtime ${runtimeId} not supported for live execution yet`;
    job.statusText = 'Unsupported runtime';
    // Contract review refuses a route this machine cannot run, so reaching here
    // means the two tables disagree. That is worth evidence, not a bare return:
    // the job exists and it ended.
    finalizeJob(job, null, null, { packet });
    return;
  }
  // `args: null` means we only know how to launch this harness interactively
  // (hermes, pi). Reaching spawn() with it would call null as a function and
  // take the whole node down with an unhandled rejection. This is the engine's
  // own guard — `headless` on /health only REPORTS it, and a surface filtering
  // on that field is a courtesy, never the boundary.
  if (!runner.args) {
    job.status = 'error';
    job.error = `${runner.label} is interactive-only here — start it yourself with \`phewsh work ${runtimeId}\``;
    job.statusText = 'Interactive-only runtime';
    finalizeJob(job, runner, null, { packet });
    return;
  }
  // An unbound job refuses instead of running in the worker's own directory.
  //
  // The job's path used to fall back to the worker's own working directory when
  // it was absent. One `createJob` caller made that unreachable, which is
  // exactly why it survived review — but unreachable today is one refactor from
  // reachable tomorrow, and its failure mode is a harness launched wherever the
  // worker happens to be standing. `test/cwd-authority.test.js` holds it gone.
  if (!job.project?.path) {
    job.status = 'error';
    job.error = 'This job is not bound to a project, so there is nowhere it may run.';
    job.statusText = 'Unbound job refused';
    finalizeJob(job, runner, null, { packet });
    return;
  }
  await executeViaHarness(job, packet, runner, job.project.path);
}

// Some harnesses (Claude Code) stream NDJSON events (--output-format
// stream-json). The web must see the model's actual answer and a readable live
// phase — not the raw event log. Plain-text harnesses (codex/gemini/cursor)
// fall through these helpers unchanged.
function parseStreamEvent(line) {
  const t = (line || '').trim();
  if (!t.startsWith('{')) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function streamPhase(evt) {
  if (!evt || typeof evt !== 'object' || !evt.type) return null;
  if (evt.type === 'result') return 'Finishing…';
  if (evt.type === 'assistant' || evt.type === 'stream_event') return 'Responding…';
  if (evt.type === 'user') return 'Running a step…';
  if (evt.type === 'system') return evt.subtype === 'status' ? 'Working…' : 'Starting…';
  // Any other recognized stream event — a readable phase, never raw JSON.
  return 'Working…';
}

// Returns { text, isError } from a stream-json transcript's final result event,
// or null when the output is not stream-json (leave it as-is).
function extractStreamResult(stdout) {
  let final = null;
  for (const line of String(stdout).split('\n')) {
    const evt = parseStreamEvent(line);
    if (evt && evt.type === 'result') final = evt;
  }
  if (!final) return null;
  return { text: typeof final.result === 'string' ? final.result : '', isError: Boolean(final.is_error) };
}

async function executeViaHarness(job, packet, runner, cwd) {
  const executable = executableInstructions(packet);
  // Build a prompt from the dispatch packet
  const prompt = [
    `# Task: ${executable.action || 'Execute task'}`,
    '',
    executable.action || '',
    '',
    executable.context ? `## Context\n${executable.context}` : '',
    '',
    executable.criteria.length
      ? `## Verify\n${executable.criteria.map(c => `- ${c}`).join('\n')}`
      : '',
    '',
    '## Instructions',
    'Execute this task and report the result. Be specific about what you did and what the outcome was.',
    'If the task involves code, show the relevant code. If it involves commands, show what you ran.',
  ].filter(Boolean).join('\n');

  // Observed before anything is launched: a tree that is already dirty must
  // never be billed to this run.
  const treeBefore = job.project?.path ? gitStatusMap(job.project.path) : null;
  job.startedAt = new Date().toISOString();

  return new Promise((resolve) => {
    job.statusText = `Launching ${runner.label}...`;

    const child = spawn(runner.bin, runner.args(prompt), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      // The resolved project's directory — never a path the caller sent, and
      // never "wherever the worker happened to be started" once a run is bound.
      cwd,
      // Its own process group, so a cancel can stop the harness AND whatever it
      // spawned. Signalling the direct child alone left orphans running in the
      // person's repository after the run was reported cancelled.
      detached: true,
    });
    // Keep a handle so an explicit human /cancel can stop this run.
    job.child = child;

    // Some harnesses (codex exec, gemini) wait for stdin EOF before running.
    child.stdin.end();

    // Bounded, because `+=` with no ceiling let a long-streaming or looping
    // harness grow this node's memory without limit. Truncation is reported, and
    // the produced byte count stays the real one, so a receipt cannot present a
    // shortened capture as the whole output.
    let out = null;
    let err = null;

    // The unfinished trailing line, carried between chunks. Re-splitting the WHOLE
    // accumulated buffer on every chunk was the other half of an O(n²) cost that
    // starved the event loop — and /cancel runs on that same loop.
    let tail = '';
    const MAX_TAIL = 64 * 1024;

    child.stdout.on('data', (data) => {
      const text = data.toString();
      out = boundedAppend(out, text);
      // Live status: a readable phase for stream-json harnesses, else the last
      // plain-text line. Never surface raw JSONL event noise to the web. Use the
      // last COMPLETE line so a mid-stream chunk boundary can't leak a fragment.
      const parts = (tail + text).split('\n');
      // Whatever follows the final newline is not a complete line yet.
      tail = parts.pop() ?? '';
      if (tail.length > MAX_TAIL) tail = tail.slice(-MAX_TAIL);
      const complete = parts.map((l) => l.trim()).filter(Boolean);
      if (complete.length > 0) {
        const lastLine = complete[complete.length - 1];
        const phase = streamPhase(parseStreamEvent(lastLine));
        job.statusText = phase || lastLine.slice(0, 80) || 'Working...';
      }
    });

    child.stderr.on('data', (data) => {
      err = boundedAppend(err, data.toString());
    });

    child.on('close', (code) => {
      const stdout = out ? out.text : '';
      const stderr = err ? err.text : '';
      job.outputTruncated = Boolean(out && out.truncated);
      job.outputBytes = out ? out.bytes : 0;
      // A human cancel already set the terminal state — record it and stop,
      // never relabel a cancelled run as a failure.
      // Exit is finally observed, so a requested cancel becomes a fact now — and
      // only now. `cancelling` is not terminal, which is the whole point.
      if (job.status === 'cancelling' || job.status === 'cancelled') {
        if (job.killTimer) { clearTimeout(job.killTimer); job.killTimer = null; }
        job.status = 'cancelled';
        job.statusText = 'Cancelled';
        console.log(`  ${yellow('■')} Job ${job.jobId.slice(0, 8)} cancelled by user`);
        // A cancelled run left the same three artifacts as any other terminal
        // state. It previously skipped the result file, so a cancelled run was
        // the one outcome with no result to point a person at.
        finalizeJob(job, runner, treeBefore, { packet, eventType: 'task_cancelled' });
        resolve();
        return;
      }
      // For stream-json harnesses, surface the model's actual answer (and honor
      // an in-band API error) instead of the raw event log.
      const streamed = extractStreamResult(stdout);
      if (streamed && streamed.isError) {
        job.status = 'error';
        job.error = streamed.text || `${runner.label} reported an error`;
        job.statusText = 'Failed';
        console.log(`  ${yellow('✗')} Job ${job.jobId.slice(0, 8)} failed: ${job.error.slice(0, 100)}`);
      } else if (code === 0 && stdout.trim()) {
        job.status = 'done';
        job.result = streamed ? (streamed.text || stdout.trim()) : stdout.trim();
        job.statusText = 'Complete';
        console.log(`  ${green('✓')} Job ${job.jobId.slice(0, 8)} completed`);
      } else {
        job.status = 'error';
        job.error = stderr.trim() || `${runner.label} exited with code ${code}`;
        job.statusText = 'Failed';
        console.log(`  ${yellow('✗')} Job ${job.jobId.slice(0, 8)} failed: ${job.error.slice(0, 100)}`);
      }
      // Leave a receipt: result file + session event, same shape as MCP path.
      finalizeJob(job, runner, treeBefore, { packet });
      resolve();
    });

    child.on('error', (err) => {
      job.status = 'error';
      job.error = err.message;
      job.statusText = 'Failed to start';
      console.log(`  ${yellow('✗')} Job ${job.jobId.slice(0, 8)} error: ${err.message}`);
      // A harness that never started is still a job that ended. This resolved
      // with no result file, no session event, and no receipt, so the run simply
      // vanished from the evidence.
      //
      // `close` may still fire after `error` for the same spawn, which is why
      // finalizeJob is guarded to run exactly once per job.
      finalizeJob(job, runner, treeBefore, { packet });
      resolve();
    });
  });
}

// The browser click starts the existing task-claim lifecycle in the repo that
// was resolved from a cloud id + explicit local registry entry + live origin.
// No task prompt or directory from the browser is ever used as an exec target.
const CLAIM_BIN = path.join(__dirname, '..', 'bin', 'phewsh.js');

/** Exactly what will be spawned — digested at review, re-digested before spend. */
const claimArgv = (claim) => claimCommand(CLAIM_BIN, claim);

function startLocalClaim(claim, contract, contractId) {
  const key = `${claim.projectId}:${claim.taskId}`;
  if (claimRuns.has(key)) throw new LocalClaimError('This task is already being claimed on this machine.', 409);

  const claimId = crypto.randomUUID();
  const child = spawn(process.execPath, claimArgv(claim), {
    cwd: claim.project.path,
    stdio: 'inherit',
    env: { ...process.env },
    windowsHide: true,
  });
  claimRuns.set(key, { claimId, child });
  // Filed under the project NAME — the receipt layer's grouping key, the same
  // convention `createJob` follows — with the stable ids alongside. This event
  // used to carry only claimId + taskId under the literal "ion", which made the
  // one route that starts a harness the one whose evidence named no repository.
  recordSessionEvent(claim.runtimeId || 'default-route', claim.project.name, 'local_claim_requested', {
    claimId,
    taskId: claim.taskId,
    contractId,
    boundProjectId: projectId(claim.project.path),
    boundProjectRemote: claim.project.remote || null,
    boundCloudProjectId: claim.projectId,
    boundBranch: contract.boundBranch,
    boundHead: contract.boundHead,
    boundWorkerId: contract.boundWorkerId,
    runtimeId: claim.runtimeId || null,
  });
  const finish = (message) => {
    claimRuns.delete(key);
    if (message) console.log(`  ${g(message)}`);
  };
  child.once('exit', (code) => finish(`Ion claim ${claim.taskId.slice(0, 8)} exited ${code}`));
  child.once('error', (error) => finish(`Ion claim ${claim.taskId.slice(0, 8)} could not start: ${error.message}`));
  return claimId;
}

// ─── HTTP Server ───────────────────────────────────────────────────────────

// A request body is buffered before any authorization can run, so it must be
// bounded. Unbounded, a single UNGRANTED request drove the node to 777 MB in a
// critic's probe — enough to OOM it and take every in-flight job's receipt with
// it. 2 MB is far more than any legitimate packet.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        const error = new Error('That request body is too large.');
        error.status = 413;
        req.destroy();
        reject(error);
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function cors(req, res) {
  for (const [name, value] of Object.entries(corsHeaders(req))) {
    res.setHeader(name, value);
  }
}

function json(req, res, data, status = 200) {
  cors(req, res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ─── Capability grants ──────────────────────────────────────────────────────
//
// One store per node instance. Everything it issues dies with this process.
const grants = createGrantStore({
  // A deliberately short TTL is how the tests observe expiry without a fake
  // clock. Unset in normal use, where the default 12h applies.
  // A non-numeric value used to yield NaN, making every comparison false and
  // every grant immortal — fail-open on a malformed operator input.
  ttlMs: (() => {
    const raw = parseInt(process.env.PHEWSH_GRANT_TTL_MS || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  })(),
});

/** Who is asking. The origin is the browser's claim; the client names itself. */
function callerOf(req) {
  return {
    origin: requestOrigin(req) || null,
    client: (typeof req.headers['x-phewsh-client'] === 'string' ? req.headers['x-phewsh-client'] : null),
  };
}

const hostToken = (req) => req.headers['x-phewsh-host-grant'];
const projectToken = (req) => req.headers['x-phewsh-project-grant'];

/**
 * Run a handler behind a grant check, turning a GrantError into its own status
 * instead of a generic 400. Returns true when it answered the request itself.
 */
function refuse(req, res, error) {
  const status = error && error.status ? error.status : 403;
  return json(req, res, { error: error && error.message ? error.message : 'Refused' }, status);
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('\n  phewsh serve — local execution bridge for phewsh.com/ion and phewsh.com/intent');
    console.log('    Runs a loopback server so the web workspace can dispatch to your');
    console.log('    installed agents. Stays running until you stop it (ctrl+c).');
    console.log('\n  Usage:  phewsh serve [--port <n>]   (default 7483)\n');
    return;
  }
  const port = getPort();
  const runtimes = detectRuntimes();
  const hasClaudeCode = runtimes.find(r => r.id === 'claude-code')?.connected;

  const handleRequest = async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (!isAllowedRequest(req)) {
      return json(req, res, { error: 'Origin not allowed' }, 403);
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
      cors(req, res);
      res.writeHead(204);
      res.end();
      return;
    }

    // Liveness and protocol ONLY.
    //
    // This used to enumerate every registered project with its remote, every
    // installed AI runtime, and the served project's name — to anyone who
    // asked. That was the discovery half of the bypass: a caller read a project
    // id here, then used it everywhere else. Discovery now needs a host grant.
    //
    // What stays is what a client genuinely cannot proceed without: is a node
    // here, does it speak my protocol, and do I already have a pairing.
    if (url.pathname === '/health' && req.method === 'GET') {
      let paired = false;
      try { grants.requireHost(hostToken(req), null, callerOf(req)); paired = true; } catch { /* not paired */ }
      return json(req, res, {
        status: 'ok',
        // The signature a real Phewsh node reports. Still only a shape claim —
        // it says "this speaks the protocol", never "this is trustworthy".
        phewsh: true,
        protocol: 1,
        node: { version: require('../package.json').version, instance: grants.nodeInstanceId },
        uptime: process.uptime(),
        paired,
      });
    }

    // ── Pairing: the one place authority enters the system ──────────────────
    //
    // Step one. The node prints a code for the human sitting in front of it.
    // The code is never returned over HTTP; that is the entire point.
    if (url.pathname === '/host/pair/request' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const caller = callerOf(req);
        const { pairingId, code, expiresAt } = grants.beginPairing({ ...caller, client: body?.client || caller.client });
        console.log('');
        console.log(`  ${cyan('▸')} ${b('A local app is asking to pair with this node.')}`);
        console.log(`    ${g('from')} ${w(caller.origin || 'a native client')}${body?.client ? g(` · ${body.client}`) : ''}`);
        console.log(`    ${g('approval code')}  ${b(green(code))}   ${g('(valid 2 minutes)')}`);
        console.log(`    ${g('Ignore this if you did not expect it — doing nothing denies it.')}`);
        console.log('');
        return json(req, res, { pairingId, expiresAt }, 202);
      } catch (error) {
        return refuse(req, res, error);
      }
    }

    // Step two. The human's code, from the same caller that asked.
    if (url.pathname === '/host/pair/complete' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const caller = callerOf(req);
        // Scopes are deliberately NOT read from the request: a pairing is worth
        // a fixed, human-comprehensible amount, never what the caller asks for.
        const issued = grants.completePairing({
          pairingId: body?.pairingId, code: body?.code, origin: caller.origin,
        });
        console.log(`  ${green('✓')} ${w('Paired')} ${g(caller.origin || 'native client')}`);
        return json(req, res, issued);
      } catch (error) {
        return refuse(req, res, error);
      }
    }

    // Registered-project discovery. Host grant only — and still no truth.
    if (url.pathname === '/host/projects' && req.method === 'GET') {
      try {
        grants.requireHost(hostToken(req), 'host:discover', callerOf(req));
      } catch (error) {
        return refuse(req, res, error);
      }
      return json(req, res, {
        projects: registeredProjects().map((p) => {
          const cloudProjectId = linkedCloudProjectId(p.path);
          // The stable id is the handle. The absolute path stays private.
          return { id: p.id, name: p.name, remote: p.remote, ...(cloudProjectId ? { cloudProjectId } : {}) };
        }),
        runtimes: detectRuntimes(),
      });
    }

    // Derive a project grant after an explicit project selection. The caller
    // names the project and the scopes it wants; the ENGINE resolves live
    // identity and decides. Asking for authority that does not exist is
    // refused, never rounded down.
    if (url.pathname === '/project/grant' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const issued = grants.issueProjectGrant({
          hostToken: hostToken(req),
          projectId: body?.projectId,
          scopes: body?.scopes,
          ...callerOf(req),
          resolve: (wanted) => resolveRunTarget(wanted, registeredProjects()),
        });
        if (issued.needsApproval) {
          // Anything that ACTS gets its own approval, and the human is shown
          // exactly which project and which powers — not just "an app wants to
          // pair". Pairing consented to discovery and reading; it never
          // consented to running a harness here or writing the Record.
          const { code, ...safe } = issued;
          console.log('');
          console.log(`  ${cyan('▸')} ${b('A local app is asking to ACT in a project.')}`);
          console.log(`    ${g('project')}  ${w(issued.project.name)}`);
          console.log(`    ${g('powers')}   ${w(issued.scopes.join(', '))}`);
          console.log(`    ${g('from')}     ${w(callerOf(req).origin || 'a native client')}`);
          console.log(`    ${g('approval code')}  ${b(green(code))}   ${g('(valid 2 minutes)')}`);
          console.log(`    ${g('Ignore this if you did not expect it — doing nothing denies it.')}`);
          console.log('');
          return json(req, res, safe, 202);
        }
        return json(req, res, issued);
      } catch (error) {
        return refuse(req, res, error);
      }
    }

    // Step two for an elevated grant: the code the person read off the node.
    if (url.pathname === '/project/grant/approve' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const issued = grants.completeScopeApproval({
          approvalId: body?.approvalId, code: body?.code,
          origin: callerOf(req).origin,
          resolve: (wanted) => resolveRunTarget(wanted, registeredProjects()),
        });
        console.log(`  ${green('✓')} ${w('Granted')} ${g(`${issued.scopes.join(', ')} in ${issued.name}`)}`);
        return json(req, res, issued);
      } catch (error) {
        return refuse(req, res, error);
      }
    }

    // Local-only workspace handshake.
    //
    // Ion may open WITHOUT a cloud sign-in only when it can prove it is talking
    // to a real local node bound to a deliberately registered repo. The browser
    // side of that proof must be unforgeable, so the caller supplies a fresh
    // nonce and we echo it: a cached response, a copied localStorage value, a
    // query parameter, or a fabricated client state cannot produce a matching
    // echo, because only a live node that received THIS nonce can return it.
    //
    // This grants no execution authority. It answers exactly one question:
    // "is there a verified local workspace here, and which one?"
    if (url.pathname === '/local-session' && req.method === 'POST') {
      // RETIRED. This issued a project-bound token to anyone who sent a nonce
      // from an allowlisted origin, which made the handshake look like
      // authorization while granting it for free. Authority now starts at
      // /host/pair/request, where a human reads a code off this terminal.
      //
      // It answers 410 rather than 404 so a stale client learns it is stale.
      return json(req, res, {
        error: 'The local handshake no longer issues authority. Pair with this node first: POST /host/pair/request, then approve the code shown on the node.',
        replacedBy: '/host/pair/request',
      }, 410);
    }

    // Local project truth, straight from the registered repo's .intent/.
    //
    // The engine owns project truth; Ion renders it. Requires the same exact
    // project id as the handshake, so a browser cannot read an arbitrary repo,
    // and returns Project/Next/Record only — Work stays derived, never stored.
    if (url.pathname === '/local-truth' && req.method === 'GET') {
      const wanted = (url.searchParams.get('projectId') || '').trim();
      // Project truth is a read of the user's own files. It requires a grant
      // that names THIS project and carries truth:read — previously it required
      // neither the session token nor the live-identity gate, so any allowlisted
      // origin could read Project, Next, and Record out of any registered repo.
      let hit;
      try {
        ({ project: hit } = requireLiveProject(req, {
          projectId: wanted,
          scope: 'truth:read',
        }));
      } catch (error) {
        return refuse(req, res, error);
      }
      if (!hit) return json(req, res, { error: 'No registered project with that id on this machine.' }, 404);
      // The grant names a repository, so truth must resolve inside it. A
      // symlinked `.intent` otherwise turned `truth:read` for one project into a
      // reader for wherever the link pointed.
      let intentDir;
      try {
        intentDir = containedPath(hit.path, '.intent');
      } catch (error) {
        return json(req, res, { error: error.message }, error.status || 403);
      }
      if (!fs.existsSync(intentDir)) {
        return json(req, res, {
          projectId: wanted, name: hit.name, intentPresent: false,
          // Said as a state, not as an instruction to go type something. The
          // surface can offer to ground it with POST /ground; a person should
          // not have to leave the room to answer two questions about their own
          // project.
          reason: 'This project has no recorded truth yet.',
          groundable: true,
        });
      }
      // Each file re-checked too: a contained `.intent` can still hold a file
      // that is itself a link out.
      const read = (file) => {
        try { return fs.readFileSync(containedPath(hit.path, '.intent', file), 'utf-8'); } catch { return null; }
      };
      // YAML frontmatter is file metadata, not what the project is trying to
      // do. Stripping it here means every surface renders Project the same way
      // instead of each one remembering to.
      const prose = (text) => {
        if (!text || !text.startsWith('---')) return text;
        const end = text.indexOf('\n---', 3);
        return end === -1 ? text : text.slice(end + 4).replace(/^\n+/, '');
      };
      let next = null;
      try {
        const raw = read('next.json');
        if (raw) {
          const parsed = JSON.parse(raw);
          const items = Array.isArray(parsed?.items) ? parsed.items : [];
          const current = items.find(i => i?.state === 'now') || items.find(i => i?.state === 'next') || null;
          next = current ? {
            id: current.id || null,
            title: current.title || null,
            state: current.state || null,
            criteria: (Array.isArray(current.criteria) ? current.criteria : [])
              .filter(c => c?.accepted !== false && c?.expected)
              .map(c => ({ expected: c.expected, type: c.type || 'measurable' })),
          } : null;
        }
      } catch { next = null; }
      // Record: newest first, bounded. The file stays the source of truth.
      const decisionsRaw = read('decisions.md') || '';
      const entries = decisionsRaw.split('\n')
        .map(l => l.trim())
        .filter(l => /^-\s+\d{4}-\d{2}-\d{2}\s/.test(l));
      return json(req, res, {
        projectId: wanted,
        name: hit.name,
        remote: hit.remote || null,
        intentPresent: true,
        vision: prose(read('vision.md')),
        next,
        record: { total: entries.length, recent: entries.slice(-10).reverse() },
        // How far the recorded truth has fallen behind the code.
        //
        // `phewsh status` has always measured this and no other surface ever
        // received it, so a room could show a project's north star in full
        // confidence while the work had moved a long way past it. That is the
        // accountability half of the promise: noticing when the record stops
        // keeping up. It is a plain number a surface renders as a risk — never
        // a command to go and run. 0 covers "in step", "not a repo", and
        // "`.intent/` has uncommitted edits", which are all "nothing to warn
        // about right now".
        driftCommits: (() => {
          try { return require('../lib/selfheal').commitsSinceIntent(hit.path); } catch { return 0; }
        })(),
        source: '.intent/ on this device',
        readAt: new Date().toISOString(),
      });
    }

    // One run's receipt, straight off disk — so it survives a node restart and
    // reads identically in the CLI and in Ion. Immutable: there is no write here.
    if (url.pathname === '/receipt' && req.method === 'GET') {
      // Authorization first: looking the receipt up before checking made this
      // an existence oracle (404 for unknown, 401 for real), which is the
      // opposite of what its sibling /receipts/run does five lines below.
      let holder;
      try {
        ({ grant: holder } = requireLiveProject(req, { scope: 'truth:read' }));
      } catch (error) {
        return refuse(req, res, error);
      }
      const receipt = readRunReceipt((url.searchParams.get('id') || '').trim());
      if (!receipt) return json(req, res, { error: 'No receipt with that id on this machine.' }, 404);
      // A receipt with no binding is readable by NOBODY rather than everybody:
      // `requireProject` skips its binding check on a falsy id, so an unbound
      // receipt used to satisfy any grant at all.
      if (!receipt.boundProjectId || receipt.boundProjectId !== holder.projectId) {
        return json(req, res, { error: 'That receipt belongs to a different project.' }, 403);
      }
      // New receipts bind the normalized remote as well as the path-derived
      // local handle. Legacy receipts remain explicitly readable by id, but
      // are labelled by the reader and cannot enter current-project lists or
      // closure because they cannot prove which repo occupied that path.
      if (receipt.boundProjectRemote
        && receipt.boundProjectRemote !== holder.remote) {
        return json(req, res, { error: 'That receipt belongs to a different project identity.' }, 403);
      }
      return json(req, res, receipt);
    }

    // Receipts for one bound project, newest first.
    if (url.pathname === '/receipts/run' && req.method === 'GET') {
      const wanted = (url.searchParams.get('projectId') || '').trim();
      let target;
      try {
        // The grant is checked BEFORE resolution, so an ungranted caller cannot
        // use this endpoint's error codes to probe which ids are registered.
        ({ project: target } = requireLiveProject(req, {
          projectId: wanted,
          scope: 'truth:read',
        }));
      } catch (error) {
        return refuse(req, res, error);
      }
      // Filtered by the STABLE id, not the display name: two registered repos
      // can share a basename, and receipts must never cross between them.
      return json(req, res, {
        receipts: listRunReceipts({
          boundProjectId: target.id,
          boundProjectRemote: target.remote,
        }),
      });
    }

    // Ground a project — the second promise, from wherever the person already is.
    //
    // Ion could show a registered repo with no `.intent/` and had exactly one
    // thing to say about it: "run `phewsh intent --init` in that repository."
    // That is a copied terminal instruction standing in the middle of the
    // product's own Level 2, and it is the most common first-run dead end there
    // is. The engine simply had no endpoint for it.
    //
    // This is NOT a second definition of project truth. `phewsh intent --init`
    // asks the same two questions and hands the same two answers to the same
    // writer; both doors call `createPPS` + `writeGuardedViews`, which own what
    // `.intent/` is and carry the truth guard. Implement once, expose everywhere.
    if (url.pathname === '/ground' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        // Writing project truth needs a writing grant. `truth:read` buys the
        // right to LOOK at a project and must never buy the right to author it.
        const { project: target } = requireLiveProject(req, {
          projectId: body?.projectId,
          scope: 'record:write',
        });
        // Resolved inside the granted repository, same containment rule
        // `/local-truth` uses: a symlinked `.intent` must not turn a grant for
        // one project into a writer for wherever the link points.
        const intentDir = containedPath(target.path, '.intent');

        // Already grounded is a conflict, not an overwrite. A person's recorded
        // truth is the one thing this endpoint must never replace.
        const grounded = fs.existsSync(path.join(intentDir, 'vision.md'))
          && fs.existsSync(path.join(intentDir, 'plan.md'));
        if (grounded) {
          return json(req, res, {
            error: 'This project already has recorded truth. Change it in the project rather than grounding it again.',
          }, 409);
        }

        const what = String(body?.what ?? '').trim().slice(0, 2000);
        const goal = String(body?.goal ?? '').trim().slice(0, 2000);
        const pps = createPPS({
          entity: target.name,
          archetype: 'product',
          raw: [what, goal].filter(Boolean).join(' '),
          intent: {
            goal: what,
            success_criteria: goal ? [goal] : [],
            constraints: [], inputs: [], outputs: [],
            // The same starter tasks `phewsh intent --init` writes. A grounded
            // project should never open onto an empty Next.
            tasks: [
              { text: 'Refine the vision — complete vision.md', type: 'do' },
              { text: 'Define Phase 1 — what is the smallest thing to ship?', type: 'do' },
              { text: 'Identify the first blocker', type: 'do' },
            ],
          },
        });
        // The writer's own guard: a partial `.intent/` holding a hand-authored
        // file slips past the check above, and that file is not ours to replace.
        const { written, preserved } = writeGuardedViews(intentDir, pps);
        console.log(`  ${cyan('→')} Grounded ${target.name}${preserved.length ? ` (kept ${preserved.join(', ')})` : ''}`);
        return json(req, res, {
          project: { id: target.id, name: target.name },
          written,
          preserved,
        });
      } catch (error) {
        if (error instanceof GrantError) return refuse(req, res, error);
        return refuseSafely(req, res, error, url.pathname);
      }
    }

    // The authority contract for a proposed run.
    //
    // The ENGINE composes it; the caller reviews it and later names it by id.
    // Ion used to compose this itself and the engine filed it verbatim, which
    // meant a direct caller could write its own claims — "fully verified",
    // "free" — into a receipt over the engine's signature.
    if (url.pathname === '/contract' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const { project: target } = requireLiveProject(req, {
          projectId: body?.projectId,
          scope: 'work:run',
        });
        const runtime = detectRuntimes().find((r) => r.id === body?.runtimeId);
        const packet = body?.packet && typeof body.packet === 'object'
          ? body.packet
          : { objective: { task: body?.task } };
        const contract = buildActionContract({
          packet,
          runtime,
          project: { id: target.id, name: target.name, remote: target.remote || null },
          // Which code the reviewer is actually looking at, read from the
          // resolved project's own directory — never from the request.
          checkout: captureCheckout(target.path),
        });
        return json(req, res, rememberContract(contract, target.id));
      } catch (error) {
        if (error instanceof GrantError) return refuse(req, res, error);
        return refuseSafely(req, res, error, url.pathname);
      }
    }

    // What accepting this receipt into project truth WOULD do. Reads only.
    if (url.pathname === '/closure/preview' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const { project: target } = requireLiveProject(req, {
          projectId: body?.projectId,
          scope: 'record:write',
        });
        const receipt = readRunReceipt(String(body.receiptId || '').trim());
        if (!receipt) return json(req, res, { error: 'No receipt with that id on this machine.' }, 404);
        // The receipt must belong to the project being closed. Otherwise one
        // project's evidence could be written into another's Record.
        if (receipt.boundProjectId !== target.id) {
          return json(req, res, { error: 'That receipt belongs to a different project.' }, 409);
        }
        if (!receipt.boundProjectRemote || receipt.boundProjectRemote !== target.remote) {
          return json(req, res, {
            error: 'That receipt lacks the current project identity binding and cannot enter its Record.',
          }, 409);
        }
        return json(req, res, rememberProposal(buildClosureProposal({
          receipt,
          note: body.note,
          intentDir: containedPath(target.path, '.intent'),
          projectRoot: target.path,
          markNextDone: body.markNextDone === true,
        }), target.id));
      } catch (error) {
        return refuseSafely(req, res, error, url.pathname);
      }
    }

    // The human's decision. The ONLY path from a receipt into .intent/.
    if (url.pathname === '/closure/decide' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const { project: target } = requireLiveProject(req, {
          projectId: body?.projectId,
          scope: 'record:write',
        });
        // The caller names a proposal; it never supplies one. A client-supplied
        // proposal could append any line it liked to the Record, including a
        // claim that checks passed.
        const held = liveHeldEntry(
          closureProposals,
          String(body.proposalId || '').trim(),
          PROPOSAL_TTL_MS,
        );
        if (!held) {
          return json(req, res, {
            error: 'That review is missing or expired — review it again before deciding.',
          }, 409);
        }
        const proposal = held.proposal;
        if (held.projectId !== target.id
          || proposal.boundProjectId !== target.id
          || proposal.boundProjectRemote !== target.remote) {
          return json(req, res, { error: 'That proposal belongs to a different project.' }, 409);
        }
        // The FIRST decision is the answer.
        //
        // Rejection returned an outcome and recorded nothing, so the proposal
        // stayed decidable: a reject followed by an accept wrote the very Record
        // line the person had just declined. The reverse answered "reject,
        // applied: false" for work already in project truth. Neither is a retry
        // — changing the answer is a new judgement, and it needs a new review of
        // the receipt against the files as they are now.
        //
        // An IDENTICAL decision is still safe to replay: acceptance recognises
        // its own Record line and rejection writes nothing either way, so a lost
        // response can always be retried.
        const asked = String(body?.decision || '').trim();
        if (held.decision && (asked === 'accept' || asked === 'reject') && asked !== held.decision) {
          return json(req, res, {
            error: `This review was already ${held.decision}ed, and a closure decision is final. `
              + 'Review the receipt again to make a new decision against the current files.',
          }, 409);
        }
        const outcome = applyClosure({
          proposal, decision: body.decision,
          intentDir: containedPath(target.path, '.intent'), projectRoot: target.path,
        });
        // Recorded only once the decision actually succeeded — a refusal must not
        // consume the person's one answer.
        held.decision = outcome.decision;
        // The decision is its own event. Evidence and judgement stay separate
        // artifacts: the receipt is never edited by a human accepting it.
        recordSessionEvent('human', target.name, 'closure_decided', {
          receiptId: proposal.receiptId,
          proposalId: proposal.proposalId,
          boundProjectId: target.id,
          boundProjectRemote: target.remote,
          decision: outcome.decision,
          applied: outcome.applied,
          alreadyApplied: outcome.alreadyApplied === true,
        });
        console.log(`  ${cyan('→')} Closure ${outcome.decision}ed for ${proposal.receiptId} in ${target.name}`);
        return json(req, res, outcome);
      } catch (error) {
        if (error instanceof GrantError) return refuse(req, res, error);
        if (error instanceof ClosureError || error instanceof LocalClaimError) {
          return refuseSafely(req, res, error, url.pathname);
        }
        return refuseSafely(req, res, error, url.pathname);
      }
    }

    // Explicit same-machine claim. The HTTPS room can reach only the viewer's
    // own loopback worker; the worker independently resolves the cloud project
    // to a deliberately registered repo and re-verifies its live origin before
    // delegating to the existing isolated branch/PR task path.
    //
    // Both doors below resolve the claim the same way, so the rule is written
    // once: authorize, resolve the cloud id to exactly one registered repo, and
    // prove the grant names THAT repo. Two copies of this would drift, and the
    // permissive copy is the one that would end up answering.
    const resolveGrantedClaim = (body) => {
      // Execution scope first, so an ungranted caller learns nothing.
      const { grant, project: grantedProject } = requireLiveProject(req, { scope: 'work:run' });
      const installed = listHarnesses()
        .filter((harness) => harness.installed && harness.headless)
        .map((harness) => harness.id);
      const claim = resolveLocalClaim(body, serveProjects(), installed);

      // The grant must name the repository this claim actually resolved to.
      //
      // An independent critic proved the hole: the scope check above passed
      // no projectId, so it bound to nothing, while `body.projectId` is a
      // CLOUD uuid resolved against a different table entirely. A grant for
      // repo A therefore spawned a harness in repo B — the one endpoint here
      // that starts a process was the one that did not bind.
      const claimedProjectId = projectId(claim.project.path);
      if (grant.projectId !== claimedProjectId) {
        throw new LocalClaimError('That grant belongs to a different project than this task is linked to.', 403);
      }
      // And the repo must still be what it was when the grant was issued.
      if (!grantedProject || grantedProject.path !== claim.project.path) {
        throw new LocalClaimError('That project moved or is no longer registered. Select it again.', 409);
      }
      return {
        grant,
        claim,
        // The resolved local project, in the shape a contract binds to.
        project: {
          id: claimedProjectId,
          name: claim.project.name,
          path: claim.project.path,
          remote: claim.project.remote || null,
        },
        workerId: grants.nodeInstanceId,
        // Same grant, proven without restating it. A contract is rendered to a
        // browser and filed as evidence; a token belongs in neither.
        grantFingerprint: crypto.createHash('sha256').update(String(grant.token)).digest('hex').slice(0, 32),
      };
    };

    // Review a claim BEFORE it can create a branch, a worktree, or a process.
    //
    // The engine composes this and holds it by id, exactly as `/contract` does
    // for a dispatch. The caller reviews it and later names it; it never sends
    // one back.
    if (url.pathname === '/claim/contract' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const { claim, project, workerId, grantFingerprint } = resolveGrantedClaim(body);
        const contract = buildClaimContract({
          claim,
          project,
          // Which code the reviewer is actually looking at, read from the
          // resolved project's own directory — never from the request.
          checkout: captureCheckout(project.path),
          workerId,
          grantFingerprint,
          argv: claimArgv(claim),
        });
        return json(req, res, rememberContract(contract, project.id));
      } catch (error) {
        if (error instanceof GrantError) return refuse(req, res, error);
        return refuseSafely(req, res, error, url.pathname);
      }
    }

    if (url.pathname === '/claim' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        // A caller-supplied contract is refused outright rather than ignored:
        // silently dropping it would let a surface believe its claims were
        // recorded, and accepting it would let a surface write its own claims
        // into evidence.
        if (body?.contract !== undefined) {
          return json(req, res, {
            error: 'A contract cannot be supplied. Review one with POST /claim/contract and send its contractId.',
          }, 400);
        }
        const { claim, project, workerId, grantFingerprint } = resolveGrantedClaim(body);

        // Shape validation AFTER authorization and resolution, so this endpoint
        // never becomes an oracle for what it expects.
        const contractId = String(body?.contractId || '').trim();
        if (!contractId) {
          return json(req, res, {
            error: 'A reviewed contractId is required. Review this run with POST /claim/contract first.',
          }, 400);
        }
        const held = liveHeldEntry(actionContracts, contractId, CONTRACT_TTL_MS);
        if (!held || held.projectId !== project.id) {
          return json(req, res, {
            error: 'That contract is missing, expired, or already used — review it again before running.',
          }, 409);
        }
        // Everything the reviewer was shown, still true — project, remote, cloud
        // project, task, route, worker, grant, and finally the commit baseline.
        // This is the LAST check before the contract is spent, and nothing
        // between here and `spawn()` awaits, so it holds at the moment the
        // harness starts rather than merely at some earlier point.
        try {
          assertClaimUnchanged(held.contract, { claim, project, workerId, grantFingerprint, argv: claimArgv(claim) });
        } catch (error) {
          // Spend it on the refusal too. A stale approval left in the store is
          // one a caller can retry until the tree happens to line up again.
          actionContracts.delete(contractId);
          return json(req, res, { error: error.message }, error.status || 409);
        }
        // One review authorizes one run. Deleted before the spawn so two
        // requests cannot spend it twice.
        actionContracts.delete(contractId);

        const claimId = startLocalClaim(claim, held.contract, contractId);
        // Not "human-approved": the only human gesture was the pairing. Saying
        // otherwise misleads the operator watching this terminal.
        console.log(`  ${cyan('→')} Ion claim ${claim.taskId.slice(0, 8)} in ${claim.project.name}`);
        return json(req, res, {
          claimId,
          status: 'accepted',
          project: { id: project.id, name: project.name },
        }, 202);
      } catch (error) {
        if (error instanceof GrantError) return refuse(req, res, error);
        return refuseSafely(req, res, error, url.pathname);
      }
    }

    // Dispatch a task
    if (url.pathname === '/dispatch' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const { actionId, runtimeId, packet } = body;

        // Every run is bound to one deliberately registered project, named
        // explicitly by the caller and resolved by the engine against its own
        // registry.
        //
        // The legacy unbound path is GONE, not preserved. It used to fall back
        // to the worker's own directory whenever projectId was absent, which
        // meant the shipped /intent page could execute with no credential at
        // all — and someone viewing project B could watch a run change project
        // A. Keeping it "for compatibility" would have kept the bypass; the
        // caller was migrated in the same wave instead.
        // Authorization comes BEFORE parameter validation. Checking the shape
        // of the request first would answer an ungranted caller with 400 and
        // turn this endpoint into an oracle for what it expects.
        let grant;
        try {
          ({ grant } = requireLiveProject(req, { scope: 'work:run' }));
        } catch (error) {
          return refuse(req, res, error);
        }
        // Shape validation AFTER authorization. Doing it first answered an
        // ungranted caller with 400 and made this an oracle for what it expects
        // — exactly what the comment below forbids.
        if (!actionId || !runtimeId || !packet) {
          return json(req, res, { error: 'Missing actionId, runtimeId, or packet' }, 400);
        }
        if (body.projectId === undefined || String(body.projectId || '').trim() === '') {
          return json(req, res, {
            error: 'A projectId is required. Select the project you want this to run in — there is no default.',
          }, 400);
        }
        let target;
        try {
          // Re-checked against the project actually named, with live identity.
          ({ grant, project: target } = requireLiveProject(req, {
            projectId: String(body.projectId).trim(),
            scope: 'work:run',
          }));
        } catch (error) {
          return refuse(req, res, error);
        }

        // The reviewed contract, taken from what the ENGINE composed and held.
        // A caller-supplied contract is refused outright rather than ignored:
        // silently dropping it would let a surface believe its claims were
        // recorded, and accepting it would let a surface write its own claims
        // into evidence.
        if (body.contract !== undefined) {
          return json(req, res, {
            error: 'A contract cannot be supplied. Review one with POST /contract and send its contractId.',
          }, 400);
        }
        const contractId = String(body.contractId || '').trim();
        if (!contractId) {
          return json(req, res, {
            error: 'A reviewed contractId is required. Review this run with POST /contract first.',
          }, 400);
        }
        const held = liveHeldEntry(actionContracts, contractId, CONTRACT_TTL_MS);
        if (!held) {
          return json(req, res, {
            error: 'That contract is missing, expired, or already used — review it again before running.',
          }, 409);
        }
        if (held.projectId !== target.id
          || held.contract.boundProjectId !== target.id
          || held.contract.boundProjectRemote !== target.remote) {
          return json(req, res, { error: 'That contract belongs to a different project.' }, 409);
        }
        if (held.contract.runtimeId !== runtimeId) {
          return json(req, res, { error: 'That contract was reviewed for a different route.' }, 409);
        }
        // ...and for THIS task. The engine composes the words, but a caller
        // could still attach a contract reviewed for "fix a typo" to a packet
        // that says "delete every file" — the same forgery with better
        // provenance, since the receipt then attests the wrong sentence.
        if (held.contract.executionDigest !== executionDigest(packet)) {
          return json(req, res, {
            error: 'That contract was reviewed for different executable instructions. Review this run again.',
          }, 409);
        }
        // ...and against the code that was there when it was reviewed. This is
        // the LAST statement before the contract is spent, and nothing between
        // here and `spawn()` awaits, so "still the same checkout" is true at the
        // moment the harness starts rather than merely at some earlier point.
        try {
          assertCheckoutUnmoved(held.contract, target.path);
        } catch (error) {
          // Spend it on the refusal too. A stale approval left in the store is
          // one a caller can retry until the tree happens to line up again.
          actionContracts.delete(contractId);
          return json(req, res, { error: error.message }, error.status || 409);
        }
        // One review authorizes one run. Delete immediately before the
        // synchronous job creation so two requests cannot spend it twice.
        actionContracts.delete(contractId);
        const jobId = createJob(actionId, runtimeId, packet, {
          id: target.id, name: target.name, path: target.path, remote: target.remote || null,
          boundByCaller: true,
        });
        // The job remembers which grant started it, so status and cancel belong
        // to that session rather than to anyone who learns the job id.
        jobs.get(jobId).grantToken = grant.token;
        jobs.get(jobId).contract = held.contract;
        console.log(`  ${cyan('→')} Dispatched job ${jobId.slice(0, 8)} for ${runtimeId}${target ? ` in ${target.name}` : ''}: ${packet.objective?.task?.slice(0, 60) || 'task'}`);

        // Start execution in background. The catch is the last line of defence:
        // a floating rejection here would kill the node and take every other
        // job's receipt with it. Record it on the job so the web still sees a
        // truthful terminal state.
        executeJob(jobId).catch((err) => {
          const job = jobs.get(jobId);
          if (job && !['done', 'error', 'cancelled'].includes(job.status)) {
            job.status = 'error';
            job.error = err && err.message ? err.message : String(err);
            job.statusText = 'Execution failed';
          }
          console.error(`  ${yellow('!')} Job ${jobId.slice(0, 8)} failed: ${err && err.message ? err.message : err}`);
        });

        // Name what it bound to, so a surface shows the resolved project
        // instead of assuming the one it asked for.
        return json(req, res, {
          jobId,
          status: 'queued',
          ...(target ? { project: { id: target.id, name: target.name } } : {}),
        });
      } catch (err) {
        return json(req, res, { error: err.message }, err.status || 400);
      }
    }

    // Human-initiated cancel of a running job. Idempotent: an unknown or
    // already-finished job answers ok without error, so a lost-response retry
    // is safe. Only running jobs are stopped; terminal jobs are left as-is.
    if (url.pathname === '/cancel' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        // Control belongs to the session that started the run, and the check
        // comes first: answering "unknown" before checking authorization told
        // an ungranted caller which job ids exist.
        let grant;
        try {
          ({ grant } = requireLiveProject(req, { scope: 'work:control' }));
        } catch (error) {
          return refuse(req, res, error);
        }
        const job = body && body.jobId ? jobs.get(body.jobId) : null;
        // Idempotent for the grant holder: an unknown or already-finished job
        // answers ok, so a lost-response retry is safe.
        if (!job) return json(req, res, { status: 'unknown' });
        if (job.grantToken && grant.token !== job.grantToken) {
          return json(req, res, { error: 'That job belongs to a different session.' }, 403);
        }
        if (job.project?.id && job.project.id !== grant.projectId) {
          return json(req, res, { error: 'That job belongs to a different project.' }, 403);
        }
        if (job.status === 'queued' || job.status === 'executing') {
          // `cancelling`, not `cancelled`. This used to jump straight to a
          // TERMINAL state the instant it was asked, so the API reported the run
          // was over while the harness was still executing and still writing into
          // the person's repository. A harness that ignores SIGTERM made that
          // claim permanently false.
          job.status = 'cancelling';
          job.statusText = 'Cancelling…';
          job.cancelRequested = true;
          job.error = 'Run cancelled by user.';
          console.log(`  ${yellow('■')} Cancel requested for job ${job.jobId.slice(0, 8)}`);
          if (job.child) stopJobProcess(job);
          else {
            // Queued and never spawned: nothing to wait for, so exit is already
            // observed and this is genuinely terminal.
            job.status = 'cancelled';
            job.statusText = 'Cancelled';
            finalizeJob(job, RUNNERS[job.runtimeId] || null, null, { packet: job.packet, eventType: 'task_cancelled' });
          }
        }
        return json(req, res, { jobId: job.jobId, status: job.status });
      } catch (err) {
        return json(req, res, { error: err.message }, 400);
      }
    }

    // Mission control state — the same five rows bare `phewsh` shows, so
    // the web cockpit (phewsh.com/cockpit) mirrors the CLI to a T.
    //
    // This is a view of the DEVICE, not of a project, so it takes a host grant
    // with the diagnostics scope rather than an ordinary project token. It also
    // no longer volunteers the user's email address or any absolute path: it
    // used to hand all of that, plus the five most recent projects' full paths,
    // to anyone who could reach the port.
    if (url.pathname === '/cockpit' && req.method === 'GET') {
      try {
        grants.requireHost(hostToken(req), 'host:diagnostics', callerOf(req));
      } catch (error) {
        return refuse(req, res, error);
      }
      try {
        const { listHarnesses, HARNESSES } = require('../lib/harnesses');
        const { outcomeStats, pendingDecisions, bypassStats } = require('../lib/outcomes');
        const { listProjects } = require('../lib/projects-index');

        const config = configFile.loadConfig(path.join(os.homedir(), '.phewsh', 'config.json'), {});

        const harnessList = listHarnesses().map(h => ({
          id: h.id, label: h.label, role: h.role, installed: h.installed, headless: h.headless,
        }));

        // Same route precedence as the CLI session
        const chatCapable = harnessList.filter(h => h.installed && h.headless);
        let routeId = null;
        if (config.defaultRoute === 'api' && config.apiKey) routeId = 'api';
        else if (config.defaultRoute && chatCapable.some(h => h.id === config.defaultRoute)) routeId = config.defaultRoute;
        else if (config.apiKey) routeId = 'api';
        else if (chatCapable.length > 0) routeId = chatCapable[0].id;

        const intentFiles = ['vision.md', 'plan.md', 'next.md']
          .filter(f => fs.existsSync(path.join(process.cwd(), '.intent', f)));

        return json(req, res, {
          // Name only. The absolute path is the machine's business.
          project: { name: path.basename(process.cwd()), intentFiles },
          route: routeId === 'api'
            ? { id: 'api', label: `API (${config.provider || 'anthropic'} key)` }
            : routeId ? { id: routeId, label: HARNESSES[routeId].label } : null,
          fallback: config.fallback === 'auto' ? 'auto' : 'ask',
          harnesses: harnessList,
          // Whether a cloud account is connected is a real fact the device view
          // needs. WHICH account it is is not, so the address stays here.
          web: { loggedIn: !!config.supabaseUserId },
          record: outcomeStats(),
          pending: pendingDecisions().length,
          bypasses: bypassStats(),
          recentProjects: listProjects().slice(0, 5).map(p => ({ name: p.name, lastOpened: p.lastOpened })),
          servedProjects: serveProjects().map(p => ({ name: p.name, remote: p.remote })),
          version: require('../package.json').version,
        });
      } catch (err) {
        return json(req, res, { error: err.message }, 500);
      }
    }

    // The proof trail — same merged data as `phewsh receipts` and the MCP
    // bridge's /receipts, so the web can show evidence regardless of which
    // local bridge is running.
    //
    // This feed crosses every project on the machine, so it takes the admin
    // host scope. A plain paired client does not get it, and an ungranted
    // caller certainly does not: it used to answer anyone who asked.
    if (url.pathname === '/receipts' && req.method === 'GET') {
      try {
        grants.requireHost(hostToken(req), 'host:admin', callerOf(req));
      } catch (error) {
        return refuse(req, res, error);
      }
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const project = url.searchParams.get('project') || null;
      const kind = url.searchParams.get('kind') || null;
      return json(req, res, gatherReceipts({ project, kind, limit, publicView: true, cwd: process.cwd() }));
    }

    // Check job status
    const statusMatch = url.pathname.match(/^\/status\/(.+)$/);
    if (statusMatch && req.method === 'GET') {
      const jobId = statusMatch[1];
      const job = jobs.get(jobId);
      if (!job) {
        // An ungranted caller must not be able to tell "no such job" from
        // "not yours" — that difference is a job-id oracle.
        try {
          requireLiveProject(req);
        } catch (error) {
          return refuse(req, res, error);
        }
        return json(req, res, { error: 'Job not found' }, 404);
      }
      try {
        const { grant } = requireLiveProject(req, {
          projectId: job.project?.id,
        });
        if (job.grantToken && grant.token !== job.grantToken) {
          return json(req, res, { error: 'That job belongs to a different session.' }, 403);
        }
      } catch (error) {
        return refuse(req, res, error);
      }
      return json(req, res, {
        jobId: job.jobId,
        status: job.status,
        statusText: job.statusText,
        result: job.result,
        error: job.error,
        // The contract state, alongside — never instead of — the node's own
        // vocabulary. Ion renders `state`; existing callers keep reading
        // `status`, so translating at this boundary means renaming an internal
        // later cannot silently change what a surface displays. Null when the
        // status has no mapping: unknown must read as unknown.
        state: workerState.jobStateOf(job),
        // NO taskId HERE, DELIBERATELY. Only /dispatch creates a `jobs` entry,
        // and its contract comes from buildActionContract, which has no claim
        // and therefore never sets boundTaskId — so a `taskId` field on this
        // route would be structurally always null. That reads as "this run has
        // no task" when the truth is "this route cannot express one".
        //
        // Ion's task-bound runs go through /claim → startLocalClaim, which
        // tracks them in its OWN `claimRuns` map (claimId + child, keyed
        // projectId:taskId) with no job record and no status route at all. The
        // Work board's Running lane needs THAT path emitting state; until the
        // two stores are reconciled, this route honestly covers dispatch only.
        harness: job.runtimeId || null,
        projectId: job.project?.id || null,
        workerId: grants.nodeInstanceId,
        startedAt: job.startedAt || null,
        // When the NODE ANSWERED — deliberately not named `updatedAt`. serve.js
        // does not currently stamp a timestamp on each status transition, so a
        // job that finished ten minutes ago would report "updated: now" on every
        // poll and a wedged run would look freshly active. Detecting a wedged
        // job needs a real transition time; until each `job.status = …` carries
        // one, this says only what it can honestly say.
        observedAt: new Date().toISOString(),
      });
    }

    // 404
    json(req, res, { error: 'Not found' }, 404);
  };

  const server = http.createServer(handleRequest);

  // One worker per machine (per port) for now. A second `phewsh serve` used to
  // die with a raw EADDRINUSE stack — say what's true and how to proceed instead.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log('');
      console.log(`  ${yellow('●')} A phewsh worker is already running on port ${port}.`);
      console.log('');
      console.log(`  ${g('One worker per machine for now — the running worker serves the project')}`);
      console.log(`  ${g('directory it was started in. To serve a different project:')}`);
      console.log(`    ${g('· stop the other worker (Ctrl+C) and start this one, or')}`);
      console.log(`    ${g('· run on another port:')} ${w(`phewsh serve --port ${port + 1}`)}`);
      console.log(`      ${g('(note: phewsh.com currently discovers port 7483 only)')}`);
      console.log('');
      console.log(`  ${g('A one-worker-many-projects registry is the planned next step.')}`);
      console.log('');
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, '127.0.0.1', () => {
    const mirror = http.createServer(handleRequest);
    mirror.on('error', () => { /* IPv6 unavailable or already bound */ });
    mirror.listen(port, '::1');

    console.log('');
    console.log(`  ${b(w('PHEWSH Serve'))} ${g('v' + require('../package.json').version)}`);
    console.log(`  ${g('Live execution bridge for phewsh.com/ion and phewsh.com/intent')}`);
    console.log('');
    console.log(`  ${green('●')} Running on ${w(`http://localhost:${port}`)}`);
    console.log(`  ${g('Web cockpit:')} ${w('phewsh.com/cockpit')} ${g('— shows this machine while the local bridge runs')}`);
    console.log('');
    console.log(`  ${b('Connected runtimes:')}`);
    runtimes.forEach(r => {
      const status = r.connected ? green('● connected') : g('○ not found');
      console.log(`    ${r.label}: ${status}`);
    });
    if (!hasClaudeCode) {
      console.log('');
      console.log(`  ${yellow('Tip:')} Install Claude Code CLI for live task execution`);
      console.log(`  ${g('https://docs.anthropic.com/en/docs/claude-code')}`);
    }
    console.log('');
    const registered = serveProjects();
    const here = currentProject();
    console.log(`  ${b('Projects this worker shows on phewsh.com/ion:')}`);
    if (registered.length === 0) {
      console.log(`    ${g('only the current directory:')} ${w(here.name)}${here.remote ? g(` (${here.remote})`) : ''}`);
      console.log(`    ${g('Register projects by name so the web knows them:')} ${cyan('phewsh project add')} ${g('(run inside each repo)')}`);
    } else {
      for (const p of registered) {
        const isHere = p.path === process.cwd();
        console.log(`    ${green('●')} ${w(p.name)}${g(` (${p.remote})`)}${isHere ? g(' ← current directory') : ''}`);
      }
      console.log(`    ${g('Manage the list:')} ${cyan('phewsh project')}`);
    }
    console.log('');
    console.log(`  ${g('Open phewsh.com/ion to see the worker online, or phewsh.com/intent → Work')}`);
    console.log(`  ${g('Press Ctrl+C to stop')}`);
    console.log('');
  });
}

module.exports = main;
module.exports._internals = { parseStreamEvent, streamPhase, extractStreamResult };
