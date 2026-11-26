// agent-conformance test suite: the scenario table against agent-score's
// fixture origins (in-process HTTP servers, hermetic), plus the baseline
// machinery as pure functions.
//
// Run: node --test agent-conformance/agent-conformance.test.mjs
//
// The fixtures pin what each origin ACTUALLY serves (see
// ../agent-score/fixtures.mjs), and the assertions follow that: goodOrigin's
// simplified /mcp rejects a parse error with a bare 400 and answers unknown
// tools with a minted result, so those strictness checks are asserted as the
// non-failing 'info' they grade to — the strict passes live in the
// agent-ready package's own Rust tests and in scans of the bench apps.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SCENARIOS, TIER_ORDER, operations, probeUrl, runScenarios } from './scenarios.mjs';
import { createServer } from 'node:http';
import { enforceBaseline, parseBaseline, renderMarkdown } from './agent-conformance.mjs';
import { brokenOrigin, goodOrigin, legacyOrigin } from '../agent-score/fixtures.mjs';
import { fixtureServedSurfaceProfile } from '../served-surface/fixtures.mjs';

// One full scan per fixture, shared across tests: every probe is read-only,
// so the results are stable, and re-running ~50 HTTP round-trips per test
// would only slow the gate down.
const cache = new Map();
async function scanOf(factory) {
  if (!cache.has(factory.name)) {
    const { origin, close } = await factory();
    try {
      cache.set(factory.name, await runScenarios(origin, { mcpProfile: fixtureServedSurfaceProfile() }));
    } finally {
      await close();
    }
  }
  return cache.get(factory.name);
}

function scenario(results, id) {
  const s = results.find((r) => r.id === id);
  assert.ok(s, `scenario ${id} missing from results`);
  return s;
}

function checkIn(s, id) {
  const c = s.checks.find((c) => c.id === id);
  assert.ok(c, `check ${s.id}:${id} missing (got: ${s.checks.map((x) => x.id).join(', ')})`);
  return c;
}

const fails = (s) => s.checks.filter((c) => c.status === 'fail');

test('scenario table: 14 uniquely-named scenarios, every tier known to the report', () => {
  assert.equal(SCENARIOS.length, 14);
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length);
  for (const s of SCENARIOS) {
    assert.ok(TIER_ORDER.includes(s.tier), `${s.id} has unknown tier ${s.tier}`);
    assert.ok(s.description.length > 0, `${s.id} has no description`);
  }
});

test('good origin: zero fail across every scenario, inapplicables read as info', async () => {
  const results = await scanOf(goodOrigin);
  assert.equal(results.length, SCENARIOS.length);
  for (const s of results) {
    for (const c of s.checks) {
      assert.notEqual(c.status, 'fail', `${s.id}:${c.id} failed: ${c.evidence}`);
      assert.ok(String(c.evidence).length > 0, `${s.id}:${c.id} carries no evidence`);
    }
  }
  // The surfaces the fixture does not serve (llms-full.txt, the readiness
  // self-report, the payment loop) must land as info, never as alarm.
  assert.equal(checkIn(scenario(results, 'readable-artefacts'), 'llms-full-companion').status, 'info');
  assert.equal(checkIn(scenario(results, 'readiness-self-report'), 'report-served').status, 'info');
  assert.equal(checkIn(scenario(results, 'x402-payment-loop'), 'paid-retry').status, 'info');
});

test('good origin: checks carry live served evidence (real tools/call, real 402)', async () => {
  const results = await scanOf(goodOrigin);
  const rt = scenario(results, 'mcp-tools-call-roundtrip');
  assert.equal(checkIn(rt, 'call-not-error').status, 'pass');
  assert.match(checkIn(rt, 'call-not-error').evidence, /isError=false/);
  assert.equal(checkIn(rt, 'call-structured-content').status, 'pass');
  const ch = scenario(results, 'x402-challenge');
  assert.match(checkIn(ch, 'unpaid-402').evidence, /402 challenge/);
  assert.equal(checkIn(ch, 'challenge-requirements').status, 'pass');
  const rj = scenario(results, 'x402-rejections');
  for (const id of ['under-payment', 'wrong-payee', 'expired-window', 'malformed-payment']) {
    assert.equal(checkIn(rj, id).status, 'pass', `${id}: ${checkIn(rj, id).evidence}`);
  }
});

