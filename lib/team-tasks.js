// Pure helpers for shared-project tasks (team-projects Phase 2).
// The command in commands/task.js does the network/git work; everything
// here is deterministic and unit-tested.

// "git@github.com:Owner/Repo.git" | "https://github.com/owner/repo" →
// "github.com/owner/repo" (lowercased) — the form stored in projects.github_remote.
function normalizeRemote(url) {
  if (!url || typeof url !== 'string') return null;
  let s = url.trim();
  if (!s) return null;
  s = s.replace(/^ssh:\/\//i, '');
  s = s.replace(/^[a-z+]+:\/\//i, '');      // https://, git://
  s = s.replace(/^git@([^:/]+)[:/]/i, '$1/'); // git@host:owner/repo → host/owner/repo
  s = s.replace(/^[^@]+@/, '');             // any other user@ prefix
  s = s.replace(/\.git$/i, '');
  s = s.replace(/\/+$/, '');
  return s.toLowerCase() || null;
}

// Deterministic branch per task: the task id is the idempotency key, so a
// retry after a crash reuses the same branch instead of creating a new one.
function taskBranch(taskId, title) {
  const short = String(taskId).replace(/-/g, '').slice(0, 8);
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '') || 'task';
  return `phewsh/${short}-${slug}`;
}

function taskLookupQuery(projectId, idArg) {
  const project = encodeURIComponent(String(projectId || ''));
  const id = String(idArg || '').trim();
  const fullId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (!/^[0-9a-f]{8}$/i.test(id) && !fullId) {
    throw new Error('Task id must be an 8-character hexadecimal prefix or a full UUID.');
  }
  const idFilter = fullId ? `id=eq.${id}` : `id=like.${id}*`;
  return `project_id=eq.${project}&${idFilter}&select=*`;
}

// Turn git's human-readable porcelain rows into the project-relative paths
// that will be proposed in the task PR. This does not infer what changed; it
// only records the paths git itself reported after the harness returned.
function changedPathsFromPorcelain(output) {
  const seen = new Set();
  const paths = [];
  const add = (file) => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    paths.push(file);
  };
  const text = String(output || '');
  if (text.includes('\0')) {
    const records = text.split('\0');
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      if (record.length < 4) continue;
      const status = record.slice(0, 2);
      add(record.slice(3));
      // In -z mode git emits the destination first, then the source as a
      // second NUL-delimited field with no status prefix. Keep the proposed
      // destination and skip that source-only field.
      if (/[RC]/.test(status)) i += 1;
    }
    return paths;
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const raw = line.slice(3);
    const renameAt = raw.lastIndexOf(' -> ');
    const file = (renameAt === -1 ? raw : raw.slice(renameAt + 4)).trim();
    add(file);
  }
  return paths;
}

// The prompt handed to the harness inside the isolated worktree.
function buildTaskPrompt(task) {
  const packet = task.packet || {};
  const objective = typeof packet.objective === 'string'
    ? packet.objective
    : packet.objective?.task || '';
  return [
    `# Task: ${task.title}`,
    '',
    objective,
    packet.context ? `\n## Context\n${typeof packet.context === 'string' ? packet.context : JSON.stringify(packet.context, null, 2)}` : '',
    Array.isArray(packet.verification) && packet.verification.length
      ? `\n## Verify\n${packet.verification.map((c) => `- ${c}`).join('\n')}`
      : '',
    '',
    '## Rules',
    '- You are working in an isolated git worktree on a dedicated branch. Stay in this directory.',
    '- Commit your changes here, but do not push, do not open PRs, and do not touch main — phewsh handles publication and review.',
    '- Run the project\'s tests if they exist and report the result honestly.',
  ].filter(Boolean).join('\n');
}

// The provisional record committed to .intent/work/task-<id>.json ON THE WORK
// BRANCH. Per the 2026-07-02 ruling it is NOT a decision: it becomes
// authoritative project truth only when the PR merges.
function proposedOutcome({ task, harnessId, host, branch, changedFiles = [], startedAt, finishedAt }) {
  const verification = Array.isArray(task.packet?.verification) ? task.packet.verification : [];
  return {
    status: 'proposed',
    note: 'Provisional proposed outcome — becomes authoritative project truth only when this branch\'s PR is merged.',
    task_id: task.id,
    title: task.title,
    requested_by: task.created_by,
    executed_by: { user: task.claimed_by, harness: harnessId, host },
    verification: verification.length ? verification : null,
    evidence: {
      branch: branch || null,
      changed_files: changedFiles,
      changed_file_count: changedFiles.length,
      tests: {
        status: 'not_recorded',
        requested: verification,
      },
    },
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

module.exports = { normalizeRemote, taskBranch, taskLookupQuery, changedPathsFromPorcelain, buildTaskPrompt, proposedOutcome };
