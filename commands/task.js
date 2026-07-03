// phewsh task — shared-project tasks (team-projects Phase 2, 2026-07-02 ruling)
//
//   phewsh task                 List tasks for the linked cloud project
//   phewsh task new <title>     Request a task teammates (or you) can claim
//   phewsh task claim <id>      Manually claim + execute on an isolated branch + open a PR
//     --via <harness>           Route to a specific installed harness
//
// Boundaries (approved ruling): claiming is MANUAL — no daemon, no auto-claim.
// Work happens on a dedicated branch in a dedicated worktree, never on main.
// The branch carries a PROVISIONAL .intent/work/task-<id>.json — it becomes
// project truth only when the PR merges. Supabase holds coordination state only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const configFile = require('../lib/config-file');
const supa = require('../lib/supabase');
const { normalizeRemote, taskBranch, buildTaskPrompt, proposedOutcome } = require('../lib/team-tasks');
const { HARNESSES, listHarnesses } = require('../lib/harnesses');
const { recordResultFile } = require('../lib/receipts-data');

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const g = (s) => `\x1b[38;5;247m${s}\x1b[0m`;
const w = (s) => `\x1b[97m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

const CONFIG_PATH = path.join(os.homedir(), '.phewsh', 'config.json');

const STATUS_COLOR = {
  open: cyan, claimed: w, in_progress: w, pr_open: green,
  approved: green, merged: green, reconciled: green,
  rejected: red, failed: red, cancelled: g,
};

async function getSession() {
  const config = configFile.loadConfig(CONFIG_PATH, {});
  if (!config.supabaseUserId) {
    throw new Error('Not logged in. Run `phewsh login` first.');
  }
  if (!config.supabaseAccessToken && config.supabaseRefreshToken) {
    const session = await supa.refreshSession(config.supabaseRefreshToken);
    if (session?.access_token) {
      config.supabaseAccessToken = session.access_token;
      config.supabaseRefreshToken = session.refresh_token;
      try { configFile.saveConfig(CONFIG_PATH, config); } catch { /* best-effort */ }
    }
  }
  if (!config.supabaseAccessToken) throw new Error('Session expired. Run `phewsh login` again.');
  return config;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function loadCloudProjectId() {
  const ppsPath = path.join(process.cwd(), '.intent', 'pps.json');
  try {
    const pps = JSON.parse(fs.readFileSync(ppsPath, 'utf-8'));
    return pps?.adapters?.phewsh?.cloud_id || null;
  } catch {
    return null;
  }
}

async function loadProject(config) {
  const cloudId = loadCloudProjectId();
  if (!cloudId) {
    throw new Error('This project is not linked to the cloud. Run `phewsh push` (or `phewsh link <id>`) first.');
  }
  const rows = await supa.select('projects', `id=eq.${cloudId}&select=id,name,user_id,archetype,github_remote`, config.supabaseAccessToken);
  if (!rows.length) throw new Error(`Cloud project ${cloudId} not found (or you are not a member).`);
  return rows[0];
}

// The claiming CLI must be sitting in the repo this project coordinates.
async function ensureRemoteMatch(project, config) {
  let local;
  try {
    local = normalizeRemote(git(['remote', 'get-url', 'origin'], process.cwd()));
  } catch {
    throw new Error('Not a git repository with an `origin` remote — claim from the project repo.');
  }
  if (!project.github_remote) {
    if (project.user_id === config.supabaseUserId) {
      await supa.upsert('projects', {
        id: project.id, user_id: project.user_id, name: project.name,
        archetype: project.archetype, github_remote: local,
      }, config.supabaseAccessToken);
      console.log(`  ${g('Project repo bound to')} ${w(local)}`);
      return local;
    }
    throw new Error('Project has no github_remote yet — ask the owner to claim once (or set it) first.');
  }
  if (normalizeRemote(project.github_remote) !== local) {
    throw new Error(`Repo mismatch: project coordinates ${project.github_remote}, but this repo's origin is ${local}. Refusing to claim.`);
  }
  return local;
}

