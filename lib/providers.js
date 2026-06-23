/**
 * Multi-provider AI routing for phewsh CLI.
 *
 * Supported providers:
 *   anthropic   — Anthropic API (Claude models)
 *   openrouter  — OpenRouter (100+ models via OpenAI-compatible API)
 *   azure       — Azure OpenAI / Microsoft Foundry
 *   openai      — OpenAI directly
 *   groq        — Groq (fast inference)
 *   together    — Together AI
 *   mistral     — Mistral AI
 *   deepseek    — DeepSeek API
 *   ollama      — Local Ollama (no key needed)
 *   custom      — Any OpenAI-compatible endpoint
 */

const PROVIDERS = {
  phewsh: {
    name: 'PHEWSH (pooled credits + budget gate)',
    baseUrl: 'https://fpnpfnahwaztdlxuayyv.supabase.co/functions/v1/chat-completions',
    defaultModel: 'anthropic/claude-sonnet-4',
    format: 'openai',
    authStyle: 'phewsh', // uses your phewsh JWT (phewsh login --token) — no BYOK
    docs: 'phewsh.com/api',
    extraHeaders: { 'HTTP-Referer': 'https://phewsh.com', 'X-Title': 'phewsh CLI' },
  },
  anthropic: {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-6',
    format: 'anthropic',
    keyEnvVar: 'ANTHROPIC_API_KEY',
    keyPrefix: 'sk-ant-',
    docs: 'console.anthropic.com/settings/keys',
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'anthropic/claude-sonnet-4',
    format: 'openai',
    keyEnvVar: 'OPENROUTER_API_KEY',
    keyPrefix: 'sk-or-',
    docs: 'openrouter.ai/keys',
    extraHeaders: { 'HTTP-Referer': 'https://phewsh.com', 'X-Title': 'phewsh CLI' },
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o',
    format: 'openai',
    keyEnvVar: 'OPENAI_API_KEY',
    keyPrefix: 'sk-',
    docs: 'platform.openai.com/api-keys',
  },
  azure: {
    name: 'Azure OpenAI',
    baseUrl: null, // user must provide: https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version=2024-02-01
    defaultModel: 'gpt-4o',
    format: 'openai',
    authStyle: 'azure', // uses api-key header instead of Bearer
    keyEnvVar: 'AZURE_OPENAI_API_KEY',
    docs: 'portal.azure.com',
  },
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
    format: 'openai',
    keyEnvVar: 'GROQ_API_KEY',
    keyPrefix: 'gsk_',
    docs: 'console.groq.com/keys',
  },
  together: {
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1/chat/completions',
    defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
    format: 'openai',
    keyEnvVar: 'TOGETHER_API_KEY',
    docs: 'api.together.ai/settings/api-keys',
  },
  mistral: {
    name: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1/chat/completions',
    defaultModel: 'mistral-large-latest',
    format: 'openai',
    keyEnvVar: 'MISTRAL_API_KEY',
    docs: 'console.mistral.ai/api-keys',
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/chat/completions',
    defaultModel: 'deepseek-chat',
    format: 'openai',
    keyEnvVar: 'DEEPSEEK_API_KEY',
    docs: 'platform.deepseek.com/api_keys',
  },
  ollama: {
    name: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1/chat/completions',
    defaultModel: 'llama3.2',
    format: 'openai',
    noKey: true,
    docs: 'ollama.com',
  },
  custom: {
    name: 'Custom (OpenAI-compatible)',
    baseUrl: null, // user must provide
    defaultModel: null,
    format: 'openai',
    docs: '',
  },
};

