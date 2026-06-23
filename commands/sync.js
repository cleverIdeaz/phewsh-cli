// phewsh intent --sync
// Syncs .intent/ artifacts to/from Supabase — same tables used by phewsh.com/intent

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { select, upsert, refreshSession } = require('../lib/supabase');
const { readPPS, writePPS } = require('../lib/pps');
const configFile = require('../lib/config-file');

const CONFIG_PATH = path.join(os.homedir(), '.phewsh', 'config.json');
const INTENT_DIR = path.join(process.cwd(), '.intent');

const FILE_TO_KIND = { 'vision.md': 'vision', 'plan.md': 'plan', 'next.md': 'next' };
const KIND_TO_FILE = { vision: 'vision.md', plan: 'plan.md', next: 'next.md' };

function loadConfig() {
  return configFile.loadConfig(CONFIG_PATH);
}

function saveConfig(config) {
  configFile.saveConfig(CONFIG_PATH, config);
}

function genProjectId() {
  return `p_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function getProjectName() {
  // Try to read entity from vision.md frontmatter, fall back to directory name
  const visionPath = path.join(INTENT_DIR, 'vision.md');
  if (fs.existsSync(visionPath)) {
    const content = fs.readFileSync(visionPath, 'utf-8');
    const match = content.match(/^entity:\s*(.+)$/m);
    if (match) return match[1].trim();
  }
  return path.basename(process.cwd());
}

async function ensureValidToken(config) {
  // Try to refresh if we have a refresh token
  if (!config.supabaseAccessToken && config.supabaseRefreshToken) {
    const session = await refreshSession(config.supabaseRefreshToken);
    if (session?.access_token) {
      config.supabaseAccessToken = session.access_token;
      config.supabaseRefreshToken = session.refresh_token;
      saveConfig(config);
    }
  }
  return config.supabaseAccessToken;
}

async function push(config, token) {
  if (!fs.existsSync(INTENT_DIR)) {
    console.log('\n  No .intent/ found. Run `phewsh intent --init` first.\n');
    process.exit(1);
  }

  const projectName = getProjectName();
  const userId = config.supabaseUserId;

  // Find or create the project
  let project;
  const existing = await select(
    'projects',
    `name=eq.${encodeURIComponent(projectName)}&user_id=eq.${userId}&select=id,name`,
    token
  );

  // Read pps.json if it exists
  const localPPS = readPPS(INTENT_DIR);
  const archetype = localPPS?.archetype || 'product';
  const projectId = localPPS?.adapters?.phewsh?.cloud_id || null;

  if (existing.length > 0) {
    project = existing[0];
  } else if (projectId) {
    // Linked to a specific cloud project — fetch it
    const linked = await select('projects', `id=eq.${projectId}&user_id=eq.${userId}&select=id,name`, token).catch(() => []);
    project = linked[0] || null;
  }

  if (!project) {
    const payload = {
      id: (localPPS?.adapters?.phewsh?.cloud_id) || genProjectId(),
      user_id: userId,
      name: projectName,
      archetype,
      freeform_text: localPPS?.intent?.raw || '',
    };
    if (localPPS) payload.pps_json = localPPS;
    const created = await upsert('projects', payload, token);
    project = Array.isArray(created) ? created[0] : created;
    console.log(`  Created project: ${projectName}`);
  } else if (localPPS) {
    // Update pps_json on existing project
    await upsert('projects', {
      id: project.id,
      user_id: userId,
      name: projectName,
      archetype,
      freeform_text: localPPS.intent?.raw || '',
      pps_json: localPPS,
    }, token).catch(() => {});
  }

  // Store cloud project_id back into local pps.json for linking
  if (localPPS && project?.id) {
    if (!localPPS.adapters) localPPS.adapters = {};
    if (!localPPS.adapters.phewsh) localPPS.adapters.phewsh = {};
    localPPS.adapters.phewsh.cloud_id = project.id;
    localPPS.adapters.phewsh.last_synced = new Date().toISOString();
    localPPS.adapters.phewsh.last_updated_by = 'cli';
    writePPS(INTENT_DIR, localPPS);
  }

  // Push each artifact file
  const pushed = [];
  for (const [file, kind] of Object.entries(FILE_TO_KIND)) {
    const filePath = path.join(INTENT_DIR, file);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf-8');
    await upsert('artifacts', {
      project_id: project.id,
      user_id: userId,
      kind,
      content,
    }, token);
    pushed.push(file);
  }
  if (localPPS) pushed.unshift('pps.json');

  // Push project.json state (decisionGate, actions, etc.) into project_state JSONB
  const projectJsonPath = path.join(INTENT_DIR, 'project.json');
  if (fs.existsSync(projectJsonPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
      const projectState = {};
      if (meta.decisionGate) projectState.decisionGate = meta.decisionGate;
      if (meta.actions) projectState.actions = meta.actions;
      if (Object.keys(projectState).length > 0) {
        await upsert('projects', {
          id: project.id,
          user_id: userId,
          name: projectName,
          tldr: meta.tldr || null,
          project_state: projectState,
          updated_at: new Date().toISOString(),
        }, token).catch(() => {});
        pushed.push('project.json → project_state');
      }
    } catch { /* ignore parse errors */ }
  }

  // Push gate.json into project_state if it exists separately
  const gatePath = path.join(INTENT_DIR, 'gate.json');
  if (fs.existsSync(gatePath) && !fs.existsSync(projectJsonPath)) {
    try {
      const gate = JSON.parse(fs.readFileSync(gatePath, 'utf-8'));
      await upsert('projects', {
        id: project.id,
        user_id: userId,
        name: projectName,
        project_state: { decisionGate: gate },
        updated_at: new Date().toISOString(),
      }, token).catch(() => {});
      pushed.push('gate.json → project_state');
    } catch { /* ignore parse errors */ }
  }

  console.log(`\n  ✓ Pushed to cloud — ${projectName} (${project.id})`);
  pushed.forEach(f => console.log(`    ${f}`));
  console.log('');
}

async function pull(config, token, cloudId = null) {
  const projectName = getProjectName();
  const userId = config.supabaseUserId;

  let query = cloudId
    ? `id=eq.${cloudId}&user_id=eq.${userId}&select=id,name,pps_json`
    : `name=eq.${encodeURIComponent(projectName)}&user_id=eq.${userId}&select=id,name,pps_json`;

  const projects = await select('projects', query, token);

  if (projects.length === 0) {
    console.log(`\n  No cloud project found for "${projectName}".\n  Push first with: phewsh push\n`);
    return;
  }

  const project = projects[0];
  fs.mkdirSync(INTENT_DIR, { recursive: true });

  const pulled = [];

  // Restore pps.json from cloud if present
  if (project.pps_json) {
    const localPPS = readPPS(INTENT_DIR);
    const merged = { ...project.pps_json };
    // Keep any local adapter links
    if (localPPS?.adapters) merged.adapters = { ...project.pps_json.adapters, ...localPPS.adapters };
    merged.adapters = merged.adapters || {};
    merged.adapters.phewsh = { cloud_id: project.id, last_synced: new Date().toISOString(), last_updated_by: 'pull' };
    writePPS(INTENT_DIR, merged);
    pulled.push('pps.json');
  }

  const artifacts = await select(
    'artifacts',
    `project_id=eq.${project.id}&user_id=eq.${userId}&select=kind,content,updated_at`,
    token
  );

  for (const artifact of artifacts) {
    const file = KIND_TO_FILE[artifact.kind];
    if (!file) continue;
    fs.writeFileSync(path.join(INTENT_DIR, file), artifact.content);
    pulled.push(file);
  }

  if (pulled.length === 0) {
    console.log('\n  No data found in cloud for this project.\n');
    return;
  }

  console.log(`\n  ✓ Pulled from cloud — ${project.name} (${project.id})`);
  pulled.forEach(f => console.log(`    ${f}`));
  console.log('');
}

async function link(config, token, cloudId) {
  const projectName = getProjectName();
  const userId = config.supabaseUserId;

  const projects = await select('projects', `id=eq.${cloudId}&user_id=eq.${userId}&select=id,name`, token);
  if (projects.length === 0) {
    console.log(`\n  No cloud project found with id: ${cloudId}\n`);
    process.exit(1);
  }

  const project = projects[0];
  let localPPS = readPPS(INTENT_DIR);
  if (!localPPS) {
    console.log('\n  No local .intent/pps.json found. Run `phewsh clarify` or `phewsh intent --init` first.\n');
    process.exit(1);
  }

  if (!localPPS.adapters) localPPS.adapters = {};
  if (!localPPS.adapters.phewsh) localPPS.adapters.phewsh = {};
  localPPS.adapters.phewsh.cloud_id = project.id;
  localPPS.adapters.phewsh.last_synced = null;
  writePPS(INTENT_DIR, localPPS);

  console.log(`\n  ✓ Linked .intent/ → cloud project "${project.name}" (${project.id})\n`);
  console.log('  Run `phewsh push` to sync.\n');
}

function isAuthError(err) {
  const m = (err && err.message || '').toLowerCase();
  return m.includes('jwt') || m.includes('expired') || m.includes('401') || m.includes('unauthorized');
}

function agoMs(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// Compare local .intent/ against the cloud copy. Read-only — tells you which
// way to sync, without doing it.
async function status(config, token) {
  if (!fs.existsSync(INTENT_DIR)) {
    console.log('\n  No .intent/ here. Run `phewsh clarify` or `phewsh intent --init` first.\n');
    return;
  }
  const pps = readPPS(INTENT_DIR);
  const cloudId = pps?.adapters?.phewsh?.cloud_id;
  const projectName = getProjectName();
  const query = cloudId
    ? `id=eq.${cloudId}&user_id=eq.${config.supabaseUserId}&select=id,updated_at`
    : `name=eq.${encodeURIComponent(projectName)}&user_id=eq.${config.supabaseUserId}&select=id,updated_at`;

  const projects = await select('projects', query, token);
  if (projects.length === 0) {
    console.log(`\n  ↕ "${projectName}" isn't in the cloud yet — run \`phewsh push\` to sync.\n`);
    return;
  }
  const project = projects[0];
  const artifacts = await select(
    'artifacts',
    `project_id=eq.${project.id}&user_id=eq.${config.supabaseUserId}&select=updated_at&order=updated_at.desc&limit=1`,
    token
  );
  const cloudTime = artifacts.length > 0
    ? new Date(artifacts[0].updated_at).getTime()
    : new Date(project.updated_at).getTime();

  let latestLocal = 0;
  for (const f of ['vision.md', 'plan.md', 'next.md']) {
    const p = path.join(INTENT_DIR, f);
    if (fs.existsSync(p)) latestLocal = Math.max(latestLocal, fs.statSync(p).mtimeMs);
  }
  if (latestLocal === 0) { console.log('\n  ↕ Not linked to cloud — run `phewsh push`.\n'); return; }

  const drift = Math.abs(cloudTime - latestLocal);
  if (drift < 60000) console.log('\n  ↕ In sync — local and cloud match.\n');
  else if (cloudTime > latestLocal) console.log(`\n  ↓ Cloud is newer (${agoMs(Date.now() - cloudTime)}) — run \`phewsh pull\`.\n`);
  else console.log(`\n  ↑ Local changes not pushed (${agoMs(Date.now() - latestLocal)}) — run \`phewsh push\`.\n`);
}