function pickHarness(viaFlag, config) {
  const installed = listHarnesses().filter((h) => h.installed && h.headless);
  if (viaFlag) {
    const hit = installed.find((h) => h.id === viaFlag);
    if (!hit) throw new Error(`--via ${viaFlag}: not an installed headless harness (${installed.map((h) => h.id).join(', ') || 'none found'})`);
    return hit.id;
  }
  if (config.defaultRoute && config.defaultRoute !== 'api' && installed.some((h) => h.id === config.defaultRoute)) {
    return config.defaultRoute;
  }
  if (!installed.length) throw new Error('No headless harness installed (Claude Code, Codex, Gemini, …).');
  return installed[0].id;
}

// One-shot, human-visible, file-editing runs inside an isolated worktree.
// claude-code/codex need explicit flags for that; others use the shared table.
function runnerArgs(harnessId, prompt) {
  if (harnessId === 'claude-code') return ['-p', prompt, '--permission-mode', 'acceptEdits'];
  if (harnessId === 'codex') return ['exec', '--full-auto', '--skip-git-repo-check', prompt];
  return HARNESSES[harnessId].args(prompt);
}

async function listTasks(config) {
  const project = await loadProject(config);
  const rows = await supa.select('tasks',
    `project_id=eq.${project.id}&select=id,title,status,claimed_by,pull_request_url,created_at&order=created_at.desc&limit=20`,
    config.supabaseAccessToken);
  console.log(`\n  ${b(w(project.name))} ${g('— shared tasks')}\n`);
  if (!rows.length) {
    console.log(`  ${g('No tasks yet.')} ${w('phewsh task new "<title>"')} ${g('to request one.')}\n`);
    return;
  }
  for (const t of rows) {
    const color = STATUS_COLOR[t.status] || w;
    const mine = t.claimed_by === config.supabaseUserId ? g(' · claimed by you') : '';
    console.log(`  ${color('●')} ${w(t.title)}  ${g(t.id.slice(0, 8))} ${color(t.status)}${mine}`);
    if (t.pull_request_url) console.log(`      ${cyan(t.pull_request_url)}`);
  }
  console.log(`\n  ${g('Claim one:')} ${w('phewsh task claim <id>')}\n`);
}

async function inviteTeammate(config, email) {
  if (!email || !email.includes('@')) throw new Error('Usage: phewsh task invite <email>');
  const project = await loadProject(config);
  if (project.user_id !== config.supabaseUserId) throw new Error('Only the project owner can invite (Phase 2).');
  await supa.insert('project_invites', {
    project_id: project.id, email, invited_by: config.supabaseUserId,
  }, config.supabaseAccessToken);
  console.log(`\n  ${green('✓')} Invited ${w(email)} to ${w(project.name)}`);
  console.log(`  ${g('They join with')} ${w('phewsh task join')} ${g('(CLI) or the Join banner on phewsh.com/intent/dashboard')}\n`);
}

async function joinProjects(config) {
  // RLS also shows an owner their own outbound invites — only accept ours.
  const invites = (await supa.select('project_invites',
    'accepted_at=is.null&select=id,project_id,email,created_at', config.supabaseAccessToken))
    .filter((inv) => inv.email?.toLowerCase() === (config.email || '').toLowerCase());
  if (!invites.length) {
    console.log(`\n  ${g('No pending invites for your account.')}\n`);
    return;
  }
  for (const inv of invites) {
    await supa.rpc('accept_project_invite', { invite_id: inv.id }, config.supabaseAccessToken);
    console.log(`\n  ${green('✓')} Joined project ${w(inv.project_id)}`);
  }
  console.log(`  ${g('See its tasks from the project repo:')} ${w('phewsh task')}\n`);
}

