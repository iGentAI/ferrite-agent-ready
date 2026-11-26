// Scenario table for the agent-ready conformance suite — a sibling of
// an MCP conformance lane, pointed at agent-ready surfaces.
//
// Where agent-score answers "how ready is this origin?" with one
// weighted score, this table answers "does the served behaviour keep the
// contracts the agent-ready package declares?" — named scenarios, each a
// handful of checks with evidence, the way the official MCP suite is
// organised. Every check probes SERVED behaviour: a real tools/call, a real
// 402 challenge, a real replay. Annotation without implementation cannot
// pass here any more than it can score in agent-score.
//
// 'info' carries the meaning agent-score gives it: the check does not apply
// to this origin (x402 on a docs site, tool shape with zero tools), or the
// behaviour cannot be evidenced from outside (a 400 whose optional error
// body was omitted). Inapplicable must never read as alarm — that is the
// lesson the Buzz repository's mcp-conformance-report.mjs encodes in tiers, and here it is encoded
// per check, because a conformance run whose noise buries its defects gets
// ignored, and one whose inapplicables read as defects gets distrusted.
//
// Reuse, not duplication: where an agent-score check already IS the contract
// (robots.txt, sitemap, llms.txt, structured errors, OpenAPI validity, the
// unpaid x402 challenge, the advertised idempotency contract), the scenario
// ADOPTS that check via import, so the two suites cannot drift apart. The
// finer-grained probes — JSON-RPC strictness, rejection reasons, replay —
// are this suite's own.

import { createHmac, randomBytes } from 'node:crypto';

import { CHECKS } from '../agent-score/checks.mjs';
import { callEligibleTool, closeMcpSession, inspectMcpSurface, selectEligibleTool } from '../served-surface/mcp-client.mjs';

async function withMcpSurface(origin, profile, inspect) {
  const observed = await inspectMcpSurface(origin, profile);
  let result;
  let cleanup;
  try { result = await inspect(observed); }
  finally { cleanup = await closeMcpSession(observed.transport_session); }
  if (cleanup.state !== 'complete') result.push(check('session-cleanup', 'fail', cleanup.evidence));
  return result;
}

const UA = 'ferrite-agent-conformance/1.0 (+https://github.com/iGentAI/ferrite-agent-ready)';

/**
 * Tier vocabulary, in report order. READABLE/CALLABLE/PAYABLE mirror
 * agent-score's categories; PROTOCOL is MCP JSON-RPC strictness; RESILIENCE
 * is error handling and retry-safety.
 */
export const TIER_ORDER = ['READABLE', 'CALLABLE', 'PAYABLE', 'PROTOCOL', 'RESILIENCE'];

// Local fetch envelope. agent-score keeps its `fetchText` module-private, so
// this cannot be imported; it is transport plumbing, not check logic — the
// grading rules that must not fork are adopted via `adopt()` below.
/**
 * The URL a probe of `path` on `origin` requests, or null. Paths can come
 * from the scanned origin's own OpenAPI document, so a path that is not a
 * single-slash absolute path, or that resolves to another origin
 * (`@127.0.0.1:8080/admin`, `.internal.corp/api`, `//evil`), is refused.
 */
export function probeUrl(origin, path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\s]/.test(path)) return null;
  let base;
  let url;
  try {
    base = new URL(origin);
    url = new URL(origin.replace(/\/$/, '') + path);
  } catch {
    return null;
  }
  return url.origin === base.origin ? url : null;
}

const MAX_REDIRECTS = 5;

async function probe(origin, path, opts = {}) {
  const first = probeUrl(origin, path);
  if (!first) {
    return { ok: false, status: 0, contentType: '', text: '', bytes: 0, error: `refused probe path ${JSON.stringify(String(path)).slice(0, 80)}: not a path on ${origin}` };
  }
  try {
    // Redirects are followed by hand and only on the scanned origin: an
    // origin-chosen redirect to loopback, link-local metadata or an internal
    // host is not followed, and a minted payment header never leaves it.
    let url = first;
    let method = opts.method || 'GET';
    let body = opts.body;
    let res;
    for (let hop = 0; ; hop += 1) {
      res = await fetch(url, {
        method,
        headers: { 'user-agent': UA, ...(opts.headers || {}) },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs || 10_000),
      });
      const location = res.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(res.status) || !location || hop >= MAX_REDIRECTS) break;
      let next;
      try {
        next = new URL(location, url);
      } catch {
        break;
      }
      if (next.origin !== first.origin) break;
      await res.body?.cancel();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      url = next;
    }
    const text = await res.text();
    return {
      ok: true,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      headers: res.headers,
      text,
      bytes: Buffer.byteLength(text),
    };
  } catch (err) {
    return { ok: false, status: 0, contentType: '', text: '', bytes: 0, error: String(err) };
  }
}

