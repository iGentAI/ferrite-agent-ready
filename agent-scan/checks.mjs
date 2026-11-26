// agent-scan check catalogue — the plan-16 tiered battery (20 checks).
//
// The 13 legacy checks are IMPORTED from ../agent-score/checks.mjs and
// wrapped unchanged (same ids, same probe logic, same evidence strings —
// verdict parity by construction; agent-score stays the oracle).
// Seven checks are new per build-out/plans/16-agentic-scanner.md §10:
// content_no_js, structured_data, md_vary_accept, mcp_manifest,
// skills_index, pricing_md, a2a_protocol.
//
// Tiers and weights (plan 16 §10.1–10.3):
//   essential   (pool 80): robots_txt 8, sitemap 6, llms_txt 10,
//     markdown_alternates 10, structured_errors 6, api_catalog 8,
//     openapi_valid 6, content_no_js 10, structured_data 8, md_vary_accept 4
//   recommended (pool 20): mcp_endpoint 14, agent_card 8, mcp_manifest 6,
//     skills_index 6, pricing_md 4
//   bonus       (+5 cap): x402_challenge 2, bot_auth_advertised 1,
//     webmcp_declared 1, idempotency_advertised 1, a2a_protocol 2
//   (bonus weights are the §10.3 SIGNAL values, not the legacy 100-point
//   weights — the probe semantics are still the legacy ones.)
//
// Each check: { id, name, tier, weight, summary, fix, probe(fetch, origin) }
// probe returns { verdict: 'pass'|'partial'|'fail'|'info', evidence, fix,
// fraction? } — fraction only for partial.

import { CHECKS as LEGACY_CHECKS } from '../agent-score/checks.mjs';

export { GRADE_BANDS, grade } from '../agent-score/checks.mjs';

const UA = 'ferrite-agent-scan/1.0 (+https://github.com/iGentAI/ferrite-agent-ready)';

/** One HTTP round-trip via the injected fetch. `path` may be absolute. */
async function grab(fetchImpl, origin, path, opts = {}) {
  const url = /^https?:\/\//i.test(path) ? path : origin.replace(/\/$/, '') + path;
  try {
    const res = await fetchImpl(url, {
      method: opts.method || 'GET',
      headers: { 'user-agent': UA, ...(opts.headers || {}) },
      body: opts.body,
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs || 10_000),
    });
    const text = await res.text();
    return { ok: true, status: res.status, contentType: res.headers.get('content-type') || '', headers: res.headers, text };
  } catch (err) {
    return { ok: false, status: 0, contentType: '', headers: null, text: '', error: String(err) };
  }
}

/** Wrap one imported legacy check. The legacy run() drives its own fetch
 * (global fetch, identical to agent-score) so verdicts and evidence
 * strings are bit-identical to the oracle. */
function legacyCheck({ id, name, tier, weight, summary, fix }) {
  const legacy = LEGACY_CHECKS.find((c) => c.id === id);
  if (!legacy) throw new Error(`legacy check ${id} not found in agent-score`);
  return {
    id, name, tier, weight, summary, fix, legacy: true,
    async probe(_fetch, origin, context = {}) {
      const r = await legacy.run(origin, context);
      return { verdict: r.status, evidence: r.evidence, fix };
    },
  };
}

/** Strip scripts/styles/tags and collapse whitespace; returns visible text. */
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract parsed JSON-LD blocks from raw HTML. */
function jsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const doc = JSON.parse(m[1]);
      for (const node of Array.isArray(doc) ? doc : doc['@graph'] || [doc]) blocks.push(node);
    } catch { /* unparseable block: skip */ }
  }
  return blocks;
}

const IDENTITY_TYPES = new Set([
  'Organization', 'WebSite', 'SoftwareApplication', 'Product', 'WebPage', 'WebApplication', 'Corporation',
]);

/** POST /mcp initialize; true when a live MCP endpoint answers in protocol. */
async function mcpAnswers(fetchImpl, origin) {
  const r = await grab(fetchImpl, origin, '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'agent-scan', version: '1.0' } } }),
  });
  if (!r.ok || r.status !== 200) return false;
  try { return Boolean(JSON.parse(r.text).result?.protocolVersion); } catch { return false; }
}

