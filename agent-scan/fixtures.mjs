// Fixture origins for the agent-scan test suite — the agent-score pattern
// (agent-score/fixtures.mjs) extended with the plan-16 new-check
// dimensions:
//
//   goodOrigin()   — passes every check: SSR homepage with an H1 and >500
//                    chars, JSON-LD identity, Vary: Accept on negotiated
//                    markdown, /server.json manifest, skills index with a
//                    fetchable SKILL.md, /pricing.md, complete A2A card.
//   legacyOrigin() — an HTML-only site: nothing served, most checks fail,
//                    surface-scoped checks (md_vary_accept, mcp_manifest,
//                    a2a_protocol, x402) report info.
//   brokenOrigin() — announces artefacts and breaks the behaviour behind
//                    them: negotiated markdown without Vary, JSON-LD without
//                    name/url (partial), skills index with a dead skill URL
//                    (partial), /server.json that is not JSON, an MCP
//                    endpoint whose tools/call errors, a priced op that
//                    never answers 402, an agent card with zero skills.
//
// Each returns { origin, close }.

import { GOOD_OPENAPI, GOOD_TOOLS, listenFixture as listen } from '../served-surface/fixtures.mjs';

export { legacyOrigin } from '../agent-score/fixtures.mjs';

const GOOD_JSONLD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Good Fixtures Ltd',
  description: 'A fully agent-ready fixture origin.',
  url: 'http://127.0.0.1/',
  sameAs: ['https://github.com/iGentAI/ferrite-agent-ready'],
});

// >500 chars of visible text so content_no_js passes on served behaviour.
const GOOD_BODY_TEXT = [
  'Good Fixtures serves every artefact an agent needs before it renders a',
  'single line of JavaScript. The robots policy names its sitemap. The',
  'llms.txt file links the catalog. Markdown twins negotiate on the same',
  'routes as the HTML they mirror, and every negotiated reply carries the',
  'Vary header so shared caches keep the twins apart. Errors arrive as',
  'problem+json with stable machine codes. The MCP endpoint completes a',
  'real tools/call round-trip, the skills index points at a served skill',
  'file, and pricing is one Markdown file an agent can quote verbatim.',
].join(' ');

const GOOD_HOME = `<html><head><title>Good</title>` +
  `<script type="application/ld+json">${GOOD_JSONLD}</script>` +
  `<script>navigator.modelContext.provideContext({tools:[]})</script>` +
  `</head><body><h1>Good</h1><p>${GOOD_BODY_TEXT}</p></body></html>`;

export function goodOrigin() {
  return listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { 'content-type': type, ...extra });
      res.end(body);
    };
    const path = url.pathname;
    if (path === '/robots.txt') return send(200, 'text/plain', 'User-agent: *\nAllow: /\nContent-Signal: search=yes, ai-input=yes\nSitemap: http://x/sitemap.xml\n');
    if (path === '/sitemap.xml') return send(200, 'application/xml', '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>http://x/</loc></url></urlset>');
    if (path === '/llms.txt') return send(200, 'text/markdown', '# Good site\n\n> A fully agent-ready fixture. Web Bot Auth welcome; idempotency-key honored.\n\n## API\n\n- [catalog](/.well-known/api-catalog): the API\n');
    if (path === '/' && (req.headers.accept || '').includes('text/markdown')) {
      return send(200, 'text/markdown; charset=utf-8', '# Good\n\nHello agents.\n', { vary: 'Accept' });
    }
    if (path === '/index.md') return send(200, 'text/markdown; charset=utf-8', '# Good\n\nHello agents.\n');
    if (path === '/') return send(200, 'text/html', GOOD_HOME);
    if (path === '/.well-known/api-catalog' || path === '/openapi.json') return send(200, 'application/json', JSON.stringify(GOOD_OPENAPI));
    if (path === '/.well-known/agent-card.json') return send(200, 'application/json', JSON.stringify({ protocolVersion: '0.3.0', name: 'fixtures/good', description: 'Good.', url: '/mcp', skills: [{ id: 'now', name: 'now' }] }));
    if (path === '/server.json') return send(200, 'application/json', JSON.stringify({ name: 'fixtures/good', description: 'Good MCP server.', remotes: [{ type: 'streamable-http', url: '/mcp' }] }));
    if (path === '/.well-known/agent-skills/index.json') return send(200, 'application/json', JSON.stringify({ skills: [{ id: 'scan-a-site', name: 'scan-a-site', url: '/skills/scan-a-site/SKILL.md' }] }));
    if (path === '/skills/scan-a-site/SKILL.md') return send(200, 'text/markdown; charset=utf-8', '# scan-a-site\n\nScan one origin and read the scorecard.\n');
    if (path === '/pricing.md') return send(200, 'text/markdown; charset=utf-8', '# Pricing\n\nGood Fixtures is free. Every route on this origin serves without payment; priced API operations answer x402 challenges.\n');
    if (path === '/mcp' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch { return send(400, 'application/json', '{}'); }
        const reply = (result) => send(200, 'application/json', JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        if (body.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'good', version: '1' } });
        if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
        if (body.method === 'tools/list') return reply({ tools: GOOD_TOOLS });
        if (body.method === 'tools/call') return reply({ content: [{ type: 'text', text: '"ok"' }], structuredContent: { ok: true }, isError: false });
        return send(200, 'application/json', JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } }));
      });
      return;
    }
    if (path === '/api/echo' && req.method === 'POST') {
      return send(402, 'application/json', JSON.stringify({ x402Version: 1, error: 'X-PAYMENT header is required', accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '5000', payTo: '0xFIX', resource: 'http://x/api/echo', asset: '0xUSDC', maxTimeoutSeconds: 60 }] }));
    }
    return send(404, 'application/problem+json', JSON.stringify({ type: 'urn:fixture:not-found', title: 'Not found', status: 404, code: 'APP_NO_ROUTE' }));
  });
}