function check(id, status, evidence) {
  return { id, status, evidence };
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function trim(s, n = 140) {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

/**
 * Run an agent-score check under a conformance check id. A missing source
 * check fails loudly so a rename in agent-score cannot silently drop coverage.
 */
async function adopt(origin, agentScoreId, asId) {
  const source = CHECKS.find((c) => c.id === agentScoreId);
  if (!source) {
    return check(asId, 'fail', `agent-score no longer has a '${agentScoreId}' check to adopt — realign the suites`);
  }
  const r = await source.run(origin); // method call keeps `this` bound to the check
  return check(asId, r.status, r.evidence);
}

const rpc = (id, method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

const mcpPost = (origin, body) =>
  probe(origin, '/mcp', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  });

/** Parsed OpenAPI catalog from the well-known path or `/openapi.json` fallback. */
async function catalogDoc(origin) {
  for (const path of ['/.well-known/api-catalog', '/openapi.json']) {
    const r = await probe(origin, path);
    if (r.status !== 200) continue;
    const doc = parseJson(r.text);
    if (doc && typeof doc === 'object') return { path, doc };
  }
  return null;
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export function operations(doc) {
  const out = [];
  for (const [path, item] of Object.entries(doc.paths || {})) {
    if (!item || typeof item !== 'object') continue;
    for (const [method, op] of Object.entries(item)) {
      const verb = method.toUpperCase();
      if (!HTTP_METHODS.has(verb)) continue;
      if (op && typeof op === 'object') out.push({ path, method: verb, op });
    }
  }
  return out;
}

async function discoverPriced(origin) {
  const found = await catalogDoc(origin);
  if (!found) return null;
  return operations(found.doc).find(({ op }) => op['x-price-usd-micros'] > 0) || null;
}

/**
 * Settlement tag a facilitator credential mints — HMAC-SHA-256 over the same
 * canonical byte string `x402.rs`'s `canonical_authorization` builds.
 */
export function settlementTag(payment, facilitatorKey) {
  const a = payment.payload.authorization;
  const msg = [
    `x402v${payment.x402Version}`, payment.scheme, payment.network,
    a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce,
  ].join('\n');
  return `0x${createHmac('sha256', facilitatorKey).update(msg).digest('hex')}`;
}

/**
 * Base64 X-PAYMENT payload. Without `facilitatorKey` the signature is shaped
 * hex that cannot settle; with a key it carries a valid settlement tag.
 */
export function mintPayment({
  payTo,
  value,
  network = 'base',
  facilitatorKey = null,
  validBefore = String(Math.floor(Date.now() / 1000) + 300),
}) {
  const payment = {
    x402Version: 1,
    scheme: 'exact',
    network,
    payload: {
      authorization: {
        from: '0x1111111111111111111111111111111111111111',
        to: payTo,
        value: String(value),
        validAfter: '0',
        validBefore,
        // Fresh per payment: the served replay ledger refuses a nonce it
        // has already settled, so a fixed nonce would 402 on the second run.
        nonce: `0x${randomBytes(32).toString('hex')}`,
      },
      signature: '0xabc123',
    },
  };
  if (facilitatorKey) payment.payload.signature = settlementTag(payment, facilitatorKey);
  return Buffer.from(JSON.stringify(payment)).toString('base64');
}

/** Unpaid 402 challenge for a priced operation, or null otherwise. */
async function unpaidChallenge(origin, target) {
  const r = await probe(origin, target.path, {
    method: target.method,
    body: '{}',
    headers: { 'content-type': 'application/json' },
  });
  if (r.status !== 402) return null;
  const body = parseJson(r.text);
  const acc = body?.accepts?.[0];
  if (!acc) return null;
  return {
    payTo: acc.payTo,
    amount: acc.maxAmountRequired,
    network: acc.network || 'base',
    accepts: acc,
    body,
  };
}

/**
 * Send a payment on both the `X-PAYMENT` header and the JSON body's `payment`
 * field so deployed and envelope-folded handlers see the same value.
 */
function sendPayment(origin, target, payment) {
  return probe(origin, target.path, {
    method: target.method,
    headers: { 'content-type': 'application/json', 'x-payment': payment },
    body: JSON.stringify({ payment }),
  });
}

export const SCENARIOS = [
  {
    id: 'readable-artefacts',
    tier: 'READABLE',
    description: 'robots.txt with a sitemap pointer, a real urlset, llms.txt shaped per llmstxt.org, and the llms-full.txt companion.',
    async run(origin) {
      const out = [];
      out.push(await adopt(origin, 'robots_txt', 'robots-txt'));
      // agent-score records the sitemap pointer in evidence but does not
      // require it; a conformance suite does — a robots.txt that never says
      // where the inventory lives leaves discovery to luck.
      const robots = await probe(origin, '/robots.txt');
      if (robots.status === 200) {
        const pointed = /sitemap:/i.test(robots.text);
        out.push(check('robots-sitemap-pointer', pointed ? 'pass' : 'fail',
          pointed ? 'robots.txt points at the sitemap' : 'robots.txt served but carries no Sitemap: pointer'));
      } else {
        out.push(check('robots-sitemap-pointer', 'fail', `GET /robots.txt -> ${robots.status || robots.error}`));
      }
      out.push(await adopt(origin, 'sitemap', 'sitemap-urlset'));
      out.push(await adopt(origin, 'llms_txt', 'llms-txt'));
      // llms-full.txt is the optional single-fetch corpus: absence is a
      // choice (info), but a SERVED companion that is degenerate — shorter
      // than the index it claims to expand, or missing its H1 — is a defect.
      const full = await probe(origin, '/llms-full.txt');
      if (full.status !== 200) {
        out.push(check('llms-full-companion', 'info',
          `no /llms-full.txt companion (GET -> ${full.status || full.error}) — optional single-fetch corpus`));
      } else {
        const llms = await probe(origin, '/llms.txt');
        const sound = full.text.startsWith('# ') && full.bytes >= llms.bytes;
        out.push(check('llms-full-companion', sound ? 'pass' : 'fail',
          sound
            ? `served (${full.bytes}B, expands llms.txt at ${llms.bytes}B)`
            : `served but degenerate: ${full.bytes}B vs llms.txt ${llms.bytes}B; starts with H1: ${full.text.startsWith('# ')}`));
      }
      return out;
    },
  },

  {
    id: 'markdown-twins',
    tier: 'READABLE',
    description: 'The landing page has a .md twin, answers a markdown ask (?format=md or Accept), and the agent-tax byte ratio is measurable.',
    async run(origin) {
      const out = [];
      const twin = await probe(origin, '/index.md');
      const twinOk = twin.status === 200 && twin.contentType.includes('markdown');
      out.push(check('md-twin', twinOk ? 'pass' : 'fail',
        twinOk
          ? `/index.md -> 200 ${twin.contentType} (${twin.bytes}B)`
          : `/index.md -> ${twin.status || twin.error} ${twin.contentType || '(untyped)'}`));
      // The query twin (?format=md) is what the constrained tier serves
      // today (the ingress envelope carries no request headers); Accept
      // negotiation is the header-capable path. Either satisfies "an agent
      // can ask the landing page itself for markdown".
      const q = await probe(origin, '/?format=md');
      const a = await probe(origin, '/', { headers: { accept: 'text/markdown' } });
      const winner = [['?format=md', q], ['Accept: text/markdown', a]]
        .find(([, r]) => r.status === 200 && r.contentType.includes('markdown'));
      out.push(check('md-negotiation', winner ? 'pass' : 'fail',
        winner
          ? `${winner[0]} -> 200 ${winner[1].contentType}`
          : `neither ?format=md (${q.status} ${q.contentType || 'untyped'}) nor Accept (${a.status} ${a.contentType || 'untyped'}) yields markdown`));
      // The agent tax is evidence, not a threshold: a short landing page can
      // legitimately have a heavier markdown twin (quotes-api does). An
      // incomputable ratio means there is no twin at all — which is already
      // md-twin's failure, so here it reads as info rather than double-count.
      const html = await probe(origin, '/');
      const md = twinOk ? twin : winner?.[1];
      if (html.status === 200 && md) {
        const ratio = +(md.bytes / Math.max(1, html.bytes)).toFixed(3);
        out.push(check('md-agent-tax', 'pass',
          `markdown ${md.bytes}B / html ${html.bytes}B = ${ratio}${ratio > 1 ? ' — agents currently read MORE bytes than browsers' : ''}`));
      } else {
        out.push(check('md-agent-tax', 'info',
          `ratio incomputable: html -> ${html.status || html.error}, markdown twin ${md ? 'ok' : 'unserved'}`));
      }
      return out;
    },
  },

  {
    id: 'readiness-self-report',
    tier: 'READABLE',
    description: 'The /.well-known/agent-readiness self-report serves findings with the check/status/evidence shape and a consistent summary.',
    async run(origin) {
      const r = await probe(origin, '/.well-known/agent-readiness');
      if (r.status !== 200) {
        // Only the agent-ready package promises this surface; other apps
        // have no obligation to self-report, so absence is not a defect.
        return [check('report-served', 'info',
          `no self-report (GET /.well-known/agent-readiness -> ${r.status || r.error}) — optional diagnostics surface`)];
      }
      const body = parseJson(r.text);
      if (!body || typeof body !== 'object') {
        return [check('report-served', 'fail',
          '200 but the body is not JSON — a self-report agents cannot parse is worse than none')];
      }
      const out = [check('report-served', 'pass', `200 (${r.bytes}B)`)];
      const findings = Array.isArray(body.checks) ? body.checks : [];
      const complete = findings.length > 0 && findings.every((f) => f && f.check && f.status && f.evidence);
      out.push(check('report-findings', complete ? 'pass' : 'fail',
        complete
          ? `${findings.length} finding(s), each carrying check/status/evidence`
          : `findings missing or incomplete (${findings.length} entries)`));
      const total = body.summary?.total;
      out.push(check('report-summary', typeof total === 'number' && total === findings.length ? 'pass' : 'fail',
        `summary.total=${total ?? 'unset'} against ${findings.length} finding(s)`));
      return out;
    },
  },

  {
    id: 'api-catalog',
    tier: 'CALLABLE',
    description: 'OpenAPI 3.1 at /.well-known/api-catalog, operations described, priced operations declaring their 402 response.',
    async run(origin) {
      const r = await probe(origin, '/.well-known/api-catalog');
      const doc = r.status === 200 ? parseJson(r.text) : undefined;
      if (!doc || typeof doc !== 'object') {
        return [check('catalog-served', 'fail',
          `GET /.well-known/api-catalog -> ${r.status || r.error}${r.status === 200 ? ' (body is not JSON)' : ''}`)];
      }
      const out = [check('catalog-served', 'pass', `200 (${r.bytes}B)`)];
      const version = String(doc.openapi || '');
      out.push(check('catalog-openapi-31', version.startsWith('3.1') ? 'pass' : 'fail',
        version ? `openapi ${version}` : 'no `openapi` version field'));
      // Adopted: validates parseability, path/operation counts and that every
      // operation is described; answers info for a zero-path content app.
      out.push(await adopt(origin, 'openapi_valid', 'catalog-operations-described'));
      const priced = operations(doc).filter(({ op }) => op['x-price-usd-micros'] > 0);
      if (priced.length === 0) {
        out.push(check('catalog-priced-extensions', 'info',
          'no x-price-usd-micros extensions — nothing priced, nothing to declare'));
      } else {
        const undeclared = priced.filter(({ op }) => !op.responses?.['402']);
        out.push(check('catalog-priced-extensions', undeclared.length === 0 ? 'pass' : 'fail',
          undeclared.length === 0
            ? `${priced.length} priced operation(s) declare the 402 response`
            : `priced but no declared 402 response: ${undeclared.map((p) => `${p.method} ${p.path}`).join(', ')}`));
      }
      return out;
    },
  },

  {
    id: 'agent-card',
    tier: 'CALLABLE',
    description: 'The A2A agent card at /.well-known/agent-card.json carries identity (name, protocolVersion) and enumerable skills.',
    async run(origin) {
      const r = await probe(origin, '/.well-known/agent-card.json');
      const card = r.status === 200 ? parseJson(r.text) : undefined;
      if (!card || typeof card !== 'object') {
        return [check('card-served', 'fail',
          `GET /.well-known/agent-card.json -> ${r.status || r.error}${r.status === 200 ? ' (body is not JSON)' : ''}`)];
      }
      const out = [check('card-served', 'pass', `200 (${r.bytes}B)`)];
      const identity = typeof card.name === 'string' && card.name.length > 0
        && typeof card.protocolVersion === 'string' && card.protocolVersion.length > 0;
      out.push(check('card-identity', identity ? 'pass' : 'fail',
        identity
          ? `name=${card.name}, protocolVersion=${card.protocolVersion}`
          : `identity incomplete: name=${card.name ?? 'unset'}, protocolVersion=${card.protocolVersion ?? 'unset'}`));
      const skills = card.skills;
      if (!Array.isArray(skills)) {
        out.push(check('card-skills', 'fail', 'skills is not an array — A2A consumers cannot enumerate'));
      } else if (skills.length === 0) {
        // A content-only app projects no skills; an empty array is honest.
        out.push(check('card-skills', 'info', 'zero skills declared (content-only app projects none)'));
      } else {
        const bad = skills.filter((s) => !s?.id || !s?.name);
        out.push(check('card-skills', bad.length === 0 ? 'pass' : 'fail',
          bad.length === 0
            ? `${skills.length} skill(s), each with id and name`
            : `${bad.length} of ${skills.length} skill(s) lack id/name`));
      }
      return out;
    },
  },

  {
    id: 'mcp-initialize',
    tier: 'CALLABLE',
    description: 'initialize answers a JSON-RPC result with protocolVersion, capabilities.tools and serverInfo; ping is recorded.',
    async run(origin) {
      const init = await mcpPost(origin, rpc(1, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'agent-conformance', version: '1.0' },
      }));
      const body = parseJson(init.text);
      if (init.status !== 200 || !body?.result) {
        // 404/405 means no MCP endpoint at all; anything else is an endpoint
        // that answered initialize out of protocol. Both are CALLABLE
        // failures — every agent-ready app serves /mcp — reported once here
        // rather than echoed through every dependent check.
        return [check('initialize', 'fail',
          `initialize -> ${init.status || init.error} ${init.contentType || ''}; ${body ? 'no result member' : 'body is not JSON'}`)];
      }
      const res = body.result;
      const out = [check('initialize', 'pass', '200 with a JSON-RPC result')];
      out.push(check('protocol-version', typeof res.protocolVersion === 'string' && res.protocolVersion ? 'pass' : 'fail',
        `protocolVersion=${res.protocolVersion ?? 'unset'}`));
      const tools = res.capabilities?.tools;
      out.push(check('capabilities-tools', tools && typeof tools === 'object' ? 'pass' : 'fail',
        tools && typeof tools === 'object' ? 'capabilities.tools declared' : 'capabilities.tools missing — nothing advertises the tool surface'));
      out.push(check('server-info', res.serverInfo?.name ? 'pass' : 'fail',
        res.serverInfo?.name ? `serverInfo.name=${res.serverInfo.name}` : 'serverInfo.name missing'));
      // ping is cheap liveness. A JSON-RPC error back is an origin that chose
      // not to serve it — recorded without alarm; only an out-of-protocol
      // reply fails, because that breaks every caller, not just ping's.
      const ping = parseJson((await mcpPost(origin, rpc(2, 'ping', {}))).text);
      if (ping?.result) out.push(check('ping', 'pass', 'ping -> {}'));
      else if (ping?.error) out.push(check('ping', 'info', `ping unanswered (code ${ping.error.code}) — liveness method not served`));
      else out.push(check('ping', 'fail', 'ping reply is not JSON-RPC'));
      return out;
    },
  },

  {
    id: 'mcp-tools-list',
    tier: 'CALLABLE',
    description: 'tools/list projects tools whose shape agents can act on: name, description, typed inputSchema, annotations.',
    async run(origin, ctx = {}) {
      if (!ctx.mcpProfile) return [check('tools-list', 'fail', 'MCP evidence is UNVERIFIED without a declared served-surface profile')];
      return withMcpSurface(origin, ctx.mcpProfile, async (observed) => {
      const tools = observed.tools;
      if (!Array.isArray(tools)) {
        return [check('tools-list', 'fail',
          observed.list?.evidence ?? observed.discovery.evidence)];
      }
      if (tools.length === 0) {
        return [check('tools-list', ctx.mcpProfile.applicability.mcp_tools_call.state === 'N/A' ? 'info' : 'fail',
          'zero tools projected; a non-applicable call requires an explicit profile declaration')];
      }
      const out = [{ ...check('tools-list', 'pass', observed.list.evidence), catalog_inventory: observed.catalog_inventory }];
      const unnamed = tools.filter((t) => !t?.name || !t?.description);
      out.push(check('tool-naming', unnamed.length === 0 ? 'pass' : 'fail',
        unnamed.length === 0 ? 'every tool has a name and a description' : `${unnamed.length} tool(s) lack name/description`));
      const unschemad = tools.filter((t) => !t?.inputSchema || typeof t.inputSchema !== 'object' || !t.inputSchema.type);
      out.push(check('tool-input-schema', unschemad.length === 0 ? 'pass' : 'fail',
        unschemad.length === 0 ? 'every tool declares a typed inputSchema' : `no typed inputSchema on: ${unschemad.map((t) => t?.name || '(unnamed)').join(', ')}`));
      // Hints are descriptive evidence only. The independent profile allowlist
      // controls which tools this evaluator is authorized to call.
      const unannotated = tools.filter((t) => typeof t?.annotations?.readOnlyHint !== 'boolean');
      out.push(check('tool-annotations', unannotated.length === 0 ? 'pass' : 'fail',
        unannotated.length === 0 ? 'every tool carries annotations.readOnlyHint' : `no readOnlyHint on: ${unannotated.map((t) => t?.name || '(unnamed)').join(', ')}`));
      return out;
      });
    },
  },

  {
    id: 'mcp-tools-call-roundtrip',
    tier: 'CALLABLE',
    description: 'A real tools/call round-trip on an advertised read-only tool returns structuredContent with isError false.',
    async run(origin, ctx = {}) {
      if (!ctx.mcpProfile) return [check('call-target', 'fail', 'MCP evidence is UNVERIFIED without a declared read-only tool allowlist')];
      return withMcpSurface(origin, ctx.mcpProfile, async (observed) => {
      const tools = observed.tools;
      if (!Array.isArray(tools)) {
        return [check('call-target', 'fail', observed.list?.evidence ?? observed.discovery.evidence)];
      }
      const ro = selectEligibleTool(tools, ctx.mcpProfile.read_only_tool_allowlist);
      const notApplicable = ctx.mcpProfile.applicability.mcp_tools_call.state === 'N/A';
      if (notApplicable) return [check('call-target', ro ? 'fail' : 'info',
        ro ? 'predeclared N/A is stale: an approved eligible tool is advertised' : ctx.mcpProfile.applicability.mcp_tools_call.reason)];
      if (!ro) {
        return [check('call-target', 'fail',
          `no profile-approved read-only zero-input tool among ${tools.length}; required execution is UNVERIFIED`)];
      }
      const r = await callEligibleTool(origin, ctx.mcpProfile, ro, fetch, observed.next_request_id, null, observed.transport_session);
      const result = r.result;
      const out = [check('call-target', 'pass', `calling read-only tool '${ro.name}'`)];
      if (r.kind !== 'ok' || !result) {
        out.push(check('call-answered', 'fail', r.evidence));
        return out; // nothing below is judgeable without a result
      }
      out.push(check('call-answered', 'pass', 'tools/call -> 200 with a result'));
      out.push(check('call-not-error', result.isError !== true ? 'pass' : 'fail', `isError=${result.isError}`));
      const structured = result.structuredContent && typeof result.structuredContent === 'object';
      out.push(check('call-structured-content', structured ? 'pass' : 'fail',
        structured
          ? `structuredContent keys: ${Object.keys(result.structuredContent).slice(0, 5).join(', ') || '(empty object)'}`
          : 'no structuredContent — agents are left re-parsing prose'));
      return out;
      });
    },
  },

  {
    id: 'x402-challenge',
    tier: 'PAYABLE',
    description: 'An unpaid call to a priced operation answers 402 with a complete x402 requirements body.',
    async run(origin) {
      // Adopted: discovers a priced operation from the catalog, probes it
      // unpaid, and answers info when nothing is priced — the docs-site case.
      const adopted = await adopt(origin, 'x402_challenge', 'unpaid-402');
      const target = await discoverPriced(origin);
      if (!target) return [adopted];
      const challenge = await unpaidChallenge(origin, target);
      if (!challenge) {
        return [adopted, check('challenge-requirements', 'fail',
          `unpaid ${target.method} ${target.path} served no x402 challenge body to inspect`)];
      }
      const acc = challenge.accepts;
      const missing = ['payTo', 'maxAmountRequired', 'network', 'asset', 'resource'].filter((k) => !acc[k]);
      return [adopted, check('challenge-requirements', missing.length === 0 ? 'pass' : 'fail',
        missing.length === 0
          ? `requirements complete: payTo=${trim(acc.payTo, 20)}, amount=${acc.maxAmountRequired}, network=${acc.network}, asset+resource declared`
          : `requirements missing ${missing.join(', ')} — an agent cannot construct payment from this challenge`)];
    },
  },

  {
    id: 'x402-payment-loop',
    tier: 'PAYABLE',
    description: 'A minted X-PAYMENT with a valid settlement tag settles: the paid retry answers 200 with a result, not another challenge.',
    async run(origin, ctx = {}) {
      if (!ctx.pricesOps) {
        // Exercising the loop needs a payment that CAN settle, and minting
        // one needs the facilitator credential — never assumed. Without the
        // declaration this stays informational, mirroring agent-score.
        return [check('paid-retry', 'info',
          'ctx does not declare this origin as pricing operations — loop not exercised (pass --priced, and --x402-key with the facilitator credential)')];
      }
      const target = await discoverPriced(origin);
      if (!target) {
        return [check('paid-retry', 'fail',
          'ctx says this origin prices operations, but the catalog advertises no x-price-usd-micros — declaration and surface disagree')];
      }
      if (!ctx.facilitatorKey) {
        return [check('paid-retry', 'info',
          `priced ${target.method} ${target.path} found, but no facilitator credential supplied — without it no acceptable settlement tag exists (that impossibility is x402.rs's security property)`)];
      }
      const challenge = await unpaidChallenge(origin, target);
      if (!challenge) {
        return [check('paid-retry', 'fail',
          `unpaid ${target.method} ${target.path} answered no 402 challenge to pay against`)];
      }
      // Pay exactly what the challenge asked, to whom it asked — the loop is
      // the protocol's own: requirements out, payment back in.
      const payment = mintPayment({
        payTo: challenge.payTo,
        value: challenge.amount,
        network: challenge.network,
        facilitatorKey: ctx.facilitatorKey,
      });
      const r = await sendPayment(origin, target, payment);
      const body = parseJson(r.text);
      const out = [check('paid-retry', r.status === 200 ? 'pass' : 'fail',
        r.status === 200
          ? `X-PAYMENT retry settled: 200 (${r.bytes}B)`
          : `paid retry -> ${r.status || r.error}: ${trim(r.text, 120)}`)];
      if (r.status === 200) {
        const rechallenged = body && (body.accepts || body.x402Version);
        out.push(check('paid-result', body && !rechallenged ? 'pass' : 'fail',
          !body ? '200 but the body is not JSON'
            : rechallenged ? '200 but the body is another challenge'
              : `result body served${body.receipt ? ' with a settlement receipt' : ''}`));
      }
      return out;
    },
  },

  {
    id: 'x402-rejections',
    tier: 'PAYABLE',
    description: 'Under-payment, wrong payee, expired window and malformed X-PAYMENT are each re-challenged with 402, ideally with distinct reasons.',
    async run(origin) {
      const target = await discoverPriced(origin);
      if (!target) {
        return [check('rejections', 'info', 'no priced operations advertised — rejection discipline has nothing to bite on')];
      }
      const challenge = await unpaidChallenge(origin, target);
      if (!challenge) {
        return [check('rejections-setup', 'fail',
          `unpaid ${target.method} ${target.path} did not answer an x402 challenge — cannot stage rejection probes`)];
      }
      const { payTo, amount } = challenge;
      // Each probe varies exactly ONE field from an otherwise well-formed
      // payment, so the origin's rejection reason (when it names one) can be
      // matched to the field that earned it.
      const probes = [
        ['under-payment', mintPayment({ payTo, value: '1' })],
        ['wrong-payee', mintPayment({ payTo: '0x000000000000000000000000000000000000dEaD', value: amount })],
        ['expired-window', mintPayment({ payTo, value: amount, validBefore: '1' })],
        ['malformed-payment', '!!!not-base64!!!'],
      ];
      const out = [];
      const reasons = new Set();
      for (const [id, payment] of probes) {
        const r = await sendPayment(origin, target, payment);
        const err = parseJson(r.text)?.error;
        if (typeof err === 'string') reasons.add(err);
        out.push(check(id, r.status === 402 ? 'pass' : 'fail',
          r.status === 402
            ? `402 re-challenged; error: ${trim(err ?? '(none)', 90)}`
            : `-> ${r.status || r.error} — an invalid payment must re-challenge with 402, not settle or crash`));
      }
      // Distinct reasons are a courtesy the spec does not mandate: without
      // them an agent cannot tell which field to repair, but a uniform
      // challenge body is still conforming — info, not fail.
      out.push(check('distinct-reasons', reasons.size >= 2 ? 'pass' : 'info',
        reasons.size >= 2
          ? `${reasons.size} distinct machine-readable reasons across the probes`
          : 'rejection reasons are not distinguished in the 402 body — allowed, but a named reason lets an agent repair the right field'));
      return out;
    },
  },

  {
    id: 'mcp-protocol-errors',
    tier: 'PROTOCOL',
    description: 'JSON-RPC strictness on /mcp: parse errors reject with HTTP 400 (-32700), unknown methods -32601, unknown tools -32602, notifications 202 with an empty body.',
    async run(origin) {
      // Strictness only applies to an endpoint that exists. 404/405 is the
      // origin declaring the surface absent — that absence is CALLABLE's
      // failure (mcp-initialize), and repeating it here five times would be
      // the alarm-inflation the tiered MCP report exists to avoid.
      const pre = await mcpPost(origin, rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'agent-conformance', version: '1.0' } }));
      if (pre.status === 404 || pre.status === 405) {
        return [check('endpoint-present', 'info',
          `no MCP endpoint to hold to protocol (initialize -> ${pre.status}) — absence is reported by mcp-initialize, not as a protocol defect`)];
      }
      const out = [];
      // 1+2: a body that never parsed. The Streamable HTTP transport rejects
      // it out of band (HTTP 400); the JSON-RPC error body is a MAY, so an
      // empty-bodied 400 leaves -32700 unproven (info), while a 2xx
      // acceptance or a wrong code is a defect.
      const bad = await mcpPost(origin, '{"jsonrpc":');
      out.push(check('parse-error-400', bad.status === 400 ? 'pass' : 'fail',
        bad.status === 400 ? 'malformed JSON -> HTTP 400' : `malformed JSON -> ${bad.status || bad.error}, expected HTTP 400`));
      const badBody = parseJson(bad.text);
      if (badBody?.error) {
        out.push(check('parse-error-code', badBody.error.code === -32700 ? 'pass' : 'fail',
          `error.code=${badBody.error.code}${badBody.error.code === -32700 ? '' : ', expected -32700'}`));
      } else if (bad.status >= 400) {
        out.push(check('parse-error-code', 'info',
          'rejected without a JSON-RPC error body — the transport makes the body optional, so -32700 is unproven'));
      } else {
        out.push(check('parse-error-code', 'fail',
          `malformed JSON was accepted (${bad.status || bad.error}, ${trim(bad.text, 60)}) — a body that never parsed cannot be served`));
      }
      // 3: unknown method.
      const method = parseJson((await mcpPost(origin, rpc(2, 'conformance/no-such-method', {}))).text);
      if (method?.error) {
        out.push(check('unknown-method', method.error.code === -32601 ? 'pass' : 'fail',
          `error.code=${method.error.code}${method.error.code === -32601 ? '' : ', expected -32601'}`));
      } else {
        out.push(check('unknown-method', 'fail',
          method?.result ? 'an unknown method was answered with a result' : 'unknown-method reply is not JSON-RPC'));
      }
      // 4: unknown tool. Strict conformance requires a -32602 protocol error.
      // An in-protocol result is recorded as info with vacuity named; only an
      // out-of-protocol reply or a wrong error code fails.
      const tool = parseJson((await mcpPost(origin, rpc(3, 'tools/call', { name: 'conformance-no-such-tool', arguments: {} }))).text);
      if (tool?.error) {
        out.push(check('unknown-tool', tool.error.code === -32602 ? 'pass' : 'fail',
          `error.code=${tool.error.code}${tool.error.code === -32602 ? '' : ', expected -32602'}`));
      } else if (tool?.result) {
        out.push(check('unknown-tool', 'info',
          `a nonexistent tool was answered with a result (isError=${tool.result.isError ?? 'unset'}) — strict -32602 not evidenced; a minted success here is vacuous`));
      } else {
        out.push(check('unknown-tool', 'fail', 'unknown-tool reply is not JSON-RPC'));
      }
      // 5: notification. Streamable HTTP answers 202 with an empty body; a
      // legacy in-protocol JSON reply is tolerated as info, HTML is not.
      const note = await mcpPost(origin, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      if (note.status === 202 && note.text === '') {
        out.push(check('notification-202', 'pass', 'notification -> 202 with an empty body'));
      } else if (parseJson(note.text)?.error || parseJson(note.text)?.result) {
        out.push(check('notification-202', 'info',
          `notification -> ${note.status} with a JSON-RPC body — Streamable HTTP wants 202 empty; legacy JSON-RPC behaviour tolerated`));
      } else {
        out.push(check('notification-202', 'fail',
          `notification -> ${note.status || note.error} ${note.contentType || ''} — neither 202-empty nor JSON-RPC`));
      }
      return out;
    },
  },

  {
    id: 'structured-errors',
    tier: 'RESILIENCE',
    description: 'Unknown paths answer RFC 9457 problem+json — machine-readable, with type/title/status, and no HTML anywhere in the body.',
    async run(origin) {
      const out = [];
      // Adopted: 4xx + JSON + a machine code, agent-score's own bar.
      out.push(await adopt(origin, 'structured_errors', 'error-machine-readable'));
      const r = await probe(origin, `/conformance-not-served-${Date.now()}`);
      if (r.status < 400) {
        out.push(check('error-problem-fields', 'fail', `unknown path answered ${r.status || r.error} — not an error at all`));
        out.push(check('error-html-free', 'fail', `unknown path answered ${r.status || r.error} — nothing to judge as an error body`));
        return out;
      }
      const body = parseJson(r.text);
      const fields = body && typeof body === 'object' && body.type && body.title && body.status;
      out.push(check('error-problem-fields', fields ? 'pass' : 'fail',
        fields
          ? `${r.status} body carries type/title/status (type=${trim(body.type, 50)})`
          : `${r.status} body lacks RFC 9457 fields: ${trim(r.text, 90)}`));
      // Agents flail at HTML error pages; RFC 9457 exists so they don't have to.
      const htmlFree = !/<\s*(!doctype|html|body|h1)/i.test(r.text);
      out.push(check('error-html-free', htmlFree ? 'pass' : 'fail',
        htmlFree ? 'no HTML in the error body' : `error body contains HTML: ${trim(r.text, 70)}`));
      return out;
    },
  },

  {
    id: 'idempotency-replay',
    tier: 'RESILIENCE',
    description: 'The retry contract: idempotency-key advertised where agents look, and one key replayed twice returns a byte-identical body on an API sample.',
    async run(origin) {
      // Adopted: the contract must be FINDABLE (catalog or llms.txt) before
      // it is exercised — an unadvertised guarantee helps no agent.
      const out = [await adopt(origin, 'idempotency_advertised', 'replay-advertised')];
      const found = await catalogDoc(origin);
      if (!found) {
        out.push(check('replay-live', 'info', 'no catalog to discover a replay sample from'));
        return out;
      }
      // Only parameter-free GETs are safe to replay against an origin we do
      // not own; cap the samples so this stays a probe, not a load test.
      const samples = operations(found.doc)
        .filter(({ method, op }) => method === 'GET' && !(op.parameters || []).some((p) => p?.required))
        .slice(0, 3);
      if (samples.length === 0) {
        out.push(check('replay-live', 'info', 'no parameter-free GET operation advertised — nothing safe to replay'));
        return out;
      }
      const key = `agent-conformance-replay-${Date.now()}`;
      const rows = [];
      for (const s of samples) {
        const a = await probe(origin, s.path, { headers: { 'idempotency-key': key } });
        const b = await probe(origin, s.path, { headers: { 'idempotency-key': key } });
        rows.push({
          path: s.path, a, b,
          live: a.status >= 200 && a.status < 300 && b.status >= 200 && b.status < 300,
          identical: a.status === b.status && a.text === b.text,
        });
      }
      const detail = rows.map((r) => `${r.path} ${r.a.status || r.a.error}/${r.b.status || r.b.error}${r.live ? (r.identical ? ' identical' : ' DIFFERS') : ''}`).join('; ');
      const live = rows.filter((r) => r.live);
      const clean = live.filter((r) => r.identical);
      // One byte-identical replay carries the verdict: a front that mints its
      // own idempotency keys (agent-ready-bench does, deliberately) makes any
      // single nondeterministic read inconclusive, while EVERY idempotent
      // read changing under one key is the origin saying nothing anywhere is
      // deduplicated. That asymmetry is the honest reading from outside.
      if (live.length === 0) {
        out.push(check('replay-live', 'info', `no advertised GET answered 2xx to replay (${detail})`));
      } else {
        out.push(check('replay-live', clean.length > 0 ? 'pass' : 'fail',
          clean.length > 0
            ? `byte-identical under one idempotency-key: ${clean[0].path} (${clean[0].a.bytes}B); ${detail}`
            : `every 2xx sample changed under replay: ${detail}`));
      }
      const stable = rows.every((r) => r.a.status === r.b.status);
      out.push(check('replay-status-stable', stable ? 'pass' : 'fail',
        stable ? `statuses stable across replays (${rows.length} sample(s))` : `status flapped under one key: ${detail}`));
      return out;
    },
  },
];

/**
 * Run every scenario against an origin sequentially for deterministic order
 * and load-independent verdicts. `ctx` gates the payment loop via `pricesOps`
 * and `facilitatorKey`.
 */
export async function runScenarios(origin, ctx = {}) {
  const results = [];
  for (const s of SCENARIOS) {
    const checks = await s.run(origin, ctx);
    results.push({ id: s.id, tier: s.tier, description: s.description, checks });
  }
  return results;
}
