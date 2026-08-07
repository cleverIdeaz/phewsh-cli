// The worker job-state contract — what a `phewsh serve` node may truthfully say
// about itself and the work it is carrying.
//
// TWO AXES, DELIBERATELY NOT ONE ENUM.
//
// Presence answers "can I reach this worker, and how recently did it speak?"
// Job state answers "what is this particular unit of work doing?" Collapsing
// them into a single field makes one sentence unsayable:
//
//     the worker went stale WHILE running task 42
//
// You would have to choose between reporting `stale` and reporting `running`,
// and both are true. That is precisely the state this contract exists to
// survive — a disconnect mid-run is the recovery case — so it cannot be the one
// state the contract cannot express. Presence and job state are therefore
// independent, and a record carries both.
//
// NOTHING HERE INVENTS PRESENCE. `connected` already has one canonical meaning
// shared by serve.js and the MCP http bridge (see intent/app/src/lib/mcp-bridge.ts);
// `stale` is heartbeat expiry made explicit rather than a new claim. A state
// this module cannot derive from real node data is not emitted — the same rule
// ion-composer-routes.ts already applies when it refuses to publish active/idle
// without real job state.

/**
 * How a job may be described. Ordered roughly by lifecycle.
 *
 * `cancelling` is NOT in the originally proposed list, and dropping it would
 * force a lie in one direction or the other: serve.js already sets a real
 * cancelling phase (`job.statusText = 'Cancelling — forcing stop…'`) during
 * which the child is still alive. Reporting `running` hides that a human asked
 * it to stop; reporting `cancelled` claims it stopped when it has not. It is a
 * distinct state the node can truthfully observe, so it stays.
 */
const JOB_STATES = Object.freeze([
  'claiming',         // accepted, not yet executing
  'running',          // a harness is executing it
  'cancelling',       // stop requested, child still alive
  'awaiting_input',   // DEFINED, NOT EMITTED — see NOT_YET_OBSERVABLE
  'awaiting_review',  // DEFINED, NOT EMITTED — see NOT_YET_OBSERVABLE
  'completed',
  'failed',
  'cancelled',
]);

/**
 * Reserved names with no truthful producer yet. No harness currently reports
 * "I am blocked on a human", and the board must not render a state the worker
 * cannot emit. They are named here so the vocabulary is stable when a harness
 * can report them — naming a state is not the same as claiming to observe it.
 */
const NOT_YET_OBSERVABLE = Object.freeze(['awaiting_input', 'awaiting_review']);

/** Reachability, independent of any job. */
const PRESENCE_STATES = Object.freeze(['connected', 'disconnected', 'stale']);

/** serve.js's internal job.status → the contract. The node's own vocabulary is
 * left untouched; this is the translation at the boundary, so renaming internals
 * later cannot silently change what Ion renders. */
const FROM_SERVE_STATUS = Object.freeze({
  queued: 'claiming',
  executing: 'running',
  cancelling: 'cancelling',
  cancelled: 'cancelled',
  done: 'completed',
  error: 'failed',
});

/** A job is finished when nothing further will happen without a new request. */
const TERMINAL = Object.freeze(['completed', 'failed', 'cancelled']);

/**
 * Translate one serve.js job record into a contract job state.
 * An unrecognised internal status returns null rather than guessing — an
 * unknown state must read as unknown, never as `running` or `failed`.
 * @param {{status?: string}} job
 * @returns {string|null}
 */
function jobStateOf(job) {
  if (!job || typeof job.status !== 'string') return null;
  return FROM_SERVE_STATUS[job.status] || null;
}

/** @param {string} state */
function isTerminal(state) {
  return TERMINAL.includes(state);
}

/**
 * Reachability from heartbeat age. `disconnected` is only ever asserted by a
 * caller that KNOWS the transport dropped; absence of a recent heartbeat is
 * `stale`, which says "I no longer know", not "it is gone". Conflating the two
 * is how a UI ends up claiming a worker died when the laptop merely slept.
 *
 * @param {object} opts
 * @param {number|null} opts.lastHeartbeatAt  epoch ms, or null if never seen
 * @param {number} opts.now                   epoch ms
 * @param {number} [opts.staleAfterMs]        default 30s
 * @param {boolean} [opts.transportClosed]    the caller observed a real close
 * @returns {'connected'|'disconnected'|'stale'}
 */
function presenceOf({ lastHeartbeatAt, now, staleAfterMs = 30000, transportClosed = false }) {
  if (transportClosed) return 'disconnected';
  if (!lastHeartbeatAt) return 'stale';
  return (now - lastHeartbeatAt) > staleAfterMs ? 'stale' : 'connected';
}

/**
 * Assemble what a worker reports about itself. `activity` is DERIVED from the
 * job list, never stored, so it cannot drift out of agreement with the jobs it
 * summarises — an idle worker is one that is reachable and carrying nothing.
 *
 * @param {object} opts
 * @param {string} opts.workerId    stable node instance id
 * @param {string|null} opts.projectId
 * @param {Array<{jobId: string, state: string, taskId?: string|null, harness?: string|null,
 *                startedAt?: string|null, updatedAt?: string|null}>} [opts.jobs]
 * @param {'connected'|'disconnected'|'stale'} opts.presence
 * @param {string|null} [opts.lastHeartbeatAt] ISO, or null when never observed
 */
function workerStateRecord({ workerId, projectId, jobs = [], presence, lastHeartbeatAt = null }) {
  const active = jobs.filter((j) => !isTerminal(j.state));
  return {
    workerId,
    projectId: projectId || null,
    presence,
    // Only meaningful while reachable. A stale worker's last known jobs are
    // still reported, but calling it "idle" would assert something we cannot
    // currently see.
    activity: presence === 'connected' ? (active.length ? 'working' : 'idle') : 'unknown',
    activeJobs: active,
    lastHeartbeatAt,
  };
}

module.exports = {
  JOB_STATES,
  PRESENCE_STATES,
  NOT_YET_OBSERVABLE,
  FROM_SERVE_STATUS,
  TERMINAL,
  jobStateOf,
  isTerminal,
  presenceOf,
  workerStateRecord,
};
