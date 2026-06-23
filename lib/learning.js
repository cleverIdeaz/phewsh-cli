// Learning loops — what gets smarter after the 100th decision.
//
// The decision record is already labeled (kept / reverted / superseded /
// failed) per route and per mode. This turns that into insight that feeds
// BACK into the next decision: which tool actually keeps best for you, and
// for which kind of work. Honest by construction — nothing surfaces until
// there's enough labeled signal, so there are no fake gauges.
//
// Pure: feed it outcomeStats(), get back rankings + one-line readouts.

const { labelFor } = require('./continuity');

function rate(r) { return r.total ? r.kept / r.total : 0; }

/** Per-route kept-rates, best first. Filters out thin samples. */
function routeRates(stats, { minSample = 1 } = {}) {
  return Object.entries((stats && stats.byRoute) || {})
    .map(([route, r]) => ({ route, total: r.total, kept: r.kept, keptRate: rate(r) }))
    .filter((r) => r.total >= minSample)
    .sort((a, b) => b.keptRate - a.keptRate || b.total - a.total);
}

/** Per-mode kept-rates, best first. */
function modeRates(stats, { minSample = 1 } = {}) {
  return Object.entries((stats && stats.byMode) || {})
    .map(([mode, m]) => ({ mode, total: m.total, kept: m.kept, keptRate: rate(m) }))
    .filter((m) => m.total >= minSample)
    .sort((a, b) => b.keptRate - a.keptRate || b.total - a.total);
}

function totalLabeled(stats) {
  if (!stats) return 0;
  return (stats.kept || 0) + (stats.reverted || 0) + (stats.superseded || 0) + (stats.failed || 0);
}

/** The route with the best kept-rate, given enough data, or null. */
function bestRoute(stats, { minSample = 3 } = {}) {
  const rates = routeRates(stats, { minSample });
  return rates.length ? rates[0] : null;
}

/**
 * One honest line of what the record has learned, or null if too thin.
 * "After 23 labeled: Codex 8/10 · Claude Code 5/9 kept"
 */
function learningLine(stats, { labeler = null, minLabeled = 5, top = 3 } = {}) {
  const labeled = totalLabeled(stats);
  if (labeled < minLabeled) return null;
  const rates = routeRates(stats, { minSample: 2 }).slice(0, top);
  if (!rates.length) return null;
  const parts = rates.map((r) => `${labelFor(r.route, labeler)} ${r.kept}/${r.total}`);
  return `After ${labeled} labeled: ${parts.join(' · ')} kept`;
}

/** A short percentage badge for one route, or '' if too thin to be honest. */
function keptBadge(stats, route, { minSample = 2 } = {}) {
  const r = stats && stats.byRoute && stats.byRoute[route];
  if (!r || r.total < minSample) return '';
  return `${r.kept}/${r.total} kept`;
}

module.exports = { routeRates, modeRates, bestRoute, learningLine, keptBadge, totalLabeled };
