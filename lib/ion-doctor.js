// Read-only preflight for the real two-person Ion walkthrough.
//
// This deliberately separates machine-verifiable evidence from browser/human
// evidence. It never writes config, refreshes tokens, registers projects,
// starts a worker, claims tasks, or treats REST reachability as realtime proof.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { serveProjects } = require('./projects-index');
const { normalizeRemote } = require('./team-tasks');
const { listHarnesses } = require('./harnesses');
const supabase = require('./supabase');

const DEFAULT_PORT = 7483;

function result(id, label, status, detail, fix = null) {
  return { id, label, status, detail, ...(fix ? { fix } : {}) };
}

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return fallback; }
}

function cloudProjectId(cwd) {
  try {
    const pps = JSON.parse(fs.readFileSync(path.join(cwd, '.intent', 'pps.json'), 'utf-8'));
    return pps?.adapters?.phewsh?.cloud_id || null;
  } catch { return null; }
}

function gitOrigin(cwd) {
  try {
    return normalizeRemote(execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim());
  } catch { return null; }
}

function githubReady() {
  try {
    execFileSync('gh', ['auth', 'status'], {
      stdio: 'ignore', timeout: 3000,
    });
    return true;
  } catch { return false; }
}

function samePath(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b); }
  catch { return path.resolve(a) === path.resolve(b); }
}