async function newTask(config, title) {
  if (!title) throw new Error('Usage: phewsh task new "<title>"');
  const project = await loadProject(config);
  const rows = await supa.insert('tasks', {
    project_id: project.id,
    created_by: config.supabaseUserId,
    title,
    packet: { objective: title },
  }, config.supabaseAccessToken);
  console.log(`\n  ${green('✓')} Task requested: ${w(title)}  ${g(rows[0].id.slice(0, 8))}`);
  console.log(`  ${g('Anyone on the project can now:')} ${w(`phewsh task claim ${rows[0].id.slice(0, 8)}`)}\n`);
}

async function claimTask(config, idArg, viaFlag) {
  if (!idArg) throw new Error('Usage: phewsh task claim <task-id>');
  const project = await loadProject(config);
  await ensureRemoteMatch(project, config);

  // Preflights BEFORE claiming, so a failed claim never strands a task.
  const harnessId = pickHarness(viaFlag, config);
  try { execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' }); } catch {
    throw new Error('`gh` is not installed or not authenticated — needed to open the PR. Run `gh auth login`.');
  }

  // `claim next` = the oldest open task; otherwise resolve a short id prefix.
  if (idArg === 'next') {
    const open = await supa.select('tasks',
      `project_id=eq.${project.id}&status=eq.open&select=id&order=created_at.asc&limit=1`, config.supabaseAccessToken);
    if (!open.length) throw new Error('No open tasks to claim.');
    idArg = open[0].id;
  }
  const candidates = await supa.select('tasks',
    `project_id=eq.${project.id}&id=like.${idArg}*&select=*`, config.supabaseAccessToken)
    .catch(() => []);
  const task = candidates.length === 1
    ? candidates[0]
    : (await supa.select('tasks', `id=eq.${idArg}&select=*`, config.supabaseAccessToken))[0];
  if (!task) throw new Error(`Task ${idArg} not found in this project.`);

  const claimed = await supa.rpc('claim_task', { p_task_id: task.id }, config.supabaseAccessToken);
  claimed.packet = claimed.packet || task.packet;
  console.log(`\n  ${green('✓')} Claimed ${w(claimed.title)} ${g(claimed.id.slice(0, 8))}`);

  // Isolated worktree on a deterministic branch (task id = idempotency key).
  const repoRoot = git(['rev-parse', '--show-toplevel'], process.cwd());
  const branch = taskBranch(claimed.id, claimed.title);
  const worktree = path.join(os.homedir(), '.phewsh', 'worktrees', `${path.basename(repoRoot)}-${claimed.id.slice(0, 8)}`);
  if (!fs.existsSync(worktree)) {
    const branchExists = spawnSync('git', ['rev-parse', '--verify', branch], { cwd: repoRoot }).status === 0;
    git(['worktree', 'add', worktree, ...(branchExists ? [branch] : ['-b', branch])], repoRoot);
  }
  console.log(`  ${g('Branch')} ${w(branch)} ${g('in worktree')} ${w(worktree)}`);

  const host = os.hostname();
  const startedAt = new Date().toISOString();
  await supa.rpc('start_execution', { p_task_id: claimed.id, p_metadata: { harness: harnessId, host } }, config.supabaseAccessToken);

  console.log(`  ${g('Running')} ${w(HARNESSES[harnessId].label)} ${g('— its output follows:')}\n`);
  const run = spawnSync(HARNESSES[harnessId].bin, runnerArgs(harnessId, buildTaskPrompt(claimed)), {
    cwd: worktree, stdio: 'inherit', env: { ...process.env },
  });
  const finishedAt = new Date().toISOString();

  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf-8' }).stdout.trim();
  if (run.status !== 0 && !dirty) {
    await supa.rpc('complete_execution', { p_task_id: claimed.id, p_success: false, p_metadata: { reason: 'harness_failed', exit: run.status } }, config.supabaseAccessToken);
    throw new Error(`${HARNESSES[harnessId].label} exited ${run.status} with no changes — task marked failed.`);
  }
  if (!dirty) {
    await supa.rpc('complete_execution', { p_task_id: claimed.id, p_success: false, p_metadata: { reason: 'no_changes' } }, config.supabaseAccessToken);
    throw new Error('The run produced no changes — nothing to propose. Task marked failed (honestly).');
  }

  // Provisional proposed outcome ON THE BRANCH — truth only after merge.
  const outcome = proposedOutcome({ task: claimed, harnessId, host, startedAt, finishedAt });
  const workDir = path.join(worktree, '.intent', 'work');
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, `task-${claimed.id}.json`), JSON.stringify(outcome, null, 2) + '\n');
  recordResultFile({ taskId: claimed.id, kind: 'team-task', branch, ...outcome });

  git(['add', '-A'], worktree);
  git(['commit', '-m', `task ${claimed.id.slice(0, 8)}: ${claimed.title}\n\nProposed via phewsh task claim (${harnessId} on ${host}). Provisional until merged.`], worktree);
  git(['push', '-u', 'origin', branch], worktree);
  await supa.rpc('complete_execution', { p_task_id: claimed.id, p_success: true, p_metadata: { harness: harnessId } }, config.supabaseAccessToken);

  const prBody = [
    `Shared phewsh task \`${claimed.id}\`: ${claimed.title}`,
    '',
    `- requested by: ${claimed.created_by}`,
    `- executed by: ${config.email || config.supabaseUserId} via ${HARNESSES[harnessId].label} on ${host}`,
    `- provisional outcome: \`.intent/work/task-${claimed.id}.json\` (authoritative only when merged)`,
    '',
    '🤖 Proposed with [phewsh](https://phewsh.com) — review, then approve or reject from the project room or GitHub.',
  ].join('\n');
  const prUrl = execFileSync('gh', ['pr', 'create', '--head', branch, '--title', `task: ${claimed.title}`, '--body', prBody], { cwd: worktree, encoding: 'utf-8' }).trim().split('\n').pop();

  await supa.rpc('open_pr', { p_task_id: claimed.id, p_branch: branch, p_pull_request_url: prUrl }, config.supabaseAccessToken);

  console.log(`\n  ${green('✓')} PR open: ${cyan(prUrl)}`);
  console.log(`  ${g('Teammates can review from the project room. Worktree kept at')} ${w(worktree)}`);
  console.log(`  ${g('Clean up later:')} ${w(`git worktree remove ${worktree}`)}\n`);
}

