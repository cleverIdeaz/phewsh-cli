// The 12-node Intent Compass — the CLI's canonical copy of the model the web
// compass renders (intent/app/src/lib/intent-analysis.ts). One definition,
// two surfaces: the web helps you SEE your intent; the terminal helps you
// SAY it. Ordered as a ladder — the first five are the strongest nodes and
// form the default clarify walk; --deep continues through all twelve.

const INTENT_NODES = [
  { id: 'purpose', title: 'Purpose', directive: 'the core reason this exists',
    q: 'What outcome are you really after — and why does this need to exist?' },
  { id: 'audience', title: 'Audience', directive: 'the people this serves',
    q: 'Who is this for? Who feels it most when it works?' },
  { id: 'method', title: 'Method', directive: 'the mechanism and approach',
    q: 'How does it actually work — the core mechanism or approach?' },
  { id: 'scope', title: 'Scope', directive: 'boundaries, in and out',
    q: "What's in — and just as important, what's deliberately out, for now?" },
  { id: 'differentiation', title: 'Edge', directive: 'what makes this yours',
    q: 'What would be lost if someone else built this instead of you?' },
  // ── the deep walk continues here (--deep) ──
  { id: 'context', title: 'Context', directive: 'the situation that led here',
    q: "What's happening right now that makes this relevant — what led to it?" },
  { id: 'resources', title: 'Resources', directive: 'time, money, energy, tools',
    q: 'What does this require — time, money, energy, tools you already have?' },
  { id: 'strategy', title: 'Strategy', directive: 'the roadmap and sequence',
    q: 'How do you get from here to success — what happens first, second, third?' },
  { id: 'signals', title: 'Signals', directive: 'metrics, validation, feedback',
    q: 'How will you know this is working — what would you actually measure?' },
  { id: 'risks', title: 'Risks', directive: 'threats, unknowns, failure modes',
    q: "What could go wrong — what's the biggest unknown or exposure?" },
  { id: 'values', title: 'Values', directive: 'ethics, trust, non-negotiables',
    q: 'What do you refuse to compromise on, even under pressure?' },
  { id: 'impact', title: 'Impact', directive: 'long-term effects and sustainability',
    q: 'If this fully succeeds, what changes — and how does it sustain itself?' },
];

// The five strongest nodes — the default clarify walk.
const CORE_NODES = INTENT_NODES.slice(0, 5);

module.exports = { INTENT_NODES, CORE_NODES };
