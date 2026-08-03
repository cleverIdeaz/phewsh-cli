// The authority contract — what running this action actually grants.
//
// This used to be composed in the browser and copied onto the receipt verbatim.
// That inverted the owner-layer rule and, worse, made the receipt a place a
// caller could write its own claims: a direct call could state "Verification:
// fully verified" or "Cost: free" and the engine would file it as if the engine
// had said it. A receipt is evidence, so every sentence in it has to come from
// the side that actually knows.
//
// So the engine composes the contract, holds it, and hands back an id. Ion
// renders what it is given and dispatches by id. It cannot edit a word — the
// same shape that already fixed closure proposals.
//
// Owner layer: CLI.

const crypto = require('crypto');
const { inspectCheckout } = require('./git-status');

/**
 * What running actually grants — stated once, rendered verbatim.
 *
 * This is the exact sentence an independent critic forced on 2026-07-29, moved
 * here unchanged when contract composition came into the engine. It used to
 * read "in this project only. No cloud, no other repository." That is false:
 * Phewsh sets the tool's working directory, which is not a sandbox. The tool
 * inherits your environment, your filesystem access, and the network, and most
 * AI tools send your prompt and file contents to their own provider.
 *
 * Promising containment Phewsh cannot enforce is worse than promising nothing,
 * because a person grants MORE on the strength of it. Do not soften it.
 */
const LOCAL_RUN_AUTHORITY =
  'Starts in this project, on this machine, with your permissions. Phewsh does not confine it: '
  + 'the tool can reach other files and the network, and most AI tools send your prompt and file '
  + 'contents to their provider.';

/**
 * Compose the contract for one proposed run.
 *
 * Every field is either something the engine observed (which project, which
 * runtime, which account authorizes it) or a constant the engine stands behind.
 * Nothing here is caller-supplied except the task text itself, which is quoted
 * back as the action rather than interpreted.
 */
function executableInstructions(packet = {}, fallbackTask = '') {
  const action = String(packet?.objective?.task ?? fallbackTask ?? '').trim();
  const context = typeof packet?.context?.plan === 'string'
    ? packet.context.plan.trim()
    : '';
  const criteria = Array.isArray(packet?.verification?.criteria)
    ? packet.verification.criteria.map((item) => String(item).trim()).filter(Boolean)
    : [];
  return { action, context, criteria };
}

function executionDigest(packet = {}, fallbackTask = '') {
  return crypto.createHash('sha256')
    .update(JSON.stringify(executableInstructions(packet, fallbackTask)))
    .digest('hex');
}

