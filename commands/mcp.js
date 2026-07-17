// phewsh mcp — Preview, serve, and sync the optional PHEWSH MCP adapter.
//
// The MCP server ships inside this package (mcp/ — ESM subtree).
// No second install, no phewsh-mcp-server package.
//
// Usage:
//   phewsh mcp setup           — Print manual Claude Code config + sync project cache
//   phewsh mcp sync            — Sync local .intent/ + cloud projects → ~/.phewsh/projects.json
//   phewsh mcp status          — Check what agents can see right now
//   phewsh mcp serve           — Start the HTTP transport for the web bridge (:7483)
//   phewsh mcp serve --stdio   — Run the stdio MCP server (what agent configs point at)

const fs = require('fs');
const path = require('path');
const os = require('os');
const configFile = require('../lib/config-file');
const { spawn } = require('child_process');

const PHEWSH_DIR = path.join(os.homedir(), '.phewsh');
const PROJECTS_FILE = path.join(PHEWSH_DIR, 'projects.json');
const RESULTS_DIR = path.join(PHEWSH_DIR, 'results');
const SESSIONS_DIR = path.join(PHEWSH_DIR, 'sessions');
const INTENT_DIR = path.join(process.cwd(), '.intent');

// ANSI helpers
const b = (s) => `\x1b[1m${s}\x1b[0m`;
const d = (s) => `\x1b[2m${s}\x1b[0m`;
const g = (s) => `\x1b[90m${s}\x1b[0m`;
const w = (s) => `\x1b[97m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function ensureDirs() {
  [PHEWSH_DIR, RESULTS_DIR, SESSIONS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

function loadLocalProject() {
  if (!fs.existsSync(INTENT_DIR)) return null;

  const project = {
    id: 'local',
    name: path.basename(process.cwd()),
    source: 'local',
    artifacts: {},
    actions: [],
    decisionGate: null,
  };

  const files = ['vision.md', 'plan.md', 'next.md', 'status.md'];
  for (const file of files) {
    const filePath = path.join(INTENT_DIR, file);
    if (fs.existsSync(filePath)) {
      const kind = file.replace('.md', '');
      project.artifacts[kind] = {
        kind,
        content: fs.readFileSync(filePath, 'utf-8'),
      };
      if (kind === 'vision') {
        const firstLine = project.artifacts[kind].content.split('\n').find(l => l.trim().length > 5);
        if (firstLine) project.name = firstLine.replace(/^#+\s*/, '').trim().slice(0, 60);
      }
    }
  }

  // Read project.json for gate, actions, constraints
  const metaPath = path.join(INTENT_DIR, 'project.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      Object.assign(project, meta);
    } catch { /* ignore */ }
  }

  return Object.keys(project.artifacts).length > 0 ? project : null;
}

async function loadCloudProjects() {
  const configPath = path.join(PHEWSH_DIR, 'config.json');
  if (!fs.existsSync(configPath)) return [];

  const config = configFile.loadConfig(configPath);
  if (!config) return [];
  if (!config?.supabaseAccessToken || !config?.supabaseUserId) return [];

  try {
    const { select, refreshSession } = require('../lib/supabase');

    // Refresh token if needed
    if (config.supabaseRefreshToken) {
      const session = await refreshSession(config.supabaseRefreshToken);
      if (session?.access_token) {
        config.supabaseAccessToken = session.access_token;
        config.supabaseRefreshToken = session.refresh_token;
        configFile.saveConfig(configPath, config);
      }
    }

    const projects = await select(
      'projects',
      `user_id=eq.${config.supabaseUserId}&select=id,name,archetype,freeform_text,pps_json`,
      config.supabaseAccessToken
    );

    // Also fetch artifacts for each project
    const enriched = [];
    for (const p of projects) {
      const artifacts = await select(
        'artifacts',
        `project_id=eq.${p.id}&user_id=eq.${config.supabaseUserId}&select=kind,content`,
        config.supabaseAccessToken
      ).catch(() => []);

      const artifactsMap = {};
      for (const a of artifacts) {
        artifactsMap[a.kind] = { kind: a.kind, content: a.content };
      }

      enriched.push({
        id: p.id,
        name: p.name,
        source: 'cloud',
        archetype: p.archetype,
        tldr: p.freeform_text?.slice(0, 200),
        artifacts: artifactsMap,
        actions: p.pps_json?.actions || [],
        decisionGate: p.pps_json?.decisionGate || null,
      });
    }
    return enriched;
  } catch (err) {
    console.log(g(`  Could not fetch cloud projects: ${err.message}`));
    return [];
  }
}

// The server is bundled with this package — no hunting.
const MCP_SERVER_PATH = path.join(__dirname, '..', 'mcp', 'index.js');
const MCP_HTTP_PATH = path.join(__dirname, '..', 'mcp', 'http-server.js');

function findMcpServerPath() {
  return fs.existsSync(MCP_SERVER_PATH) ? MCP_SERVER_PATH : null;
}

function findHttpServerPath() {
  return fs.existsSync(MCP_HTTP_PATH) ? MCP_HTTP_PATH : null;
}

const DEFAULT_HTTP_PORT = 7483;

async function probeHttp(port = DEFAULT_HTTP_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function serveStdio() {
  // stdio MCP server: stdout IS the protocol — print nothing here.
  ensureDirs();
  const child = spawn(process.execPath, [MCP_SERVER_PATH], {
    stdio: 'inherit',
    env: { ...process.env },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  const shutdown = () => { if (!child.killed) child.kill('SIGTERM'); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function serve() {
  if (process.argv.includes('--stdio')) {
    serveStdio();
    return;
  }

  console.log('');
  console.log(`  ${b(w('PHEWSH MCP HTTP transport'))}`);
  console.log('');

  ensureDirs();

  const httpPath = findHttpServerPath();
  if (!httpPath) {
    console.log(`  ${yellow('HTTP transport not found.')} Expected bundled at ${g(MCP_HTTP_PATH)}`);
    console.log(`  ${g('Reinstall: npm i -g phewsh')}`);
    return;
  }

  const port = parseInt(process.env.PHEWSH_MCP_PORT || String(DEFAULT_HTTP_PORT), 10);

  const existing = await probeHttp(port);
  if (existing) {
    console.log(`  ${yellow('Already running')} on port ${port} (v${existing.version || '?'}).`);
    console.log(`  ${g('Stop the other process or set PHEWSH_MCP_PORT to use a different port.')}`);
    return;
  }

  const child = spawn(process.execPath, [httpPath], {
    stdio: 'inherit',
    env: { ...process.env, PHEWSH_MCP_PORT: String(port) },
  });

  console.log(`  ${green('Starting on')} ${w('http://127.0.0.1:' + port)}`);
  console.log(`  ${g('The intent web app will see this on its next health check.')}`);
  console.log(`  ${g('Stop with Ctrl-C.')}`);
  console.log('');

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });

  const shutdown = () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function setup() {
  console.log(`\n  ${b('Manual MCP client setup')} ${g('— Phewsh will not edit agent config')}`);
  console.log('');
  console.log(`  ${b(w('PHEWSH MCP Setup'))}`);
  console.log(`  ${g('Connect your AI agents to your project intelligence')}`);
  console.log('');

  ensureDirs();

  // 1. Confirm the bundled server is present
  const serverPath = findMcpServerPath();

  if (!serverPath) {
    console.log(`  ${yellow('Bundled MCP server missing.')} Reinstall: ${w('npm i -g phewsh')}`);
    console.log('');
    return;
  }

  console.log(`  ${green('MCP server:')} ${g('bundled with phewsh — no separate install')}`);

  // 2. Print a settings.json snippet — points at phewsh itself, survives upgrades
  const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const snippet = {
    mcpServers: {
      phewsh: {
        command: 'phewsh',
        args: ['mcp', 'serve', '--stdio'],
      },
    },
  };

  console.log('');
  console.log(`  ${b('Add this to')} ${w(claudeSettingsPath)}${b(':')}`);
  console.log('');
  console.log(g('  ' + JSON.stringify(snippet, null, 2).split('\n').join('\n  ')));
  console.log('');

  // Check if already configured — and flag stale configs from the two-package era
  if (fs.existsSync(claudeSettingsPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
      const current = existing.mcpServers?.phewsh;
      if (current?.command === 'phewsh') {
        console.log(`  ${green('Already configured in Claude Code settings.')}`);
      } else if (current) {
        console.log(`  ${yellow('Configured the old way')} (${g(current.command + ' ' + (current.args || []).join(' '))}).`);
        console.log(`  ${g('Update it to the snippet above — the server now ships inside phewsh.')}`);
      } else {
        console.log(`  ${yellow('Not yet configured.')} Add the snippet above to your settings.`);
      }
    } catch { /* ignore */ }
  }

  // 4. Sync projects
  console.log('');
  console.log(`  ${g('Running initial sync...')}`);
  await sync();
}

async function sync() {
  ensureDirs();

  const projects = [];
  let localCount = 0;
  let cloudCount = 0;

  // Load local project
  const local = loadLocalProject();
  if (local) {
    projects.push(local);
    localCount = 1;
  }

  // Load cloud projects
  const cloud = await loadCloudProjects();
  // Deduplicate — if local project matches a cloud one by name, prefer local
  for (const cp of cloud) {
    if (!projects.find(p => p.name === cp.name)) {
      projects.push(cp);
      cloudCount++;
    }
  }

  // Write projects.json
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));

  console.log('');
  console.log(`  ${green('Synced')} ${b(projects.length + '')} project${projects.length !== 1 ? 's' : ''} → ${g(PROJECTS_FILE)}`);
  if (localCount > 0) console.log(`    ${localCount} from local .intent/`);
  if (cloudCount > 0) console.log(`    ${cloudCount} from cloud`);
  projects.forEach(p => {
    const actions = p.actions || [];
    const pending = actions.filter(a => a.state === 'intended').length;
    const progress = actions.length > 0
      ? ` (${actions.filter(a => a.state === 'reconciled').length}/${actions.length} tasks)`
      : '';
    console.log(`    ${g('•')} ${p.name}${progress}${pending > 0 ? ` — ${pending} pending` : ''}`);
  });
  console.log('');
}

async function status() {
  ensureDirs();

  console.log('');
  console.log(`  ${b(w('PHEWSH MCP Status'))}`);
  console.log('');

  // Check projects.json
  if (fs.existsSync(PROJECTS_FILE)) {
    try {
      const projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
      console.log(`  ${green('projects.json:')} ${projects.length} project${projects.length !== 1 ? 's' : ''}`);
      projects.forEach(p => {
        const actions = p.actions || [];
        const pending = actions.filter(a => a.state === 'intended').length;
        console.log(`    ${g('•')} ${p.name} [${p.source || 'unknown'}]${pending > 0 ? ` — ${yellow(pending + ' pending')}` : ''}`);
      });
    } catch {
      console.log(`  ${yellow('projects.json:')} exists but unreadable`);
    }
  } else {
    console.log(`  ${yellow('projects.json:')} not found. Run ${w('phewsh mcp sync')} first.`);
  }

  // Check results
  if (fs.existsSync(RESULTS_DIR)) {
    const resultFiles = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json'));
    const blockers = resultFiles.filter(f => f.startsWith('blocker_'));
    const completions = resultFiles.filter(f => !f.startsWith('blocker_'));
    if (resultFiles.length > 0) {
      console.log(`  ${green('results:')} ${completions.length} completion${completions.length !== 1 ? 's' : ''}, ${blockers.length} blocker${blockers.length !== 1 ? 's' : ''}`);
    } else {
      console.log(`  ${g('results:')} none yet`);
    }
  }

  // Check sessions
  if (fs.existsSync(SESSIONS_DIR)) {
    const sessionFiles = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    if (sessionFiles.length > 0) {
      let totalEvents = 0;
      for (const f of sessionFiles) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
          totalEvents += data.length;
        } catch { /* skip */ }
      }
      console.log(`  ${green('sessions:')} ${totalEvents} events across ${sessionFiles.length} project${sessionFiles.length !== 1 ? 's' : ''}`);
    } else {
      console.log(`  ${g('sessions:')} none yet`);
    }
  }

  // Check MCP server
  const serverPath = findMcpServerPath();
  if (serverPath) {
    console.log(`  ${green('server:')} ${g(serverPath)}`);
  } else {
    console.log(`  ${yellow('server:')} not found. Run ${w('phewsh mcp setup')}`);
  }

  // Check HTTP transport (the bridge to the web app)
  const httpPort = parseInt(process.env.PHEWSH_MCP_PORT || String(DEFAULT_HTTP_PORT), 10);
  const httpHealth = await probeHttp(httpPort);
  if (httpHealth) {
    const rtCount = Array.isArray(httpHealth.runtimes) ? httpHealth.runtimes.length : 0;
    console.log(`  ${green('http bridge:')} alive on :${httpPort} (v${httpHealth.version || '?'}) — ${rtCount} runtime${rtCount === 1 ? '' : 's'} connected`);
    if (rtCount > 0) {
      httpHealth.runtimes.forEach(rt => {
        console.log(`    ${g('•')} ${rt.id}${rt.label !== rt.id ? ` (${rt.label})` : ''} ${g('[' + (rt.transport || 'unknown') + ']')}`);
      });
    }
  } else {
    console.log(`  ${yellow('http bridge:')} not running. Start with ${w('phewsh mcp serve')} to connect the intent web app.`);
  }

  // Check Claude Code config
  const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (fs.existsSync(claudeSettingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
      if (settings.mcpServers?.phewsh) {
        console.log(`  ${green('claude code:')} configured`);
      } else {
        console.log(`  ${yellow('claude code:')} settings exist but phewsh not configured`);
      }
    } catch {
      console.log(`  ${yellow('claude code:')} settings unreadable`);
    }
  } else {
    console.log(`  ${g('claude code:')} no settings.json found`);
  }

  console.log('');
}

async function main() {
  const subcommand = process.argv[3] || 'status';

  switch (subcommand) {
    case 'setup':
      await setup();
      break;
    case 'sync':
      await sync();
      break;
    case 'status':
      await status();
      break;
    case 'serve':
      await serve();
      break;
    case 'token': {
      const { mintToken } = require('../lib/mcp-token');
      try {
        const out = await mintToken();
        console.log(`\n  ${b('Remote MCP token')} (Supabase JWT${out.expiresInMin !== null ? `, expires in ~${out.expiresInMin} min` : ''})\n`);
        console.log(`  ${out.token}\n`);
        console.log(`  ${green('Connect Claude Code:')}`);
        console.log(`  ${w(out.addCommand)}\n`);
        console.log(`  ${d('For a long-lived key instead, use a phewsh API key from phewsh.com/api.')}\n`);
      } catch (err) {
        console.error(`\n  ${yellow(err.message)}\n`);
        process.exitCode = 1;
      }
      break;
    }
    default:
      console.log(`\n  ${b('phewsh mcp')} — Connect AI agents to your project intelligence\n`);
      console.log(`  ${w('setup')}            Print manual Claude Code config + sync project cache`);
      console.log(`  ${w('sync')}             Sync projects → ~/.phewsh/projects.json`);
      console.log(`  ${w('status')}           Check what agents can see right now`);
      console.log(`  ${w('serve')}            Run the HTTP bridge for the web app (:7483)`);
      console.log(`  ${w('serve --stdio')}    Run the stdio MCP server (for agent configs)`);
      console.log(`  ${w('token')}            Print a bearer token for the remote MCP server`);
      console.log('');
  }
}

module.exports = main;