const FIX = {
  robots_txt: 'Serve /robots.txt with a User-agent rule and a Sitemap pointer. packages/agent-ready projects it from the declared Surface.',
  sitemap: 'Serve a urlset sitemap. agent-ready generates it from declared pages; Rsx apps get it from the meta module (packages/rsx).',
  llms_txt: 'Publish /llms.txt per https://llmstxt.org: one H1, a blockquote summary, linked resources. agent-ready projects it (src/artefacts.rs).',
  markdown_alternates: 'Serve Markdown twins: Accept negotiation per https://acceptmarkdown.com or static .md twins. agent-ready serves both (src/markdown.rs).',
  structured_errors: 'Return RFC 9457 problem+json (https://www.rfc-editor.org/rfc/rfc9457) with a stable code on every error, including 404s. agent-ready src/problem.rs.',
  api_catalog: 'Publish an RFC 9727 api-catalog linkset (https://www.rfc-editor.org/rfc/rfc9727) at /.well-known/api-catalog. agent-ready src/catalog.rs generates it.',
  openapi_valid: 'Serve OpenAPI 3.1 (https://spec.openapis.org) with a summary or description on every operation.',
  content_no_js: 'Render the page server-side: an H1 and at least 500 characters of text must arrive in the initial HTML. On Ferrite, Rsx pages render on the server (packages/rsx); Alloy apps should serve md twins for content routes.',
  structured_data: 'Embed a JSON-LD identity block (Organization or SoftwareApplication with name, description, url) in the homepage head.',
  md_vary_accept: 'Emit Vary: Accept alongside negotiated markdown so caches keep the twins separate. On Ferrite, set it in the IngressReply headers.',
  mcp_endpoint: 'Serve a stateless MCP endpoint at /mcp (spec https://modelcontextprotocol.io/specification, revision 2025-11-25). agent-ready src/mcp_face.rs projects tools from declared operations.',
  agent_card: 'Publish an agent card at /.well-known/agent-card.json (A2A, https://a2a-protocol.org). agent-ready src/catalog.rs generates it.',
  mcp_manifest: 'Publish an MCP registry manifest at /server.json (schema static.modelcontextprotocol.io) and a server card at /.well-known/mcp/server-card.json so agents can discover the endpoint without probing.',
  skills_index: 'Publish an Agent Skills index at /.well-known/agent-skills/index.json (https://skills.sh, schemas.agentskills.io) pointing at served SKILL.md files.',
  pricing_md: 'Serve machine-readable pricing at /pricing.md — plain Markdown an agent can quote. Free products should say so in one line.',
  x402_challenge: 'Serve x402 challenges (https://www.x402.org) for priced operations. agent-ready src/x402.rs.',
  bot_auth_advertised: 'Advertise Web Bot Auth (RFC 9421, https://www.rfc-editor.org/rfc/rfc9421; IETF draft-meunier-web-bot-auth-architecture) in llms.txt or an Accept-Signature challenge. agent-ready src/bot_auth.rs parses signatures.',
  webmcp_declared: 'Declare WebMCP tools on the human-facing UI (https://webmachinelearning.github.io/webmcp/); see fe-taskboard.',
  idempotency_advertised: 'Advertise the Idempotency-Key contract in the OpenAPI catalog or llms.txt. Ferrite operations declare idempotent in the Surface.',
  a2a_protocol: 'Complete the agent card per A2A (https://a2a-protocol.org): protocolVersion, skills, and a reachable service URL.',
};

