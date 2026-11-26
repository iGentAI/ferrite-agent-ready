// agent-scan test suite — the 20-check tiered battery against known-good,
// legacy, and broken fixture origins (in-process HTTP servers, hermetic).
//
// Run: node --test agent-scan/test.mjs
//
// The core assertion is the coverage matrix: across the three fixtures,
// every check must be observed passing at least once and failing at least
// once. Two legacy checks are exempt from the hard-fail requirement because
// their imported probe semantics have no fail branch (agent-score/checks.mjs:
// bot_auth_advertised returns only pass|info, webmcp_declared returns only
// pass|info) — verdict parity forbids adding one, so for those two the
// matrix requires pass >= 1 and a non-pass (info) observation instead.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CHECKS } from './checks.mjs';
import { score, fractionOf, GRADE_LABELS, POOLS, BONUS_CAP } from './scoring.mjs';
import { runReport as runProfiledReport } from './report.mjs';
import { renderMarkdown } from './render-md.mjs';
import { goodOrigin, legacyOrigin, brokenOrigin } from './fixtures.mjs';
import { fixtureServedSurfaceProfile } from '../served-surface/fixtures.mjs';

const runReport = (origin, opts = {}) => runProfiledReport(origin, { ...opts, mcpProfile: fixtureServedSurfaceProfile() });

const NO_FAIL_BRANCH = new Set(['bot_auth_advertised', 'webmcp_declared']);

const scanCache = new Map();
function scanOf(factory) {
  if (!scanCache.has(factory)) {
    scanCache.set(factory, (async () => {
      const { origin, close } = await factory();
      try {
        return { origin, report: await runReport(origin) };
      } finally {
        await close();
      }
    })());
  }
  return scanCache.get(factory);
}

function byId(report, id) {
  const c = report.checks.find((c) => c.id === id);
  assert.ok(c, `check ${id} missing from report`);
  return c;
}

/* ------------------------- catalogue shape ------------------------- */

test('catalogue is the plan-16 shape: 10 essential, 5 recommended, 5 bonus', () => {
  assert.equal(CHECKS.length, 20);
  const tiers = { essential: [], recommended: [], bonus: [] };
  for (const c of CHECKS) {
    assert.ok(tiers[c.tier], `unknown tier ${c.tier} on ${c.id}`);
    tiers[c.tier].push(c.id);
    assert.ok(typeof c.weight === 'number' && c.weight > 0, `${c.id} weight`);
    assert.ok(c.name && c.summary && c.fix, `${c.id} carries name/summary/fix`);
    assert.equal(typeof c.probe, 'function', `${c.id} probe`);
  }
  assert.deepEqual(tiers.essential, [
    'robots_txt', 'sitemap', 'llms_txt', 'markdown_alternates', 'structured_errors',
    'api_catalog', 'openapi_valid', 'content_no_js', 'structured_data', 'md_vary_accept',
  ]);
  assert.deepEqual(tiers.recommended, ['mcp_endpoint', 'agent_card', 'mcp_manifest', 'skills_index', 'pricing_md']);
  assert.deepEqual(tiers.bonus, ['x402_challenge', 'bot_auth_advertised', 'webmcp_declared', 'idempotency_advertised', 'a2a_protocol']);
});

test('legacy checks keep agent-score ids and probe objects', async () => {
  const { CHECKS: LEGACY } = await import('../agent-score/checks.mjs');
  const legacyIds = new Set(LEGACY.map((c) => c.id));
  const wrapped = CHECKS.filter((c) => c.legacy);
  assert.equal(wrapped.length, 13);
  for (const c of wrapped) assert.ok(legacyIds.has(c.id), `${c.id} is not a legacy id`);
});

/* --------------------------- scoring unit --------------------------- */

test('scoring: full pass scores 100 regardless of bonus', () => {
  const results = CHECKS.map((c) => ({ id: c.id, tier: c.tier, weight: c.weight, verdict: c.tier === 'bonus' ? 'info' : 'pass' }));
  const s = score(results);
  assert.equal(s.score, 100);
  assert.equal(s.grade, 'A');
  assert.equal(s.label, 'Agent-ready');
  assert.equal(s.tiers.essential.points, POOLS.essential);
  assert.equal(s.tiers.recommended.points, POOLS.recommended);
  assert.equal(s.tiers.bonus.points, 0);
});

test('scoring: bonus is capped and never required', () => {
  const results = CHECKS.map((c) => ({ id: c.id, tier: c.tier, weight: c.weight, verdict: 'pass' }));
  const s = score(results);
  // bonus signal weights sum to 7 (2+1+1+1+2); the cap holds at +5.
  assert.equal(s.tiers.bonus.points, BONUS_CAP);
  assert.equal(s.score, 100, 'total is still capped at 100');
});

