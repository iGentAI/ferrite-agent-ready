// Agent-readiness check battery — Ferrite's equivalent of the industry
// Diagnostics tool. Each check probes SERVED behaviour on an origin and
// returns { id, category, weight, status: 'pass'|'fail'|'info', evidence }.
// A check passes only on behaviour, never on annotation: the MCP check
// completes a real tools/call, the markdown check fetches a real twin.
//
// Categories and weights (100 total):
//   readable  40: robots_txt 8, sitemap 6, llms_txt 10, markdown_alternates 10, structured_errors 6
//   callable  40: api_catalog 8, openapi_valid 6, mcp_endpoint 14, agent_card 8, webmcp_declared 4
//   payable   20: bot_auth_advertised 6, x402_challenge 8, idempotency_advertised 6

import { runStrictServedSurface } from '../served-surface/served-surface.mjs';

const UA = 'ferrite-agent-score/1.0 (+https://github.com/iGentAI/ferrite-agent-ready)';

/// The URL of `path` on `origin`, or null when `path` is not an origin-relative
/// path (`//host`, `@host`, `:port`, a scheme): a scanned server's own documents
/// must never steer a probe to another host.
export function sameOriginUrl(origin, path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return null;
  const base = new URL(origin);
  const url = new URL(origin.replace(/\/$/, '') + path);
  return url.origin === base.origin ? url : null;
}

async function fetchText(origin, path, opts = {}) {
  const started = performance.now();
  const url = sameOriginUrl(origin, path);
  if (!url) return { ok: false, status: 0, contentType: '', text: '', bytes: 0, ms: 0, error: `refused cross-origin or malformed path ${JSON.stringify(path)}` };
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: { 'user-agent': UA, ...(opts.headers || {}) },
      body: opts.body,
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs || 10_000),
    });
    // A probe that credits the target (opts.sameOrigin) does not count another origin's answer.
    if (opts.sameOrigin && res.url && new URL(res.url).origin !== url.origin) {
      return { ok: false, status: 0, contentType: '', text: '', bytes: 0, ms: performance.now() - started, error: `redirected off-origin to ${new URL(res.url).origin}` };
    }
    const text = await res.text();
    return {
      ok: true,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      headers: res.headers,
      text,
      bytes: Buffer.byteLength(text),
      ms: performance.now() - started,
    };
  } catch (err) {
    return { ok: false, status: 0, contentType: '', text: '', bytes: 0, ms: performance.now() - started, error: String(err) };
  }
}

function result(id, category, weight, status, evidence) {
  return { id, category, weight, status, evidence };
}

async function fetchOpenApiDocs(origin) {
  const docs = [];
  for (const path of ['/.well-known/api-catalog', '/openapi.json']) {
    const r = await fetchText(origin, path);
    if (!r.ok || r.status !== 200) continue;
    try {
      const doc = JSON.parse(r.text);
      if (doc && typeof doc === 'object') docs.push(doc);
    } catch { /* ignore */ }
  }
  return docs;
}

