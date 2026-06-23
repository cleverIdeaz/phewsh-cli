const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  getProvider, buildHeaders, buildBody, getUrl, streamParser, detectProvider,
} = require('../lib/providers');
const configFile = require('../lib/config-file');

const CONFIG_PATH = path.join(os.homedir(), '.phewsh', 'config.json');

const args = process.argv.slice(3);

// ANSI helpers
const b  = (s) => `\x1b[1m${s}\x1b[0m`;
const d  = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function loadConfig() {
  return configFile.loadConfig(CONFIG_PATH);
}

function resolveApiKey(config, provider) {
  const providerKey = config.providerKeys?.[provider.id];
  if (providerKey) return providerKey;
  if (provider.keyEnvVar && process.env[provider.keyEnvVar]) return process.env[provider.keyEnvVar];
  if (config.apiKey) {
    const detected = detectProvider(config.apiKey);
    if (!detected || detected === provider.id) return config.apiKey;
  }
  if (provider.noKey) return null;
  return null;
}

// ── Content extraction ──

function stripHtml(html) {
  // Remove script/style blocks
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  // Convert common elements
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<\/h[1-6]>/gi, '\n\n');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '- ');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<\/tr>/gi, '\n');
  text = text.replace(/<td[^>]*>/gi, ' | ');
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common entities
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : null;
}

function extractMeta(html) {
  const desc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
  return desc ? desc[1].trim() : null;
}

function isYouTube(url) {
  return /youtube\.com\/watch|youtu\.be\//.test(url);
}

function extractYouTubeId(url) {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?#]+)/);
  return match ? match[1] : null;
}

function isGitHub(url) {
  return /github\.com\/[^/]+\/[^/]+\/?$/.test(url);
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; phewsh-browse/1.0)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const contentType = resp.headers.get('content-type') || '';

    // JSON responses
    if (contentType.includes('application/json')) {
      const json = await resp.json();
      return { type: 'json', content: JSON.stringify(json, null, 2).slice(0, 8000), title: url };
    }

    // Plain text
    if (contentType.includes('text/plain')) {
      const text = await resp.text();
      return { type: 'text', content: text.slice(0, 8000), title: url };
    }

    // HTML
    const html = await resp.text();
    const title = extractTitle(html) || url;
    const description = extractMeta(html);
    const text = stripHtml(html);

    return {
      type: 'html',
      content: text.slice(0, 8000),
      title,
      description,
      rawHtml: html,
    };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function fetchYouTubeTranscript(videoId) {
  // Try to get captions via the YouTube page itself
  // This extracts the timedtext URL from the page source
  try {
    const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const resp = await fetch(pageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; phewsh-browse/1.0)' },
    });
    const html = await resp.text();

    // Extract title
    const title = extractTitle(html) || `YouTube: ${videoId}`;

    // Extract video description from meta
    const descMatch = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
    const description = descMatch
      ? descMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').slice(0, 2000)
      : null;

    // Try to extract caption track URL
    const captionMatch = html.match(/"captionTracks":\[(\{.*?\})\]/);
    let transcript = null;

    if (captionMatch) {
      try {
        const trackData = JSON.parse('[' + captionMatch[1] + ']');
        const enTrack = trackData.find(t => t.languageCode === 'en') || trackData[0];
        if (enTrack?.baseUrl) {
          const captionUrl = enTrack.baseUrl.replace(/\\u0026/g, '&');
          const captResp = await fetch(captionUrl);
          const captXml = await captResp.text();
          // Parse XML captions
          const lines = [];
          const regex = /<text[^>]*>([^<]*)<\/text>/g;
          let m;
          while ((m = regex.exec(captXml)) !== null) {
            const line = m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'")
              .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
            if (line.trim()) lines.push(line.trim());
          }
          transcript = lines.join(' ').slice(0, 6000);
        }
      } catch { /* caption extraction failed */ }
    }

    // Extract key metadata
    const viewMatch = html.match(/"viewCount":"(\d+)"/);
    const views = viewMatch ? parseInt(viewMatch[1]).toLocaleString() : null;
    const channelMatch = html.match(/"ownerChannelName":"([^"]+)"/);
    const channel = channelMatch ? channelMatch[1] : null;

    let content = '';
    if (channel) content += `Channel: ${channel}\n`;
    if (views) content += `Views: ${views}\n`;
    if (description) content += `\nDescription:\n${description}\n`;
    if (transcript) content += `\nTranscript:\n${transcript}\n`;
    else content += '\n(No transcript available — summarizing from metadata)\n';

    return { type: 'youtube', content: content.slice(0, 8000), title, videoId };
  } catch (err) {
    return { type: 'youtube', content: `Failed to fetch YouTube data: ${err.message}`, title: `YouTube: ${videoId}`, videoId };
  }
}