test('scoring: an all-info tier contributes 0 available and 0 points without penalty', () => {
  const results = CHECKS.map((c) => ({
    id: c.id, tier: c.tier, weight: c.weight,
    verdict: c.tier === 'essential' ? 'pass' : 'info',
  }));
  const s = score(results);
  assert.equal(s.tiers.recommended.available, 0);
  assert.equal(s.tiers.recommended.points, 0);
  assert.equal(s.score, 80, 'essential-only origin earns the essential pool');
});

test('scoring: partial results earn proportional credit', () => {
  assert.equal(fractionOf({ verdict: 'partial', fraction: 0.5 }), 0.5);
  assert.equal(fractionOf({ verdict: 'partial' }), 0.5);
  assert.equal(fractionOf({ verdict: 'pass' }), 1);
  assert.equal(fractionOf({ verdict: 'fail' }), 0);
  const half = CHECKS.filter((c) => c.tier === 'essential').map((c) => ({
    id: c.id, tier: c.tier, weight: c.weight, verdict: 'partial', fraction: 0.5,
  }));
  const s = score(half);
  assert.equal(s.tiers.essential.points, 40, 'all-partial essential tier earns half the pool');
});

test('grade bands and labels map score thresholds consistently', () => {
  assert.deepEqual(Object.keys(GRADE_LABELS), ['A', 'B', 'C', 'D', 'F']);
  for (const [fraction, expectedGrade] of [[1.0, 'A'], [0.8, 'B'], [0.6, 'C'], [0.4, 'D'], [0.1, 'F']]) {
    const s = score(CHECKS.map((c) => ({ id: c.id, tier: c.tier, weight: c.weight, verdict: 'partial', fraction })));
    assert.equal(s.grade, expectedGrade);
    assert.equal(s.label, GRADE_LABELS[expectedGrade]);
  }
});

/* -------------------------- fixture scans -------------------------- */

test('good origin: every check passes, grade A at 100, and report JSON carries the contract shape', async () => {
  const { origin, report } = await scanOf(goodOrigin);
  assert.equal(report.origin, origin);
  assert.match(report.scannedAt, /^\d{4}-\d{2}-\d{2}T/);
  for (const key of ['score', 'grade', 'label', 'eligibleChecks', 'tiers', 'checks']) {
    assert.ok(key in report, `report.${key} missing`);
  }
  for (const tier of ['essential', 'recommended', 'bonus']) assert.ok(report.tiers[tier], `tiers.${tier}`);
  for (const c of report.checks) {
    for (const key of ['id', 'name', 'tier', 'weight', 'verdict', 'evidence', 'fix']) {
      assert.ok(key in c, `check ${c.id}.${key} missing`);
    }
    assert.equal(c.verdict, 'pass', `${c.id} expected pass, got ${c.verdict}: ${c.evidence}`);
  }
  assert.equal(report.score, 100);
  assert.equal(report.grade, 'A');
  assert.equal(report.label, 'Agent-ready');
  assert.equal(report.eligibleChecks, 20);
  // Behaviour, not annotation: the MCP check completed a real tools/call
  // and the x402 check saw a real 402 challenge.
  assert.match(byId(report, 'mcp_endpoint').evidence, /tools\/call/);
  assert.match(byId(report, 'x402_challenge').evidence, /402 challenge/);
  assert.match(byId(report, 'md_vary_accept').evidence, /Vary: Accept/i);
});

test('legacy HTML-only origin: essential tier collapses; grade F', async () => {
  const { report } = await scanOf(legacyOrigin);
  for (const id of ['robots_txt', 'llms_txt', 'markdown_alternates', 'structured_errors', 'api_catalog', 'content_no_js', 'structured_data', 'skills_index', 'pricing_md']) {
    assert.equal(byId(report, id).verdict, 'fail', `${id} must fail on legacy`);
  }
  // Surface-scoped checks report not-applicable, not failure.
  assert.equal(byId(report, 'md_vary_accept').verdict, 'info');
  assert.equal(byId(report, 'mcp_manifest').verdict, 'info');
  assert.equal(byId(report, 'a2a_protocol').verdict, 'info');
  assert.equal(report.grade, 'F');
  assert.equal(report.score, 0);
});