async function main(direction = 'push') {
  const argv = process.argv.slice(3);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`\n  phewsh ${direction} — sync .intent/ with phewsh.com/intent`);
    console.log(`    sync   show which way to sync      push   .intent/ → cloud`);
    console.log(`    pull   cloud → .intent/            link   adopt a cloud project\n`);
    return;
  }

  const config = loadConfig();
  if (!config?.supabaseUserId) {
    console.log('\n  Not logged in. Run `phewsh login` first.\n');
    process.exit(1);
  }

  const token = await ensureValidToken(config);
  if (!token) {
    console.log('\n  Session expired. Run `phewsh login` to re-authenticate.\n');
    process.exit(1);
  }

  // The token can still be rejected server-side (refresh token also expired).
  // Convert that into the same friendly nudge instead of a raw stack trace.
  try {
    if (direction === 'status') {
      await status(config, token);
    } else if (direction === 'pull') {
      await pull(config, token);
    } else if (direction === 'link') {
      const cloudId = argv[0] && !argv[0].startsWith('-') ? argv[0] : process.argv[4];
      if (!cloudId) {
        console.log('\n  Usage: phewsh link <cloud-project-id>\n');
        process.exit(1);
      }
      await link(config, token, cloudId);
    } else {
      await push(config, token);
    }
  } catch (err) {
    if (isAuthError(err)) {
      console.log('\n  Session expired. Run `phewsh login` to re-authenticate.\n');
    } else {
      console.log(`\n  ${direction} failed: ${err.message}\n`);
    }
    process.exit(1);
  }
}

module.exports = { main, push, pull, link, status, ensureValidToken, loadConfig };