async function fetchHealth(fetchImpl, port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function summarize(checks) {
  return checks.reduce((summary, check) => {
    summary[check.status] = (summary[check.status] || 0) + 1;
    return summary;
  }, { pass: 0, fail: 0, human: 0, skip: 0 });
}

async function diagnoseIon(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const home = options.home || os.homedir();
  const config = options.config === undefined
    ? readJson(path.join(home, '.phewsh', 'config.json'), {})
    : (options.config || {});
  const registeredProjects = options.registeredProjects || serveProjects();
  const harnesses = options.harnesses || listHarnesses();
  const getOrigin = options.getOrigin || gitOrigin;
  const isGithubReady = options.isGithubReady || githubReady;
  const fetchImpl = options.fetchImpl || global.fetch;
  const cloud = options.supabase || supabase;
  const offline = options.offline === true;
  const port = options.port || DEFAULT_PORT;
  const checks = [];

  const hasTruth = fs.existsSync(path.join(cwd, '.intent', 'vision.md'));
  checks.push(hasTruth
    ? result('project-truth', 'Project truth', 'pass', '.intent/vision.md is present')
    : result('project-truth', 'Project truth', 'fail', 'No project-owned .intent/ truth here', 'Run `phewsh init` in the project repo'));

  const origin = getOrigin(cwd);
  checks.push(origin
    ? result('git-origin', 'Git identity', 'pass', `origin is ${origin}`)
    : result('git-origin', 'Git identity', 'fail', 'No readable Git origin', 'Add an origin remote so Phewsh can bind the correct repo'));

  const cloudId = cloudProjectId(cwd);
  checks.push(cloudId
    ? result('cloud-link', 'Cloud link', 'pass', 'This checkout carries a cloud project ID')
    : result('cloud-link', 'Cloud link', 'fail', 'This checkout is not linked to an Ion room', 'Run `phewsh push` or `phewsh link <id>`'));

  const registered = registeredProjects.find((project) => samePath(project.path, cwd));
  if (!registered) {
    checks.push(result('worker-registration', 'Worker registration', 'fail', 'This repo is not deliberately registered', 'Run `phewsh project add` inside this repo'));
  } else if (origin && normalizeRemote(registered.remote) !== origin) {
    checks.push(result('worker-registration', 'Worker registration', 'fail', 'Registered remote no longer matches the live Git origin', 'Remove and re-add this project registration'));
  } else {
    checks.push(result('worker-registration', 'Worker registration', 'pass', 'This repo is explicitly allowed on the local worker'));
  }

  const cliLoggedIn = !!(config.supabaseUserId && config.supabaseAccessToken);
  checks.push(cliLoggedIn
    ? result('cli-login', 'CLI account', 'pass', 'configured locally (identity and tokens are not printed)')
    : result('cli-login', 'CLI account', 'fail', 'No complete local Phewsh session', 'Run `phewsh login` (or `phewsh login --refresh` for an expired session)'));

  const headless = harnesses.filter((harness) => harness.installed && harness.headless);
  checks.push(headless.length
    ? result('harness', 'AI harness', 'pass', `${headless.map((harness) => harness.label || harness.id).join(' · ')} available`)
    : result('harness', 'AI harness', 'fail', 'No installed headless harness can claim work', 'Install or authenticate Claude Code, Codex, Gemini, or another supported harness'));

  checks.push(isGithubReady()
    ? result('github', 'GitHub PR path', 'pass', 'gh is installed and authenticated')
    : result('github', 'GitHub PR path', 'fail', 'gh is unavailable or not authenticated', 'Run `gh auth login`'));

  if (offline) {
    checks.push(result('worker-live', 'Local worker', 'skip', 'Offline mode did not contact loopback'));
    checks.push(result('cloud-room', 'Cloud room', 'skip', 'Offline mode did not contact Supabase'));
  } else {
    const health = typeof fetchImpl === 'function' ? await fetchHealth(fetchImpl, port) : null;
    const served = (health?.projects || []).find((project) =>
      (cloudId && project.cloudProjectId === cloudId)
      || (origin && project.remote && normalizeRemote(project.remote) === origin));
    checks.push(health?.status === 'ok' && served
      ? result('worker-live', 'Local worker', 'pass', `online on port ${port} and bound to this room`)
      : health?.status === 'ok'
        ? result('worker-live', 'Local worker', 'fail', `online on port ${port}, but this repo/room is not exposed`, 'Run `phewsh project add` here, then restart `phewsh serve` if needed')
        : result('worker-live', 'Local worker', 'fail', `not reachable on loopback port ${port}`, `Run \`phewsh serve${port === DEFAULT_PORT ? '' : ` --port ${port}`}\` in another terminal`));

    if (!cliLoggedIn || !cloudId) {
      checks.push(result('cloud-room', 'Cloud room', 'fail', 'Cloud access cannot be checked until login and linking pass', 'Fix the CLI account and cloud link above'));
    } else {
      try {
        const rows = await cloud.select('projects',
          `id=eq.${encodeURIComponent(cloudId)}&select=id,name,user_id,github_remote`,
          config.supabaseAccessToken);
        if (!rows.length) throw new Error('room not found or membership denied');
        const project = rows[0];
        if (origin && project.github_remote && normalizeRemote(project.github_remote) !== origin) {
          throw new Error('cloud room points to a different Git origin');
        }
        await cloud.select('tasks',
          `project_id=eq.${encodeURIComponent(cloudId)}&select=id,status&limit=1`,
          config.supabaseAccessToken);
        checks.push(result('cloud-room', 'Cloud room', 'pass', `read-only project and task access works${project.name ? ` for ${project.name}` : ''}`));
      } catch (error) {
        checks.push(result('cloud-room', 'Cloud room', 'fail', `Read-only access failed: ${error.message}`, 'Run `phewsh login --refresh`, then confirm this account is a room member'));
      }
    }
  }

  checks.push(result('browser-session', 'Browser account', 'human', 'Sign in at phewsh.com/ion in both browsers; the CLI cannot inspect browser sessions'));
  checks.push(result('realtime', 'Realtime propagation', 'human', 'With both rooms open, create a request in one; it must appear in the other without reload'));

  const summary = summarize(checks);
  return {
    version: 1,
    mode: offline ? 'offline' : 'online',
    readyForWalkthrough: summary.fail === 0 && !offline,
    checks,
    summary,
  };
}

module.exports = {
  DEFAULT_PORT,
  cloudProjectId,
  diagnoseIon,
  fetchHealth,
  gitOrigin,
  summarize,
};
