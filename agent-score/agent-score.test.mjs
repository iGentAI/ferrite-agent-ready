// agent-score test suite: the check battery against known-good, legacy, and
// broken fixture origins (in-process HTTP servers, hermetic).
//
// Run: node --test agent-score/agent-score.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { runChecks as runProfiledChecks, runPerformance, grade } from './checks.mjs';
import { renderMarkdown } from './agent-score.mjs';
import { goodOrigin, legacyOrigin, brokenOrigin } from './fixtures.mjs';
import { fixtureServedSurfaceProfile, mcpFixture } from '../served-surface/fixtures.mjs';

const runChecks = (origin, options = {}) => runProfiledChecks(origin, { mcpProfile: fixtureServedSurfaceProfile(), ...options });

function byId(card, id) {
  const c = card.checks.find((c) => c.id === id);
  assert.ok(c, `check ${id} missing from card`);
  return c;
}

test('a scanned catalog path cannot steer a probe to another origin (finding_6741fbb6a43cb882)', async () => {
  const { sameOriginUrl } = await import('./checks.mjs');
  assert.equal(sameOriginUrl('https://target.example', '/priced')?.href, 'https://target.example/priced');
  for (const path of ['@attacker.example/priced', '//attacker.example/x', ':8080/foo', 'https://attacker.example/', '/\\attacker.example']) {
    assert.equal(sameOriginUrl('https://target.example', path), null, path);
  }
});

test('good origin scores grade A with every check passing', async () => {
  const { origin, close } = await goodOrigin();
  try {
    const card = await runChecks(origin, { mcpProfile: fixtureServedSurfaceProfile() });
    for (const c of card.checks) {
      assert.notEqual(c.status, 'fail', `${c.id} failed: ${c.evidence}`);
    }
    assert.ok(card.score >= 90, `expected >= 90, got ${card.score}`);
    assert.equal(card.grade, 'A');
    // The MCP check must have completed a REAL tools/call round-trip.
    assert.match(byId(card, 'mcp_endpoint').evidence, /tools\/call/);
    // The x402 check must have seen a real 402 challenge.
    assert.match(byId(card, 'x402_challenge').evidence, /402 challenge/);
  } finally {
    await close();
  }
});

test('legacy HTML-only origin fails readable and callable checks', async () => {
  const { origin, close } = await legacyOrigin();
  try {
    const card = await runChecks(origin);
    assert.equal(byId(card, 'robots_txt').status, 'fail');
    assert.equal(byId(card, 'llms_txt').status, 'fail');
    assert.equal(byId(card, 'markdown_alternates').status, 'fail');
    assert.equal(byId(card, 'structured_errors').status, 'fail');
    assert.equal(byId(card, 'api_catalog').status, 'fail');
    assert.equal(byId(card, 'mcp_endpoint').status, 'fail');
    assert.ok(card.score < 35, `legacy site should grade F, got ${card.score}`);
    assert.equal(card.grade, 'F');
  } finally {
    await close();
  }
});

test('broken origin: annotation without behaviour cannot score', async () => {
  const { origin, close } = await brokenOrigin();
  try {
    const card = await runChecks(origin);
    // The claims are served...
    assert.equal(byId(card, 'robots_txt').status, 'pass');
    assert.equal(byId(card, 'llms_txt').status, 'pass');
    assert.equal(byId(card, 'api_catalog').status, 'pass');
    // ...but the behaviour behind them fails the served-behaviour checks.
    assert.equal(byId(card, 'sitemap').status, 'fail', 'non-urlset sitemap must fail');
    assert.equal(byId(card, 'markdown_alternates').status, 'fail', '500 twin must fail');
    assert.equal(byId(card, 'mcp_endpoint').status, 'fail', 'out-of-protocol MCP must fail');
    assert.equal(byId(card, 'x402_challenge').status, 'fail', 'priced op that never 402s must fail');
    assert.equal(byId(card, 'structured_errors').status, 'fail', 'HTML 404 must fail');
    assert.ok(card.score < 55, `broken site must not reach C, got ${card.score}`);
  } finally {
    await close();
  }
});

test('a non-empty catalog without a safe callable tool cannot receive MCP credit', async () => {
  const { origin, close } = await mcpFixture({
    tools: [{ name: 'mutate', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } }],
  });
  try {
    const card = await runChecks(origin);
    assert.equal(byId(card, 'mcp_endpoint').status, 'fail');
    assert.match(byId(card, 'mcp_endpoint').evidence, /UNVERIFIED|no profile-allowlisted read-only zero-input tool/);
  } finally {
    await close();
  }
});

test('the compatibility scorer cannot infer call permission without a profile', async () => {
  const fixture = await mcpFixture();
  try {
    const card = await runProfiledChecks(fixture.origin);
    assert.equal(byId(card, 'mcp_endpoint').status, 'fail');
    assert.match(byId(card, 'mcp_endpoint').evidence, /UNVERIFIED/);
    assert.equal(fixture.stats.calls.some((call) => call.method === 'tools/call'), false);
  } finally { await fixture.close(); }
});

test('performance battery measures latency and the agent tax', async () => {
  const { origin, close } = await goodOrigin();
  try {
    const perf = await runPerformance(origin, { samples: 5 });
    assert.ok(perf.surfaces.length >= 4);
    const llms = perf.surfaces.find((s) => s.id === 'llms_txt');
    assert.equal(llms.status, 200);
    assert.ok(llms.p50_ms >= 0 && llms.p95_ms >= llms.p50_ms);
    assert.ok(perf.agent_tax_markdown_vs_html > 0, 'agent tax computed');
  } finally {
    await close();
  }
});

test('markdown scorecard renders every check row', async () => {
  const { origin, close } = await goodOrigin();
  try {
    const card = await runChecks(origin);
    const md = renderMarkdown(card, null, 'fixture');
    assert.match(md, /# Agent readiness — fixture/);
    for (const c of card.checks) assert.ok(md.includes(c.id), `${c.id} missing from markdown`);
  } finally {
    await close();
  }
});

test('grade bands', () => {
  assert.equal(grade(95), 'A');
  assert.equal(grade(80), 'B');
  assert.equal(grade(60), 'C');
  assert.equal(grade(40), 'D');
  assert.equal(grade(10), 'F');
});

test('poppy_discovery passes on valid Poppy 1.0 discovery and fails on malformed document', async () => {
  const http = await import('node:http');
  let body = JSON.stringify({
    protocol_version: '1.0',
    organization: { name: 'Example Co', domain: 'example.com' },
    apis: [{ type: 'mcp', url: 'https://example.com/mcp', description: 'MCP endpoint' }],
  });
  const srv = http.createServer((req, res) => {
    if (req.url === '/.well-known/poppy.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  try {
    const okCard = await runChecks(origin);
    assert.equal(byId(okCard, 'poppy_discovery').status, 'pass');
    assert.match(byId(okCard, 'poppy_discovery').evidence, /Poppy 1\.0: org=Example Co/);

    body = JSON.stringify({ protocol_version: '1.0', organization: { name: 'Broken', domain: 'example.com' } });
    const badCard = await runChecks(origin);
    assert.equal(byId(badCard, 'poppy_discovery').status, 'fail');
    assert.match(byId(badCard, 'poppy_discovery').evidence, /at least one of agent, apis, or web/);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