test('broken origin: mcp-protocol-errors fails with evidence — an out-of-protocol /mcp cannot conform', async () => {
  const results = await scanOf(brokenOrigin);
  const pe = scenario(results, 'mcp-protocol-errors');
  assert.ok(fails(pe).length >= 4, `expected >=4 failing checks, got ${fails(pe).length}`);
  for (const c of fails(pe)) assert.ok(c.evidence.length > 0, `${c.id} has no evidence`);
  assert.equal(checkIn(pe, 'parse-error-400').status, 'fail');
  assert.match(checkIn(pe, 'parse-error-400').evidence, /expected HTTP 400/);
  assert.equal(checkIn(pe, 'notification-202').status, 'fail');
});

test('broken origin: structured-errors fails on the HTML 404', async () => {
  const results = await scanOf(brokenOrigin);
  const se = scenario(results, 'structured-errors');
  assert.equal(checkIn(se, 'error-machine-readable').status, 'fail');
  assert.equal(checkIn(se, 'error-html-free').status, 'fail');
  assert.match(checkIn(se, 'error-html-free').evidence, /HTML/);
});

test('broken origin: x402-challenge fails — the priced operation never challenges', async () => {
  const results = await scanOf(brokenOrigin);
  const ch = scenario(results, 'x402-challenge');
  assert.equal(checkIn(ch, 'unpaid-402').status, 'fail');
  assert.match(checkIn(ch, 'unpaid-402').evidence, /-> 200, expected 402/);
  // And the annotation-without-behaviour signature: the CATALOG still passes.
  assert.equal(fails(scenario(results, 'api-catalog')).length, 0, 'the announced catalog document itself is fine');
});

test('legacy origin: readable scenarios fail — no artefacts, no markdown, HTML errors', async () => {
  const results = await scanOf(legacyOrigin);
  const ra = scenario(results, 'readable-artefacts');
  assert.ok(fails(ra).length >= 3, `expected >=3 readable failures, got ${fails(ra).length}`);
  assert.equal(checkIn(ra, 'robots-txt').status, 'fail');
  const mt = scenario(results, 'markdown-twins');
  assert.equal(checkIn(mt, 'md-twin').status, 'fail');
  assert.equal(checkIn(mt, 'md-negotiation').status, 'fail');
  assert.ok(fails(scenario(results, 'structured-errors')).length >= 2);
});

test('legacy origin: absent surfaces are inapplicable, not alarm', async () => {
  const results = await scanOf(legacyOrigin);
  // No /mcp endpoint: the absence is mcp-initialize's CALLABLE failure, and
  // PROTOCOL strictness must not echo it five more times.
  assert.equal(checkIn(scenario(results, 'mcp-initialize'), 'initialize').status, 'fail');
  const pe = scenario(results, 'mcp-protocol-errors');
  assert.ok(pe.checks.every((c) => c.status === 'info'), `expected all info, got ${JSON.stringify(pe.checks)}`);
  // Nothing priced, nothing advertised: PAYABLE stays informational.
  assert.ok(scenario(results, 'x402-challenge').checks.every((c) => c.status === 'info'));
  assert.ok(scenario(results, 'x402-rejections').checks.every((c) => c.status === 'info'));
});

test('x402-payment-loop: info without ctx, exercised (and failing) with a credential against a non-settling origin', async () => {
  const loop = SCENARIOS.find((s) => s.id === 'x402-payment-loop');
  const { origin, close } = await goodOrigin();
  try {
    const silent = await loop.run(origin, {});
    assert.equal(silent.length, 1);
    assert.equal(silent[0].status, 'info');
    // goodOrigin's priced route ALWAYS re-challenges, so a minted payment
    // must come back as a hard failure with the 402 in evidence — proving
    // the loop really pays and really judges the reply.
    const paid = await loop.run(origin, { pricesOps: true, facilitatorKey: 'not-the-fixture-credential' });
    assert.equal(paid[0].id, 'paid-retry');
    assert.equal(paid[0].status, 'fail');
    assert.match(paid[0].evidence, /402/);
  } finally {
    await close();
  }
});

