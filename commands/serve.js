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
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { corsHeaders, isAllowedRequest } = require('../lib/cors');
const configFile = require('../lib/config-file');

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

// ─── Runtime Detection ─────────────────────────────────────────────────────

// Harness runners — shared table in lib/harnesses.js. PHEWSH is not a
// harness; it's the layer that dispatches to whichever harnesses you have.
// Detection is honest: a runtime is only "connected" if its binary is on PATH.
const { HARNESSES: RUNNERS, isInstalled } = require('../lib/harnesses');

function detectRuntimes() {
  const runtimes = [];

  for (const [id, r] of Object.entries(RUNNERS)) {
    runtimes.push({ id, label: r.label, connected: isInstalled(id) });
  }

  // Always report human as available
  runtimes.push({ id: 'human', label: 'You', connected: true });
  runtimes.push({ id: 'generic', label: 'AI Draft', connected: false });

  return runtimes;
}

// ─── Job Queue ─────────────────────────────────────────────────────────────

const { gatherReceipts, recordSessionEvent, recordResultFile } = require('../lib/receipts-data');

const jobs = new Map();

function createJob(actionId, runtimeId, packet) {
  const jobId = crypto.randomUUID();
  jobs.set(jobId, {
    jobId,
    actionId,
    runtimeId,
    packet,
    status: 'queued',
    statusText: 'Queued — waiting to execute',
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
  });
  // Work executed here must leave the same paper trail as the MCP path —
  // otherwise `phewsh receipts` has a blind spot for exactly the headline flow.
  recordSessionEvent(runtimeId || 'web', 'web', 'dispatch_enqueued', {
    jobId,
    actionId,
    taskSummary: packet?.objective?.task?.slice(0, 120),
  });
  return jobId;
}

async function executeJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = 'executing';
  job.statusText = 'Starting execution...';

  const { runtimeId, packet } = job;

  const runner = RUNNERS[runtimeId];
  if (runner) {
    await executeViaHarness(job, packet, runner);
  } else {
    job.status = 'error';
    job.error = `Runtime ${runtimeId} not supported for live execution yet`;
    job.statusText = 'Unsupported runtime';
  }
}

async function executeViaHarness(job, packet, runner) {
  // Build a prompt from the dispatch packet
  const prompt = [
    `# Task: ${packet.objective?.task || 'Execute task'}`,
    '',
    packet.objective?.task || '',
    '',
    packet.context?.plan ? `## Context\n${packet.context.plan}` : '',
    '',
    packet.verification?.criteria?.length
      ? `## Verify\n${packet.verification.criteria.map(c => `- ${c}`).join('\n')}`
      : '',
    '',
    '## Instructions',
    'Execute this task and report the result. Be specific about what you did and what the outcome was.',
    'If the task involves code, show the relevant code. If it involves commands, show what you ran.',
  ].filter(Boolean).join('\n');

  return new Promise((resolve) => {
    job.statusText = `Launching ${runner.label}...`;

    const child = spawn(runner.bin, runner.args(prompt), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd: process.cwd(),
    });

    // Some harnesses (codex exec, gemini) wait for stdin EOF before running.
    child.stdin.end();

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      // Update status with last line of output as progress indicator
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1].trim().slice(0, 80);
        job.statusText = lastLine || 'Working...';
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        job.status = 'done';
        job.result = stdout.trim();
        job.statusText = 'Complete';
        console.log(`  ${green('✓')} Job ${job.jobId.slice(0, 8)} completed`);
      } else {
        job.status = 'error';
        job.error = stderr.trim() || `${runner.label} exited with code ${code}`;
        job.statusText = 'Failed';
        console.log(`  ${yellow('✗')} Job ${job.jobId.slice(0, 8)} failed: ${job.error.slice(0, 100)}`);
      }
      // Leave a receipt: result file + session event, same shape as MCP path.
      const success = job.status === 'done';
      recordResultFile({
        projectId: 'web',
        taskId: packet?.id || job.actionId || job.jobId,
        result: success ? job.result : job.error,
        success,
        agentId: job.runtimeId,
        executor: 'phewsh-serve',
        reportedAt: new Date().toISOString(),
      });
      recordSessionEvent(job.runtimeId, 'web', 'task_complete', {
        taskId: packet?.id || job.actionId || job.jobId,
        success,
        result: (success ? job.result : job.error || '').slice(0, 200),
      });
      resolve();
    });

    child.on('error', (err) => {
      job.status = 'error';
      job.error = err.message;
      job.statusText = 'Failed to start';
      console.log(`  ${yellow('✗')} Job ${job.jobId.slice(0, 8)} error: ${err.message}`);
      resolve();
    });
  });
}