export const CHECKS = [
  {
    id: 'robots_txt', category: 'readable', weight: 8,
    async run(origin) {
      const r = await fetchText(origin, '/robots.txt');
      if (!r.ok || r.status !== 200) return result(this.id, this.category, this.weight, 'fail', `GET /robots.txt -> ${r.status || r.error}`);
      const hasAgent = /user-agent:/i.test(r.text);
      const hasSitemap = /sitemap:/i.test(r.text);
      if (!hasAgent) return result(this.id, this.category, this.weight, 'fail', 'robots.txt served but has no User-agent rule');
      return result(this.id, this.category, this.weight, 'pass',
        `served (${r.bytes}B); sitemap pointer: ${hasSitemap}; content-signals: ${/content-signal:/i.test(r.text)}`);
    },
  },
  {
    id: 'sitemap', category: 'readable', weight: 6,
    async run(origin) {
      const r = await fetchText(origin, '/sitemap.xml');
      if (!r.ok || r.status !== 200) return result(this.id, this.category, this.weight, 'fail', `GET /sitemap.xml -> ${r.status || r.error}`);
      const urls = (r.text.match(/<loc>/g) || []).length;
      if (!r.text.includes('<urlset') || urls === 0) return result(this.id, this.category, this.weight, 'fail', 'sitemap served but not a urlset with <loc> entries');
      return result(this.id, this.category, this.weight, 'pass', `${urls} URL(s) listed`);
    },
  },
  {
    id: 'llms_txt', category: 'readable', weight: 10,
    async run(origin) {
      const r = await fetchText(origin, '/llms.txt');
      if (!r.ok || r.status !== 200) return result(this.id, this.category, this.weight, 'fail', `GET /llms.txt -> ${r.status || r.error}`);
      const lines = r.text.split('\n');
      const h1 = lines.find((l) => l.startsWith('# '));
      const quote = lines.find((l) => l.startsWith('> '));
      const links = (r.text.match(/\[[^\]]+\]\([^)]+\)/g) || []).length;
      if (!h1) return result(this.id, this.category, this.weight, 'fail', 'llms.txt served but missing the required H1 title');
      const detail = `H1 ok; summary blockquote: ${Boolean(quote)}; ${links} link(s)`;
      return result(this.id, this.category, this.weight, links > 0 ? 'pass' : 'fail', detail);
    },
  },
  {
    id: 'markdown_alternates', category: 'readable', weight: 10,
    async run(origin) {
      // Strategy 1: Accept negotiation on /. Strategy 2: /index.md twin.
      const neg = await fetchText(origin, '/', { headers: { accept: 'text/markdown' } });
      if (neg.ok && neg.status === 200 && neg.contentType.includes('text/markdown')) {
        return result(this.id, this.category, this.weight, 'pass', `Accept: text/markdown negotiated (${neg.bytes}B)`);
      }
      const twin = await fetchText(origin, '/index.md');
      if (twin.ok && twin.status === 200 && twin.contentType.includes('markdown')) {
        return result(this.id, this.category, this.weight, 'pass', `/index.md twin served (${twin.bytes}B)`);
      }
      return result(this.id, this.category, this.weight, 'fail',
        `no markdown for agents: negotiation -> ${neg.status} ${neg.contentType || ''}; /index.md -> ${twin.status} ${twin.contentType || ''}`);
    },
  },
  {
    id: 'structured_errors', category: 'readable', weight: 6,
    async run(origin) {
      const r = await fetchText(origin, '/definitely-not-a-real-path-' + Date.now());
      if (!r.ok) return result(this.id, this.category, this.weight, 'fail', `error probe failed: ${r.error}`);
      if (r.status < 400) return result(this.id, this.category, this.weight, 'fail', `unknown path served ${r.status}, not an error`);
      if (!r.contentType.includes('json')) return result(this.id, this.category, this.weight, 'fail', `404 body is ${r.contentType || 'untyped'} — agents need problem+json`);
      let body;
      try { body = JSON.parse(r.text); } catch { return result(this.id, this.category, this.weight, 'fail', 'error body is not valid JSON'); }
      const isProblem = r.contentType.includes('application/problem+json');
      const hasMachine = Boolean(body.code || body.type);
      return result(this.id, this.category, this.weight, hasMachine ? 'pass' : 'fail',
        `status ${r.status}; problem+json: ${isProblem}; machine code: ${body.code || body.type || 'none'}`);
    },
  },
  {
    id: 'api_catalog', category: 'callable', weight: 8,
    async run(origin) {
      for (const p of ['/.well-known/api-catalog', '/openapi.json']) {
        const r = await fetchText(origin, p);
        if (r.ok && r.status === 200 && r.contentType.includes('json')) {
          return result(this.id, this.category, this.weight, 'pass', `catalog at ${p} (${r.bytes}B)`);
        }
      }
      return result(this.id, this.category, this.weight, 'fail', 'no /.well-known/api-catalog or /openapi.json');
    },
  },
  {
    id: 'openapi_valid', category: 'callable', weight: 6,
    async run(origin) {
      for (const doc of await fetchOpenApiDocs(origin)) {
        if (!doc.openapi) continue;
        const paths = Object.keys(doc.paths || {});
        const ops = paths.flatMap((k) => Object.keys(doc.paths[k]));
        const withDesc = paths.every((k) => Object.values(doc.paths[k]).every((o) => o.summary || o.description));
        if (paths.length === 0) return result(this.id, this.category, this.weight, 'info', 'OpenAPI doc has zero paths (content-only app — nothing callable to validate)');
        return result(this.id, this.category, this.weight, 'pass',
          `openapi ${doc.openapi}; ${paths.length} path(s), ${ops.length} operation(s); all described: ${withDesc}`);
      }
      return result(this.id, this.category, this.weight, 'fail', 'no parseable OpenAPI document');
    },
  },
  {
    id: 'mcp_endpoint', category: 'callable', weight: 14,
    async run(origin, { mcpProfile } = {}) {
      if (!mcpProfile) return result(this.id, this.category, this.weight, 'fail',
        'MCP evidence is UNVERIFIED: supply a served-surface profile with an explicit read-only tool allowlist');
      const report = await runStrictServedSurface(origin, mcpProfile);
      const call = report.findings.find((row) => row.id === 'mcp_tools_call');
      const status = report.summary.verdict === 'PASS' ? (call.verdict === 'N/A' ? 'info' : 'pass') : 'fail';
      return {
        ...result(this.id, this.category, this.weight, status,
          report.findings.map((row) => `${row.verdict} ${row.evidence}`).join('; ')),
        served_surface: report,
      };
    },
  },
  {
    id: 'agent_card', category: 'callable', weight: 8,
    async run(origin) {
      for (const p of ['/.well-known/agent-card.json', '/.well-known/agent.json']) {
        const r = await fetchText(origin, p);
        if (!r.ok || r.status !== 200) continue;
        let card; try { card = JSON.parse(r.text); } catch { continue; }
        if (!card.name) continue;
        const skills = (card.skills || []).length;
        return result(this.id, this.category, this.weight, 'pass', `${p}: name=${card.name}, ${skills} skill(s), protocolVersion=${card.protocolVersion || 'unset'}`);
      }
      return result(this.id, this.category, this.weight, 'fail', 'no agent card at /.well-known/agent-card.json');
    },
  },
  {
    id: 'webmcp_declared', category: 'callable', weight: 4,
    async run(origin) {
      const r = await fetchText(origin, '/');
      if (!r.ok || r.status !== 200) {
        // No landing page at all: WebMCP applies to human-facing UIs, so an
        // API-only origin is out of scope for this check (informational).
        return result(this.id, this.category, this.weight, 'info', `no landing page (GET / -> ${r.status || r.error}); WebMCP not applicable`);
      }
      const declared = /modelContext|webmcp|provideContext|registerTool/i.test(r.text);
      return result(this.id, this.category, this.weight, declared ? 'pass' : 'info',
        declared ? 'page declares WebMCP tooling' : 'no WebMCP declaration on the landing page (informational)');
    },
  },
  {
    id: 'poppy_discovery', category: 'callable', weight: 6,
    async run(origin) {
      const r = await fetchText(origin, '/.well-known/poppy.json');
      if (!r.ok || r.status === 404) {
        return result(this.id, this.category, this.weight, 'info', 'no /.well-known/poppy.json (informational — Personal Agent Protocol is opt-in)');
      }
      if (r.status !== 200) {
        return result(this.id, this.category, this.weight, 'fail', `GET /.well-known/poppy.json -> ${r.status}`);
      }
      let doc;
      try { doc = JSON.parse(r.text); } catch {
        return result(this.id, this.category, this.weight, 'fail', '/.well-known/poppy.json is not valid JSON');
      }
      if (typeof doc?.protocol_version !== 'string' || !/^[0-9]+\.[0-9]+$/.test(doc.protocol_version)) {
        return result(this.id, this.category, this.weight, 'fail', 'poppy.json missing valid protocol_version (major.minor)');
      }
      if (typeof doc?.organization?.name !== 'string' || !doc.organization.name || typeof doc?.organization?.domain !== 'string' || !doc.organization.domain) {
        return result(this.id, this.category, this.weight, 'fail', 'poppy.json missing organization.name or organization.domain');
      }
      const channels = ['agent', 'apis', 'web'].filter((k) => doc[k] !== undefined);
      if (channels.length === 0) {
        return result(this.id, this.category, this.weight, 'fail', 'poppy.json must declare at least one of agent, apis, or web');
      }
      return result(this.id, this.category, this.weight, 'pass',
        `Poppy ${doc.protocol_version}: org=${doc.organization.name} (${doc.organization.domain}); channels=${channels.join(',')}`);
    },
  },
  {
    id: 'bot_auth_advertised', category: 'payable', weight: 6,
    async run(origin) {
      // Signals accepted: an Accept-Signature challenge, a signature-agents
      // policy file, or documented tiering in llms.txt.
      const probe = await fetchText(origin, '/');
      const acceptSig = probe.headers?.get?.('accept-signature');
      if (acceptSig) return result(this.id, this.category, this.weight, 'pass', `Accept-Signature: ${acceptSig}`);
      const llms = await fetchText(origin, '/llms.txt');
      if (llms.ok && /web bot auth|signature-agent/i.test(llms.text)) {
        return result(this.id, this.category, this.weight, 'pass', 'Web Bot Auth policy documented in llms.txt');
      }
      return result(this.id, this.category, this.weight, 'info', 'no Web Bot Auth advertisement (informational — verification lives at the edge)');
    },
  },
  {
    id: 'x402_challenge', category: 'payable', weight: 8,
    async run(origin) {
      // Discover a priced operation from the catalog, then probe it unpaid.
      let priced = null;
      for (const doc of await fetchOpenApiDocs(origin)) {
        for (const [path, item] of Object.entries(doc.paths || {})) {
          for (const [method, op] of Object.entries(item)) {
            if (op['x-price-usd-micros'] > 0) priced = { path, method: method.toUpperCase() };
          }
        }
      }
      if (!priced) return result(this.id, this.category, this.weight, 'info', 'no priced operations advertised (informational)');
      const r = await fetchText(origin, priced.path, { method: priced.method, body: '{}', headers: { 'content-type': 'application/json' }, sameOrigin: true });
      if (!r.ok && r.status === 0 && /refused|off-origin/.test(r.error || '')) return result(this.id, this.category, this.weight, 'fail', `priced path ${JSON.stringify(priced.path)}: ${r.error}`);
      if (r.status !== 402) return result(this.id, this.category, this.weight, 'fail', `${priced.method} ${priced.path} unpaid -> ${r.status}, expected 402`);
      try {
        const body = JSON.parse(r.text);
        const acc = body.accepts?.[0];
        if (body.x402Version && acc?.scheme && acc?.payTo) {
          return result(this.id, this.category, this.weight, 'pass',
            `402 challenge: x402Version=${body.x402Version}, scheme=${acc.scheme}, amount=${acc.maxAmountRequired}`);
        }
        return result(this.id, this.category, this.weight, 'fail', '402 served but body is not an x402 challenge');
      } catch {
        return result(this.id, this.category, this.weight, 'fail', '402 body is not JSON');
      }
    },
  },
  {
    id: 'idempotency_advertised', category: 'payable', weight: 6,
    async run(origin) {
      for (const doc of await fetchOpenApiDocs(origin)) {
        if (JSON.stringify(doc).toLowerCase().includes('idempotency-key')) {
          return result(this.id, this.category, this.weight, 'pass', 'idempotency-key contract advertised in the catalog');
        }
      }
      const llms = await fetchText(origin, '/llms.txt');
      if (llms.ok && /idempotency/i.test(llms.text)) {
        return result(this.id, this.category, this.weight, 'pass', 'idempotency contract documented in llms.txt');
      }
      return result(this.id, this.category, this.weight, 'fail', 'retry-safety not advertised anywhere agents can find it');
    },
  },
];

