// Same-machine Ion claims: resolve a cloud task to a deliberately registered
// local repo before the serve bridge may spawn anything.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { normalizeRemote } = require('./team-tasks');
const { matchProjectId } = require('./project-identity');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class LocalClaimError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function linkedCloudProjectId(dir) {
  try {
    const pps = JSON.parse(fs.readFileSync(path.join(dir, '.intent', 'pps.json'), 'utf8'));
    return typeof pps?.adapters?.phewsh?.cloud_id === 'string'
      ? pps.adapters.phewsh.cloud_id
      : null;
  } catch {
    return null;
  }
}

function liveOrigin(dir) {
  try {
    return normalizeRemote(execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
  } catch {
    return null;
  }
}

/**
 * THE staleness gate. A registered project is only usable if it is still the
 * repository it registered as — a directory can be moved, re-cloned, or
 * re-pointed at a different origin long after `phewsh project add` ran.
 *
 * Every authority path calls this one function. Two subtly different versions
 * of "is this still that repo?" is how one of them ends up more permissive.
 */
function assertLiveIdentity(project, originFor = liveOrigin) {
  const registeredRemote = normalizeRemote(project.remote);
  const currentRemote = originFor(project.path);
  if (!registeredRemote || !currentRemote || registeredRemote !== currentRemote) {
    throw new LocalClaimError('The registered repo identity no longer matches its live origin. Re-run `phewsh project add` inside the correct repo.', 409);
  }
  return project;
}

/**
 * Resolve where a run may happen, from a STABLE LOCAL ID and nothing else.
 *
 * The caller supplies only the id it proved through the local handshake. A
 * filesystem path, display name, first match, cookie, URL value, or stored
 * value in the request is not identity and is never consulted — this function
 * reads the machine's own registry.
 *
 * Fails closed before anything is spawned: unknown, unregistered, ambiguous,
 * or drifted ids all throw.
 */
function resolveRunTarget(projectId, projects, originFor = liveOrigin) {
  // The identity question itself lives in `project-identity.js`, shared with the
  // MCP surface. Two implementations of one boundary drift, and the permissive
  // one is the one that ends up answering. The wording, the status codes and the
  // live-origin gate below stay here — those are this path's own.
  const verdict = matchProjectId(projects, projectId);
  switch (verdict.outcome) {
    case 'missing':
      throw new LocalClaimError('A projectId is required. Names are not identity.');
    case 'unknown':
      throw new LocalClaimError('No registered project with that id on this machine.', 404);
    case 'ambiguous':
      throw new LocalClaimError('More than one registered repo claims that id. Remove the stale registry entry before running.', 409);
    default:
      return assertLiveIdentity(verdict.match, originFor);
  }
}

/**
 * The registered repo a cloud project is linked to — exactly one, still live.
 *
 * Shared by the serve route and the direct CLI claim, because those two doors
 * reach the same spawn. `serve === true` is the deliberate `phewsh project add`
 * gesture: a directory that merely CONTAINS a convincing `.intent/pps.json` and
 * a matching origin has registered nothing and cannot execute.
 */
function resolveLinkedWorkspace(cloudProjectId, projects, originFor = liveOrigin) {
  const linked = (Array.isArray(projects) ? projects : [])
    .filter((project) => project?.serve === true && linkedCloudProjectId(project.path) === cloudProjectId);
  if (!linked.length) {
    throw new LocalClaimError('This cloud project is not linked to a project registered on this machine.', 404);
  }
  if (linked.length > 1) {
    throw new LocalClaimError('More than one registered repo is linked to this cloud project. Remove the stale registry entry before running.', 409);
  }
  // Same gate as a bound dispatch — one authority path, not two.
  return assertLiveIdentity(linked[0], originFor);
}

function repoRootOf(dir) {
  try {
    return fs.realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
  } catch {
    return null;
  }
}

/**
 * Where a DIRECT `phewsh ion claim` may run.
 *
 * `process.cwd()` used to answer this on its own: the repo root of wherever the
 * person happened to be standing became the execution target, and the machine's
 * registry was never consulted. This keeps the useful local workflow — stand in
 * your project, claim a task — but the registry is the authority and the current
 * folder only has to AGREE with it.
 *
 * A resolved repo that is not where you are standing is refused rather than
 * silently relocated: running somewhere other than where a person believes they
 * are is the same surprise this layer exists to prevent. `--project <id>` is the
 * explicit way to mean a different one.
 */
function resolveClaimWorkspace({ cloudProjectId, projects, cwd, requestedProjectId, originFor = liveOrigin }) {
  const requested = typeof requestedProjectId === 'string' ? requestedProjectId.trim() : '';
  if (requested) {
    // An explicit id names a repo; it does not grant one. It still has to be
    // registered, still has to be live, and still has to be linked — the cloud
    // project is then read from THAT repo's own `.intent/`, so naming a project
    // and standing in a different one cannot disagree.
    const target = resolveRunTarget(requested, projects, originFor);
    const linked = linkedCloudProjectId(target.path);
    if (!linked) {
      throw new LocalClaimError('That project is not linked to a cloud project. Run `phewsh push` inside it first.', 409);
    }
    if (cloudProjectId && linked !== cloudProjectId) {
      throw new LocalClaimError('That project is not linked to this cloud project.', 409);
    }
    return target;
  }
  if (!cloudProjectId) {
    throw new LocalClaimError('This project is not linked to the cloud. Run `phewsh push` (or `phewsh link <id>`) first, or name a registered project with `--project <id>`.', 404);
  }

  const target = resolveLinkedWorkspace(cloudProjectId, projects, originFor);
  const standingIn = repoRootOf(cwd);
  if (!standingIn || standingIn !== repoRootOf(target.path)) {
    throw new LocalClaimError(
      `This task is registered to ${target.name}, which is not the repository you are in. `
      + 'Run it from there, or name it explicitly with `--project <id>`.',
      409,
    );
  }
  return target;
}

function resolveLocalClaim(body, projects, installedHarnesses = [], originFor = liveOrigin) {
  const projectId = typeof body?.projectId === 'string' ? body.projectId.trim() : '';
  const taskId = typeof body?.taskId === 'string' ? body.taskId.trim() : '';
  const runtimeId = typeof body?.runtimeId === 'string' ? body.runtimeId.trim() : '';

  if (!UUID_RE.test(projectId)) {
    throw new LocalClaimError('A full cloud project id is required.');
  }
  if (!UUID_RE.test(taskId)) {
    throw new LocalClaimError('A full task id is required.');
  }
  if (runtimeId && !installedHarnesses.includes(runtimeId)) {
    throw new LocalClaimError(`Runtime ${runtimeId} is not an installed headless harness on this machine.`);
  }

  const project = resolveLinkedWorkspace(projectId, projects, originFor);

  return { project, projectId, taskId, runtimeId: runtimeId || null };
}

function claimCommand(binPath, claim) {
  return [binPath, 'ion', 'claim', claim.taskId, ...(claim.runtimeId ? ['--via', claim.runtimeId] : [])];
}

module.exports = {
  LocalClaimError, linkedCloudProjectId, liveOrigin, assertLiveIdentity,
  resolveRunTarget, resolveLinkedWorkspace, resolveClaimWorkspace,
  resolveLocalClaim, claimCommand,
};