// `phewsh dispatch` is the friendly verb over the same machinery — no second
// architecture. Bare = list; an id prefix = claim; anything else = new task.
function dispatchToTaskArgs(args) {
  const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  if (!positional.length) return ['list'];
  if (positional.length === 1 && (positional[0] === 'next' || /^[0-9a-f-]{6,36}$/i.test(positional[0]))) return ['claim', ...args];
  return ['new', ...args];
}

module.exports = async function run() {
  let args = process.argv.slice(3);
  if (process.argv[2] === 'dispatch') args = dispatchToTaskArgs(args);
  const sub = args[0] || 'list';
  const viaIdx = args.indexOf('--via');
  const via = viaIdx !== -1 ? args[viaIdx + 1] : null;
  const rest = args.filter((a, i) => i > 0 && i !== viaIdx && i !== viaIdx + 1);

  try {
    const config = await getSession();
    if (sub === 'list') return await listTasks(config);
    if (sub === 'new') return await newTask(config, rest.join(' ').trim());
    if (sub === 'claim') return await claimTask(config, rest[0], via);
    if (sub === 'invite') return await inviteTeammate(config, rest[0]);
    if (sub === 'join') return await joinProjects(config);
    console.log(`\n  Usage: phewsh task [list | new "<title>" | claim <id> [--via <harness>] | invite <email> | join]\n         phewsh dispatch ["<title>" | <id> | next] [--via <harness>]\n`);
  } catch (err) {
    console.error(`\n  ${red('✗')} ${err.message}\n`);
    process.exitCode = 1;
  }
};

module.exports.dispatchToTaskArgs = dispatchToTaskArgs;
