// Fixture origins for the agent-score test suite and the baseline benchmarks.
//
// Three in-process HTTP servers:
//   goodOrigin()   — a fully agent-ready origin (every check passes);
//   legacyOrigin() — an HTML-only site: no robots, no llms.txt, HTML errors;
//   brokenOrigin() — the "don't score what you can't serve" case: artefacts
//                    ANNOUNCED (catalog, card, llms.txt) but the behaviour
//                    behind them broken (MCP times out out of protocol, the
//                    priced route never answers 402, markdown twins 500).
//
// Each returns { origin, close }.

import { GOOD_OPENAPI, GOOD_TOOLS, listenFixture as listen } from '../served-surface/fixtures.mjs';

export function goodOrigin() {
  return listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    const path = url.pathname;
    if (path === '/robots.txt') return send(200, 'text/plain', 'User-agent: *\nAllow: /\nContent-Signal: search=yes, ai-input=yes\nSitemap: http://x/sitemap.xml\n');
    if (path === '/sitemap.xml') return send(200, 'application/xml', '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>http://x/</loc></url></urlset>');
    if (path === '/llms.txt') return send(200, 'text/markdown', '# Good site\n\n> A fully agent-ready fixture. Web Bot Auth welcome; idempotency-key honored.\n\n## API\n\n- [catalog](/.well-known/api-catalog): the API\n');
    if (path === '/' && (req.headers.accept || '').includes('text/markdown')) return send(200, 'text/markdown; charset=utf-8', '# Good\n\nHello agents.\n');
    if (path === '/index.md') return send(200, 'text/markdown; charset=utf-8', '# Good\n\nHello agents.\n');
    if (path === '/') return send(200, 'text/html', '<html><head><script>navigator.modelContext.provideContext({tools:[]})</script></head><body><h1>Good</h1></body></html>');
    if (path === '/.well-known/api-catalog' || path === '/openapi.json') return send(200, 'application/json', JSON.stringify(GOOD_OPENAPI));
    if (path === '/.well-known/agent-card.json') return send(200, 'application/json', JSON.stringify({ protocolVersion: '0.3.0', name: 'fixtures/good', description: 'Good.', url: 'http://x/mcp', skills: [{ id: 'now', name: 'now' }] }));
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
      // Priced: unpaid -> x402 challenge.
      return send(402, 'application/json', JSON.stringify({ x402Version: 1, error: 'X-PAYMENT header is required', accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '5000', payTo: '0xFIX', resource: 'http://x/api/echo', asset: '0xUSDC', maxTimeoutSeconds: 60 }] }));
    }
    return send(404, 'application/problem+json', JSON.stringify({ type: 'urn:fixture:not-found', title: 'Not found', status: 404, code: 'APP_NO_ROUTE' }));
  });
}

export function legacyOrigin() {
  return listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><body><h1>Legacy Corp</h1><p>Welcome to our website.</p></body></html>');
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html><body><h1>404</h1><p>Page not found.</p></body></html>');
  });
}

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
    if (path === '/mcp') return send(200, 'text/html', '<h1>MCP coming soon</h1>'); // out of protocol
    if (path === '/api/echo' && req.method === 'POST') return send(200, 'application/json', '{"echo":true}'); // priced op never challenges
    if (path === '/') return send(200, 'text/html', '<html><body><h1>Broken</h1></body></html>');
    return send(404, 'text/html', '<h1>404</h1>'); // HTML error, no problem+json
  });
}