export const CHECKS = [
  /* essential (pool 80) */
  legacyCheck({ id: 'robots_txt', name: 'robots.txt served', tier: 'essential', weight: 8, summary: 'GET /robots.txt answers 200 with a User-agent rule; a Sitemap pointer and Content-Signal are noted.', fix: FIX.robots_txt }),
  legacyCheck({ id: 'sitemap', name: 'Sitemap lists URLs', tier: 'essential', weight: 6, summary: 'GET /sitemap.xml answers 200 with a urlset carrying at least one <loc> entry.', fix: FIX.sitemap }),
  legacyCheck({ id: 'llms_txt', name: 'llms.txt published', tier: 'essential', weight: 10, summary: 'GET /llms.txt answers 200 with an H1 title and at least one markdown link.', fix: FIX.llms_txt }),
  legacyCheck({ id: 'markdown_alternates', name: 'Markdown twins served', tier: 'essential', weight: 10, summary: 'The landing page negotiates Accept: text/markdown or serves an /index.md twin.', fix: FIX.markdown_alternates }),
  legacyCheck({ id: 'structured_errors', name: 'Errors are machine-readable', tier: 'essential', weight: 6, summary: 'An unknown path answers an error status with a JSON body carrying a stable machine code.', fix: FIX.structured_errors }),
  legacyCheck({ id: 'api_catalog', name: 'API catalog discoverable', tier: 'essential', weight: 8, summary: 'GET /.well-known/api-catalog or /openapi.json answers 200 with JSON.', fix: FIX.api_catalog }),
  legacyCheck({ id: 'openapi_valid', name: 'OpenAPI describes operations', tier: 'essential', weight: 6, summary: 'The served OpenAPI document parses, names a version, and describes its operations.', fix: FIX.openapi_valid }),
  {
    id: 'content_no_js', name: 'Content readable without JavaScript', tier: 'essential', weight: 10,
    summary: 'The initial HTML of the landing page carries an H1 and at least 500 characters of visible text.',
    fix: FIX.content_no_js,
    async probe(fetchImpl, origin) {
      const r = await grab(fetchImpl, origin, '/');
      if (!r.ok || r.status !== 200) return { verdict: 'fail', evidence: `GET / -> ${r.status || r.error}`, fix: this.fix };
      const hasH1 = /<h1[\s>]/i.test(r.text);
      const chars = visibleText(r.text).length;
      const evidence = `h1: ${hasH1}; ${chars} chars of text without JavaScript`;
      return { verdict: hasH1 && chars >= 500 ? 'pass' : 'fail', evidence, fix: this.fix };
    },
  },
  {
    id: 'structured_data', name: 'JSON-LD identity block', tier: 'essential', weight: 8,
    summary: 'The homepage embeds a JSON-LD identity block (Organization, WebSite, …) with name and url.',
    fix: FIX.structured_data,
    async probe(fetchImpl, origin) {
      const r = await grab(fetchImpl, origin, '/');
      if (!r.ok || r.status !== 200) return { verdict: 'fail', evidence: `GET / -> ${r.status || r.error}`, fix: this.fix };
      const blocks = jsonLdBlocks(r.text);
      const identity = blocks.find((b) => {
        const types = Array.isArray(b['@type']) ? b['@type'] : [b['@type']];
        return types.some((t) => IDENTITY_TYPES.has(t));
      });
      if (!identity) return { verdict: 'fail', evidence: `no JSON-LD identity block (${blocks.length} ld+json block(s) parsed)`, fix: this.fix };
      const type = Array.isArray(identity['@type']) ? identity['@type'][0] : identity['@type'];
      const hasName = Boolean(identity.name);
      const hasUrl = Boolean(identity.url);
      const sameAs = Array.isArray(identity.sameAs) ? identity.sameAs.length : 0;
      const evidence = `JSON-LD @type=${type}; name: ${hasName}; url: ${hasUrl}; sameAs: ${sameAs}`;
      if (hasName && hasUrl) return { verdict: 'pass', evidence, fix: this.fix };
      return { verdict: 'partial', fraction: 0.5, evidence, fix: this.fix };
    },
  },
  {
    id: 'md_vary_accept', name: 'Vary: Accept on markdown twins', tier: 'essential', weight: 4,
    summary: 'Negotiated markdown responses carry Vary: Accept so caches keep the twins separate.',
    fix: FIX.md_vary_accept,
    async probe(fetchImpl, origin) {
      const r = await grab(fetchImpl, origin, '/', { headers: { accept: 'text/markdown' } });
      const negotiated = r.ok && r.status === 200 && r.contentType.includes('text/markdown');
      if (!negotiated) {
        return { verdict: 'info', evidence: `no Accept negotiation on / (-> ${r.status || r.error} ${r.contentType || ''}); Vary not applicable`, fix: this.fix };
      }
      const vary = r.headers?.get?.('vary') || '';
      if (/(^|,)\s*accept\s*(,|$)/i.test(vary)) return { verdict: 'pass', evidence: `Vary: ${vary}`, fix: this.fix };
      return { verdict: 'fail', evidence: 'negotiated markdown without Vary: Accept', fix: this.fix };
    },
  },

  /* recommended (pool 20) */
  legacyCheck({ id: 'mcp_endpoint', name: 'MCP endpoint answers tools/call', tier: 'recommended', weight: 14, summary: 'POST /mcp completes initialize, tools/list, and a real read-only tools/call.', fix: FIX.mcp_endpoint }),
  legacyCheck({ id: 'agent_card', name: 'Agent card published', tier: 'recommended', weight: 8, summary: 'GET /.well-known/agent-card.json answers 200 with a named A2A card.', fix: FIX.agent_card }),
  {
    id: 'mcp_manifest', name: 'MCP manifest published', tier: 'recommended', weight: 6,
    summary: 'A live MCP endpoint is discoverable through /server.json or a well-known server card.',
    fix: FIX.mcp_manifest,
    async probe(fetchImpl, origin) {
      if (!(await mcpAnswers(fetchImpl, origin))) {
        return { verdict: 'info', evidence: 'no MCP endpoint answered initialize; manifest not applicable', fix: this.fix };
      }
      for (const p of ['/server.json', '/.well-known/mcp/server-card.json']) {
        const r = await grab(fetchImpl, origin, p);
        if (!r.ok || r.status !== 200) continue;
        let doc;
        try { doc = JSON.parse(r.text); } catch {
          return { verdict: 'fail', evidence: `manifest at ${p} is not valid JSON`, fix: this.fix };
        }
        const remotes = doc.remotes || doc.servers || (doc.server ? [doc.server] : []);
        const transport = remotes?.[0]?.type || remotes?.[0]?.transport || remotes?.[0]?.transportType || remotes?.[0]?.transport_type;
        if (doc.name && transport) {
          return { verdict: 'pass', evidence: `manifest at ${p}: name=${doc.name}, transport=${transport}`, fix: this.fix };
        }
        return { verdict: 'fail', evidence: `manifest at ${p} missing name or a remote transport entry`, fix: this.fix };
      }
      return { verdict: 'fail', evidence: 'MCP endpoint live but no manifest at /server.json or /.well-known/mcp/server-card.json', fix: this.fix };
    },
  },
  {
    id: 'skills_index', name: 'Agent Skills index served', tier: 'recommended', weight: 6,
    summary: 'GET /.well-known/agent-skills/index.json lists at least one skill whose URL serves.',
    fix: FIX.skills_index,
    async probe(fetchImpl, origin) {
      const r = await grab(fetchImpl, origin, '/.well-known/agent-skills/index.json');
      if (!r.ok || r.status !== 200) return { verdict: 'fail', evidence: `GET /.well-known/agent-skills/index.json -> ${r.status || r.error}`, fix: this.fix };
      let doc;
      try { doc = JSON.parse(r.text); } catch { return { verdict: 'fail', evidence: 'skills index is not valid JSON', fix: this.fix }; }
      const skills = Array.isArray(doc.skills) ? doc.skills : Array.isArray(doc) ? doc : [];
      const named = skills.filter((s) => (s.name || s.id) && s.url);
      if (named.length === 0) return { verdict: 'fail', evidence: `skills index has no entries with a name/id and a URL (${skills.length} raw entr${skills.length === 1 ? 'y' : 'ies'})`, fix: this.fix };
      const first = await grab(fetchImpl, origin, named[0].url);
      const evidence = `index: ${named.length} skill(s); first skill fetch: ${first.status || first.error}`;
      if (first.ok && first.status === 200) return { verdict: 'pass', evidence, fix: this.fix };
      return { verdict: 'partial', fraction: 0.5, evidence, fix: this.fix };
    },
  },
  {
    id: 'pricing_md', name: 'Machine-readable pricing', tier: 'recommended', weight: 4,
    summary: 'GET /pricing.md serves at least 100 characters of Markdown with an H1.',
    fix: FIX.pricing_md,
    async probe(fetchImpl, origin) {
      const r = await grab(fetchImpl, origin, '/pricing.md');
      if (!r.ok || r.status !== 200) return { verdict: 'fail', evidence: `GET /pricing.md -> ${r.status || r.error}`, fix: this.fix };
      const typed = r.contentType.includes('markdown') || r.contentType.includes('text');
      const hasH1 = /^# /m.test(r.text);
      const bytes = Buffer.byteLength(r.text);
      const evidence = `served (${bytes}B); h1: ${hasH1}`;
      if (typed && hasH1 && r.text.length >= 100) return { verdict: 'pass', evidence, fix: this.fix };
      return { verdict: 'fail', evidence: `${evidence}; content-type: ${r.contentType || 'untyped'}`, fix: this.fix };
    },
  },

  /* bonus (+5 cap, never required) */
  legacyCheck({ id: 'x402_challenge', name: 'x402 payment challenge', tier: 'bonus', weight: 2, summary: 'An advertised priced operation answers an unpaid request with a real x402 challenge.', fix: FIX.x402_challenge }),
  legacyCheck({ id: 'bot_auth_advertised', name: 'Web Bot Auth advertised', tier: 'bonus', weight: 1, summary: 'An Accept-Signature challenge or a Web Bot Auth policy in llms.txt is advertised.', fix: FIX.bot_auth_advertised }),
  legacyCheck({ id: 'webmcp_declared', name: 'WebMCP declared', tier: 'bonus', weight: 1, summary: 'The landing page declares WebMCP tooling for in-page agents.', fix: FIX.webmcp_declared }),
  legacyCheck({ id: 'idempotency_advertised', name: 'Idempotency contract advertised', tier: 'bonus', weight: 1, summary: 'The catalog or llms.txt advertises the Idempotency-Key retry contract.', fix: FIX.idempotency_advertised }),
  {
    id: 'a2a_protocol', name: 'A2A agent card complete', tier: 'bonus', weight: 2,
    summary: 'The agent card carries protocolVersion, at least one skill, and a reachable service URL.',
    fix: FIX.a2a_protocol,
    async probe(fetchImpl, origin) {
      let card = null; let cardPath = null;
      for (const p of ['/.well-known/agent-card.json', '/.well-known/agent.json']) {
        const r = await grab(fetchImpl, origin, p);
        if (!r.ok || r.status !== 200) continue;
        try { const c = JSON.parse(r.text); if (c.name) { card = c; cardPath = p; break; } } catch { /* skip */ }
      }
      if (!card) return { verdict: 'info', evidence: 'no agent card served; A2A shape not applicable', fix: this.fix };
      const hasVersion = Boolean(card.protocolVersion);
      const skills = Array.isArray(card.skills) ? card.skills.length : 0;
      let reachable = false; let urlStatus = 'unset';
      if (card.url) {
        const r = await grab(fetchImpl, origin, card.url, { method: 'GET' });
        reachable = r.ok && r.status > 0 && r.status < 500;
        urlStatus = String(r.status || r.error);
      }
      const evidence = `${cardPath}: protocolVersion=${card.protocolVersion || 'unset'}; ${skills} skill(s); url ${card.url ? `-> ${urlStatus}` : 'unset'}`;
      if (hasVersion && skills >= 1 && reachable) return { verdict: 'pass', evidence, fix: this.fix };
      return { verdict: 'fail', evidence, fix: this.fix };
    },
  },
];
