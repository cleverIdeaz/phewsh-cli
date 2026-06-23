#!/usr/bin/env node

/**
 * PHEWSH MCP Server v0.3.0 — stdio transport.
 *
 * The coordination layer between humans and AI agents.
 *
 * Any MCP-capable agent connects here and immediately knows:
 *   - What project they're working on
 *   - What needs to happen next (structured, not vague)
 *   - What constraints to respect
 *   - How to prove they did it right
 *   - What to do after they finish
 *
 * One call to start. One call to finish. Everything in between is execution.
 *
 * The HTTP transport at src/http-server.js shares state via src/lib/ so the
 * intent web app sees the same coordination layer this stdio server sees.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

import {
  PHEWSH_DIR,
  loadProjects,
  getOrderedTasks,
  classifyExecutionType,
  generatePacket,
  recordSession,
  getRecentSessions,
  recordResult,
  recordBlocker,
  updateLocalStatusMd,
  buildFullBriefing,
  summarizeProject,
  deriveVerification,
  assessReversibility,
} from "./lib/handlers.js";
import * as runtimes from "./lib/runtime-registry.js";
import * as queue from "./lib/dispatch-queue.js";

// Version comes from the phewsh package this server ships inside — never hardcode it.
const PKG_VERSION = (() => {
  try {
    const pkgPath = join(fileURLToPath(new URL(".", import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// ─── Spend Tracking ─────────────────────────────────────────────────────────
// Daily rolling spend tracker — feeds the budget gate in evaluateAction.

const SPEND_DIR = join(PHEWSH_DIR, "spend");
mkdirSync(SPEND_DIR, { recursive: true });

const COST_CATALOG = {
  "claude-opus-4-7":   { in: 0.0025, out: 0.0125 },
  "claude-opus-4-6":   { in: 0.0025, out: 0.0125 },
  "claude-opus-4":     { in: 0.0025, out: 0.0125 },
  "claude-sonnet-4-7": { in: 0.0010, out: 0.0050 },
  "claude-sonnet-4":   { in: 0.0010, out: 0.0050 },
  "claude-sonnet-3-5": { in: 0.0005, out: 0.0015 },
  "step-3-5-flash":    { in: 0.0001, out: 0.0004 },
  "stepflash":         { in: 0.0001, out: 0.0004 },
  "gemini-2-0-flash":  { in: 0.0000, out: 0.0000 },
  "deepseek-chat":     { in: 0.0002, out: 0.0002 },
  "deepseek-reasoner": { in: 0.0005, out: 0.0015 },
  "openai/gpt-4o":     { in: 0.0010, out: 0.0040 },
  "openai/gpt-4o-mini":{ in: 0.0001, out: 0.0004 },
  "default":           { in: 0.0005, out: 0.0015 },
};

function _todaySpendData() {
  const dateKey = new Date().toISOString().slice(0, 10);
  const path = join(SPEND_DIR, `${dateKey}.json`);
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return { date: dateKey, entries: {}, total: 0 }; }
  }
  return { date: dateKey, entries: {}, total: 0 };
}

function _perCallCost(model, inputTokens, outputTokens) {
  const cat = COST_CATALOG[(model || "").toLowerCase()] || COST_CATALOG["default"];
  return Math.round(
    ((inputTokens  || 0) * cat.in  / 1000 +
     (outputTokens || 0) * cat.out / 1000) * 1e6,
  ) / 1e6;
}

function recordSpend(projectId, agentId, taskId, model, inputTokens, outputTokens, phase) {
  const data = _todaySpendData();
  const cost = _perCallCost(model, inputTokens, outputTokens);
  const key = new Date().toISOString();
  data.entries[key] = {
    timestamp: key, project_id: projectId, agent_id: agentId,
    task_id: taskId, model, input_tokens: inputTokens, output_tokens: outputTokens,
    cost, phase,
  };
  data.total = Math.round((data.total + cost) * 1e6) / 1e6;
  writeFileSync(join(SPEND_DIR, `${data.date}.json`), JSON.stringify(data, null, 2));
  return [data.total, cost];
}

function dailyBudgetStatus(softLimit, hardLimit) {
  const data = _todaySpendData();
  const total = data.total;
  const byModel = {};
  Object.values(data.entries).forEach(e => {
    const m = e.model || "unknown";
    byModel[m] ??= { cost: 0, calls: 0 };
    byModel[m].cost = Math.round((byModel[m].cost + e.cost) * 1e6) / 1e6;
    byModel[m].calls += 1;
  });
  return {
    status: total < softLimit ? "ok" : total < hardLimit ? "soft_exceeded" : "hard_exceeded",
    total, soft: softLimit, hard: hardLimit,
    remaining: Math.max(0, softLimit - total),
    by_model: byModel,
    date: data.date,
    entries: Object.keys(data.entries).length,
  };
}

// ─── Pre-Action Evaluation Gate ─────────────────────────────────────────────
// Four binary checks against project constraints. Deterministic allow / block
// / modify. See spec/enforcement.yaml.

function evaluateAction(project, args) {
  const ctx = args.context || {};
  const action = String(args.proposed_action || "");
  const lower = action.toLowerCase();
  const constraints = project?.decisionGate?.constraints || {};

  // Confidence failure hard branch — independent of all other checks.
  {
    const cintegrity = typeof ctx.context_integrity === "number" ? ctx.context_integrity : 1.0;
    const repeats = typeof ctx.repeated_injection_count === "number" ? ctx.repeated_injection_count : 0;
    const recursives = typeof ctx.recursive_summary_count === "number" ? ctx.recursive_summary_count : 0;
    const depth = typeof ctx.session_depth === "number" ? ctx.session_depth : 0;

    const degraded = (cintegrity < 0.55) || (repeats >= 3) || (recursives >= 3) || (depth > 2);

    if (degraded) {
      const reasons = [];
      if (cintegrity < 0.55) reasons.push(`context integrity ${cintegrity.toFixed(2)} < 0.55 threshold`);
      if (repeats >= 3) reasons.push(`repeated injection count ${repeats} >= 3`);
      if (recursives >= 3) reasons.push(`recursive summary count ${recursives} >= 3`);
      if (depth > 2) reasons.push(`session depth ${depth} > 2`);

      return {
        status: "block",
        reason: `Confidence failure — ${reasons.join("; ")}. Entering recovery mode.`,
        gate_reference: "constraints.confidence",
        suggested_action: "Summarize session state, queue pending work, and await higher-tier review. Do not resume autonomous writes until session integrity is restored.",
      };
    }
  }

  // Budget enforcement — rolling daily spend (soft/hard limits).
  const DAILY_SOFT = 0.65;
  const DAILY_HARD = 0.75;
  const budget = dailyBudgetStatus(DAILY_SOFT, DAILY_HARD);

  if (budget.status === "hard_exceeded") {
    return {
      status: "block",
      reason: `Daily hard budget limit exceeded: $${budget.total.toFixed(4)} spent today against $${DAILY_HARD}/day hard limit. Autonomous writes halted.`,
      gate_reference: "constraints.budget.daily_hard",
      suggested_action: "Session paused (hard limit). Human review required before continuing.",
      budget,
    };
  }

  if (budget.status === "soft_exceeded") {
    return {
      status: "modify",
      reason: `Daily soft budget limit reached: $${budget.total.toFixed(4)} spent today against $${DAILY_SOFT}/day soft limit. Downgrade to lightweight model and restrict to read-only/plan-only writes.`,
      gate_reference: "constraints.budget.daily_soft",
      suggested_action: `Switch to lightweight model (e.g. StepFlash / Gemini Flash free tier). Budget resets at midnight UTC. By-model breakdown: ${Object.entries(budget.by_model || {}).map(([m, v]) => `${m}($${v.cost})`).join(", ")}.`,
      budget,
    };
  }

  // diff / file allowlist gate.
  {
    const policy = project?.decisionGate?.codingPolicy || {};
    const diffCap = typeof policy.diff_cap === "number" ? policy.diff_cap : Infinity;
    const protectedFiles = Array.isArray(policy.protected_files) ? policy.protected_files : [];
    const blockedUnderFallback = Array.isArray(policy.blocked_under_fallback) ? policy.blocked_under_fallback : [];
    const filesTouched = Array.isArray(args.files_touched) ? args.files_touched.map(String) : [];
    const diffLines = typeof args.diff_lines === "number" ? args.diff_lines : null;

    const hitProtected = filesTouched.filter(f =>
      protectedFiles.some(p => f === p || f.endsWith(`/${p}`) || f.split("/").pop() === p));
    if (hitProtected.length > 0) {
      return {
        status: "block",
        reason: `Protected file(s) in diff: ${hitProtected.join(", ")}. These paths are off-limits to autonomous writes.`,
        suggested_action: "Drop the protected paths from this change, or escalate to a human to edit them directly.",
        gate_reference: "constraints.codingPolicy.protected_files",
      };
    }

    if (diffLines !== null && diffLines > diffCap) {
      return {
        status: "modify",
        reason: `Diff is ${diffLines} lines, over the ${diffCap}-line cap. Split into smaller reviewable changes.`,
        suggested_action: `Break this into chunks under ${diffCap} lines each and re-evaluate per chunk.`,
        gate_reference: "constraints.codingPolicy.diff_cap",
      };
    }

    const fallbackActive = ctx.fallback_active === true;
    const fallbackRestricts = typeof policy.fallback_behavior === "string" && policy.fallback_behavior.length > 0;
    if (fallbackActive && fallbackRestricts) {
      const hit = blockedUnderFallback.find(prefix => lower.startsWith(String(prefix).toLowerCase()));
      if (hit) {
        return {
          status: "block",
          reason: `Action "${action}" is blocked under the fallback execution path (matched prefix "${hit}"). Fallback policy: ${policy.fallback_behavior}`,
          suggested_action: "Queue this for the premium execution path (Claude Code subscription) and stay in maintenance mode meanwhile.",
          gate_reference: "constraints.codingPolicy.blocked_under_fallback",
        };
      }
    }
  }

  const isIrreversible = /\brm\s+-rf\b|\bdelete\b|drop\s+table|truncate|--force|force-push|git\s+push\s+--force|publish|deploy|announce|send\s+email|wipe|reset\s+--hard/.test(lower);
  const isNonEssential = /polish|cosmetic|refactor|cleanup|clean\s*up|rename|reorganize|tweak|nice[-\s]?to[-\s]?have/.test(lower);
  const confirmed = ctx.confirmed === true;

  if (typeof constraints.budget === "number" && constraints.budget > 0 &&
      typeof ctx.total_spend === "number" && ctx.total_spend > constraints.budget * 0.9) {
    return {
      status: "block",
      reason: `Over budget: $${ctx.total_spend} spent against a $${constraints.budget} budget (>90% threshold).`,
      gate_reference: "constraints.budget",
    };
  }

  if (constraints.urgency === "critical" && isNonEssential) {
    return {
      status: "block",
      reason: "Urgency is critical — non-essential work (polish/refactor/cleanup) is blocked. Strip to essentials.",
      gate_reference: "constraints.urgency",
    };
  }

  if (isIrreversible && !confirmed) {
    return {
      status: "block",
      reason: "Irreversible action without confirmation. Re-call with context.confirmed=true after the human signs off.",
      suggested_action: "Pause and get human confirmation, then re-evaluate with context.confirmed=true.",
      gate_reference: "constraints.reversibility",
    };
  }

  const allowedCategories = [...new Set((project?.actions || []).map(a => a.category).filter(Boolean))];
  const actionCategory = ctx.action_category;
  if (actionCategory && allowedCategories.length > 0 && !allowedCategories.includes(actionCategory)) {
    return {
      status: "modify",
      reason: `Action category "${actionCategory}" is outside declared intent (allowed: ${allowedCategories.join(", ")}).`,
      suggested_action: `Re-scope this action into one of the declared categories, or add "${actionCategory}" to .intent/ before proceeding.`,
      gate_reference: "constraints.intent",
    };
  }

  return {
    status: "allow",
    reason: "Within declared constraints; reversible or confirmed.",
    gate_reference: "constraints.none",
  };
}

// ─── MCP Server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "phewsh", version: PKG_VERSION },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

// ── Tools ──

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "phewsh_start",
      description: "Start a work session. Returns everything you need: project context, constraints, what changed, and your next task — all in one call. Call this first.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project ID (use 'local' for .intent/ project in cwd). Omit to auto-detect." },
          agent_id: { type: "string", description: "Your agent identifier (e.g. 'claude-code', 'cursor', 'custom-agent')" },
        },
      },
    },
    {
      name: "phewsh_next_task",
      description: "Get the next highest-priority task as a structured dispatch packet. Contains objective, constraints, verification criteria, and what to do after. Call this when you're ready for more work.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project ID" },
          type: { type: "string", enum: ["agent", "ai", "human", "any"], description: "Filter by who can do it (default: agent)" },
          skip_ids: { type: "array", items: { type: "string" }, description: "Task IDs to skip (already attempted)" },
          agent_id: { type: "string", description: "Your agent identifier" },
        },
        required: ["project_id"],
      },
    },
    {
      name: "phewsh_complete_task",
      description: "Report that you finished a task. Include what you did and whether it worked. Returns the next task automatically — keep the momentum going.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project ID" },
          task_id: { type: "string", description: "The task ID from the dispatch packet" },
          result: { type: "string", description: "What you accomplished — be specific about outputs and artifacts" },
          success: { type: "boolean", description: "Did it work?" },
          issues: { type: "string", description: "Problems encountered, decisions made, or things the human should know" },
          agent_id: { type: "string", description: "Your agent identifier" },
        },
        required: ["project_id", "task_id", "result", "success"],
      },
    },
    {
      name: "phewsh_list_projects",
      description: "List all available projects with their progress, constraints, and pending task counts.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "phewsh_get_context",
      description: "Get the full project briefing — vision, plan, constraints, execution state. Use when you need deeper context on a specific project.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project ID" },
        },
        required: ["project_id"],
      },
    },
    {
      name: "phewsh_check_verification",
      description: "Before marking a task complete, check its verification criteria. Returns what you need to confirm.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "The task ID to check verification for" },
          project_id: { type: "string", description: "Project ID" },
        },
        required: ["task_id", "project_id"],
      },
    },
    {
      name: "phewsh_evaluate_action",
      description: "Evaluate a proposed tool action against project constraints before executing. Call this BEFORE any write_file, terminal, or browser action. Returns allow/block/modify. Required for every action.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Current task ID from dispatch packet" },
          project_id: { type: "string", description: "Project ID" },
          proposed_action: { type: "string", description: "Tool action you want to take (e.g. 'write_file /path/to/file', 'terminal: git push', 'browser: submit')" },
          diff_lines: { type: "integer", minimum: 1, description: "Optional: number of lines this change adds/removes. Checked against codingPolicy.diff_cap." },
          files_touched: { type: "array", items: { type: "string" }, description: "Optional: file paths this action would write. Checked against codingPolicy.protected_files." },
          context: { type: "object", description: "Optional: total_spend (float, cumulative spend so far), elapsed_minutes (int, minutes since session start), action_category (string), confirmed (bool for irreversible actions), fallback_active (bool, true when running the restricted fallback execution path), context_integrity (float 0-1, rough trust/coherence level of current context reconstruction; 1=fully intact), repeated_injection_count (int, times context has been injected/recursive), recursive_summary_count (int, times context has been truncated/recap-ed), session_depth (int, nesting depth of this execution context, 0=origin)" },
          agent_id: { type: "string", description: "Your agent identifier" },
        },
        required: ["project_id", "proposed_action"],
      },
    },
    {
      name: "phewsh_flag_blocker",
      description: "Flag a task as blocked — something is preventing execution. The human will be notified.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project ID" },
          task_id: { type: "string", description: "Task ID that's blocked" },
          reason: { type: "string", description: "What's blocking execution" },
          needs: { type: "string", description: "What you need to unblock (e.g. 'API key', 'human decision', 'access to service')" },
          agent_id: { type: "string", description: "Your agent identifier" },
        },
        required: ["project_id", "task_id", "reason"],
      },
    },
    {
      name: "phewsh_session_history",
      description: "See what agents have done on this project — completions, blockers, session starts. Useful for understanding context across sessions.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project ID" },
          limit: { type: "number", description: "Number of events to return (default: 20)" },
        },
        required: ["project_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const projects = loadProjects();

  switch (name) {
    // ─── START SESSION ──────────────────────────────────────────────────────
    case "phewsh_start": {
      let projectId = args.project_id;
      if (!projectId) {
        if (projects.length === 1) projectId = projects[0].id;
        else if (projects.find(p => p.id === "local")) projectId = "local";
        else {
          return { content: [{ type: "text", text: `Multiple projects available. Specify one:\n${projects.map(p => `- ${p.id}: ${p.name}`).join("\n")}` }] };
        }
      }

      const project = projects.find(p => p.id === projectId);
      if (!project) {
        return { content: [{ type: "text", text: `Project "${projectId}" not found. Available: ${projects.map(p => `${p.id} (${p.name})`).join(", ")}` }] };
      }

      // Register this harness as a connected runtime so the HTTP /health
      // endpoint can surface it to the intent web app.
      const runtimeId = args.agent_id || "claude-code";
      runtimes.register({
        id: runtimeId,
        label: args.agent_id || "Claude Code (stdio)",
        transport: "stdio",
        agentId: args.agent_id || null,
      });

      recordSession(args.agent_id, projectId, "session_start");

      const sections = [];
      sections.push(`# Session Started: ${project.name}`);
      if (args.agent_id) sections.push(`Agent: ${args.agent_id}`);
      sections.push("");

      const recentSessions = getRecentSessions(projectId, 20);
      const recentCompletions = recentSessions.filter(s => s.event === "task_complete" && s.timestamp > new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      const recentBlockers = recentSessions.filter(s => s.event === "blocker_flagged" && !s.resolved);

      if (recentCompletions.length > 0 || recentBlockers.length > 0) {
        sections.push("## Since Last Session");
        if (recentCompletions.length > 0) {
          sections.push("**Completed:**");
          recentCompletions.slice(-5).forEach(s => sections.push(`- ${s.result?.split("\n")[0] || s.taskId}`));
        }
        if (recentBlockers.length > 0) {
          sections.push("**Blocked:**");
          recentBlockers.forEach(s => sections.push(`- ${s.reason} (needs: ${s.needs || "unknown"})`));
        }
        sections.push("");
      }

      sections.push(buildFullBriefing(project));

      // Prefer a web-dispatched job over the project's pending actions, so
      // pressing Execute in the web app surfaces here immediately.
      const queuedJob = queue.nextForRuntime(runtimeId);
      if (queuedJob) {
        queue.markExecuting(queuedJob.jobId, runtimeId, "Picked up by stdio harness");
        const packet = queuedJob.packet;
        sections.push("---");
        sections.push("## Your First Task (dispatched from web)");
        sections.push("");
        sections.push(`**${packet.objective.task}**`);
        sections.push(`Done when: ${packet.objective.successState}`);
        sections.push(`Task ID: \`${packet.id}\``);
        sections.push("");
        sections.push("**Enforcement:** before any write_file, terminal, or browser action, call `phewsh_evaluate_action` (status allow/block/modify). This is required — skipping it is a protocol violation.");
        sections.push("");
        sections.push(`When done, call \`phewsh_complete_task\` with task_id: "${packet.id}"`);
        return { content: [{ type: "text", text: sections.join("\n") }] };
      }

      const nextTasks = getOrderedTasks(project, "any");
      if (nextTasks.length > 0) {
        const first = nextTasks[0];
        const packet = generatePacket(first, project);
        sections.push("---");
        sections.push("## Your First Task");
        sections.push("");
        sections.push(`**${packet.objective.task}**`);
        sections.push(`Done when: ${packet.objective.successState}`);
        sections.push(`Task ID: \`${packet.id}\``);
        sections.push("");
        if (packet.constraints.boundaries) {
          sections.push("Boundaries:");
          packet.constraints.boundaries.forEach(b => sections.push(`- ${b}`));
          sections.push("");
        }
        sections.push("Verify before completing:");
        packet.verification.criteria.forEach(c => sections.push(`- [ ] ${c}`));
        sections.push("");
        if (!packet.rollback.canRevert) {
          sections.push(`**Warning:** This action is not easily reversible. ${packet.rollback.warning || "Confirm before executing."}`);
          sections.push("");
        }
        if (packet.continuation.nextActions?.length > 0) {
          sections.push("After this, next up:");
          packet.continuation.nextActions.forEach(a => sections.push(`- ${a}`));
          sections.push("");
        }
        sections.push("**Enforcement:** before any write_file, terminal, or browser action, call `phewsh_evaluate_action` (status allow/block/modify). This is required — skipping it is a protocol violation.");
        sections.push("");
        sections.push(`When done, call \`phewsh_complete_task\` with task_id: "${packet.id}"`);
      } else {
        sections.push("---");
        sections.push("## No Pending Tasks");
        sections.push("All tasks are complete or dispatched. Check back later or ask the project owner for new work.");
      }

      return { content: [{ type: "text", text: sections.join("\n") }] };
    }

    // ─── NEXT TASK ──────────────────────────────────────────────────────────
    case "phewsh_next_task": {
      const project = projects.find(p => p.id === args.project_id);
      if (!project) return { content: [{ type: "text", text: `Project "${args.project_id}" not found.` }] };

      // Prefer a web-dispatched job over project.actions.
      const runtimeId = args.agent_id || "claude-code";
      runtimes.touch(runtimeId);
      const queuedJob = queue.nextForRuntime(runtimeId);
      if (queuedJob) {
        queue.markExecuting(queuedJob.jobId, runtimeId, "Picked up by stdio harness");
        return { content: [{ type: "text", text: JSON.stringify({ ...queuedJob.packet, _meta: { source: "web_dispatch", jobId: queuedJob.jobId } }, null, 2) }] };
      }

      const typeFilter = args.type || "agent";
      const skipIds = args.skip_ids || [];
      let ordered = getOrderedTasks(project, typeFilter);
      ordered = ordered.filter(a => !skipIds.includes(a.id));

      if (ordered.length === 0) {
        if (typeFilter !== "any") {
          ordered = getOrderedTasks(project, "any").filter(a => !skipIds.includes(a.id));
          if (ordered.length > 0) {
            return { content: [{ type: "text", text: `No "${typeFilter}" tasks pending. ${ordered.length} tasks available with type filter "any". Call again with type: "any" if you can handle them.` }] };
          }
        }
        return { content: [{ type: "text", text: "All caught up. No pending tasks matching your criteria." }] };
      }

      const action = ordered[0];
      const packet = generatePacket(action, project);
      const remaining = ordered.length - 1;

      const output = {
        ...packet,
        _meta: {
          remaining_tasks: remaining,
          queue_position: 1,
          total_in_project: (project.actions || []).length,
        },
      };

      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }

    // ─── COMPLETE TASK ──────────────────────────────────────────────────────
    case "phewsh_complete_task": {
      const record = {
        projectId: args.project_id,
        taskId: args.task_id,
        result: args.result,
        success: args.success,
        issues: args.issues,
        agentId: args.agent_id,
        reportedAt: new Date().toISOString(),
      };

      recordResult(record);
      recordSession(args.agent_id, args.project_id, "task_complete", {
        taskId: args.task_id,
        success: args.success,
        result: args.result?.slice(0, 200),
      });

      // Mirror completion into the HTTP dispatch queue so any web poller
      // waiting on this task resolves.
      queue.completeByTaskId(args.task_id, {
        success: args.success,
        result: args.result,
        issues: args.issues,
      });

      // Record spend if model + token usage present in args.context.
      const estModel = (args.context || {}).est_model;
      const inTok = (args.context || {}).est_input_tokens;
      const outTok = (args.context || {}).est_output_tokens;
      if (estModel) {
        try {
          recordSpend(
            args.project_id, args.agent_id, args.task_id,
            estModel, inTok, outTok, args.success ? "task_complete" : "task_failed",
          );
        } catch { /* spend logging is best-effort; never block task completion */ }
      }

      updateLocalStatusMd(args.project_id, args.success, args.result.split("\n")[0], args.agent_id);

      if (args.agent_id) runtimes.touch(args.agent_id);

      const sections = [];
      if (args.success) {
        sections.push(`Task "${args.task_id}" completed successfully.`);
        if (args.issues) sections.push(`Note: ${args.issues}`);
      } else {
        sections.push(`Task "${args.task_id}" reported as failed.`);
        sections.push(`Issues: ${args.issues || args.result}`);
        sections.push("The project owner will be notified to review.");
      }

      const project = projects.find(p => p.id === args.project_id);
      if (project && args.success) {
        const runtimeId = args.agent_id || "claude-code";
        const queuedNext = queue.nextForRuntime(runtimeId);
        if (queuedNext) {
          queue.markExecuting(queuedNext.jobId, runtimeId, "Picked up by stdio harness");
          sections.push("");
          sections.push("---");
          sections.push("## Next Task (dispatched from web)");
          sections.push(`**${queuedNext.packet.objective.task}**`);
          sections.push(`Done when: ${queuedNext.packet.objective.successState}`);
          sections.push(`Task ID: \`${queuedNext.packet.id}\``);
        } else {
          const nextTasks = getOrderedTasks(project, "any").filter(a => a.id !== args.task_id);
          if (nextTasks.length > 0) {
            const next = nextTasks[0];
            const packet = generatePacket(next, project);
            sections.push("");
            sections.push("---");
            sections.push("## Next Task");
            sections.push(`**${packet.objective.task}**`);
            sections.push(`Done when: ${packet.objective.successState}`);
            sections.push(`Task ID: \`${packet.id}\``);
            sections.push("");
            sections.push("Verify:");
            packet.verification.criteria.forEach(c => sections.push(`- [ ] ${c}`));
            sections.push("");
            sections.push(`${nextTasks.length - 1} more tasks after this.`);
          } else {
            sections.push("");
            sections.push("All tasks complete! Great work.");
          }
        }
      }

      return { content: [{ type: "text", text: sections.join("\n") }] };
    }

    // ─── LIST PROJECTS ──────────────────────────────────────────────────────
    case "phewsh_list_projects": {
      const summary = projects.map(summarizeProject);
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }

    // ─── GET CONTEXT ────────────────────────────────────────────────────────
    case "phewsh_get_context": {
      const project = projects.find(p => p.id === args.project_id);
      if (!project) return { content: [{ type: "text", text: `Project "${args.project_id}" not found.` }] };
      return { content: [{ type: "text", text: buildFullBriefing(project) }] };
    }

    // ─── CHECK VERIFICATION ─────────────────────────────────────────────────
    case "phewsh_check_verification": {
      const project = projects.find(p => p.id === args.project_id);
      if (!project) return { content: [{ type: "text", text: `Project "${args.project_id}" not found.` }] };

      const action = (project.actions || []).find(a => a.id === args.task_id);
      if (!action) return { content: [{ type: "text", text: `Task "${args.task_id}" not found.` }] };

      const verification = deriveVerification(action.intent);
      const rollback = assessReversibility(action.intent);

      const sections = [];
      sections.push(`# Verification: ${action.intent}`);
      sections.push("");
      sections.push("Before marking this complete, confirm ALL of:");
      sections.push("");
      verification.criteria.forEach((c, i) => sections.push(`${i + 1}. ${c}`));
      sections.push("");
      if (!rollback.canRevert) {
        sections.push(`**This is irreversible.** ${rollback.warning}`);
      } else {
        sections.push("This is reversible if needed.");
        if (rollback.how) sections.push(`Rollback: ${rollback.how}`);
      }

      return { content: [{ type: "text", text: sections.join("\n") }] };
    }

    // ─── EVALUATE ACTION (pre-action enforcement gate) ──────────────────────
    case "phewsh_evaluate_action": {
      const project = projects.find(p => p.id === args.project_id)
        || projects.find(p => p.id === "local");
      if (!project) return { content: [{ type: "text", text: `Project "${args.project_id}" not found.` }] };

      const result = evaluateAction(project, args);

      recordSession(args.agent_id, args.project_id, "action_evaluated", {
        taskId: args.task_id,
        proposedAction: String(args.proposed_action || "").slice(0, 200),
        status: result.status,
        gateReference: result.gate_reference,
      });

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    // ─── FLAG BLOCKER ───────────────────────────────────────────────────────
    case "phewsh_flag_blocker": {
      recordSession(args.agent_id, args.project_id, "blocker_flagged", {
        taskId: args.task_id,
        reason: args.reason,
        needs: args.needs,
      });

      recordBlocker({
        projectId: args.project_id,
        taskId: args.task_id,
        reason: args.reason,
        needs: args.needs,
        agentId: args.agent_id,
        flaggedAt: new Date().toISOString(),
      });

      // Surface the blocker to any HTTP poller waiting on this task.
      queue.completeByTaskId(args.task_id, {
        success: false,
        result: args.reason,
        issues: `Blocked — needs: ${args.needs || "unknown"}`,
      });

      const project = projects.find(p => p.id === args.project_id);
      let suggestion = "";
      if (project) {
        const nextTasks = getOrderedTasks(project, "any").filter(a => a.id !== args.task_id);
        if (nextTasks.length > 0) {
          suggestion = `\n\nMeanwhile, you can work on: "${nextTasks[0].intent}" (task_id: ${nextTasks[0].id})`;
        }
      }

      return { content: [{ type: "text", text: `Blocker flagged for task "${args.task_id}". The project owner will be notified.\n\nReason: ${args.reason}\nNeeds: ${args.needs || "Unknown"}${suggestion}` }] };
    }

    // ─── SESSION HISTORY ────────────────────────────────────────────────────
    case "phewsh_session_history": {
      const sessions = getRecentSessions(args.project_id, args.limit || 20);
      if (sessions.length === 0) {
        return { content: [{ type: "text", text: "No session history for this project yet." }] };
      }

      const sections = [`# Session History: ${args.project_id}`, ""];
      sessions.reverse().forEach(s => {
        const time = s.timestamp.split("T")[0];
        const agent = s.agentId || "unknown";
        switch (s.event) {
          case "session_start":
            sections.push(`- [${time}] ${agent} started session`);
            break;
          case "task_complete":
            sections.push(`- [${time}] ${agent} completed: ${s.result || s.taskId} ${s.success ? "OK" : "FAILED"}`);
            break;
          case "blocker_flagged":
            sections.push(`- [${time}] ${agent} blocked on: ${s.reason}`);
            break;
          default:
            sections.push(`- [${time}] ${agent}: ${s.event}`);
        }
      });

      return { content: [{ type: "text", text: sections.join("\n") }] };
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
});