async function fetchGitHubRepo(url) {
  // Try the GitHub API for repo info
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return fetchPage(url);

  const [, owner, repo] = match;
  const repoName = repo.replace(/\.git$/, '');

  try {
    const apiResp = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
      headers: { 'User-Agent': 'phewsh-browse/1.0', 'Accept': 'application/vnd.github.v3+json' },
    });

    if (!apiResp.ok) return fetchPage(url);

    const data = await apiResp.json();

    // Also fetch README
    let readme = '';
    try {
      const readmeResp = await fetch(`https://api.github.com/repos/${owner}/${repoName}/readme`, {
        headers: { 'User-Agent': 'phewsh-browse/1.0', 'Accept': 'application/vnd.github.v3+json' },
      });
      if (readmeResp.ok) {
        const readmeData = await readmeResp.json();
        readme = Buffer.from(readmeData.content, 'base64').toString('utf-8').slice(0, 4000);
      }
    } catch { /* no readme */ }

    // Fetch recent commits
    let commits = '';
    try {
      const commitsResp = await fetch(`https://api.github.com/repos/${owner}/${repoName}/commits?per_page=5`, {
        headers: { 'User-Agent': 'phewsh-browse/1.0', 'Accept': 'application/vnd.github.v3+json' },
      });
      if (commitsResp.ok) {
        const commitsData = await commitsResp.json();
        commits = commitsData.map(c =>
          `  ${c.sha.slice(0, 7)} ${c.commit.message.split('\n')[0]} (${c.commit.author?.name || 'unknown'})`
        ).join('\n');
      }
    } catch { /* no commits */ }

    let content = `Repository: ${data.full_name}\n`;
    content += `Description: ${data.description || '(none)'}\n`;
    content += `Stars: ${data.stargazers_count.toLocaleString()} | Forks: ${data.forks_count.toLocaleString()} | Issues: ${data.open_issues_count}\n`;
    content += `Language: ${data.language || 'unknown'} | License: ${data.license?.spdx_id || 'none'}\n`;
    content += `Created: ${new Date(data.created_at).toLocaleDateString()} | Updated: ${new Date(data.updated_at).toLocaleDateString()}\n`;
    if (data.topics?.length) content += `Topics: ${data.topics.join(', ')}\n`;
    if (commits) content += `\nRecent commits:\n${commits}\n`;
    if (readme) content += `\nREADME:\n${readme}\n`;

    return { type: 'github', content: content.slice(0, 8000), title: data.full_name };
  } catch {
    return fetchPage(url);
  }
}

// ── AI summarization ──

