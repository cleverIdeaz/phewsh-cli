const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const crypto = require('crypto');
const { sendOtp, verifyOtp, refreshSession } = require('../lib/supabase');
const configFile = require('../lib/config-file');

const CONFIG_DIR = path.join(os.homedir(), '.phewsh');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  return configFile.loadConfig(CONFIG_PATH);
}

function saveConfig(config) {
  configFile.saveConfig(CONFIG_PATH, config);
}

function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
  const close = () => rl.close();
  return { ask, close };
}

async function main() {
  const args = process.argv.slice(3);

  if (args.includes('--status') || args.includes('-s')) {
    const config = loadConfig();
    if (!config) {
      console.log('\n  Not logged in. Run `phewsh login` to get started.\n');
    } else {
      console.log('\n  phewsh — identity\n');
      console.log(`  Email      ${config.email || '(not set)'}`);
      console.log(`  Synced     ${config.supabaseUserId ? '✓ cloud sync enabled' : '✗ local only'}`);
      console.log(`  API key    ${config.apiKey ? config.apiKey.slice(0, 8) + '...' : '(not set)'}`);
      console.log(`  Provider   ${config.defaultProvider || 'anthropic'}`);
      // Verified state over assumptions: a stored token is not a live session.
      const { decodeExpiry } = require('../lib/mcp-token');
      const mins = config.supabaseAccessToken ? decodeExpiry(config.supabaseAccessToken) : null;
      if (!config.supabaseAccessToken) {
        console.log('  Session    (no cloud session)');
      } else if (mins === null) {
        console.log('  Session    ? unreadable token — run `phewsh login --logout` then `phewsh login`');
      } else if (mins <= 0) {
        console.log(`  Session    ✗ expired${config.supabaseRefreshToken ? ' (may auto-refresh on next cloud call)' : ''} — if cloud sync fails, run \`phewsh login --logout\` then \`phewsh login\``);
      } else {
        console.log(`  Session    ✓ valid ~${mins} more min`);
      }
      console.log('');
    }
    return;
  }

  if (args.includes('--logout')) {
    if (fs.existsSync(CONFIG_PATH)) {
      fs.unlinkSync(CONFIG_PATH);
      console.log('\n  Logged out.\n');
    } else {
      console.log('\n  Not logged in.\n');
    }
    return;
  }

  // --token: paste a JWT obtained from phewsh.com/intent settings
  if (args.includes('--token')) {
    const tokenIdx = args.indexOf('--token');
    const jwt = args[tokenIdx + 1];
    if (!jwt) {
      console.log('\n  Usage: phewsh login --token <jwt-from-web>\n');
      console.log('  Get your token at phewsh.com/intent → Settings → CLI Access\n');
      process.exit(1);
    }
    // Decode JWT payload (no verification needed — Supabase will validate on API calls)
    try {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
      const config = loadConfig() || {};
      saveConfig({
        ...config,
        userId: payload.sub,
        email: payload.email || config.email || '',
        supabaseUserId: payload.sub,
        supabaseAccessToken: jwt,
        supabaseRefreshToken: config.supabaseRefreshToken || null,
      });
      console.log(`\n  ✓ Logged in as ${payload.email || payload.sub}`);
      console.log('  ✓ Cloud sync enabled\n');
      console.log('  Note: web tokens expire in ~1 hour. Run `phewsh login --refresh` if sync fails.\n');
    } catch {
      console.error('\n  Invalid token. Copy it from phewsh.com/intent → Settings → CLI Access.\n');
      process.exit(1);
    }
    return;
  }

  if (args.includes('--set-key')) {
    const { listProviders, detectProvider } = require('../lib/providers');
    const config = loadConfig() || {};
    const { ask, close } = createPrompter();

    const providers = listProviders();
    console.log('\n  Available providers:\n');
    providers.forEach((p, i) => {
      const tag = p.noKey ? ' (no key needed)' : '';
      console.log(`    ${i + 1}. ${p.name} (${p.id})${tag}`);
    });

    const choice = await ask(`\n  Choose provider [1-${providers.length}] or name (default: 1)\n  > `);
    let provider;
    const num = parseInt(choice);
    if (!choice || choice === '') {
      provider = providers[0]; // anthropic
    } else if (num >= 1 && num <= providers.length) {
      provider = providers[num - 1];
    } else {
      provider = providers.find(p => p.id === choice.toLowerCase() || p.name.toLowerCase() === choice.toLowerCase());
    }

    if (!provider) {
      close();
      console.error(`\n  Unknown provider: ${choice}\n`);
      process.exit(1);
    }

    // Handle providers that need a custom URL
    if (!provider.baseUrl && (provider.id === 'azure' || provider.id === 'custom')) {
      const url = await ask(`\n  ${provider.name} endpoint URL\n  > `);
      if (url) {
        config.providerUrl = url;
      }
    }

    if (provider.noKey) {
      config.defaultProvider = provider.id;
      saveConfig(config);
      close();
      console.log(`\n  ${provider.name} selected — no API key needed.`);
      console.log(`  Default provider set to: ${provider.id}\n`);
      return;
    }

    const keyHint = provider.docs ? ` (get one at ${provider.docs})` : '';
    const apiKey = await ask(`\n  ${provider.name} API key${keyHint}\n  > `);
    close();

    if (apiKey) {
      // Store in provider-specific keys map
      if (!config.providerKeys) config.providerKeys = {};
      config.providerKeys[provider.id] = apiKey;
      config.defaultProvider = provider.id;

      // Keep backward compat: if anthropic, also set generic apiKey
      if (provider.id === 'anthropic') config.apiKey = apiKey;

      saveConfig(config);
      console.log(`\n  ${provider.name} API key saved.`);
      console.log(`  Default provider set to: ${provider.id}\n`);
    }
    return;
  }

  // --refresh: try to refresh the Supabase token silently
  if (args.includes('--refresh')) {
    const config = loadConfig();
    if (!config?.supabaseRefreshToken) {
      console.log('\n  No session to refresh. Run `phewsh login`.\n');
      return;
    }
    try {
      const session = await refreshSession(config.supabaseRefreshToken);
      if (session?.access_token) {
        saveConfig({
          ...config,
          supabaseAccessToken: session.access_token,
          supabaseRefreshToken: session.refresh_token,
        });
        console.log('\n  Session refreshed.\n');
      }
    } catch (err) {
      console.error('\n  Refresh failed:', err.message, '\n');
    }
    return;
  }

  const existing = loadConfig();
  if (existing?.supabaseUserId) {
    console.log(`\n  Already logged in as ${existing.email || existing.supabaseUserId}`);
    console.log('  Run `phewsh login --logout` to reset or `phewsh login --status` to view.\n');
    return;
  }

  console.log('\n  😮\u200d💨🤫  phewsh login\n');
  const { ask, close } = createPrompter();

  const email = await ask('  Email address\n  > ');
  if (!email) { close(); console.log('\n  Cancelled.\n'); return; }

  console.log('\n  Sending verification code...');
  const sent = await sendOtp(email);
  if (!sent) {
    close();
    console.error('\n  Failed to send code. Check your email address.\n');
    process.exit(1);
  }

  console.log(`  Check ${email} — look for a 6-digit code.`);
  console.log(`  (It may arrive as a link — if so, visit phewsh.com/intent to log in there first,`);
  console.log(`   then run: phewsh login --from-web to save that session.)\n`);
  const token = await ask('  6-digit code\n  > ');
  console.log('');

  if (!token || token.length < 4) {
    close();
    console.log('\n  No code entered. If you received a link, log in at phewsh.com/intent\n  then run `phewsh login --status` after logging in via web.\n');
    process.exit(1);
  }

  let session;
  try {
    session = await verifyOtp(email, token);
  } catch (err) {
    close();
    console.error('\n  Verification failed:', err.message);
    console.error('  If you received a link instead of a code, ask your admin to enable');
    console.error('  Email OTP in the Supabase dashboard (Authentication → Email).\n');
    process.exit(1);
  }

  console.log('\n  To use `phewsh ai`, you need an API key.');
  console.log('  Supports: Anthropic, OpenRouter, OpenAI, Groq, Mistral, DeepSeek, Ollama, Azure, and more.');
  console.log('  Run `phewsh login --set-key` to configure any provider.');
  console.log('  For now, enter an Anthropic key (or leave blank to skip).\n');
  const apiKey = await ask('  API key (optional)\n  > ');
  close();
  console.log('');

  const config = {
    userId: session.user.id,
    email: session.user.email,
    supabaseUserId: session.user.id,
    supabaseAccessToken: session.access_token,
    supabaseRefreshToken: session.refresh_token,
    defaultProvider: 'anthropic',
    createdAt: new Date().toISOString(),
  };
  if (apiKey) config.apiKey = apiKey;

  saveConfig(config);

  console.log(`  ✓ Logged in as ${session.user.email}`);
  console.log('  ✓ Cloud sync enabled — run `phewsh intent --sync` in any project\n');
  if (!apiKey) console.log('  Add an API key any time with `phewsh login --set-key`\n');
}

main().catch(err => {
  console.error('\n  Error:', err.message);
  process.exit(1);
});
