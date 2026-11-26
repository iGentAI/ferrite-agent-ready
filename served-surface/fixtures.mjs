import { createServer } from 'node:http';

export function listenFixture(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done, closeReject) => server.close((error) => error ? closeReject(error) : done())),
      });
    });
  });
}

export const GOOD_OPENAPI = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'good', version: '1.0.0', description: 'A good API.' },
  paths: {
    '/api/echo': {
      post: {
        operationId: 'echo',
        summary: 'Echo the payload back.',
        'x-price-usd-micros': 5000,
        parameters: [{ name: 'idempotency-key', in: 'header', required: false, schema: { type: 'string' } }],
        responses: { 200: { description: 'ok' }, 402: { description: 'payment required' } },
      },
    },
    '/api/time': {
      get: { operationId: 'now', summary: 'Current time.', responses: { 200: { description: 'ok' } } },
    },
  },
});

export const GOOD_TOOLS = Object.freeze([
  { name: 'now', description: 'Current time.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'echo', description: 'Echo.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, idempotentHint: true } },
]);

export const FIXTURE_READ_ONLY_TOOLS = Object.freeze(['now']);

export function fixtureServedSurfaceProfile(endpointClass = 'mcp-2025-11-25') {
  return {
    schema_version: 'served-surface-profile.v1',
    id: `fixture-required-${endpointClass}`,
    endpoint_class: endpointClass,
    protocol_revision: endpointClass.slice(4),
    read_only_tool_allowlist: [...FIXTURE_READ_ONLY_TOOLS],
    applicability: { mcp_tools_call: { state: 'REQUIRED' } },
  };
}

export async function mcpFixture({
  endpointClass = 'mcp-2025-11-25',
  tools = GOOD_TOOLS,
  toolPages = null,
  callResult = { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true }, isError: false },
  sessionId = null,
  cleanupStatus = 204,
  notificationStatus = 202,
} = {}) {
  const stats = { calls: [], listPages: 0, cleanups: [], initialized: false };
  const fixture = await listenFixture((req, res) => {
    if (req.url === '/mcp' && req.method === 'DELETE' && sessionId) {
      stats.cleanups.push({ ...req.headers });
      res.writeHead(req.headers['mcp-session-id'] === sessionId ? cleanupStatus : 400);
      res.end();
      return;
    }
    if (req.url !== '/mcp' || req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/problem+json' });
      res.end(JSON.stringify({ type: 'urn:fixture:not-found', status: 404 }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
        return;
      }
      stats.calls.push({
        id: body.id,
        method: body.method,
        name: body.params?.name ?? null,
        params: body.params ?? null,
        headers: { ...req.headers },
      });
      const reply = (result) => {
        res.writeHead(200, { 'content-type': 'application/json', ...(body.method === 'initialize' && sessionId ? { 'mcp-session-id': sessionId } : {}) });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      };
      if (body.method === 'initialize' && endpointClass !== 'mcp-2026-07-28') {
        reply({ protocolVersion: endpointClass.slice(4), capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
      } else if (endpointClass !== 'mcp-2026-07-28' && (req.headers['mcp-protocol-version'] !== endpointClass.slice(4) || sessionId && req.headers['mcp-session-id'] !== sessionId)) {
        res.writeHead(400);
        res.end();
      } else if (body.method === 'notifications/initialized' && endpointClass !== 'mcp-2026-07-28') {
        stats.initialized = notificationStatus === 202 && !Object.hasOwn(body, 'id');
        res.writeHead(notificationStatus);
        res.end();
      } else if (body.method === 'server/discover' && endpointClass === 'mcp-2026-07-28') {
        reply({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 60000, cacheScope: 'public', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture', version: '1' } } });
      } else if (endpointClass !== 'mcp-2026-07-28' && !stats.initialized) {
        res.writeHead(400);
        res.end();
      } else if (body.method === 'tools/list') {
        const page = toolPages === null ? { tools } : toolPages[Math.min(stats.listPages, toolPages.length - 1)];
        stats.listPages += 1;
        reply(endpointClass === 'mcp-2026-07-28' ? { resultType: 'complete', ttlMs: 60000, cacheScope: 'public', ...page } : page);
      } else if (body.method === 'tools/call') {
        reply(endpointClass === 'mcp-2026-07-28' ? { resultType: 'complete', ...callResult } : callResult);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } }));
      }
    });
  });
  return { ...fixture, stats };
}