const BROKEN_HOME = '<html><head>' +
  '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","description":"identity block without name or url"}</script>' +
  '</head><body><h1>Broken</h1></body></html>';

export function brokenOrigin() {
  return listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
    const path = url.pathname;
    // Announces everything...
    if (path === '/robots.txt') return send(200, 'text/plain', 'User-agent: *\nAllow: /\nSitemap: http://x/sitemap.xml\n');
    if (path === '/llms.txt') return send(200, 'text/markdown', '# Broken site\n\n> Claims everything, serves little. idempotency promised.\n\n## API\n\n- [catalog](/.well-known/api-catalog): the API\n');
    if (path === '/.well-known/api-catalog') return send(200, 'application/json', JSON.stringify(GOOD_OPENAPI));
    if (path === '/.well-known/agent-card.json') return send(200, 'application/json', JSON.stringify({ protocolVersion: '0.3.0', name: 'fixtures/broken', skills: [] }));
    // ...but the behaviour behind the claims is broken:
    if (path === '/sitemap.xml') return send(200, 'application/xml', '<html>oops not xml</html>'); // not a urlset
    if (path === '/index.md') return send(500, 'text/html', '<h1>markdown renderer crashed</h1>');
    if (path === '/' && (req.headers.accept || '').includes('text/markdown')) {
      return send(200, 'text/markdown; charset=utf-8', '# Broken\n\nNegotiated without Vary.\n'); // no Vary: Accept -> md_vary_accept fails
    }
    if (path === '/server.json') return send(200, 'application/json', '<xml>not json at all</xml>'); // manifest announced, unparseable
    if (path === '/.well-known/agent-skills/index.json') return send(200, 'application/json', JSON.stringify({ skills: [{ id: 'ghost', name: 'ghost', url: '/skills/ghost/SKILL.md' }] })); // skill URL 404s -> partial
    if (path === '/pricing.md') return send(200, 'text/html', '<h1>pricing page</h1>'); // no markdown H1, too short
    if (path === '/mcp' && req.method === 'POST') {
      // In protocol for initialize/tools/list, but the advertised read-only
      // tool errors on a real call — announced behaviour that does not work.
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch { return send(400, 'application/json', '{}'); }
        const reply = (result) => send(200, 'application/json', JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        if (body.method === 'initialize') return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'broken', version: '1' } });
        if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
        if (body.method === 'tools/list') return reply({ tools: GOOD_TOOLS });
        if (body.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'tool crashed' }], isError: true });
        return send(200, 'application/json', JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } }));
      });
      return;
    }
    if (path === '/api/echo' && req.method === 'POST') return send(200, 'application/json', '{"echo":true}'); // priced op never challenges
    if (path === '/') return send(200, 'text/html', BROKEN_HOME);
    return send(404, 'text/html', '<h1>404</h1>'); // HTML error, no problem+json
  });
}
