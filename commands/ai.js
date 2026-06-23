const fs = require('fs');
const path = require('path');
const os = require('os');
const { trackSap } = require('../lib/supabase');
const {
  getProvider, listProviders, detectProvider,
  buildHeaders, buildBody, getUrl, streamParser,
} = require('../lib/providers');
const { HARNESSES, detectInstalled, listHarnesses, runViaHarness } = require('../lib/harnesses');
const configFile = require('../lib/config-file');

const CONFIG_PATH = path.join(os.homedir(), '.phewsh', 'config.json');
const INTENT_DIR = path.join(process.cwd(), '.intent');

const args = process.argv.slice(3);
const subcommand = args[0];

function loadConfig() {
  return configFile.loadConfig(CONFIG_PATH);
}

function loadIntentContext() {
  const files = ['vision.md', 'plan.md', 'next.md'];
  const loaded = [];
  for (const file of files) {
    const p = path.join(INTENT_DIR, file);
    if (fs.existsSync(p)) {
      loaded.push({ file, content: fs.readFileSync(p, 'utf-8') });
    }
  }
  return loaded;
}

function buildSystemPrompt(intentFiles) {
  if (intentFiles.length === 0) return null;

  const sections = intentFiles.map(({ file, content }) =>
    `## ${file}\n\n${content.trim()}`
  ).join('\n\n---\n\n');

  return `You are a focused execution assistant. The user has structured intent artifacts that define what they are building. Use these as your primary context for every response — stay aligned with their vision, plan, and next actions.\n\n${sections}`;
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider' || args[i] === '-p') {
      flags.provider = args[i + 1];
      i++;
    } else if (args[i] === '--model' || args[i] === '-m') {
      flags.model = args[i + 1];
      i++;
    }
  }
  // Strip flags from args to get the prompt
  const clean = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--provider' || args[i] === '-p' || args[i] === '--model' || args[i] === '-m') && args[i + 1]) {
      i++; // skip value
    } else {
      clean.push(args[i]);
    }
  }
  return { flags, clean };
}

function resolveProvider(config, flagProvider) {
  const providerName = flagProvider || config.defaultProvider || 'anthropic';
  return getProvider(providerName);
}

function readProjectId() {
  try {
    const p = path.join(INTENT_DIR, 'project.json');
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return j.id || null;
  } catch { return null; }
}

function resolveApiKey(config, provider) {
  // PHEWSH gateway authenticates with your phewsh JWT (phewsh login --token),
  // not a BYOK provider key.
  if (provider.id === 'phewsh') return config.supabaseAccessToken || null;
  // Check provider-specific key first, then fall back to generic apiKey
  const providerKey = config.providerKeys?.[provider.id];
  if (providerKey) return providerKey;
  // Check env var
  if (provider.keyEnvVar && process.env[provider.keyEnvVar]) return process.env[provider.keyEnvVar];
  // Fall back to generic key if provider matches or can be auto-detected
  if (config.apiKey) {
    const detected = detectProvider(config.apiKey);
    if (!detected || detected === provider.id) return config.apiKey;
  }
  if (provider.noKey) return null; // ollama doesn't need a key
  return null;
}

async function streamResponse(config, provider, model, systemPrompt, userPrompt) {
  const apiKey = resolveApiKey(config, provider);
  if (!apiKey && !provider.noKey) {
    if (provider.id === 'phewsh') {
      throw new Error('Not logged in. Run `phewsh login --token <jwt>` (get it at phewsh.com/intent → Settings → CLI Access) to use pooled credits.');
    }
    throw new Error(`No API key for ${provider.name}. Run \`phewsh login --set-key\` or set ${provider.keyEnvVar}.`);
  }

  const url = getUrl(provider, config);
  const headers = buildHeaders(provider, apiKey);
  // Route through the Decision Gate: tell the gateway which project this spend
  // belongs to, so a budget set on that project is enforced server-side.
  if (provider.id === 'phewsh') {
    const projectId = readProjectId();
    if (projectId) headers['x-phewsh-project'] = projectId;
  }
  const body = buildBody(provider, model, systemPrompt, userPrompt);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = err.error?.message || err.message || `API error ${response.status}`;
    throw new Error(`${provider.name}: ${msg}`);
  }

  process.stdout.write('\n');

  const parse = streamParser(provider);
  let promptTokens = null;
  let completionTokens = null;

  for await (const event of parse(response)) {
    if (event.type === 'text') {
      process.stdout.write(event.text);
    } else if (event.type === 'usage') {
      promptTokens = event.promptTokens;
      completionTokens = event.completionTokens;
    }
  }

  process.stdout.write('\n\n');

  // SAP tracking
  trackSap({
    userId: config.supabaseUserId,
    source: 'cli',
    model,
    promptTokens,
    completionTokens,
    accessToken: config.supabaseAccessToken,
  });
}