// ─── HTTP Server ───────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
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

    // Health check
    if (url.pathname === '/health' && req.method === 'GET') {
      return json(req, res, {
        status: 'ok',
        runtimes: detectRuntimes(),
        version: require('../package.json').version,
        uptime: process.uptime(),
      });
    }

    // Dispatch a task
    if (url.pathname === '/dispatch' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const { actionId, runtimeId, packet } = body;

        if (!actionId || !runtimeId || !packet) {
          return json(req, res, { error: 'Missing actionId, runtimeId, or packet' }, 400);
        }

        const jobId = createJob(actionId, runtimeId, packet);
        console.log(`  ${cyan('→')} Dispatched job ${jobId.slice(0, 8)} for ${runtimeId}: ${packet.objective?.task?.slice(0, 60) || 'task'}`);

        // Start execution in background
        executeJob(jobId);

        return json(req, res, { jobId, status: 'queued' });
      } catch (err) {
        return json(req, res, { error: err.message }, 400);
      }
    }

    // Mission control state — the same five rows bare `phewsh` shows, so
    // the web cockpit (phewsh.com/cockpit) mirrors the CLI to a T.
    if (url.pathname === '/cockpit' && req.method === 'GET') {
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
          project: { name: path.basename(process.cwd()), cwd: process.cwd(), intentFiles },
          route: routeId === 'api'
            ? { id: 'api', label: `API (${config.provider || 'anthropic'} key)` }
            : routeId ? { id: routeId, label: HARNESSES[routeId].label } : null,
          fallback: config.fallback === 'auto' ? 'auto' : 'ask',
          harnesses: harnessList,
          web: { loggedIn: !!config.supabaseUserId, email: config.email || null },
          record: outcomeStats(),
          pending: pendingDecisions().length,
          bypasses: bypassStats(),
          recentProjects: listProjects().slice(0, 5).map(p => ({ name: p.name, path: p.path, lastOpened: p.lastOpened })),
          version: require('../package.json').version,
        });
      } catch (err) {
        return json(req, res, { error: err.message }, 500);
      }
    }

    // The proof trail — same merged data as `phewsh receipts` and the MCP
    // bridge's /receipts, so the web can show evidence regardless of which
    // local bridge is running.
    if (url.pathname === '/receipts' && req.method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const project = url.searchParams.get('project') || null;
      return json(req, res, gatherReceipts({ project, limit }));
    }

    // Check job status
    const statusMatch = url.pathname.match(/^\/status\/(.+)$/);
    if (statusMatch && req.method === 'GET') {
      const jobId = statusMatch[1];
      const job = jobs.get(jobId);
      if (!job) return json(req, res, { error: 'Job not found' }, 404);
      return json(req, res, {
        jobId: job.jobId,
        status: job.status,
        statusText: job.statusText,
        result: job.result,
        error: job.error,
      });
    }

    // 404
    json(req, res, { error: 'Not found' }, 404);
  };

  const server = http.createServer(handleRequest);

  server.listen(port, '127.0.0.1', () => {
    const mirror = http.createServer(handleRequest);
    mirror.on('error', () => { /* IPv6 unavailable or already bound */ });
    mirror.listen(port, '::1');

    console.log('');
    console.log(`  ${b(w('PHEWSH Serve'))} ${g('v' + require('../package.json').version)}`);
    console.log(`  ${g('Live execution bridge for phewsh.com/ion and phewsh.com/intent')}`);
    console.log('');
    console.log(`  ${green('●')} Running on ${w(`http://localhost:${port}`)}`);
    console.log(`  ${g('Web cockpit:')} ${w('phewsh.com/cockpit')} ${g('— mirrors this machine live')}`);
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
    console.log(`  ${g('Open phewsh.com/ion to see the worker online, or phewsh.com/intent → Work')}`);
    console.log(`  ${g('Press Ctrl+C to stop')}`);
    console.log('');
  });
}

module.exports = main;
