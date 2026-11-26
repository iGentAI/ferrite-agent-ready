// agent-scan report runner — executes the catalogue against one origin with
// bounded concurrency and per-check timeouts, then scores the results.
//
// Concurrency is bounded (default 4) rather than sequential: the new
// catalogue is 20 checks and several are multi-request; each check still
// runs its own requests in order, so per-origin behaviour stays polite.
// Each check is additionally wrapped in a hard timeout so one hung origin
// cannot stall the scan (a timed-out check fails with the timeout as its
// evidence — a site that cannot answer is not agent-ready).

import { CHECKS } from './checks.mjs';
import { score } from './scoring.mjs';

const DEFAULT_CHECK_TIMEOUT_MS = 20_000;
const DEFAULT_CONCURRENCY = 4;

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const gate = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}

/** Run workers over the check list with bounded concurrency. */
async function runBounded(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

/**
 * Scan one origin. Options:
 *   fetchImpl    — injected fetch (default globalThis.fetch)
 *   concurrency  — parallel checks (default 4)
 *   checkTimeoutMs — hard per-check budget (default 20s)
 * Returns { origin, scannedAt, grade, score, label, eligibleChecks,
 *           tiers: {essential, recommended, bonus}, checks: [...] }.
 */
export async function runReport(origin, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;
  const checkTimeoutMs = opts.checkTimeoutMs || DEFAULT_CHECK_TIMEOUT_MS;

  const results = await runBounded(CHECKS, concurrency, async (check) => {
    const run = Promise.resolve()
      .then(() => check.probe(fetchImpl, origin, { mcpProfile: opts.mcpProfile }))
      .catch((err) => ({ verdict: 'fail', evidence: `probe threw: ${String(err)}`, fix: check.fix }));
    const r = await withTimeout(run, checkTimeoutMs, () => ({
      verdict: 'fail',
      evidence: `check timed out after ${checkTimeoutMs}ms`,
      fix: check.fix,
    }));
    return {
      id: check.id,
      name: check.name,
      tier: check.tier,
      weight: check.weight,
      summary: check.summary,
      verdict: r.verdict,
      ...(r.verdict === 'partial' ? { fraction: typeof r.fraction === 'number' ? r.fraction : 0.5 } : {}),
      evidence: r.evidence,
      fix: r.fix || check.fix,
    };
  });

  const s = score(results);
  return {
    origin,
    scannedAt: new Date().toISOString(),
    engine: { tool: 'agent-scan', version: '1.0.0' },
    score: s.score,
    grade: s.grade,
    label: s.label,
    eligibleChecks: s.eligibleChecks,
    tiers: s.tiers,
    checks: results,
  };
}