function getProvider(name) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown provider: ${name}. Available: ${Object.keys(PROVIDERS).join(', ')}`);
  return { id: name, ...p };
}

function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, ...p }));
}

function detectProvider(apiKey) {
  if (!apiKey) return null;
  for (const [id, p] of Object.entries(PROVIDERS)) {
    if (p.keyPrefix && apiKey.startsWith(p.keyPrefix)) return id;
  }
  return null;
}

function buildHeaders(provider, apiKey, opts = {}) {
  const headers = { 'content-type': 'application/json' };

  if (provider.format === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (opts.oauthToken) {
      // Subscription (Claude Pro/Max) auth: Bearer token + OAuth beta header.
      // Must NOT send x-api-key alongside the bearer token.
      const { OAUTH_BETA } = require('./anthropic-oauth');
      headers['authorization'] = `Bearer ${opts.oauthToken}`;
      headers['anthropic-beta'] = OAUTH_BETA;
    } else {
      headers['x-api-key'] = apiKey;
    }
  } else if (provider.authStyle === 'azure') {
    headers['api-key'] = apiKey;
  } else if (!provider.noKey) {
    headers['authorization'] = `Bearer ${apiKey}`;
  }

  if (provider.extraHeaders) Object.assign(headers, provider.extraHeaders);
  return headers;
}

function buildBody(provider, model, systemPrompt, userPrompt, opts = {}) {
  if (provider.format === 'anthropic') {
    const body = {
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: userPrompt }],
      stream: true,
    };
    if (opts.oauthToken) {
      // Subscription OAuth requires the Claude Code identity as the first
      // system block; the real system prompt follows as a second block.
      const { CLAUDE_CODE_IDENTITY } = require('./anthropic-oauth');
      const system = [{ type: 'text', text: CLAUDE_CODE_IDENTITY }];
      if (systemPrompt) system.push({ type: 'text', text: systemPrompt });
      body.system = system;
    } else if (systemPrompt) {
      body.system = systemPrompt;
    }
    return body;
  }

  // OpenAI-compatible format
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userPrompt });

  return {
    model,
    max_tokens: 1024,
    messages,
    stream: true,
  };
}

function getUrl(provider, config) {
  if (provider.id === 'azure' || provider.id === 'custom') {
    const url = config.providerUrl || config.baseUrl;
    if (!url) throw new Error(`${provider.name} requires a base URL. Run \`phewsh login --set-key\` to configure.`);
    return url;
  }
  return provider.baseUrl;
}

async function* streamAnthropicResponse(response) {
  let promptTokens = null;
  let completionTokens = null;

  for await (const chunk of response.body) {
    const text = Buffer.from(chunk).toString('utf-8');
    const lines = text.split('\n').filter(l => l.startsWith('data: '));
    for (const line of lines) {
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          yield { type: 'text', text: parsed.delta.text };
        }
        if (parsed.type === 'message_start' && parsed.message?.usage) {
          promptTokens = parsed.message.usage.input_tokens;
        }
        if (parsed.type === 'message_delta' && parsed.usage) {
          completionTokens = parsed.usage.output_tokens;
        }
      } catch { /* skip malformed */ }
    }
  }

  yield { type: 'usage', promptTokens, completionTokens };
}

async function* streamOpenAIResponse(response) {
  let promptTokens = null;
  let completionTokens = null;

  for await (const chunk of response.body) {
    const text = Buffer.from(chunk).toString('utf-8');
    const lines = text.split('\n').filter(l => l.startsWith('data: '));
    for (const line of lines) {
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield { type: 'text', text: delta };
        if (parsed.usage) {
          promptTokens = parsed.usage.prompt_tokens;
          completionTokens = parsed.usage.completion_tokens;
        }
      } catch { /* skip malformed */ }
    }
  }

  yield { type: 'usage', promptTokens, completionTokens };
}

function streamParser(provider) {
  return provider.format === 'anthropic' ? streamAnthropicResponse : streamOpenAIResponse;
}

// One place for the Anthropic default — commands must not pin their own.
const DEFAULT_ANTHROPIC_MODEL = PROVIDERS.anthropic.defaultModel;

module.exports = {
  PROVIDERS,
  DEFAULT_ANTHROPIC_MODEL,
  getProvider,
  listProviders,
  detectProvider,
  buildHeaders,
  buildBody,
  getUrl,
  streamParser,
};