export const GRADE_BANDS = [[90, 'A'], [75, 'B'], [55, 'C'], [35, 'D'], [0, 'F']];

export function grade(score) {
  for (const [min, g] of GRADE_BANDS) if (score >= min) return g;
  return 'F';
}

/** Run every check against an origin; returns the scorecard object. */
export async function runChecks(origin, context = {}) {
  const results = [];
  for (const check of CHECKS) {
    // Sequential on purpose: deterministic order, no thundering herd.
    results.push(await check.run(origin, context));
  }
  const scorable = results.filter((r) => r.status !== 'info');
  const earned = scorable.filter((r) => r.status === 'pass').reduce((a, r) => a + r.weight, 0);
  const available = scorable.reduce((a, r) => a + r.weight, 0);
  const score = available === 0 ? 0 : Math.round((earned / available) * 100);
  const byCategory = {};
  for (const r of results) {
    byCategory[r.category] ??= { earned: 0, available: 0 };
    if (r.status !== 'info') {
      byCategory[r.category].available += r.weight;
      if (r.status === 'pass') byCategory[r.category].earned += r.weight;
    }
  }
  return { origin, score, grade: grade(score), earned, available, byCategory, checks: results };
}

/** Performance battery: latency percentiles + the agent-tax ratio. */
export async function runPerformance(origin, { samples = 20 } = {}) {
  const surfaces = [
    { id: 'llms_txt', path: '/llms.txt' },
    { id: 'markdown_page', path: '/index.md' },
    { id: 'html_page', path: '/' },
    { id: 'api_catalog', path: '/.well-known/api-catalog' },
    { id: 'mcp_tools_list', path: '/mcp', method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), headers: { 'content-type': 'application/json' } },
  ];
  const out = [];
  for (const s of surfaces) {
    const times = [];
    let bytes = 0; let status = 0;
    for (let i = 0; i < samples; i++) {
      const r = await fetchText(origin, s.path, { method: s.method, body: s.body, headers: s.headers });
      times.push(r.ms); bytes = r.bytes; status = r.status;
    }
    times.sort((a, b) => a - b);
    const pct = (p) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))];
    out.push({ id: s.id, path: s.path, status, bytes, samples, p50_ms: +pct(50).toFixed(2), p95_ms: +pct(95).toFixed(2) });
  }
  const md = out.find((s) => s.id === 'markdown_page');
  const html = out.find((s) => s.id === 'html_page');
  const agentTax = md?.bytes && html?.bytes ? +(md.bytes / html.bytes).toFixed(3) : null;
  return { surfaces: out, agent_tax_markdown_vs_html: agentTax };
}