test('baseline parser: sections, both entry kinds, comments — and the shipped file parses empty', () => {
  const { sections, problems } = parseBaseline([
    '# header comment',
    'fe-docs-site:',
    '  # nothing expected',
    'quotes-api:',
    '  - x402-challenge            # whole scenario excused',
    '  - mcp-protocol-errors:parse-error-400',
    '',
  ].join('\n'));
  assert.deepEqual(problems, []);
  assert.deepEqual([...sections.get('fe-docs-site')], []);
  assert.deepEqual([...sections.get('quotes-api')].sort(), ['mcp-protocol-errors:parse-error-400', 'x402-challenge']);
  // A line that is neither section nor entry is a problem, never a skip.
  assert.equal(parseBaseline('fe-x:\n  not a list item\n').problems.length, 1);
  // The shipped baseline: three sections, all deliberately empty.
  const shipped = parseBaseline(readFileSync(new URL('./baseline.yml', import.meta.url), 'utf8'));
  assert.deepEqual(shipped.problems, []);
  for (const name of ['fe-docs-site', 'fe-taskboard', 'quotes-api']) {
    assert.deepEqual([...shipped.sections.get(name)], [], `${name} must start with zero expected failures`);
  }
});

test('baseline enforcement: an unexpected failure is a regression; entries excuse at either granularity', () => {
  const results = [{
    id: 's1',
    tier: 'READABLE',
    checks: [{ id: 'a', status: 'fail', evidence: 'x' }, { id: 'b', status: 'pass', evidence: 'y' }],
  }];
  const v = enforceBaseline(results, new Set());
  assert.equal(v.ok, false);
  assert.deepEqual(v.regressions, ['s1:a']);
  assert.equal(enforceBaseline(results, new Set(['s1'])).ok, true, 'scenario-level entry excuses');
  assert.equal(enforceBaseline(results, new Set(['s1:a'])).ok, true, 'check-level entry excuses');
});

test('baseline enforcement: a stale entry fails the run — including one naming an info check', () => {
  const results = [{ id: 's1', tier: 'READABLE', checks: [{ id: 'a', status: 'info', evidence: 'n/a here' }] }];
  const byCheck = enforceBaseline(results, new Set(['s1:a']));
  assert.equal(byCheck.ok, false);
  assert.deepEqual(byCheck.stale, ['s1:a']);
  const byScenario = enforceBaseline(results, new Set(['s1']));
  assert.equal(byScenario.ok, false);
  assert.deepEqual(byScenario.stale, ['s1']);
  assert.deepEqual(byScenario.regressions, [], 'info is not a failure either');
});

test('report renderer: every scenario id under its tier heading, plus the baseline verdict', async () => {
  const results = await scanOf(goodOrigin);
  const md = renderMarkdown({
    name: 'fixture-good',
    origin: 'http://127.0.0.1:0',
    generated_at: '2026-08-07T00:00:00.000Z',
    scenarios: results,
    baseline: { path: 'baseline.yml', expected: [], regressions: [], stale: [] },
  });
  for (const s of SCENARIOS) assert.ok(md.includes(s.id), `${s.id} missing from the report`);
  for (const tier of TIER_ORDER) assert.ok(md.includes(`## ${tier}`), `${tier} heading missing`);
  assert.match(md, /Baseline agrees: 0 expected failure/);
  // And the failure direction renders as alarm, not as agreement.
  const alarmed = renderMarkdown({
    name: 'x', origin: 'o', generated_at: 't', scenarios: results,
    baseline: { path: 'b', expected: ['s'], regressions: ['s1:a'], stale: ['s2'] },
  });
  assert.match(alarmed, /REGRESSION `s1:a`/);
  assert.match(alarmed, /STALE `s2`/);
});

test('a probe path from a scanned document cannot leave the origin', () => {
  const origin = 'https://app.example.com';
  assert.equal(probeUrl(origin, '/api/pay')?.href, 'https://app.example.com/api/pay');
  for (const bad of ['@127.0.0.1:8080/admin', '.internal.corp/api', '//evil.example/x', 'api', '/\\evil.example', '', undefined]) {
    assert.equal(probeUrl(origin, bad), null, String(bad));
  }
  const ops = operations({ paths: { '/a': { get: {}, trace: {}, connect: {}, propfind: {}, post: {} } } });
  assert.deepEqual(ops.map((o) => o.method), ['GET', 'POST']);
});

test('a probe follows redirects only on the scanned origin', async () => {
  const hits = [];
  const other = createServer((req, res) => { hits.push(req.url); res.end('internal'); });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${other.address().port}/metadata`;
  const app = createServer((req, res) => {
    if (req.url === '/.well-known/agent-readiness') { res.writeHead(307, { location: target }); return res.end(); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  try {
    const origin = `http://localhost:${app.address().port}`;
    await runScenarios(origin).catch(() => {});
    assert.deepEqual(hits, [], 'no request reached the other origin');
  } finally {
    app.close(); other.close();
  }
});
