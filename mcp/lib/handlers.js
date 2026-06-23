// Shared coordination helpers for PHEWSH MCP.
//
// Both the stdio transport (src/index.js) and the HTTP transport
// (src/http-server.js) call into this module so they see the same projects,
// sessions, results, and dispatch-packet shape.
//
// Enforcement-specific logic (evaluateAction, dailyBudgetStatus, recordSpend,
// COST_CATALOG) stays in src/index.js because the test suite at
// tests/mcp-evaluateAction.mjs imports those symbols directly from there. If
// the HTTP transport ever needs to expose evaluate_action, re-export from
// here.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const PHEWSH_DIR = join(homedir(), ".phewsh");
export const PROJECTS_FILE = join(PHEWSH_DIR, "projects.json");
export const RESULTS_DIR = join(PHEWSH_DIR, "results");
export const SESSIONS_DIR = join(PHEWSH_DIR, "sessions");

export function ensureDirs() {
  for (const dir of [PHEWSH_DIR, RESULTS_DIR, SESSIONS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// ─── Project Loading ────────────────────────────────────────────────────────

export function loadProjects(cwd = process.cwd()) {
  ensureDirs();
  const projects = [];

  const localIntent = join(cwd, ".intent");
  if (existsSync(localIntent)) {
    const local = loadLocalIntentProject(localIntent);
    if (local) projects.push(local);
  }

  if (existsSync(PROJECTS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(PROJECTS_FILE, "utf-8"));
      if (Array.isArray(data)) projects.push(...data);
    } catch { /* ignore */ }
  }

  return projects;
}

function loadLocalIntentProject(dir) {
  const project = {
    id: "local",
    name: "Current Project",
    source: "local",
    artifacts: {},
    actions: [],
    decisionGate: null,
  };

  const files = ["vision.md", "plan.md", "next.md", "status.md", "narrative.md"];
  for (const file of files) {
    const path = join(dir, file);
    if (existsSync(path)) {
      const kind = file.replace(".md", "");
      project.artifacts[kind] = { kind, content: readFileSync(path, "utf-8") };
      if (kind === "vision") {
        const firstLine = project.artifacts[kind].content.split("\n").find(l => l.trim().length > 5);
        if (firstLine) project.name = firstLine.replace(/^#+\s*/, "").trim().slice(0, 60);
      }
    }
  }

  const metaPath = join(dir, "project.json");
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      Object.assign(project, meta);
    } catch { /* ignore */ }
  }

  return Object.keys(project.artifacts).length > 0 ? project : null;
}

// ─── Task Ordering ──────────────────────────────────────────────────────────

const URGENCY_WEIGHT = { critical: 4, urgent: 3, moderate: 2, relaxed: 1 };
const TYPE_PRIORITY = { agent: 3, ai: 2, human: 1 };

export function classifyExecutionType(intent) {
  const lower = intent.toLowerCase();
  if (/\b(meet|call|email|talk|discuss|decide|choose|buy|purchase|sign up|register|hire|interview|negotiate|pitch|present|attend|schedule|book|contact|reach out|approve)\b/.test(lower)) return "human";
  if (/\b(deploy|publish|push|install|run|execute|build|compile|test|debug|browse|navigate|click|fill|submit|upload|download|configure|ssh|terminal|git push|npm|docker|automate|scrape|monitor)\b/.test(lower)) return "agent";
  return "ai";
}

function scoreTask(action, project) {
  let score = 0;
  const gate = project.decisionGate;
  if (gate?.constraints?.urgency) score += (URGENCY_WEIGHT[gate.constraints.urgency] || 2) * 10;
  const execType = action.executionType || classifyExecutionType(action.intent);
  score += (TYPE_PRIORITY[execType] || 1) * 5;
  const completedCategories = (project.actions || [])
    .filter(a => a.state === "reconciled" && a.reconciliation?.decision === "accept")
    .slice(-3)
    .map(a => a.category);
  if (action.category && !completedCategories.includes(action.category)) score += 3;
  if (action.createdAt) {
    const age = Date.now() - new Date(action.createdAt).getTime();
    score += Math.min(5, Math.floor(age / (1000 * 60 * 60 * 24)));
  }
  return score;
}

export function getOrderedTasks(project, filter = "any") {
  const pending = (project.actions || []).filter(a => {
    if (a.state !== "intended") return false;
    if (filter === "any") return true;
    const aType = a.executionType || classifyExecutionType(a.intent);
    return aType === filter;
  });
  return pending
    .map(a => ({ action: a, score: scoreTask(a, project) }))
    .sort((a, b) => b.score - a.score)
    .map(s => s.action);
}

// ─── Sessions ───────────────────────────────────────────────────────────────

export function recordSession(agentId, projectId, event, data = {}) {
  ensureDirs();
  const session = {
    agentId: agentId || "anonymous",
    projectId,
    event,
    timestamp: new Date().toISOString(),
    ...data,
  };
  const file = join(SESSIONS_DIR, `${projectId}_sessions.json`);
  let sessions = [];
  if (existsSync(file)) {
    try { sessions = JSON.parse(readFileSync(file, "utf-8")); } catch { sessions = []; }
  }
  sessions.push(session);
  if (sessions.length > 100) sessions = sessions.slice(-100);
  writeFileSync(file, JSON.stringify(sessions, null, 2));
  return session;
}

export function getRecentSessions(projectId, limit = 10) {
  const file = join(SESSIONS_DIR, `${projectId}_sessions.json`);
  if (!existsSync(file)) return [];
  try {
    const sessions = JSON.parse(readFileSync(file, "utf-8"));
    return sessions.slice(-limit);
  } catch { return []; }
}

// ─── Results / Blockers ─────────────────────────────────────────────────────

export function recordResult(record) {
  ensureDirs();
  const file = join(RESULTS_DIR, `${record.taskId}_${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

export function recordBlocker(record) {
  ensureDirs();
  const file = join(RESULTS_DIR, `blocker_${record.taskId}_${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({ type: "blocker", ...record }, null, 2));
  return file;
}

export function updateLocalStatusMd(projectId, success, summaryLine, agentId) {
  if (projectId !== "local") return;
  const intentDir = join(process.cwd(), ".intent");
  if (!existsSync(intentDir)) return;
  const statusFile = join(intentDir, "status.md");
  const entry = `\n- [${success ? "x" : "!"}] ${summaryLine} (${new Date().toISOString().split("T")[0]})${agentId ? ` [${agentId}]` : ""}\n`;
  try {
    if (existsSync(statusFile)) {
      writeFileSync(statusFile, readFileSync(statusFile, "utf-8") + entry);
    } else {
      writeFileSync(statusFile, `# Execution Log\n${entry}`);
    }
  } catch { /* non-critical */ }
}

// ─── Dispatch Packet Generation ─────────────────────────────────────────────

export function generatePacket(action, project) {
  const constraints = project.decisionGate?.constraints || {};
  return {
    version: "1.0",
    id: action.id || `task_${Date.now()}`,
    createdAt: new Date().toISOString(),
    objective: {
      task: action.intent,
      category: action.category,
      successState: deriveSuccessState(action.intent),
    },
    constraints: {
      budget: constraints.budget ? `$${constraints.budget}` : undefined,
      time: constraints.timeHoursPerWeek ? `${constraints.timeHoursPerWeek}h/week available` : undefined,
      skill: constraints.skillLevel,
      urgency: constraints.urgency,
      boundaries: deriveBoundaries(constraints),
    },
    context: {
      project: `${project.name}${project.tldr ? ` — ${project.tldr}` : ""}`,
      vision: project.artifacts?.vision?.content?.slice(0, 600),
      plan: findRelevantPlan(action.intent, project.artifacts?.plan?.content),
      priorWork: getPriorWork(action, project),
    },
    verification: deriveVerification(action.intent),
    rollback: assessReversibility(action.intent),
    evaluation: {
      required: true,
      pre_action_check: "phewsh_evaluate_action",
      post_completion_check: "phewsh_check_verification",
    },
    continuation: {
      reportBack: "When done, call phewsh_complete_task with your result. Include: what you did, what worked, any issues.",
      nextActions: getNextActions(action, project),
    },
    runtime: inferRuntime(action.intent),
  };
}

function deriveSuccessState(intent) {
  const lower = intent.toLowerCase();
  if (/deploy|publish|push|ship/.test(lower)) return "Live and accessible at target URL";
  if (/set up|configure|install/.test(lower)) return "Service running and verified";
  if (/write|draft|create/.test(lower)) return "Document complete and saved";
  if (/research|investigate|analyze/.test(lower)) return "Findings documented with recommendations";
  if (/fix|debug|resolve/.test(lower)) return "Issue no longer reproducible";
  if (/build|implement|code/.test(lower)) return "Feature working and integrated";
  if (/test|verify/.test(lower)) return "All checks pass";
  return `"${intent}" completed and verified`;
}

function deriveBoundaries(constraints) {
  const b = [];
  if (constraints.budget && constraints.budget < 100) b.push("Do not use paid services without approval");
  if (constraints.urgency === "critical") b.push("Do not spend time on non-essential polish");
  if (constraints.autonomy === "hands-on") b.push("Do not make irreversible decisions without presenting options");
  return b.length > 0 ? b : undefined;
}

function findRelevantPlan(intent, planContent) {
  if (!planContent) return undefined;
  const lines = planContent.split("\n");
  const words = intent.toLowerCase().split(/\s+/).filter(w => w.length > 4);
  let bestIdx = -1, bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const score = words.filter(w => lines[i].toLowerCase().includes(w)).length;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  if (bestIdx >= 0 && bestScore >= 2) {
    return lines.slice(Math.max(0, bestIdx - 2), bestIdx + 8).join("\n");
  }
  return undefined;
}

function getPriorWork(action, project) {
  const done = (project.actions || [])
    .filter(a => a.id !== action.id && a.state === "reconciled" && a.reconciliation?.decision === "accept")
    .slice(-5)
    .map(a => a.intent);
  return done.length > 0 ? done : undefined;
}

function getNextActions(action, project) {
  const next = (project.actions || [])
    .filter(a => a.id !== action.id && a.state === "intended" && a.category === action.category)
    .slice(0, 2)
    .map(a => a.intent);
  return next.length > 0 ? next : undefined;
}

export function deriveVerification(intent) {
  const lower = intent.toLowerCase();
  const criteria = [];
  if (/deploy|publish/.test(lower)) { criteria.push("Accessible at target URL", "No error responses"); }
  else if (/build|implement|code/.test(lower)) { criteria.push("Compiles without errors", "Feature works as described"); }
  else if (/write|draft/.test(lower)) { criteria.push("Content complete and coherent", "Saved to expected location"); }
  else if (/set up|configure/.test(lower)) { criteria.push("Responds to test interaction", "Persists across restart"); }
  else { criteria.push("Objective achieved as described", "No unintended side effects"); }
  return { criteria };
}

export function assessReversibility(intent) {
  const lower = intent.toLowerCase();
  if (/delete|remove|send email|publish|announce/.test(lower)) return { canRevert: false, warning: "Confirm before executing" };
  if (/deploy|push|migrate/.test(lower)) return { canRevert: true, how: "Redeploy previous version" };
  return { canRevert: true };
}

function inferRuntime(intent) {
  const lower = intent.toLowerCase();
  if (/deploy|push|git|npm|build|compile|test|ssh|terminal/.test(lower)) return { preferred: "claude-code", needs: ["filesystem", "terminal"] };
  if (/browse|navigate|click|fill|submit|sign up|scrape/.test(lower)) return { preferred: "browser-agent", needs: ["browser", "network"] };
  if (/meet|call|email|discuss|decide|buy|hire/.test(lower)) return { preferred: "human", needs: ["judgment", "social"] };
  return { preferred: "claude-code", needs: ["text-generation"] };
}

// ─── Briefing ───────────────────────────────────────────────────────────────

export function summarizeProject(p) {
  const actions = p.actions || [];
  const total = actions.length;
  const done = actions.filter(a => a.state === "reconciled" && a.reconciliation?.decision === "accept").length;
  const pending = actions.filter(a => a.state === "intended").length;
  const dispatched = actions.filter(a => a.state === "dispatched").length;
  const gate = p.decisionGate;
  return {
    id: p.id,
    name: p.name,
    tldr: p.tldr,
    source: p.source || "synced",
    progress: total > 0 ? { done, total, percent: Math.round(done / total * 100) } : null,
    pending,
    dispatched,
    feasibility: gate?.feasibility,
    constraints: gate?.constraints ? {
      budget: gate.constraints.budget || null,
      timePerWeek: gate.constraints.timeHoursPerWeek || null,
      urgency: gate.constraints.urgency,
      autonomy: gate.constraints.autonomy,
    } : null,
  };
}

export function buildFullBriefing(project) {
  const sections = [];
  sections.push(`# ${project.name}`);
  if (project.tldr) sections.push(`> ${project.tldr}`);
  sections.push("");

  const gate = project.decisionGate;
  if (gate) {
    sections.push("## Your Operating Reality");
    if (gate.goal) sections.push(`**Goal:** ${gate.goal}`);
    if (gate.feasibility) sections.push(`**Feasibility:** ${gate.feasibility}`);
    const c = gate.constraints || {};
    const constraintLines = [];
    if (c.budget) constraintLines.push(`Budget: $${c.budget}`);
    if (c.timeHoursPerWeek) constraintLines.push(`Time: ${c.timeHoursPerWeek}h/week`);
    if (c.skillLevel) constraintLines.push(`Skill: ${c.skillLevel}`);
    if (c.urgency) constraintLines.push(`Urgency: ${c.urgency}`);
    if (c.autonomy) constraintLines.push(`Autonomy: ${c.autonomy}`);
    if (constraintLines.length > 0) {
      sections.push("");
      constraintLines.forEach(l => sections.push(`- ${l}`));
    }
    if (gate.successCriteria?.length > 0) {
      sections.push("");
      sections.push("**Success looks like:**");
      gate.successCriteria.forEach(c => sections.push(`- ${c}`));
    }
    sections.push("");
  }

  if (project.artifacts?.vision?.content) {
    sections.push("## Vision");
    sections.push(project.artifacts.vision.content.slice(0, 800));
    sections.push("");
  }

  if (project.artifacts?.plan?.content) {
    sections.push("## Plan");
    sections.push(project.artifacts.plan.content.slice(0, 1200));
    sections.push("");
  }

  const actions = project.actions || [];
  if (actions.length > 0) {
    const done = actions.filter(a => a.state === "reconciled" && a.reconciliation?.decision === "accept");
    const pending = actions.filter(a => a.state === "intended");
    const dispatched = actions.filter(a => a.state === "dispatched");

    sections.push("## Execution State");
    sections.push(`Progress: ${done.length}/${actions.length} complete (${Math.round(done.length / actions.length * 100)}%)`);

    if (dispatched.length > 0) {
      sections.push("");
      sections.push("**In progress:**");
      dispatched.forEach(a => sections.push(`- ${a.intent}`));
    }

    if (done.length > 0) {
      sections.push("");
      sections.push("**Recently completed:**");
      done.slice(-5).forEach(a => sections.push(`- ${a.intent}`));
    }

    if (pending.length > 0) {
      sections.push("");
      sections.push("**Ready for you:**");
      const ordered = getOrderedTasks(project, "any").slice(0, 8);
      ordered.forEach(a => {
        const type = a.executionType || classifyExecutionType(a.intent);
        sections.push(`- [${type}] ${a.intent}`);
      });
      if (pending.length > 8) sections.push(`  ...and ${pending.length - 8} more`);
    }
    sections.push("");
  }

  return sections.join("\n");
}