function movedError(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

/**
 * The commit baseline a run is approved against.
 *
 * `boundProjectId` + `boundProjectRemote` answer WHICH REPOSITORY. They do not
 * answer WHICH CODE: a person reviews the work in front of them, and a branch
 * can move — a commit, a checkout, a detach — between review and run. Same
 * repo, same words on the contract, different code underneath.
 *
 * `head: null` is an unborn HEAD, which is a real state a registered repo can
 * be in and NOT an unknown: the first commit therefore moves it. Anything that
 * cannot be read at all fails closed here instead, because "cannot check"
 * must never pass for "unchanged".
 */
function captureCheckout(dir) {
  const state = inspectCheckout(dir);
  if (!state?.isRepo || state.error) {
    throw movedError('That project is not a git checkout that can be read, so a run cannot be bound to a commit baseline.');
  }
  return {
    branch: state.detached ? null : (state.branch || null),
    head: state.head?.full || null,
  };
}

/**
 * Still the same code the reviewer saw? Called immediately before the run is
 * authorized, so a stale approval becomes a conflict rather than a run.
 */
function assertCheckoutUnmoved(contract, dir) {
  if (!contract || !('boundHead' in contract) || !('boundBranch' in contract)) {
    throw movedError('That approval carries no commit baseline, so it cannot be checked. Review this run again.');
  }
  const live = captureCheckout(dir);
  if (live.head !== contract.boundHead || live.branch !== contract.boundBranch) {
    throw movedError('This project moved since that run was approved — its branch or commit changed. Review it again.');
  }
  return live;
}

function buildActionContract({ task, packet, runtime, project, checkout }) {
  const executable = executableInstructions(packet, task);
  const action = executable.action;
  if (!action) {
    const error = new Error('A run needs a task to describe.');
    error.status = 400;
    throw error;
  }
  if (!runtime || runtime.connected !== true || runtime.headless !== true) {
    // Same rule the dispatcher enforces. Stated once, here, so a surface cannot
    // offer a route the engine would refuse.
    const error = new Error(
      `${(runtime && (runtime.label || runtime.id)) || 'That route'} cannot take a run on this machine.`,
    );
    error.status = 409;
    throw error;
  }
  if (!checkout || !('head' in checkout) || !('branch' in checkout)) {
    // A contract with no baseline is one nothing can be verified against later.
    throw movedError('A run must name the checkout it was approved against.');
  }

  const account = runtime.auth
    ? ` Billed to whatever ${runtime.auth} charges, if anything.`
    : '';

  return {
    action,
    context: executable.context || null,
    verificationInstructions: executable.criteria,
    actor: runtime.label || runtime.id,
    actorAccount: runtime.auth || null,
    where: `${project.name} — the copy on this device${project.remote ? ` (${project.remote})` : ''}`,
    reads: 'Files in this project, including its .intent/ — and whatever else it chooses to open.',
    writes: 'May create or change files here. Phewsh does not stop it writing elsewhere on this machine.',
    // The engine reports which account authorizes a tool. It does not know a
    // price and must never imply one.
    cost: `Unknown — the engine reports which account authorizes a tool, never a price.${account}`,
    authority: LOCAL_RUN_AUTHORITY,
    verificationCeiling:
      'Not verified. A receipt records what happened and points at evidence; it does not check the work.',
    undo: 'File changes are yours to revert with git. Nothing reaches Record or Next unless you accept it.',
    // Bound so a contract cannot be reviewed for one project and spent on
    // another, the same way a closure proposal is bound.
    boundProjectId: project.id,
    boundProjectRemote: project.remote || null,
    // ...and to the code that was there when it was reviewed, re-checked before
    // the run is authorized. Null branch means detached; null head means the
    // checkout had no commit yet.
    boundBranch: checkout.branch,
    boundHead: checkout.head,
    runtimeId: runtime.id,
    // Binds every caller-controlled word the harness will receive. Matching
    // only `action` let a caller review a benign task and smuggle destructive
    // instructions through context or verification criteria at dispatch time.
    executionDigest: executionDigest(packet, task),
  };
}

/**
 * The contract for one claimed Ion task.
 *
 * A claim is not a passive task operation. One authorized POST creates a branch,
 * creates a worktree, and launches a harness in it — the same authority a
 * dispatch grants, reached by a different door. It had a strong REPOSITORY
 * binding (cloud id → exactly one registered repo → live origin) and no RUN
 * binding at all, so an approval could outlive the task, the route, the worker,
 * and the code it was given for.
 *
 * Its executable instructions are not a packet: the task text is fetched from
 * the cloud at run time, so the only caller-controlled words that reach the
 * harness are the argv this worker will spawn. That is what the digest covers —
 * which also means a future change to the command's SHAPE invalidates contracts
 * reviewed against the old one, rather than silently widening what was approved.
 */
function claimExecutionDigest(argv) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(Array.isArray(argv) ? argv : []))
    .digest('hex');
}