// ── Prompts ──

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: "work_session",
      description: "Full work session: get briefed, execute tasks, report results. Best for autonomous agents that want to do as much as possible.",
      arguments: [
        { name: "project_id", description: "Project to work on (omit for auto-detect)", required: false },
        { name: "max_tasks", description: "Maximum tasks to complete this session (default: 5)", required: false },
      ],
    },
    {
      name: "status_check",
      description: "Quick status check: what's done, what's pending, any blockers. No execution.",
      arguments: [
        { name: "project_id", description: "Project to check", required: false },
      ],
    },
    {
      name: "review_results",
      description: "Review recent agent work: what was completed, what failed, what's blocked. For human oversight.",
      arguments: [
        { name: "project_id", description: "Project to review", required: false },
      ],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const projects = loadProjects();

  switch (name) {
    case "work_session": {
      const projectId = args?.project_id || (projects.length === 1 ? projects[0].id : "local");
      const maxTasks = args?.max_tasks || 5;
      const project = projects.find(p => p.id === projectId);

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `You are an autonomous agent working on the "${project?.name || projectId}" project via PHEWSH coordination.

Your workflow:
1. Call \`phewsh_start\` with project_id: "${projectId}" to get your briefing and first task
2. Execute the task described in the dispatch packet
3. Call \`phewsh_complete_task\` with your results — it will auto-chain to the next task
4. Repeat until you've completed ${maxTasks} tasks or hit a blocker
5. If blocked, call \`phewsh_flag_blocker\` and move to the next available task

MANDATORY ENFORCEMENT HOOKS (no exceptions):
1. After phewsh_start, read the evaluation.required block in the dispatch packet.
2. Before EVERY tool call (write_file, terminal, browser_*, etc.), call phewsh_evaluate_action and check the status:
   - allow → proceed
   - block → stop and report to human
   - modify → use suggested_action instead
3. After completing work, call phewsh_check_verification before marking done.
4. If blocked, call phewsh_flag_blocker and get next work.

Skipping phewsh_evaluate_action = protocol violation.

Rules:
- Always check verification criteria before marking complete
- If a task is irreversible, confirm with the user before executing
- Report issues honestly — failed tasks help the project owner make better decisions
- Stay within the constraints provided in each dispatch packet
- You are the executor, not the decision-maker. Execute what's been planned.

Start now by calling phewsh_start.`,
            },
          },
        ],
      };
    }

    case "status_check": {
      const projectId = args?.project_id || (projects.length === 1 ? projects[0].id : "local");
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Give me a quick status check on the "${projectId}" project. Call \`phewsh_list_projects\` and \`phewsh_session_history\` with project_id: "${projectId}" to get the current state. Summarize: what's done, what's pending, any blockers, and what needs my attention.`,
            },
          },
        ],
      };
    }

    case "review_results": {
      const projectId = args?.project_id || (projects.length === 1 ? projects[0].id : "local");
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Review the recent agent work on "${projectId}". Call \`phewsh_session_history\` with project_id: "${projectId}" and limit: 30. Then summarize:
- What was completed successfully
- What failed and why
- Any unresolved blockers
- Recommendations for what the project owner should do next

Be honest and specific. This is for human oversight.`,
            },
          },
        ],
      };
    }

    default:
      return { messages: [] };
  }
});