async function summarize(config, pageData, mode) {
  const providerName = config.defaultProvider || 'anthropic';
  const provider = getProvider(providerName);
  const model = config.providerModels?.[provider.id] || provider.defaultModel;
  const apiKey = resolveApiKey(config, provider);

  if (!apiKey && !provider.noKey) {
    console.log(yellow('\n  No API key configured — showing raw extract instead.\n'));
    console.log(pageData.content);
    return;
  }

  const prompts = {
    tldr: `Give a concise TLDR summary (3-5 bullet points) of this content. Be direct and informative. Focus on the key takeaways.`,
    deep: `Give a thorough summary of this content. Include key points, main arguments, important details, and any actionable information. Structure with headers if the content warrants it.`,
    code: `Extract and summarize any code-related content. List technologies mentioned, code patterns, APIs, dependencies, and technical decisions. If there's actual code, show the most important snippets.`,
    raw: null,
  };

  const systemPrompt = `You are a web content summarizer for a CLI tool. Output clean, terminal-friendly text. Use markdown formatting sparingly — mainly bullet points and headers. No HTML. Be concise but thorough. The user is reading this in a terminal.`;

  const userPrompt = `${prompts[mode] || prompts.tldr}

Page: ${pageData.title}
Type: ${pageData.type}
${pageData.description ? `Meta: ${pageData.description}` : ''}

Content:
${pageData.content}`;

  const url = getUrl(provider, config);
  const headers = buildHeaders(provider, apiKey);
  const body = buildBody(provider, model, systemPrompt, userPrompt);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`${provider.name}: ${err.error?.message || err.message || `HTTP ${response.status}`}`);
  }

  const parse = streamParser(provider);
  for await (const event of parse(response)) {
    if (event.type === 'text') process.stdout.write(event.text);
  }
  process.stdout.write('\n');
}

// ── Main ──

async function main() {
  const url = args.find(a => !a.startsWith('-'));
  const mode = args.includes('--deep') ? 'deep'
    : args.includes('--code') ? 'code'
    : args.includes('--raw') ? 'raw'
    : 'tldr';

  if (!url || args.includes('--help') || args.includes('-h')) {
    console.log(`
  ${b('phewsh browse')} — read the web from your terminal

  Usage:
    phewsh browse <url>              TLDR summary (default)
    phewsh browse <url> --deep       Detailed summary
    phewsh browse <url> --code       Extract code/tech content
    phewsh browse <url> --raw        Raw text extract (no AI)

  Examples:
    phewsh browse https://news.ycombinator.com
    phewsh browse https://youtube.com/watch?v=dQw4w9WgXcQ
    phewsh browse https://github.com/anthropics/claude-code
    phewsh browse https://developer.mozilla.org/en-US/docs/Web/API/fetch --code
    phewsh browse reddit.com/r/programming --deep
    `);
    return;
  }

  // Normalize URL
  let targetUrl = url;
  if (!/^https?:\/\//.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  const config = loadConfig();

  // Detect content type and fetch accordingly
  console.log(`\n  ${d('Fetching')} ${cyan(targetUrl)}${d('...')}`);

  let pageData;
  if (isYouTube(targetUrl)) {
    const videoId = extractYouTubeId(targetUrl);
    console.log(`  ${d('Detected: YouTube video')} ${d(videoId)}`);
    pageData = await fetchYouTubeTranscript(videoId);
  } else if (isGitHub(targetUrl)) {
    console.log(`  ${d('Detected: GitHub repository')}`);
    pageData = await fetchGitHubRepo(targetUrl);
  } else {
    pageData = await fetchPage(targetUrl);
  }

  console.log(`  ${green('●')} ${b(pageData.title)}`);
  if (pageData.description) console.log(`  ${d(pageData.description)}`);
  console.log('');

  if (mode === 'raw') {
    console.log(pageData.content);
    return;
  }

  if (!config) {
    console.log(yellow('  No phewsh config — showing raw extract. Run `phewsh login` for AI summaries.\n'));
    console.log(pageData.content);
    return;
  }

  const providerName = config.defaultProvider || 'anthropic';
  console.log(`  ${d(`Summarizing via ${providerName} (--${mode})...`)}\n`);

  await summarize(config, pageData, mode);
}

main().catch(err => {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
});