function buildClaimContract({ claim, project, checkout, workerId, grantFingerprint, argv }) {
  if (!claim?.taskId) {
    const error = new Error('A claim needs a task to describe.');
    error.status = 400;
    throw error;
  }
  if (!checkout || !('head' in checkout) || !('branch' in checkout)) {
    throw movedError('A run must name the checkout it was approved against.');
  }
  if (!workerId) {
    // Without this a contract reviewed on one worker could be presented to
    // another. Refusing beats binding to a blank.
    throw movedError('This worker could not identify itself, so a run cannot be bound to it.');
  }

  return {
    action: `Claim Ion task ${claim.taskId} and run it on this machine.`,
    context: null,
    verificationInstructions: [],
    actor: claim.runtimeId || 'the default headless route on this machine',
    actorAccount: null,
    where: `${project.name} — the copy on this device${project.remote ? ` (${project.remote})` : ''}`,
    reads: 'Files in this project, including its .intent/ — and whatever else it chooses to open.',
    // Said plainly BEFORE approval, because these are repository mutations and
    // the previous route performed both with nothing reviewed.
    writes: 'Creates a git branch and an isolated worktree for this task, then runs the tool there. '
      + 'Phewsh does not stop it writing elsewhere on this machine.',
    cost: 'Unknown — the engine reports which account authorizes a tool, never a price.',
    authority: LOCAL_RUN_AUTHORITY,
    verificationCeiling:
      'Not verified. A receipt records what happened and points at evidence; it does not check the work.',
    undo: 'The branch and worktree are yours to remove with git. Nothing reaches Record or Next unless you accept it.',
    boundProjectId: project.id,
    boundProjectRemote: project.remote || null,
    // The cloud project this task came from — a different namespace from the
    // local registry id, and both have to hold for the claim to be the one
    // that was reviewed.
    boundCloudProjectId: claim.projectId,
    boundTaskId: claim.taskId,
    boundBranch: checkout.branch,
    boundHead: checkout.head,
    runtimeId: claim.runtimeId || null,
    boundWorkerId: workerId,
    // A fingerprint, never the token: the contract is rendered to a browser and
    // filed as evidence, and neither is a place to restate a secret.
    boundGrantFingerprint: grantFingerprint || null,
    executionDigest: claimExecutionDigest(argv),
  };
}

/**
 * Everything the reviewer was shown, still true — checked immediately before the
 * contract is spent.
 *
 * Project, remote, cloud project, task, route, worker, grant and finally the
 * checkout. The checkout is last because it is the only one that reads the
 * filesystem: the cheap identity mismatches should refuse before the expensive
 * one runs.
 */
function assertClaimUnchanged(contract, { claim, project, workerId, grantFingerprint, argv }) {
  if (!contract || !contract.boundTaskId) {
    throw movedError('That approval carries no claim binding, so it cannot be checked. Review this run again.');
  }
  if (contract.boundProjectId !== project.id || contract.boundProjectRemote !== (project.remote || null)) {
    throw movedError('That contract belongs to a different project.');
  }
  if (contract.boundCloudProjectId !== claim.projectId || contract.boundTaskId !== claim.taskId) {
    throw movedError('That contract was reviewed for a different task.');
  }
  if (contract.runtimeId !== (claim.runtimeId || null)) {
    throw movedError('That contract was reviewed for a different route.');
  }
  if (contract.boundWorkerId !== workerId) {
    throw movedError('That contract was reviewed on a different worker.');
  }
  if (contract.boundGrantFingerprint !== (grantFingerprint || null)) {
    throw movedError('That contract was reviewed under a different grant.');
  }
  if (contract.executionDigest !== claimExecutionDigest(argv)) {
    throw movedError('That contract was reviewed for different executable instructions. Review this run again.');
  }
  return assertCheckoutUnmoved(contract, project.path);
}

module.exports = {
  buildActionContract,
  buildClaimContract,
  assertClaimUnchanged,
  claimExecutionDigest,
  captureCheckout,
  assertCheckoutUnmoved,
  executableInstructions,
  executionDigest,
  LOCAL_RUN_AUTHORITY,
};
