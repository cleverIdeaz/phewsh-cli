// phewsh style — build and manage your StyleTree identity
// Pipeline: ingest → extract features → rebuild profile → display

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { select, upsert, SUPABASE_URL, SUPABASE_ANON_KEY } = require('../lib/supabase');
const configFile = require('../lib/config-file');

const CONFIG_PATH = path.join(os.homedir(), '.phewsh', 'config.json');
const STYLE_CACHE_DIR = path.join(os.homedir(), '.phewsh', 'styletree');

// ── ANSI
const b = (s) => `\x1b[1m${s}\x1b[0m`;
const d = (s) => `\x1b[2m${s}\x1b[0m`;
const g = (s) => `\x1b[90m${s}\x1b[0m`;
const c = (s) => `\x1b[36m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;

function loadConfig() {
  return configFile.loadConfig(CONFIG_PATH);
}

function ask(rl, q) {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
}

function ensureCacheDir() {
  fs.mkdirSync(STYLE_CACHE_DIR, { recursive: true });
}

// ── Basic audio metadata via Node (no heavy deps — just file info for MVP)
function extractBasicFileInfo(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mediumMap = {
      '.mp3': 'audio', '.wav': 'audio', '.flac': 'audio', '.aac': 'audio',
      '.ogg': 'audio', '.m4a': 'audio', '.aiff': 'audio',
      '.mid': 'midi', '.midi': 'midi',
      '.txt': 'text', '.md': 'text',
    };
    return {
      file_size_bytes: stat.size,
      mime_type: ext,
      medium: mediumMap[ext] || 'other',
    };
  } catch {
    return { medium: 'other' };
  }
}

// ── Save artifact + features locally (Tier 0)
function saveLocally(artifact, features) {
  ensureCacheDir();
  const localPath = path.join(STYLE_CACHE_DIR, 'artifacts.json');
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(localPath, 'utf-8')); } catch { /* empty */ }
  existing.push({ artifact, features, savedAt: new Date().toISOString() });
  fs.writeFileSync(localPath, JSON.stringify(existing, null, 2));
}

// ── Load local artifact cache
function loadLocal() {
  try {
    const localPath = path.join(STYLE_CACHE_DIR, 'artifacts.json');
    return JSON.parse(fs.readFileSync(localPath, 'utf-8'));
  } catch { return []; }
}

// ── Rebuild profile from local cache
function buildLocalProfile(entries) {
  const tempos = entries.map(e => e.features?.tempo_bpm).filter(Boolean);
  const keys = entries.map(e => e.features?.key_signature).filter(Boolean);
  const vibes = entries.flatMap(e => e.features?.vibe || []).filter(Boolean);
  const instruments = entries.flatMap(e => e.features?.instruments || []).filter(Boolean);
  const energies = entries.map(e => e.features?.energy).filter(Boolean);

  const freq = (arr) => {
    const counts = {};
    arr.forEach(v => counts[v] = (counts[v] || 0) + 1);
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  };

  return {
    artifact_count: entries.length,
    tempo_range: tempos.length ? [Math.min(...tempos), Math.max(...tempos)] : null,
    dominant_keys: [...new Set(keys)].slice(0, 3),
    vibe_signature: freq(vibes).slice(0, 5),
    instrument_palette: freq(instruments).slice(0, 6),
    energy_avg: energies.length ? energies.reduce((a, b) => a + b, 0) / energies.length : null,
  };
}

// ── Print style profile
function printProfile(profile, email) {
  console.log('');
  console.log(`  ${b('your style')}  ${g(email ? `· ${email}` : '')}`);
  console.log(`  ${d('─────────────────────────────')}`);

  if (profile.artifact_count === 0) {
    console.log(`  ${g('no artifacts yet — run: phewsh style --ingest <file>')}`);
    return;
  }

  console.log(`  ${g('sessions     ')}${profile.artifact_count}`);

  if (profile.tempo_range) {
    const [lo, hi] = profile.tempo_range;
    const label = lo === hi ? `${lo} BPM` : `${Math.round(lo)}–${Math.round(hi)} BPM`;
    console.log(`  ${g('tempo        ')}${label}`);
  }

  if (profile.dominant_keys?.length) {
    console.log(`  ${g('keys         ')}${profile.dominant_keys.join(', ')}`);
  }

  if (profile.vibe_signature?.length) {
    console.log(`  ${g('vibe         ')}${profile.vibe_signature.join(' · ')}`);
  }

  if (profile.instrument_palette?.length) {
    console.log(`  ${g('instruments  ')}${profile.instrument_palette.join(', ')}`);
  }

  if (profile.energy_avg !== null && profile.energy_avg !== undefined) {
    const energyLabel = profile.energy_avg > 0.7 ? 'high' : profile.energy_avg > 0.4 ? 'mid' : 'soft';
    console.log(`  ${g('dynamics     ')}${energyLabel}`);
  }

  console.log('');
}

// ── Sync artifact + features to Supabase
async function syncToCloud(config, artifact, features) {
  if (!config?.supabaseAccessToken) return null;

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${config.supabaseAccessToken}`,
    'Prefer': 'resolution=merge-duplicates,return=representation',
  };

  // Insert artifact
  const artifactRes = await fetch(`${SUPABASE_URL}/rest/v1/styletree_artifacts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...artifact, user_id: config.supabaseUserId }),
  });
  if (!artifactRes.ok) return null;
  const [savedArtifact] = await artifactRes.json();

  // Insert features
  await fetch(`${SUPABASE_URL}/rest/v1/styletree_features`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...features, artifact_id: savedArtifact.id, user_id: config.supabaseUserId }),
  });

  // Trigger profile rebuild via RPC
  await fetch(`${SUPABASE_URL}/rest/v1/rpc/rebuild_styletree_profile`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_user_id: config.supabaseUserId }),
  });

  return savedArtifact.id;
}

// ── Main
async function main() {
  const args = process.argv.slice(3);
  const config = loadConfig();

  if (args.includes('--help') || args.includes('-h')) {
    console.log('\n  phewsh style — your creative identity (StyleTree)');
    console.log('\n  Usage:');
    console.log('    phewsh style                  show your style profile');
    console.log('    phewsh style --ingest <file>  add an artifact to learn from');
    console.log('    phewsh style --status         same as bare (profile + sync tip)\n');
    return;
  }

  // --status
  if (args.includes('--status') || args.length === 0) {
    const entries = loadLocal();
    const profile = buildLocalProfile(entries);
    printProfile(profile, config?.email);
    if (!config?.supabaseUserId) {
      console.log(`  ${g('tip: run phewsh login to sync your style to the cloud')}`);
      console.log('');
    }
    return;
  }

  // --ingest <file>
  if (args.includes('--ingest')) {
    const fileIdx = args.indexOf('--ingest');
    const filePath = args[fileIdx + 1];

    if (!filePath) {
      console.error(`\n  Usage: phewsh style --ingest <file>\n`);
      process.exit(1);
    }

    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      console.error(`\n  File not found: ${absPath}\n`);
      process.exit(1);
    }

    const fileInfo = extractBasicFileInfo(absPath);
    const fileName = path.basename(absPath);

    console.log('');
    console.log(`  ${b('😮\u200d💨  ingesting')} ${c(fileName)}`);
    console.log(`  ${g('medium: ' + fileInfo.medium + '  ·  size: ' + (fileInfo.file_size_bytes ? Math.round(fileInfo.file_size_bytes / 1024) + 'kb' : 'unknown'))}`);
    console.log('');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const title = await ask(rl, `  ${g('title')} (or enter to use filename)\n  > `);
    const tempoInput = await ask(rl, `  ${g('tempo')} BPM (leave blank if unknown)\n  > `);
    const keyInput = await ask(rl, `  ${g('key')} (e.g. C minor, F# major — blank to skip)\n  > `);
    const vibeInput = await ask(rl, `  ${g('vibe')} (e.g. dark chill driving — space-separated)\n  > `);
    const instrumentInput = await ask(rl, `  ${g('instruments')} (e.g. piano bass drums — space-separated)\n  > `);

    rl.close();
    console.log('');

    const artifact = {
      title: title || fileName,
      medium: fileInfo.medium,
      file_path: absPath,
      file_size_bytes: fileInfo.file_size_bytes || null,
      mime_type: fileInfo.mime_type || null,
      sync_tier: 0,
    };

    const features = {
      tempo_bpm: tempoInput ? parseFloat(tempoInput) : null,
      key_signature: keyInput || null,
      mode: keyInput?.toLowerCase().includes('minor') ? 'minor'
           : keyInput?.toLowerCase().includes('major') ? 'major'
           : 'unknown',
      vibe: vibeInput ? vibeInput.split(/\s+/).filter(Boolean) : [],
      instruments: instrumentInput ? instrumentInput.split(/\s+/).filter(Boolean) : [],
    };

    // Always save locally first
    saveLocally(artifact, features);
    console.log(`  ${c('✓')} saved locally`);

    // Sync to cloud if logged in
    if (config?.supabaseAccessToken) {
      process.stdout.write(`  ${g('syncing to cloud...')}`);
      try {
        const id = await syncToCloud(config, artifact, features);
        if (id) {
          process.stdout.write(`\r  ${c('✓')} synced to cloud\n`);
        } else {
          process.stdout.write(`\r  ${g('⚠ cloud sync skipped (run phewsh login --refresh)')}\n`);
        }
      } catch {
        process.stdout.write(`\r  ${g('⚠ cloud sync failed — local copy saved')}\n`);
      }
    } else {
      console.log(`  ${g('tip: run phewsh login to enable cloud sync')}`);
    }

    // Print updated profile
    const entries = loadLocal();
    const profile = buildLocalProfile(entries);
    printProfile(profile, config?.email);
    return;
  }

  // --sync
  if (args.includes('--sync')) {
    if (!config?.supabaseAccessToken) {
      console.error(`\n  Not logged in. Run: phewsh login\n`);
      process.exit(1);
    }
    const entries = loadLocal();
    if (!entries.length) {
      console.log(`\n  Nothing to sync. Run: phewsh style --ingest <file>\n`);
      return;
    }
    console.log(`\n  Syncing ${entries.length} artifact(s) to cloud...\n`);
    let synced = 0;
    for (const { artifact, features } of entries) {
      try {
        const id = await syncToCloud(config, artifact, features);
        if (id) synced++;
      } catch { /* skip */ }
    }
    console.log(`  ${c('✓')} ${synced}/${entries.length} synced\n`);
    return;
  }

  // --link-intent: mark that style should influence intent generation
  if (args.includes('--link-intent')) {
    const intentDir = path.join(process.cwd(), '.intent');
    if (!fs.existsSync(intentDir)) {
      console.error(`\n  No .intent/ found here. Run: phewsh intent --init\n`);
      process.exit(1);
    }
    const entries = loadLocal();
    const profile = buildLocalProfile(entries);
    const linkPath = path.join(intentDir, 'style.json');
    fs.writeFileSync(linkPath, JSON.stringify(profile, null, 2));
    console.log(`\n  ${c('✓')} style profile linked to .intent/style.json`);
    console.log(`  ${g('phewsh ai will now include your style context automatically')}\n`);
    return;
  }

  console.error(`\n  Unknown style command. Try:\n`);
  console.error(`    phewsh style --ingest <file>    ingest a new artifact`);
  console.error(`    phewsh style --status           view your style profile`);
  console.error(`    phewsh style --sync             push to cloud`);
  console.error(`    phewsh style --link-intent      link style to current project\n`);
  process.exit(1);
}

main().catch(err => {
  console.error('\n  Error:', err.message);
  process.exit(1);
});
