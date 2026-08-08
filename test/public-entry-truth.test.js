const baseTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// These assertions read the monorepo's website sources, which are NOT part of
// the public cli/ mirror (ship.sh rsyncs only cli/). Outside the monorepo they
// skip rather than fail on a missing path — a test that cannot pass where it is
// published is noise, not a guard.
const MONOREPO = fs.existsSync(path.join(ROOT, 'ship.sh'));
const test = MONOREPO ? baseTest : baseTest.skip;


test('repository front door explains one truth, native adapters, and three doors', () => {
  const readme = read('README.md');

  assert.match(readme, /The next AI starts from your files/);
  assert.match(readme, /project-owned `.intent\/` directory/);
  assert.match(readme, /Project · Next · Work · Record/);
  assert.match(readme, /Intent.*CLI.*Ion/s);
  assert.match(readme, /~\/\.agents\/skills\/intent\//);
  assert.match(readme, /~\/\.claude\/skills\/intent\//);
  assert.match(readme, /same byte-identical user-level skill/);
  assert.match(readme, /adapters, not two copies of project intent/);
  assert.match(readme, /user-owned workflow can take\s+precedence over the user-level skill/);
  assert.match(readme, /never creates, edits, or removes project-local skills/);
  assert.match(readme, /A handoff records file and Git fingerprints, routes, and explicit\s+losses/);
  assert.match(readme, /`\.intent\/` is useful by itself, CLI adds native local\s+integration/);
  assert.match(readme, /transcripts, model reasoning, editor buffers/);

  assert.doesNotMatch(readme, /Three primitives/);
  assert.doesNotMatch(readme, /Portable Project Spec/);
  assert.doesNotMatch(readme, /CLI is the wedge/i);
});

test('public explainer pages preserve the bounded continuity and authority model', () => {
  const platform = read('platform/index.html');
  const products = read('products/index.html');
  const cli = read('cli/index.html');

  assert.match(platform, /same project truth reaches/);
  assert.match(platform, /recorded project truth stays with the project/);
  assert.match(platform, /same machine/);
  assert.match(platform, /bounded handoff.*losses named/);
  assert.match(platform, /optional bundled MCP adapter/);
  assert.match(platform, /One open adapter contract/);
  assert.match(platform, /phewsh ambient explain --json/);
  assert.match(platform, /href="\/platform\/adapters\.json"/);
  assert.match(platform, /Setup prints manual config and syncs a bounded project cache/);
  assert.match(platform, /Slack and Discord remain planned request\/notification connectors/);
  assert.match(platform, /npm never runs with sudo/);
  assert.match(platform, /legacy ownership repair is disclosed first/);
  assert.match(platform, /The local view/);
  assert.match(platform, /your-project\/\.intent\/.*created by.*phewsh init/s);
  assert.match(platform, /~\/\.agents\/skills\/intent\/.*installed only after ambient consent/s);
  assert.match(platform, /your-project\/\.agents\/skills\/intent\/.*Phewsh never creates or changes it/s);
  assert.doesNotMatch(platform, /The live mirror|mirrored in a browser|never sudo/);
  assert.doesNotMatch(platform, /same memory shows up/i);
  assert.doesNotMatch(platform, /zero<\/span> re-explaining/i);
  assert.doesNotMatch(platform, /Every action lands in your decision record/i);
  assert.doesNotMatch(platform, /follow the record from any browser/i);

  assert.match(products, /Intent · CLI · Ion/);
  assert.match(products, /Start with intent\. Move between tools\. Bring the record back\./);
  assert.match(products, /\.intent\/next\.json/);
  assert.match(products, /only tool-neutral truth/);
  assert.match(products, /One open Intent skill reaches Codex and Claude Code/);
  assert.doesNotMatch(products, /gain full context instantly/i);
  assert.doesNotMatch(products, /\.intent\/next\.md/);

  assert.match(cli, /Same-machine Ion worker — human-initiated claims only/);
  assert.match(cli, /MCP is an optional adapter, not project truth/);
  assert.match(cli, /routable choices at the coordination layer,\s+even though their capabilities differ/);
  assert.match(cli, /Portable project context <em>across compatible AI tools/);
  assert.match(cli, /flex-direction: column;\s+align-items: center;/);
  assert.match(cli, /\.packs \{ width: 100%; min-width: 0; padding: 0 24px; \}/);
  assert.doesNotMatch(cli, /Any MCP-capable agent can connect, get tasks, report results, and chain autonomously/);
  assert.doesNotMatch(cli, /for every AI tool/i);
});

test('packaged and public adapter contracts are byte-identical and deployable', () => {
  const packaged = read('cli/docs/adapter-contract.json');
  const published = read('platform/adapters.json');
  const contract = JSON.parse(packaged);
  const packageJson = JSON.parse(read('cli/package.json'));
  const ship = read('ship.sh');

  assert.equal(published, packaged);
  assert.equal(contract.name, 'phewsh-adapter-contract');
  assert.equal(contract.projectTruth.path, '.intent/');
  assert.ok(packageJson.files.includes('docs/adapter-contract.json'));
  assert.match(ship, /"products\/" "platform\/" "cockpit\/"/);
});

test('public demo makes the Claude-to-Codex boundary reproducible, not magical', () => {
  const homepage = read('index.html');
  const demo = read('demo/index.html');
  const fixture = JSON.parse(read('cli/docs/handoff-proof-fixture.json'));

  assert.match(homepage, /href="\/demo#handoff-proof"/);
  assert.match(demo, /One project\.<br>Your AI tools\./);
  assert.match(demo, /receipt written before any destination-tool output/);
  assert.match(demo, /pickup verified: \.intent\/ \+ Git state \+ saved brief unchanged/);
  assert.match(demo, /the prior Claude transcript stays put/);
  assert.match(demo, /Public proof · no AI account required/);
  assert.match(demo, /node --test test\/public-handoff-proof\.test\.js/);
  assert.match(demo, /Failed attempt stays outside/);
  assert.match(demo, /The prior provider response was not included/);
  assert.match(demo, /Provider budget checks apply to <code>phewsh ai<\/code> calls/);
  assert.doesNotMatch(demo, /Every AI tool|every tool read|All tools aligned automatically|zero re-explanation/i);
  assert.doesNotMatch(demo, /context intact|summarize what we built|implements JWT middleware/i);

  assert.equal(fixture.handoff.from, 'claude-code');
  assert.equal(fixture.handoff.to, 'codex');
  assert.equal(fixture.failed_attempt.captured_in_receipt, false);
  assert.equal(fixture.expected.receipt_before_destination_output, true);
  assert.equal(fixture.expected.pickup_status, 'verified');
});

test('Intent demo projects current project truth into four bounded native targets', () => {
  const demoSource = read('intent/app/src/components/DemoProjectView.tsx');
  const fixtureSource = read('intent/app/src/lib/demo-fixture.ts');
  const welcomeSource = read('intent/app/src/components/WelcomeOverlay.tsx');
  const phewshSource = read('intent/app/src/app/phewsh/page.tsx');
  const builtDemo = read('intent/phewsh/demo/index.html');
  const builtPhewsh = read('intent/phewsh/index.html');
  const builtIntent = read('intent/index.html');
  const source = [demoSource, fixtureSource, welcomeSource, phewshSource].join('\n');

  assert.match(demoSource, /One project truth\. Four native projections\./);
  assert.match(demoSource, /phewsh seq --write/);
  assert.match(demoSource, /refreshes only its marked blocks/);
  assert.match(demoSource, /flex flex-col pt-12/);
  assert.match(demoSource, /transcripts, hidden reasoning, editor buffers, or unrecorded conversation/);
  assert.match(fixtureSource, /# Project/);
  assert.match(fixtureSource, /## Next/);
  assert.match(fixtureSource, /Work is derived from the current checkout/);
  assert.match(fixtureSource, /## Record/);
  for (const target of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules']) {
    assert.match(fixtureSource, new RegExp(target.replace('.', '\\.')));
    assert.match(builtDemo, new RegExp(target.replace('.', '\\.')));
  }
  for (const word of ['Project', 'Next', 'Work', 'Record']) {
    assert.match(welcomeSource, new RegExp(`label: "${word}"`));
  }

  assert.match(phewshSource, /href="\/phewsh\/demo"/);
  assert.doesNotMatch(phewshSource, /href="\/intent\/phewsh\/demo"/);
  assert.match(builtPhewsh, /href="\/intent\/phewsh\/demo"/);
  assert.doesNotMatch(builtPhewsh, /\/intent\/intent\/phewsh\/demo/);
  assert.match(builtDemo, /One project truth\. Four native projections\./);
  assert.match(builtDemo, /phewsh seq --write/);
  assert.match(builtDemo, /transcripts, hidden reasoning, editor buffers, or unrecorded conversation/);
  assert.match(builtIntent, /Project-owned \.intent\/ truth for supported AI tools/);
  assert.doesNotMatch(source, /every AI tool|all outputs stay in sync|everywhere/i);
  assert.doesNotMatch(builtDemo, /every AI tool|all outputs stay in sync|everywhere/i);
});

test('Intent app installs the canonical user-level skill without recreating project overrides', () => {
  const settings = read('intent/app/src/components/SettingsModal.tsx');
  const onboarding = read('intent/app/src/components/BusinessContext.tsx');
  const publicSkill = read('intent/skill/SKILL.md');
  const packagedSkill = read('cli/skills/intent/SKILL.md');
  const ship = read('ship.sh');

  assert.equal(publicSkill, packagedSkill);
  assert.match(settings, /For developers using Claude Code or Codex/);
  assert.match(settings, /phewsh ambient on/);
  assert.match(settings, /user-level adapters only after consent/);
  assert.match(settings, /It does not move native tool transcripts or push automatically/);
  assert.doesNotMatch(settings, /mkdir -p \.claude\/skills\/intent/);
  assert.doesNotMatch(onboarding, /Add the skill file to\s+any project/);
  assert.match(ship, /"intent\/skill\/"/);
});

test('the /intent/app export preserves the Intent source directory', () => {
  const ship = read('ship.sh');

  assert.doesNotMatch(ship, /for page in[^\n]*\bapp\b/);
  assert.doesNotMatch(ship, /rm -rf ["']?\.\/app(?:["'\s]|$)/);
  assert.match(ship, /rm -f \.\/app\.html \.\/app\/index\.html \.\/app\/__next\.\*\.txt/);
  assert.match(ship, /cp app\/out\/app\.html \.\/app\/index\.html/);
});

test('live supporting pages treat MCP, sync, and local execution as bounded adapters', () => {
  const about = read('about.html');
  const connect = read('connect/index.html');
  const mcp = read('mcp/index.html');
  const desktop = read('desktop/index.html');
  const phewsh = read('phewsh.html');

  assert.match(about, /One truth, many adapters/);
  assert.match(about, /Project · Next · Work · Record/);
  assert.match(about, /Transcripts, private model reasoning, editor buffers/);
  assert.match(about, /assets\/nav\.js/);
  assert.doesNotMatch(about, /working memory\s+follow you/i);
  assert.doesNotMatch(about, /your AI context follows you\s+everywhere/i);

  assert.match(connect, /coordinates the AI tools you already use around one project-owned record/);
  assert.match(connect, /Unrecorded conversation nuance still does not transfer/);
  assert.match(connect, /Work begins only after a human explicitly claims the task/);
  assert.doesNotMatch(connect, /switching tools or machines never means starting over/i);
  assert.doesNotMatch(connect, /turns every agent CLI.*into a dispatchable runtime/i);

  assert.match(mcp, /<h1>MCP <span>adapter<\/span><\/h1>/);
  assert.match(mcp, /does not claim work\s+or grant remote execution/);
  assert.match(mcp, /teammates cannot reach this machine's localhost/);
  assert.match(mcp, /Connect to this machine/);
  assert.match(mcp, /targetAddressSpace: 'loopback'/);
  assert.doesNotMatch(mcp, /\bpoll\(\);\s+setInterval\(poll/);
  assert.doesNotMatch(mcp, /executes\s+tasks instantly/i);
  assert.doesNotMatch(mcp, /Dispatch from anywhere/i);

  // The desktop page now offers a REAL download, so the old guard (no
  // download language at all, because no download existed) is retired. What
  // replaces it is stricter: if the page offers a binary, it must disclose
  // that the binary is unsigned and must not overstate what the app can do.
  assert.match(desktop, /Install Ion/);
  assert.match(desktop, /never grants blanket device authority/);
  assert.match(desktop, /illustrative only, nothing there executes/);
  assert.match(desktop, /bounded, human-initiated work|you stay in control/);

  // Downloads point at the public release repo — never at a path in this
  // private repo, which no visitor could fetch.
  assert.match(desktop, /cleverIdeaz\/phewsh-desktop\/releases/);

  // The unsigned-alpha disclosure is load-bearing: it is the reason a user
  // sees an OS malware warning, and it must not quietly disappear.
  assert.match(desktop, /not code-signed/i);
  assert.match(desktop, /System Settings → Privacy &amp; Security/);
  assert.match(desktop, /Run anyway/);
  // Unverified must never be dressed up as "checked and safe".
  assert.match(desktop, /not .this file was checked and found harmful/i);

  // Updates are the one thing that IS signed; the page may claim verification
  // only alongside the refusal behaviour that makes the claim meaningful.
  assert.match(desktop, /signed with Phewsh's release key is refused/);

  // The unfinished link step must stay admitted while it is unfinished.
  assert.match(desktop, /does not yet create the link/);
  // The CLI is a hard prerequisite for serve; the page must not imply the
  // desktop app is self-sufficient.
  assert.match(desktop, /npm install -g phewsh/);
  // Loopback-only dispatch is a security boundary, not a missing feature.
  assert.match(desktop, /teammate still cannot command an agent on your machine/);

  assert.match(phewsh, /One project truth across your AI tools and team/);
  assert.match(phewsh, /What was not recorded does not transfer/);
  assert.match(phewsh, /Work together in Ion/);
  assert.doesNotMatch(phewsh, /your context follows you everywhere/i);
});

test('platform fallbacks and Cockpit preserve the bounded contract without shared-nav JavaScript', () => {
  const fallbackPages = [
    'api/index.html',
    'cli/index.html',
    'cockpit/index.html',
    'mcp/index.html',
    'platform/index.html',
  ];
  const pages = fallbackPages.map(read);
  const cockpit = read('cockpit/index.html');
  const nav = read('assets/nav.js');
  const ship = read('ship.sh');

  for (const [index, page] of pages.entries()) {
    assert.match(page, /See a bounded Claude Code → Codex handoff and verify its receipt/,
      `${fallbackPages[index]} should explain the proof link without a pooled-budget claim`);
    assert.match(page, /terminal sync happens only when you push or pull/,
      `${fallbackPages[index]} should keep the fallback Intent link explicit`);
    assert.doesNotMatch(page, /one budget across Claude, Cursor, local|same projects, stays synced/i);
  }

  assert.match(cockpit, /One machine\. Supported AI tools\. Shared recorded project truth\./);
  assert.match(cockpit, /each route receives a fresh bounded \.intent\/ brief; prior transcripts stay put/);
  assert.match(cockpit, /sync only on push, pull, or signed-in watch/);
  assert.match(cockpit, /Cloud sync remains a separate, explicit action/);
  assert.doesNotMatch(cockpit, /shared project memory|context travels|no memory yet|mirrored|decisions and outcomes accumulate/i);
  assert.match(nav, /mi\('\/cockpit', 'Cockpit'/);
  assert.match(ship, /"cockpit\/"/);
});

test('shared live entry surfaces use one bounded promise contract', () => {
  const homepage = read('index.html');
  const nav = read('assets/nav.js');
  const platform = read('platform/index.html');
  const cockpit = read('cockpit/index.html');
  const api = read('api/index.html');
  const connect = read('connect/index.html');
  const ion = read('ion/classic.html');
  const ionApp = read('ion/index.html');
  const founder = read('neal/index.html');
  const cliPage = read('cli/index.html');
  const session = read('cli/commands/session.js');
  const ui = read('cli/lib/ui.js');
  const ship = read('ship.sh');
  const combined = [homepage, nav, platform, cockpit, api, connect, ion, ionApp, founder, cliPage, session, ui].join('\n');

  assert.match(nav, /Install \+ review adapter setup/);
  assert.match(nav, /two separate consent screens/);
  assert.match(nav, /<code>shim on<\/code> — one PATH line \+ tiny wrappers/);
  assert.match(nav, /<code>ambient on<\/code> — previews every file, then adds marked skills\/context blocks \+ Claude hooks that inject a bounded brief at start/);
  assert.match(nav, /save time\/project\/cwd metadata at end\. Never transcript content/);
  assert.match(nav, /No existing AI-tool files or shell PATH configuration are changed; a bare first launch keeps adapters off/);
  assert.match(nav, /your-project\/\.intent\/.*created only by.*phewsh init/s);
  assert.match(nav, /~\/\.agents\/skills\/intent\/.*~\/\.claude\/skills\/intent\/.*ambient on.*consent/s);
  assert.match(nav, /your-project\/\.agents\/skills\/intent\/.*Phewsh never creates or changes it/s);
  assert.match(nav, /#pn-get-modal-bd\{[^}]*z-index:2147483000/);
  assert.match(nav, /#pn-auth-modal-bd\{[^}]*z-index:2147483002/);
  assert.ok(nav.indexOf('>_ Just install') < nav.indexOf('Full setup + official packs'),
    'the minimal install should appear before optional packs');
  assert.match(platform, /source-backed self-assessment, not an independent audit/);
  assert.match(platform, /Loopback is not authentication/);
  assert.match(api, /supported gateway models/);
  assert.match(api, /any\s+client using that key receives the gateway budget check/);
  assert.match(api, /Phewsh MCP Connector Key/);
  assert.match(api, /cannot call the paid model gateway/);
  assert.match(api, /purpose: 'mcp'/);
  assert.match(api, /purpose: 'gateway'/);
  assert.match(api, /activeGatewayKeyId/);
  assert.match(api, /activeMcpKeyId/);
  assert.match(connect, /Keep supported AI tools native/);
  assert.match(ion, /your team and supported AI tools one room/);
  assert.match(ionApp, /Phewsh Ion/);
  assert.match(ionApp, /The workspace above every AI workspace/);
  assert.match(homepage, /unrecorded conversation stays tool-local/);
  // The founder page was deliberately redesigned on 2026-08-07 (Neal) and no
  // longer carries the long sentence this used to pin. Asserting one exact
  // sentence made this guard brittle against any legitimate rewrite, which is
  // how it ended up red on shipped, intentional work.
  //
  // The protection that MATTERS is unchanged: `founder` is part of `combined`,
  // so every overclaim assertion at the bottom of this test still covers it —
  // it still cannot say context follows you, that transcripts sync, or that
  // every AI tool starts on the same page. What is asserted here now is only
  // that the page still makes a bounded continuity claim at all.
  assert.match(founder, /continuity layer/i);
  assert.match(cliPage, /Their capabilities and transcripts remain separate/);
  assert.match(session, /supported adapters can read it; native transcripts do not move/);
  assert.match(ui, /Native transcripts stay with their tool/);
  assert.match(ship, /"platform\/"/);
  assert.match(ship, /"cockpit\/"/);
  assert.match(ship, /"install\.sh"/);

  assert.doesNotMatch(combined, /every AI tool starts on the same page/i);
  assert.doesNotMatch(combined, /One project truth for every AI tool/i);
  assert.doesNotMatch(combined, /They inherit the same four answers/i);
  assert.doesNotMatch(combined, /Last audited/i);
  assert.doesNotMatch(combined, /Context follows|sync everywhere|agents pick it up automatically/i);
  assert.doesNotMatch(nav, /Install \+ turn everything on/);
});

test('repository front door local links resolve', () => {
  const readme = read('README.md');
  const targets = [...readme.matchAll(/\]\((\.\/.+?)(?:#[^)]+)?\)/g)].map((match) => match[1]);

  assert.ok(targets.length >= 4, 'README should link to durable local evidence and docs');
  for (const target of targets) {
    assert.ok(fs.existsSync(path.resolve(ROOT, target)), `missing README link target: ${target}`);
  }
});

// The download page hardcodes asset filenames, but `make-release.mjs` is what
// actually decides them. Nothing connects the two at runtime: rename an asset in
// the script (or fix a typo on the page) and every download silently 404s, which
// is exactly the failure a visitor cannot diagnose and will not report. This ties
// them together so the break happens in CI instead of on the live site.
test('every /desktop download URL matches an asset the release script really produces', () => {
  const desktop = read('desktop/index.html');
  const script = read('desktop/spike-tauri/scripts/make-release.mjs');

  // Canonical names the script assigns, e.g.  as: "Phewsh-Ion-macOS.dmg",
  const canonical = new Set([...script.matchAll(/\bas:\s*"([^"]+)"/g)].map((m) => m[1]));

  assert.ok(
    canonical.size >= 5,
    `expected make-release.mjs to define at least 5 canonical asset names, parsed ${canonical.size}. ` +
      `If the script's shape changed, update this parser — do not weaken the check.`
  );

  // Every release-download link the page offers must name one of those assets.
  const linked = [...desktop.matchAll(/releases\/latest\/download\/([^"'\s>]+)/g)].map((m) => m[1]);
  assert.ok(linked.length > 0, 'the desktop page offers no download links at all');

  for (const asset of linked) {
    assert.ok(
      canonical.has(asset),
      `desktop/index.html links "${asset}", which make-release.mjs never produces. ` +
        `Known assets: ${[...canonical].join(', ')}`
    );
  }

  // The updater manifest must be reachable at the stable URL the app polls;
  // tag-pinned asset URLs inside it are fine, but this entry point cannot move.
  assert.match(
    read('desktop/spike-tauri/src-tauri/tauri.conf.json'),
    /releases\/latest\/download\/latest\.json/,
    'the updater endpoint must use the /latest/ URL so installed apps keep finding it'
  );

  // Platform detection may only offer a binary that is actually built.
  for (const os of ['macOS', 'Windows', 'Linux']) {
    assert.ok(
      linked.some((a) => a.includes(os)),
      `the page offers no ${os} download, but the release pipeline builds one`
    );
  }
});

// ── phewsh x: a charter, not a launch ──────────────────────────────────────
// The page's whole claim to credibility is that it says the guild does not
// exist. The pressure to quietly upgrade "proposed" into "join now" will
// arrive long before the guild does, so the disclosures are pinned here.
test('the phewsh x page states the guild does not exist and cannot imply it does', () => {
  const x = read('x/index.html');

  // The disclosure, and its position: it must be in the hero, not the footer.
  assert.match(x, /Nothing is being shared yet/);
  assert.ok(
    x.indexOf('Nothing is being shared yet') < x.indexOf('The charter'),
    'the disclosure must appear before the charter, not after it'
  );
  assert.match(x, /No compute is pooled, no\s+machine has joined/);
  assert.match(x, /currently forbids running work across machines/);

  // The honest status of every piece, including the parts that look bad.
  assert.match(x, /Currently forbidden/);
  assert.match(x, /Not started/);

  // The six terms are the product. Losing one silently is the failure mode.
  for (const term of [
    /Off unless chosen/,
    /You set the ceiling/,
    /Every cycle is attributable/,
    /Leaving is instant/,
    /Compute is shared\. Your project is not/,
    /What you give sets what you can draw/,
  ]) {
    assert.match(x, term, `charter term missing: ${term}`);
  }

  // The three gates must stay named, because they are what gate the build.
  assert.match(x, /requires a separate ruling/);
  assert.match(x, /isolation, not\s*a\s*security boundary/);
  assert.match(x, /One meaning for SAP/);

  // Signing must never read as joining.
  assert.match(x, /Signing binds nobody and joins nothing/);
  assert.doesNotMatch(x, /\bJoin the (guild|network)\b/i);
  // The page says "Not a waitlist" — so forbid the *offer*, not the word.
  assert.match(x, /Not a waitlist/);
  assert.doesNotMatch(x, /join the waitlist|sign up now|get early access/i);
});

// ── /build: Neal's own condition on selling the service ────────────────────
test('the MCP service page keeps "you could do this yourself" near the top', () => {
  const b = read('build/index.html');

  assert.match(b, /You could do this yourself/);
  assert.match(b, /modelcontextprotocol\.io/);
  // Burying it turns candour into a tactic: it must precede the pitch.
  assert.ok(
    b.indexOf('You could do this yourself') < b.indexOf('What you get'),
    'the self-serve disclosure must come before the sales content'
  );
  assert.match(b, /not false modesty/);

  // No invented price, and no placeholder that could ship by accident.
  assert.match(b, /Pay what it is worth to you/);
  assert.doesNotMatch(b, /\$\s?\d/, 'no dollar figure — Neal sets pricing, not the page');
  assert.doesNotMatch(b, /TBD|TODO|XXX|placeholder/i);

  // Handover, not lock-in — the page promises the buyer owns the result.
  assert.match(b, /no dependency\s+on Phewsh/);
  assert.match(b, /never sit between you and your bill/);
  assert.match(b, /may end with me telling you that\s+you do not need this/);
});
