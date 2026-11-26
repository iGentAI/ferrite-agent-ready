import { createHash } from 'node:crypto';

import { validateProfile } from './evidence.mjs';
import { McpWireError, encodeMcpHeader, parseRpcBody, readBoundedResponse, sessionlessParams } from './mcp-wire.mjs';

const CLIENT = Object.freeze({ name: 'ferrite-served-surface', version: '1.0.0' });
const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
// Session IDs stay in memory, outside enumerable observations and retained traces.
const sessions = new WeakMap();
const opaque = (value) => `[OPAQUE:${digest(value)}]`;

function rpc(id, method, params) {
  return { jsonrpc: '2.0', id, method, params };
}

async function post(fetchImpl, origin, protocolRevision, method, id, params = {}, toolName = null, trace = null, session = null) {
  const current = protocolRevision === '2026-07-28';
  const sessionState = sessions.get(session);
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (current) {
    headers['mcp-protocol-version'] = protocolRevision;
    headers['mcp-method'] = method;
    if (toolName) headers['mcp-name'] = encodeMcpHeader(toolName);
  } else if (method !== 'initialize') {
    headers['mcp-protocol-version'] = protocolRevision;
    if (sessionState?.id) headers['mcp-session-id'] = sessionState.id;
  }
  const request = id === undefined ? { jsonrpc: '2.0', method }
    : rpc(id, method, current ? sessionlessParams(protocolRevision, CLIENT, params) : params);
  const started = performance.now();
  const record = {
    request: { endpoint: `${origin.replace(/\/$/, '')}/mcp`, headers: {
      ...headers, ...(headers['mcp-session-id'] ? { 'mcp-session-id': opaque(headers['mcp-session-id']) } : {}),
    }, body: request },
    response: null,
    started_at_utc: new Date().toISOString(),
    elapsed_ms: null,
    transport_state: 'started',
  };
  trace?.push(record);
  const finish = (state) => {
    record.transport_state = state;
    record.elapsed_ms = Math.round((performance.now() - started) * 1000) / 1000;
  };
  let response;
  try {
    response = await fetchImpl(`${origin.replace(/\/$/, '')}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    finish('unavailable');
    return { kind: 'infra', error: 'MCP transport unavailable' };
  }
  let text;
  let body;
  record.response = {
    status: response.status,
    headers: Object.fromEntries(['content-type', 'mcp-protocol-version', 'cache-control', 'vary']
      .flatMap((name) => response.headers.has(name) ? [[name, response.headers.get(name)]] : [])),
    session_id_present: response.headers.has('mcp-session-id'),
    session_id_sha256: response.headers.has('mcp-session-id') ? digest(response.headers.get('mcp-session-id')) : null,
    raw_body_sha256: null,
    body: null,
  };
  if (response.headers.has('mcp-session-id') && sessionState) {
    const observed = response.headers.get('mcp-session-id');
    const valid = observed && observed.length <= 4096 && !/[^\x21-\x7e]/.test(observed);
    if (!current && method === 'initialize' && valid) sessionState.id = observed;
    else if (current || !valid || observed !== sessionState.id) {
      sessionState.unaccountedAllocation = true;
      sessionState.unaccountedSessionDigests.add(digest(observed));
    }
  }
  try {
    text = id === undefined && response.body === null ? '' : await readBoundedResponse(response);
    record.response.raw_body_sha256 = createHash('sha256').update(text).digest('hex');
    if (id === undefined) {
      finish('completed');
      if (response.status !== 202 || text !== '') return { kind: 'response', status: response.status, error: 'initialized notification requires HTTP 202 and an empty body' };
      if (sessionState?.unaccountedAllocation) return { kind: 'response', status: response.status, error: 'ambiguous MCP session identity blocks continuation' };
      if (sessionState) sessionState.initialized = true;
      return { kind: 'notification', status: 202 };
    }
    body = parseRpcBody(text, response.headers.get('content-type'), id).body;
    record.response.body = body;
  } catch (error) {
    record.response.error = error instanceof McpWireError ? error.code : 'MCP response unavailable';
    finish('invalid_response');
    return { kind: 'response', status: response.status, error: error instanceof McpWireError ? error.code : 'MCP response unavailable' };
  }
  finish('completed');
  if (current && response.headers.has('mcp-session-id')) {
    return { kind: 'response', status: response.status, error: 'sessionless endpoint returned a session ID' };
  }
  if (sessionState?.unaccountedAllocation) {
    return { kind: 'response', status: response.status, error: 'ambiguous MCP session identity blocks continuation' };
  }
  return { kind: 'response', status: response.status, text, body };
}

/** Terminate exactly the allocated legacy session; no replay or new session. */
export async function closeMcpSession(session, fetchImpl = fetch, trace = null) {
  const state = sessions.get(session);
  if (state?.unaccountedAllocation && !state.id) return {
    state: 'incomplete', verdict: 'UNVERIFIED', resource_sha256: null,
    unresolved_resource_sha256: [...state.unaccountedSessionDigests],
    evidence: 'invalid or unexpected session allocation cannot be accounted for safely',
  };
  if (!state?.id) return { state: 'complete', verdict: 'PASS', resource_sha256: null, evidence: 'no server-side session was allocated' };
  if (state.cleanup) return state.cleanup;
  const resource = digest(state.id);
  const headers = { 'mcp-protocol-version': state.version, 'mcp-session-id': state.id };
  const record = {
    request: { endpoint: `${state.origin.replace(/\/$/, '')}/mcp`, method: 'DELETE', headers: { ...headers, 'mcp-session-id': opaque(state.id) }, body: null },
    response: null, started_at_utc: new Date().toISOString(), elapsed_ms: null, transport_state: 'started',
  };
  trace?.push(record);
  const started = performance.now();
  try {
    const response = await fetchImpl(record.request.endpoint, { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (response.headers.has('mcp-session-id') && response.headers.get('mcp-session-id') !== state.id) {
      state.unaccountedAllocation = true;
      state.unaccountedSessionDigests.add(digest(response.headers.get('mcp-session-id')));
    }
    const body = response.body === null ? '' : await readBoundedResponse(response);
    record.response = { status: response.status, raw_body_sha256: createHash('sha256').update(body).digest('hex') };
    record.transport_state = 'completed';
    const complete = [200, 204, 404].includes(response.status);
    state.cleanup = { state: complete ? 'complete' : 'incomplete', verdict: complete ? 'PASS' : 'UNVERIFIED', resource_sha256: resource, evidence: `exact session DELETE: HTTP ${response.status}` };
  } catch {
    record.transport_state = 'unavailable';
    state.cleanup = { state: 'incomplete', verdict: 'INFRA', resource_sha256: resource, evidence: 'exact session DELETE was unavailable' };
  } finally {
    record.elapsed_ms = Math.round((performance.now() - started) * 1000) / 1000;
    state.initialized = false;
  }
  if (state.unaccountedAllocation) {
    state.cleanup = {
      state: 'incomplete', verdict: state.cleanup.verdict === 'INFRA' ? 'INFRA' : 'UNVERIFIED',
      resource_sha256: resource, known_session_cleanup: state.cleanup,
      unresolved_resource_sha256: [...state.unaccountedSessionDigests],
      evidence: 'exact known-session cleanup was attempted; unexpected session identities remain unresolved',
    };
  }
  return state.cleanup;
}

function responseResult(response, label) {
  if (response.kind === 'infra') return { kind: 'infra', evidence: `${label}: ${response.error}` };
  if (response.status !== 200) return { kind: 'fail', evidence: `${label}: HTTP ${response.status}` };
  if (response.error) return { kind: 'fail', evidence: `${label}: ${response.error}` };
  if (response.body?.error) {
    return { kind: 'fail', evidence: `${label}: JSON-RPC ${response.body.error.code ?? 'error'}` };
  }
  if (!response.body?.result || typeof response.body.result !== 'object') {
    return { kind: 'fail', evidence: `${label}: response has no result object` };
  }
  return { kind: 'ok', evidence: `${label}: HTTP 200 JSON-RPC result`, result: response.body.result };
}

export function emptyArgumentsAreValid(schema) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.$ref !== undefined || schema.not !== undefined || schema.if !== undefined) return false;
  if (schema.type !== undefined && schema.type !== 'object') return false;
  if (Number(schema.minProperties ?? 0) > 0) return false;
  if (Array.isArray(schema.required) && schema.required.length > 0) return false;
  if (schema.const !== undefined && JSON.stringify(schema.const) !== '{}') return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((value) => JSON.stringify(value) === '{}')) return false;
  if (Array.isArray(schema.allOf) && !schema.allOf.every(emptyArgumentsAreValid)) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(emptyArgumentsAreValid)) return false;
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter(emptyArgumentsAreValid).length !== 1) return false;
  return true;
}

export function selectEligibleTool(tools, readOnlyAllowlist = []) {
  if (!Array.isArray(tools) || !Array.isArray(readOnlyAllowlist)) return null;
  const allowed = new Set(readOnlyAllowlist);
  return tools.find((tool) =>
    typeof tool?.name === 'string' &&
    tool.name.length > 0 &&
    allowed.has(tool.name) &&
    tool?.annotations?.readOnlyHint === true &&
    emptyArgumentsAreValid(tool.inputSchema)
  ) ?? null;
}

async function inspectWithSession(origin, profile, fetchImpl, trace, session) {
  profile = validateProfile(profile);
  const protocolRevision = profile.protocol_revision;
  const current = profile.endpoint_class === 'mcp-2026-07-28';
  const discoveryMethod = current ? 'server/discover' : 'initialize';
  const discoveryParams = current
    ? {}
    : { protocolVersion: protocolRevision, capabilities: {}, clientInfo: CLIENT };
  const discoveryResponse = await post(fetchImpl, origin, protocolRevision, discoveryMethod, 1, discoveryParams, null, trace, session);
  const discovery = responseResult(discoveryResponse, discoveryMethod);
  if (discovery.kind !== 'ok') return { discovery, list: null, tools: null };
  const versionMatches = current
    ? Array.isArray(discovery.result.supportedVersions) && discovery.result.supportedVersions.includes(protocolRevision)
    : discovery.result.protocolVersion === protocolRevision;
  if (!versionMatches) {
    return {
      discovery: {
        kind: 'fail',
        evidence: `${discoveryMethod}: the returned version inventory does not support ${protocolRevision}`,
      },
      list: null,
      tools: null,
    };
  }
  const completeCache = (result) => result.resultType === 'complete' && Number.isSafeInteger(result.ttlMs) && result.ttlMs >= 0 && ['public', 'private'].includes(result.cacheScope);
  if (current && (!completeCache(discovery.result) || !discovery.result._meta?.['io.modelcontextprotocol/serverInfo'])) {
    return { discovery: { kind: 'fail', evidence: 'server/discover: incomplete result, missing cache identity, or missing server metadata' }, list: null, tools: null };
  }
  if (!current) {
    const initialized = await post(fetchImpl, origin, protocolRevision, 'notifications/initialized', undefined, {}, null, trace, session);
    if (initialized.kind !== 'notification') {
      return { discovery: { kind: initialized.kind === 'infra' ? 'infra' : 'fail', evidence: initialized.error ?? 'initialized notification was not accepted' }, list: null, tools: null };
    }
  }

  const tools = [];
  const names = new Set();
  const cursors = new Set();
  const inventory = { complete: false, pages: [], tool_names: [], catalog_response_sha256: null };
  let cursor;
  let requestId = 2;
  let cacheScope;
  const failed = (list) => ({ discovery, list, tools: null, catalog_inventory: inventory, next_request_id: requestId });
  for (let page = 0; page < profile.max_tool_pages; page += 1) {
    const listResponse = await post(fetchImpl, origin, protocolRevision, 'tools/list', requestId++, cursor === undefined ? {} : { cursor }, null, trace, session);
    const list = responseResult(listResponse, 'tools/list');
    if (list.kind !== 'ok') return failed(list);
    const pageTools = list.result.tools;
    const nextCursor = list.result.nextCursor;
    if (current && (!completeCache(list.result) || (cacheScope !== undefined && cacheScope !== list.result.cacheScope))) {
      return failed({ kind: 'fail', evidence: 'tools/list: incomplete result or missing/changed cache identity' });
    }
    cacheScope = list.result.cacheScope;
    if (!Array.isArray(pageTools)) return failed({ kind: 'fail', evidence: 'tools/list: result.tools is not an array' });
    inventory.pages.push({
      page_index: page,
      request_id: requestId - 1,
      request_cursor_sha256: cursor === undefined ? null : digest(cursor),
      next_cursor_sha256: nextCursor === undefined ? null : digest(nextCursor),
      response_sha256: digest(list.result),
      tool_names: pageTools.map((tool) => typeof tool?.name === 'string' ? tool.name : null),
    });
    for (const tool of pageTools) {
      if (typeof tool?.name !== 'string' || !tool.name.trim() || tool.name.length > 512 || /[\x00-\x1f]/.test(tool.name)) {
        return failed({ kind: 'fail', evidence: 'tools/list: a tool has an invalid name' });
      }
      if (names.has(tool.name)) return failed({ kind: 'fail', evidence: 'tools/list: duplicate tool name across the complete catalog' });
      names.add(tool.name);
      tools.push(tool);
      inventory.tool_names.push(tool.name);
    }
    if (nextCursor === undefined) {
      inventory.complete = true;
      inventory.catalog_response_sha256 = digest(tools);
      return {
        discovery,
        list: { kind: 'ok', evidence: `tools/list: ${tools.length} tool(s) across ${inventory.pages.length} complete page(s)`, result: { tools } },
        tools,
        catalog_inventory: inventory,
        next_request_id: requestId,
      };
    }
    if (typeof nextCursor !== 'string' || nextCursor.length === 0 || nextCursor.length > 8192) {
      return failed({ kind: 'fail', evidence: 'tools/list: invalid continuation cursor' });
    }
    if (cursors.has(nextCursor)) return failed({ kind: 'fail', evidence: 'tools/list: repeated cursor prevents complete catalog evidence' });
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  return failed({ kind: 'fail', evidence: `tools/list: page budget ${profile.max_tool_pages} exhausted before catalog completion` });
}

export async function inspectMcpSurface(origin, profile, fetchImpl = fetch, trace = null) {
  profile = validateProfile(profile);
  const session = Object.freeze({});
  sessions.set(session, { origin, version: profile.protocol_revision, id: null, initialized: false, cleanup: null, unaccountedAllocation: false, unaccountedSessionDigests: new Set() });
  try {
    const observed = await inspectWithSession(origin, profile, fetchImpl, trace, session);
    Object.defineProperty(observed, 'transport_session', { value: session });
    return observed;
  } catch (error) {
    await closeMcpSession(session, fetchImpl, trace);
    throw error;
  }
}

export async function callEligibleTool(origin, profile, tool, fetchImpl = fetch, requestId = 3, trace = null, session = null) {
  profile = validateProfile(profile);
  if (sessions.get(session)?.unaccountedAllocation) {
    return { kind: 'fail', evidence: 'tools/call denied: ambiguous MCP session identity' };
  }
  if (profile.applicability.mcp_tools_call.state !== 'REQUIRED'
    || !selectEligibleTool([tool], profile.read_only_tool_allowlist)) {
    return { kind: 'fail', evidence: 'tools/call denied: the profile does not approve this read-only zero-input tool' };
  }
  if (profile.protocol_revision !== '2026-07-28') {
    const state = sessions.get(session);
    if (!state?.initialized || state.origin !== origin || state.version !== profile.protocol_revision || state.cleanup) {
      return { kind: 'fail', evidence: 'tools/call denied: no matching initialized legacy MCP session' };
    }
  }
  const response = await post(fetchImpl, origin, profile.protocol_revision, 'tools/call', requestId, {
    name: tool.name,
    arguments: {},
  }, tool.name, trace, session);
  const parsed = responseResult(response, `tools/call ${tool.name}`);
  if (parsed.kind !== 'ok') return parsed;
  if (profile.endpoint_class === 'mcp-2026-07-28' && parsed.result.resultType !== 'complete') {
    return { kind: 'fail', evidence: `tools/call ${tool.name}: no complete result` };
  }
  if (parsed.result.isError === true) {
    return { kind: 'fail', evidence: `tools/call ${tool.name}: result.isError=true` };
  }
  return { kind: 'ok', evidence: `tools/call ${tool.name}: real HTTP 200 result, isError=${String(parsed.result.isError)}`, result: parsed.result };
}