test('broken origin: announced artefacts with broken behaviour fail or earn partial credit, ordering good > broken > legacy', async () => {
  const [{ report: rg }, { report: rl }, { report }] = await Promise.all([
    scanOf(goodOrigin),
    scanOf(legacyOrigin),
    scanOf(brokenOrigin),
  ]);
  // The claims are served...
  assert.equal(byId(report, 'robots_txt').verdict, 'pass');
  assert.equal(byId(report, 'llms_txt').verdict, 'pass');
  assert.equal(byId(report, 'api_catalog').verdict, 'pass');
  assert.equal(byId(report, 'agent_card').verdict, 'pass');
  // ...but the behaviour behind them fails:
  assert.equal(byId(report, 'sitemap').verdict, 'fail', 'non-urlset sitemap');
  assert.equal(byId(report, 'structured_errors').verdict, 'fail', 'HTML 404');
  assert.equal(byId(report, 'content_no_js').verdict, 'fail', 'thin HTML shell');
  assert.equal(byId(report, 'md_vary_accept').verdict, 'fail', 'negotiated markdown without Vary');
  assert.equal(byId(report, 'mcp_manifest').verdict, 'fail', 'unparseable /server.json');
  assert.equal(byId(report, 'mcp_endpoint').verdict, 'fail', 'tools/call isError');
  assert.equal(byId(report, 'pricing_md').verdict, 'fail', 'HTML, no markdown H1');
  assert.equal(byId(report, 'x402_challenge').verdict, 'fail', 'priced op never 402s');
  assert.equal(byId(report, 'a2a_protocol').verdict, 'fail', 'card without skills or url');
  // Partial credit where the artefact half-works:
  const ld = byId(report, 'structured_data');
  assert.equal(ld.verdict, 'partial', 'JSON-LD without name/url');
  assert.equal(ld.fraction, 0.5);
  const skills = byId(report, 'skills_index');
  assert.equal(skills.verdict, 'partial', 'index ok, skill URL dead');
  assert.equal(skills.fraction, 0.5);
  assert.notEqual(report.grade, 'A');
  assert.ok(rg.score > report.score, `good ${rg.score} > broken ${report.score}`);
  assert.ok(report.score > rl.score, `broken ${report.score} > legacy ${rl.score}`);
});

/* ------------------------- coverage matrix ------------------------- */

test('coverage matrix: every check passes at least once and fails at least once across fixtures', async () => {
  const [{ report: rg }, { report: rl }, { report: rb }] = await Promise.all([
    scanOf(goodOrigin),
    scanOf(legacyOrigin),
    scanOf(brokenOrigin),
  ]);
  const reports = [rg, rl, rb];
  const seen = new Map(CHECKS.map((c) => [c.id, new Set()]));
  for (const report of reports) {
    for (const c of report.checks) seen.get(c.id).add(c.verdict);
  }
  for (const [id, verdicts] of seen) {
    assert.ok(verdicts.has('pass'), `${id} never passed (saw: ${[...verdicts]})`);
    if (NO_FAIL_BRANCH.has(id)) {
      // Imported legacy probes with no fail branch (pass|info only):
      // require a non-pass observation instead of a hard fail.
      assert.ok(verdicts.has('info'), `${id} never non-passed (saw: ${[...verdicts]})`);
    } else {
      assert.ok(verdicts.has('fail') || verdicts.has('partial'), `${id} never failed (saw: ${[...verdicts]})`);
      assert.ok(verdicts.has('fail'), `${id} never hard-failed (saw: ${[...verdicts]})`);
    }
  }
});

/* ------------------------- report + markdown ------------------------- */

test('markdown twin renders every check row and the tier table', async () => {
  const { report } = await scanOf(brokenOrigin);
  const md = renderMarkdown(report, 'fixture');
  assert.match(md, /# Agent readiness — fixture/);
  assert.match(md, /\| Essential \|/);
  assert.match(md, /\| Recommended \|/);
  assert.match(md, /\| Bonus \|/);
  for (const c of report.checks) assert.ok(md.includes(c.id), `${c.id} missing from markdown`);
  assert.match(md, /## Fix these gaps first/, 'broken origin has ranked fixes');
  assert.match(md, /PARTIAL \(50%\)/, 'partial verdicts carry their percentage');
});

test('a hung origin fails the check via the timeout instead of stalling the scan', async () => {
  // A server that accepts connections and never answers.
  const { createServer } = await import('node:http');
  const server = createServer(() => { /* never respond */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const report = await runReport(origin, { checkTimeoutMs: 300, concurrency: 20 });
    assert.equal(report.grade, 'F');
    for (const c of report.checks) {
      assert.ok(c.verdict === 'fail' || c.verdict === 'info', `${c.id} verdict ${c.verdict}`);
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