// ── Resources ──

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const projects = loadProjects();
  const resources = [];

  for (const project of projects) {
    resources.push({
      uri: `phewsh://projects/${project.id}/briefing`,
      name: `${project.name} — Full Briefing`,
      description: `Complete project context: vision, plan, constraints, execution state`,
      mimeType: "text/markdown",
    });

    if (project.artifacts) {
      for (const [kind, artifact] of Object.entries(project.artifacts)) {
        if (artifact?.content) {
          resources.push({
            uri: `phewsh://projects/${project.id}/artifacts/${kind}`,
            name: `${project.name} — ${kind}`,
            description: `${kind} artifact`,
            mimeType: "text/markdown",
          });
        }
      }
    }
  }

  return { resources };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const projects = loadProjects();

  const match = uri.match(/^phewsh:\/\/projects\/([^/]+)\/(briefing|artifacts\/(.+))$/);
  if (!match) return { contents: [{ uri, text: "Invalid resource URI", mimeType: "text/plain" }] };

  const [, projectId, path, artifactKind] = match;
  const project = projects.find(p => p.id === projectId);
  if (!project) return { contents: [{ uri, text: `Project "${projectId}" not found`, mimeType: "text/plain" }] };

  if (path === "briefing") {
    return { contents: [{ uri, text: buildFullBriefing(project), mimeType: "text/markdown" }] };
  }

  if (artifactKind && project.artifacts?.[artifactKind]?.content) {
    return { contents: [{ uri, text: project.artifacts[artifactKind].content, mimeType: "text/markdown" }] };
  }

  return { contents: [{ uri, text: "Resource not found", mimeType: "text/plain" }] };
});

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("PHEWSH MCP Server v0.3.0 — stdio coordination layer active");
}

// Exported for unit testing (see tests/mcp-evaluateAction.mjs).
export { evaluateAction, dailyBudgetStatus, recordSpend };

// Only start the stdio server when run directly, not when imported by tests.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error("Failed to start PHEWSH MCP server:", err);
    process.exit(1);
  });
}