async function main() {
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(`
  phewsh ai

  Usage:
    phewsh ai run "<prompt>"    Run a prompt with .intent/ context injected
    phewsh ai status            Show current config and context
    phewsh ai providers         List available AI providers

  Options:
    -p, --provider <name>       Override provider (e.g. openrouter, groq, ollama)
    -m, --model <model>         Override model

  Examples:
    phewsh ai run "what should I build next?"
    phewsh ai run -p claude-code "use my Claude subscription — no API key"
    phewsh ai run -p codex "use my ChatGPT plan — no API key"
    phewsh ai run -p openrouter "compare these approaches"
    phewsh ai run -p ollama "local inference, no API key needed"

  No API key? phewsh automatically runs through an installed agent CLI
  (Claude Code, Codex, Gemini, Cursor, OpenCode) using its own login.
    `);
    return;
  }

  if (subcommand === 'providers') {
    const config = loadConfig() || {};
    console.log('\n  Subscription harnesses (no API key — they carry their own login):\n');
    for (const h of listHarnesses()) {
      const status = h.installed ? '\x1b[32minstalled\x1b[0m' : '\x1b[2mnot installed\x1b[0m';
      console.log(`  ${h.id.padEnd(12)} ${h.label.padEnd(26)} ${status}  (${h.auth})`);
    }
    console.log('\n  API providers:\n');
    for (const p of listProviders()) {
      const isDefault = (config.defaultProvider || 'anthropic') === p.id;
      const hasKey = !!(config.providerKeys?.[p.id] || (p.keyEnvVar && process.env[p.keyEnvVar]));
      const keyStatus = p.id === 'phewsh'
        ? (config.supabaseAccessToken ? 'logged in' : 'run: phewsh login --token')
        : (p.noKey ? 'no key needed' : (hasKey ? 'key set' : 'no key'));
      const marker = isDefault ? ' (default)' : '';
      console.log(`  ${p.id.padEnd(12)} ${p.name.padEnd(26)} ${keyStatus}${marker}`);
      console.log(`  ${''.padEnd(12)} model: ${p.defaultModel || '(configure)'}`);
      if (p.docs) console.log(`  ${''.padEnd(12)} ${p.docs}`);
      console.log('');
    }
    return;
  }

  if (subcommand === 'status') {
    const config = loadConfig();
    const intentFiles = loadIntentContext();
    const providerName = config?.defaultProvider || 'anthropic';
    let provider;
    try { provider = getProvider(providerName); } catch { provider = { name: providerName }; }
    console.log('\n  phewsh ai — status\n');
    console.log(`  Config    ${config ? 'found' : 'not found — run \`phewsh login\`'}`);
    console.log(`  Provider  ${provider.name} (${providerName})`);
    console.log(`  API key   ${config?.apiKey || config?.providerKeys?.[providerName] ? 'set' : 'not set'}`);
    if (config?.providerKeys) {
      const configured = Object.keys(config.providerKeys).filter(k => config.providerKeys[k]);
      if (configured.length > 0) console.log(`  Keys for  ${configured.join(', ')}`);
    }
    console.log(`  .intent/  ${intentFiles.length > 0 ? intentFiles.map(f => f.file).join(', ') : 'none found'}`);
    console.log('');
    return;
  }

  if (subcommand === 'run') {
    const { flags, clean } = parseFlags(args.slice(1));
    const prompt = clean.join(' ');
    if (!prompt) {
      console.error('\n  Usage: phewsh ai run "<your prompt>"\n');
      process.exit(1);
    }

    const config = loadConfig() || {};
    const intentFiles = loadIntentContext();
    const systemPrompt = buildSystemPrompt(intentFiles);
    const contextLine = intentFiles.length > 0
      ? `\n  Context: ${intentFiles.map(f => f.file).join(', ')}`
      : '\n  No .intent/ found — running without project context';

    // Harnesses double as providers: they carry their own auth (your Claude /
    // ChatGPT / Google subscription), so no API key is needed in phewsh.
    const requested = flags.provider || config.defaultProvider;
    if (requested && HARNESSES[requested]) {
      console.log(contextLine);
      console.log(`  Provider: ${HARNESSES[requested].label} (your ${HARNESSES[requested].auth} — no API key)`);
      await runViaHarness(requested, systemPrompt, prompt);
      return;
    }

    const provider = resolveProvider(config, flags.provider);
    const model = flags.model || config.providerModels?.[provider.id] || provider.defaultModel;
    const apiKey = resolveApiKey(config, provider);

    // No key? Fall back to an installed harness instead of erroring — that's
    // what platform-agnostic means in practice.
    if (!apiKey && !provider.noKey && !flags.provider) {
      const harness = detectInstalled();
      if (harness) {
        console.log(contextLine);
        console.log(`  Provider: ${HARNESSES[harness].label} (your ${HARNESSES[harness].auth} — no API key)`);
        console.log(`  \x1b[2mTip: pin it with \`phewsh ai run -p ${harness}\` or add an API key via \`phewsh login --set-key\`\x1b[0m`);
        await runViaHarness(harness, systemPrompt, prompt);
        return;
      }
    }

    if (!apiKey && !provider.noKey) {
      console.error(`\n  No API key for ${provider.name}.`);
      console.error(`  Run \`phewsh login --set-key\`, set ${provider.keyEnvVar},`);
      console.error(`  or use an installed agent CLI: phewsh ai run -p claude-code|codex|gemini|cursor|opencode\n`);
      process.exit(1);
    }

    console.log(contextLine);
    console.log(`  Provider: ${provider.name} | Model: ${model}`);

    await streamResponse(config, provider, model, systemPrompt, prompt);
    return;
  }

  console.error(`\n  Unknown subcommand: ${subcommand}\n  Run 'phewsh ai --help' for usage.\n`);
  process.exit(1);
}

main().catch(err => {
  console.error('\n  Error:', err.message);
  process.exit(1);
});
