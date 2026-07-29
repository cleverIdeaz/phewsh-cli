// Same-machine Ion claims: resolve a cloud task to a deliberately registered
// local repo before the serve bridge may spawn anything.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { normalizeRemote } = require('./team-tasks');
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
  const wanted = typeof projectId === 'string' ? projectId.trim() : '';
  if (!wanted) throw new LocalClaimError('A projectId is required. Names are not identity.');

  const matches = (Array.isArray(projects) ? projects : []).filter((p) => p?.id === wanted);
  if (!matches.length) {
    throw new LocalClaimError('No registered project with that id on this machine.', 404);
  }
  // `.find()` would quietly pick one. Ambiguity is a registry problem a human
  // must resolve, not something to guess through.
  if (matches.length > 1) {
    throw new LocalClaimError('More than one registered repo claims that id. Remove the stale registry entry before running.', 409);
  }
  return assertLiveIdentity(matches[0], originFor);
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

  const linked = (Array.isArray(projects) ? projects : [])
    .filter((project) => project?.serve === true && linkedCloudProjectId(project.path) === projectId);
  if (!linked.length) {
    throw new LocalClaimError('This cloud project is not linked to a project registered on this machine.', 404);
  }
  if (linked.length > 1) {
    throw new LocalClaimError('More than one registered repo is linked to this cloud project. Remove the stale registry entry before running.', 409);
  }

  // Same gate as a bound dispatch — one authority path, not two.
  const project = assertLiveIdentity(linked[0], originFor);

  return { project, projectId, taskId, runtimeId: runtimeId || null };
}

function claimCommand(binPath, claim) {
  return [binPath, 'ion', 'claim', claim.taskId, ...(claim.runtimeId ? ['--via', claim.runtimeId] : [])];
}

module.exports = {
  LocalClaimError, linkedCloudProjectId, liveOrigin, assertLiveIdentity,
  resolveRunTarget, resolveLocalClaim, claimCommand,
};
