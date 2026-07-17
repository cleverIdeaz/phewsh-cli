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

  const project = linked[0];
  const registeredRemote = normalizeRemote(project.remote);
  const currentRemote = originFor(project.path);
  if (!registeredRemote || !currentRemote || registeredRemote !== currentRemote) {
    throw new LocalClaimError('The registered repo identity no longer matches its live origin. Re-run `phewsh project add` inside the correct repo.', 409);
  }

  return { project, projectId, taskId, runtimeId: runtimeId || null };
}

function claimCommand(binPath, claim) {
  return [binPath, 'ion', 'claim', claim.taskId, ...(claim.runtimeId ? ['--via', claim.runtimeId] : [])];
}

module.exports = { LocalClaimError, linkedCloudProjectId, liveOrigin, resolveLocalClaim, claimCommand };
