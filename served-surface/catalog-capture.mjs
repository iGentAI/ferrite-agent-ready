// A catalog receipt is contract evidence, never a semantic, security, or live
// readiness result. This instrument has no tools/call or mutation capability.

import { createHash } from 'node:crypto';
import { constants, existsSync, fstatSync, mkdirSync, openSync, closeSync, fsyncSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpWireError, canonicalJson, jsonPointer, parseStrictJson, parseRpcBody, readBoundedResponse, sessionlessParams } from './mcp-wire.mjs';

export { canonicalJson, parseStrictJson } from './mcp-wire.mjs';
export const CANONICALIZATION_VERSION = 'mcp-canonical-json-v2';
export const CAPTURE_PROFILE_VERSION = 'mcp.catalog-capture-profile.v1';
export const CAPTURE_VERSION = 'mcp.catalog-capture.v1';
export const CLIENT = Object.freeze({ name: 'ferrite-catalog-capture', version: '1.0.0' });
export const PROTOCOL_REVISION = '2026-07-28';
export const READ_ONLY_METHODS = Object.freeze([
  'server/discover', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list',
]);

const REPOSITORY_ROOT = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const HEX = /^[a-f0-9]{64}$/;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SAFE_LABEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const SCHEMA_ARRAYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_SINGLE = new Set(['items', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema']);
const SENSITIVE_KEY = /(?:^|_)(?:authorization|password|passwd|access_token|refresh_token|api_key|api_token|client_secret|private_key|cookie|set_cookie|secret|credential)$/;
const SECRET_PATTERN = /(?:\bBearer\s+[a-zA-Z0-9._~+\/-]{8,}=*|\bsk-(?:proj-)?[a-zA-Z0-9_-]{12,}|\b(?:ghp|github_pat)_[a-zA-Z0-9_]{16,}|\bAKIA[A-Z0-9]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,})/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const utf8Order = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const pointerEscape = (key) => String(key).replaceAll('~', '~0').replaceAll('/', '~1');
const sensitiveKey = (key) => SENSITIVE_KEY.test(String(key).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replaceAll('-', '_'));
const safeMarker = (value) => typeof value === 'string' && /^\[REDACTED:sha256:[a-f0-9]{16}\]$/.test(value);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const jsonDigest = (value) => sha256(canonicalJson(value));
const fail = (code, verdict = 'FAIL') => { throw new McpWireError(code, verdict); };

function exactKeys(value, allowed, code) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(code);
}

function identity(value) {
  exactKeys(value, ['subject_class', 'scopes', 'account_class'], 'INVALID_AUTHORIZATION_IDENTITY');
  if (!SAFE_LABEL.test(value.subject_class ?? '') || !SAFE_LABEL.test(value.account_class ?? '')
    || !Array.isArray(value.scopes) || value.scopes.some((scope) => !SAFE_LABEL.test(scope))
    || new Set(value.scopes).size !== value.scopes.length) fail('INVALID_AUTHORIZATION_IDENTITY');
  if ([value.subject_class, value.account_class, ...value.scopes].some((part) => SECRET_PATTERN.test(part))) fail('SECRET_BEARING_AUTHORIZATION_IDENTITY');
  return { subject_class: value.subject_class, scopes: [...value.scopes].sort(utf8Order), account_class: value.account_class };
}

export function validateCaptureProfile(input) {
  exactKeys(input, ['schema_version', 'id', 'protocol_revision', 'endpoint_class', 'endpoint_uri', 'authorization', 'authorization_evidence', 'max_pages_per_method', 'max_response_bytes', 'max_capture_bytes', 'timeout_ms'], 'INVALID_CAPTURE_PROFILE');
  if (input.schema_version !== CAPTURE_PROFILE_VERSION || !SAFE_LABEL.test(input.id ?? '')) fail('INVALID_CAPTURE_PROFILE_VERSION_OR_ID');
  if (input.protocol_revision !== PROTOCOL_REVISION) fail('UNSUPPORTED_CAPTURE_PROTOCOL');
  if (!['fixture', 'public_read_only', 'isolated_live'].includes(input.endpoint_class)) fail('INVALID_CAPTURE_ENDPOINT_CLASS');
  let uri;
  try { uri = new URL(input.endpoint_uri); } catch { fail('INVALID_CAPTURE_ENDPOINT'); }
  if (uri.username || uri.password || uri.search || uri.hash || SECRET_PATTERN.test(input.endpoint_uri)) fail('SECRET_OR_AMBIGUITY_IN_ENDPOINT');
  if (input.endpoint_class === 'fixture') {
    if (uri.protocol !== 'fixture:') fail('FIXTURE_REQUIRES_NON_NETWORK_URI');
  } else if (uri.protocol !== 'https:' && !(uri.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(uri.hostname))) {
    fail('UNSAFE_CAPTURE_ENDPOINT');
  }
  if (uri.href !== input.endpoint_uri) fail('NONCANONICAL_CAPTURE_ENDPOINT');
  const authorization = identity(input.authorization);
  exactKeys(input.authorization_evidence, ['mode', 'response_pointer'], 'INVALID_AUTHORIZATION_EVIDENCE');
  const auth = input.authorization_evidence;
  if (auth.mode === 'anonymous_request') {
    if (auth.response_pointer !== undefined || authorization.subject_class !== 'anonymous' || authorization.account_class !== 'public' || authorization.scopes.length) {
      fail('AMBIGUOUS_ANONYMOUS_IDENTITY');
    }
  } else if (auth.mode === 'response_identity') {
    if (typeof auth.response_pointer !== 'string' || !auth.response_pointer.startsWith('/result/_meta/')
      || /~(?![01])/.test(auth.response_pointer) || SECRET_PATTERN.test(auth.response_pointer)) fail('INVALID_AUTHORIZATION_POINTER');
  } else fail('MISSING_AUTHORIZATION_EVIDENCE', 'UNVERIFIED');
  const bounded = (value, fallback, maximum) => {
    const actual = value ?? fallback;
    if (!Number.isSafeInteger(actual) || actual < 1 || actual > maximum) fail('INVALID_CAPTURE_BUDGET');
    return actual;
  };
  return {
    ...input,
    authorization,
    max_pages_per_method: bounded(input.max_pages_per_method, 64, 256),
    max_response_bytes: bounded(input.max_response_bytes, 8 * 1024 * 1024, 32 * 1024 * 1024),
    max_capture_bytes: bounded(input.max_capture_bytes, 64 * 1024 * 1024, 256 * 1024 * 1024),
    timeout_ms: bounded(input.timeout_ms, 15000, 60000),
  };
}

export function redactCaptureValue(value, { secrets = [], prefix = '' } = {}) {
  const events = [];
  const secret = (text) => SECRET_PATTERN.test(text) || secrets.some((candidate) => candidate.length >= 8 && text.includes(candidate));
  const redact = (original, path, reason) => {
    const digest = jsonDigest(original);
    events.push({ json_pointer: path, reason, original_sha256: digest });
    return `[REDACTED:sha256:${digest.slice(0, 16)}]`;
  };
  const visit = (node, path, key, schema = false, schemaSensitive = false, schemaMap = false) => {
    if (typeof node === 'string' && safeMarker(node)) return node;
    if (typeof node === 'string' && secret(node)) return redact(node, path, 'credential-shaped or exact credential value');
    if (!schema && ['cursor', 'nextCursor'].includes(key) && node !== null) return redact(node, path, 'opaque pagination cursor');
    if (!schema && sensitiveKey(key) && node !== null && !object(node)) return redact(node, path, 'sensitive field name');
    if (schemaSensitive && ['default', 'examples', 'example', 'enum', 'const'].includes(key) && node !== null) {
      if (Array.isArray(node) && ['examples', 'enum'].includes(key)) return node.map((item, index) => redact(item, `${path}/${index}`, 'credential-bearing schema literal'));
      return redact(node, path, 'credential-bearing schema literal');
    }
    if (Array.isArray(node)) return node.map((item, index) => visit(item, `${path}/${index}`, '', schema, schemaSensitive));
    if (!object(node)) return node;
    const output = Object.create(null);
    for (const [childKey, child] of Object.entries(node)) {
      if (secret(childKey)) fail('SECRET_BEARING_PROPERTY_NAME');
      const childPath = `${path}/${pointerEscape(childKey)}`;
      const rootSchema = ['inputSchema', 'outputSchema', 'input_schema', 'output_schema', 'structured_content_schema'].includes(childKey);
      const childSchema = rootSchema || schema;
      const childSensitive = schemaSensitive || (schemaMap && sensitiveKey(childKey));
      output[childKey] = visit(child, childPath, childKey, childSchema, childSensitive, schema && SCHEMA_MAPS.has(childKey));
    }
    return output;
  };
  return { value: visit(value, prefix, ''), events };
}

export function extractHeaderConstraints(inputSchema) {
  const found = [];
  const names = new Set();
  const walk = (schema, path, instancePath, reachable, required) => {
    if (typeof schema === 'boolean') return;
    if (!object(schema)) fail('INVALID_SCHEMA_NODE');
    if (Object.hasOwn(schema, 'x-mcp-header')) {
      const suffix = schema['x-mcp-header'];
      if (!reachable || !instancePath.length || Object.hasOwn(schema, '$ref') || Object.hasOwn(schema, '$dynamicRef')) fail('HEADER_NOT_STATICALLY_REACHABLE');
      if (typeof suffix !== 'string' || !TOKEN.test(suffix)) fail('INVALID_HEADER_NAME');
      const name = `Mcp-Param-${suffix}`;
      if (names.has(name.toLowerCase())) fail('DUPLICATE_HEADER_NAME');
      names.add(name.toLowerCase());
      if (!['string', 'integer', 'boolean'].includes(schema.type)) fail('INVALID_HEADER_VALUE_TYPE');
      const sensitive = instancePath.some(sensitiveKey) || schema.writeOnly === true || schema.format === 'password' || schema['x-sensitive'] === true;
      if (sensitive) fail('SENSITIVE_PARAMETER_IN_HEADER');
      let minimum = null;
      let maximum = null;
      if (schema.type === 'integer') {
        minimum = schema.minimum ?? -Number.MAX_SAFE_INTEGER;
        maximum = schema.maximum ?? Number.MAX_SAFE_INTEGER;
        if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum) fail('UNSAFE_HEADER_INTEGER_RANGE');
        const literals = [schema.default, schema.const, ...(Array.isArray(schema.enum) ? schema.enum : [])].filter((item) => item !== undefined);
        if (literals.some((item) => !Number.isSafeInteger(item) || item < minimum || item > maximum)) fail('INVALID_HEADER_INTEGER_LITERAL');
      }
      if (schema.pattern !== undefined && typeof schema.pattern !== 'string') fail('INVALID_HEADER_PATTERN');
      found.push({ name, value_type: schema.type, required, sensitive: false, minimum, maximum, pattern: schema.pattern ?? null, body_field: `/params/arguments/${instancePath.map(pointerEscape).join('/')}` });
    }
    for (const [key, child] of Object.entries(schema)) {
      if (SCHEMA_MAPS.has(key)) {
        if (!object(child)) fail('INVALID_SCHEMA_MAP');
        for (const [property, subschema] of Object.entries(child)) {
          const throughProperty = key === 'properties';
          walk(subschema, `${path}/${pointerEscape(key)}/${pointerEscape(property)}`, throughProperty ? [...instancePath, property] : instancePath,
            reachable && throughProperty, required && throughProperty && Array.isArray(schema.required) && schema.required.includes(property));
        }
      } else if (SCHEMA_ARRAYS.has(key)) {
        if (!Array.isArray(child)) fail('INVALID_SCHEMA_ARRAY');
        child.forEach((subschema, index) => walk(subschema, `${path}/${key}/${index}`, instancePath, false, false));
      } else if (SCHEMA_SINGLE.has(key)) {
        if (Array.isArray(child)) child.forEach((subschema, index) => walk(subschema, `${path}/${key}/${index}`, instancePath, false, false));
        else walk(child, `${path}/${key}`, instancePath, false, false);
      } else if (key === 'dependencies') {
        if (!object(child)) fail('INVALID_SCHEMA_MAP');
        for (const [property, subschema] of Object.entries(child)) if (!Array.isArray(subschema)) walk(subschema, `${path}/${key}/${pointerEscape(property)}`, instancePath, false, false);
      }
    }
  };
  walk(inputSchema, '', [], true, true);
  return found.sort((left, right) => utf8Order(left.name.toLowerCase(), right.name.toLowerCase()));
}

function standardHeaders() {
  return [
    ['MCP-Protocol-Version', `/params/_meta/${pointerEscape('io.modelcontextprotocol/protocolVersion')}`],
    ['Mcp-Method', '/method'],
    ['Mcp-Name', '/params/name'],
  ].map(([name, body_field]) => ({ name, value_type: 'string', required: true, sensitive: false, minimum: null, maximum: null, pattern: null, body_field }));
}

function toolContract(tool) {
  if (!object(tool) || typeof tool.name !== 'string' || !tool.name.trim() || tool.name.length > 512 || /[\r\n\0]/.test(tool.name)) fail('INVALID_TOOL_NAME');
  if (tool.description !== undefined && typeof tool.description !== 'string') fail('INVALID_TOOL_DESCRIPTION');
  if (!(object(tool.inputSchema) || typeof tool.inputSchema === 'boolean')) fail('MISSING_INPUT_SCHEMA');
  if (tool.outputSchema !== undefined && !(object(tool.outputSchema) || typeof tool.outputSchema === 'boolean')) fail('INVALID_OUTPUT_SCHEMA');
  if (tool.annotations !== undefined && !object(tool.annotations)) fail('INVALID_TOOL_ANNOTATIONS');
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema,
    output_schema: tool.outputSchema ?? null,
    annotations: tool.annotations ?? {},
    structured_content_schema: tool.outputSchema ?? null,
    // The protocol permits content envelopes; an individual tool has not
    // promised any particular envelope merely by appearing in tools/list.
    content_envelopes: [],
    header_constraints: [...standardHeaders(), ...extractHeaderConstraints(tool.inputSchema)],
  };
}

function normalizedTools(tools) {
  return tools.map((tool) => ({
    ...tool,
    content_envelopes: [...new Set(tool.content_envelopes ?? [])].sort(utf8Order),
    header_constraints: [...(tool.header_constraints ?? [])].sort((left, right) => utf8Order(left.name.toLowerCase(), right.name.toLowerCase())),
  })).sort((left, right) => utf8Order(left.name, right.name));
}

export function catalogDigest(snapshot) {
  if (snapshot.schema_version !== 'mcp.catalog-snapshot.v1' || snapshot.canonicalization_version !== CANONICALIZATION_VERSION) fail('UNSUPPORTED_CATALOG_VERSION');
  const endpoint = {
    ...snapshot.endpoint,
    authorization: { ...snapshot.endpoint.authorization, scopes: [...new Set(snapshot.endpoint.authorization.scopes)].sort(utf8Order) },
  };
  return jsonDigest({
    schema_version: snapshot.schema_version,
    protocol_revision: snapshot.protocol_revision,
    endpoint,
    instructions: snapshot.instructions,
    capabilities: snapshot.capabilities,
    tools: normalizedTools(snapshot.tools),
    canonicalization_version: snapshot.canonicalization_version,
  });
}

function observeCache(result) {
  if (!Number.isSafeInteger(result.ttlMs) || result.ttlMs < 0 || !['public', 'private'].includes(result.cacheScope)) fail('MISSING_OR_INVALID_CACHE_IDENTITY', 'UNVERIFIED');
  return { scope: result.cacheScope, ttl_ms: result.ttlMs, varies_by_authorization: result.cacheScope === 'private' };
}

function verifyAuthorization(profile, body, credential) {
  if (profile.authorization_evidence.mode === 'anonymous_request') {
    if (credential) fail('CREDENTIAL_IN_ANONYMOUS_CAPTURE');
    return profile.authorization;
  }
  if (!credential && profile.endpoint_class !== 'fixture') fail('REQUIRED_CREDENTIAL_UNAVAILABLE', 'UNVERIFIED');
  const observed = jsonPointer(body, profile.authorization_evidence.response_pointer);
  if (observed === undefined) fail('AUTHORIZATION_IDENTITY_NOT_OBSERVED', 'UNVERIFIED');
  if (canonicalJson(identity(observed)) !== canonicalJson(profile.authorization)) fail('AUTHORIZATION_IDENTITY_CHANGED');
  return profile.authorization;
}

export function fixtureTransport(fixture) {
  if (fixture.schema_version !== 'mcp.catalog-transport-fixture.v1' || !Array.isArray(fixture.responses)) fail('INVALID_TRANSPORT_FIXTURE');
  let next = 0;
  const requests = [];
  return {
    requests,
    async request(uri, options) {
      const expected = fixture.responses[next++];
      const request = parseStrictJson(options.body);
      requests.push(request);
      if (!expected) fail('FIXTURE_RESPONSE_MISSING', 'INFRA');
      if (uri !== fixture.profile.endpoint_uri || request.method !== expected.method || request.id !== expected.id
        || (request.params.cursor ?? null) !== (expected.request_cursor ?? null)) fail('FIXTURE_REQUEST_MISMATCH');
      const body = expected.raw_body ?? canonicalJson(expected.body);
      return new Response(body, { status: expected.status ?? 200, headers: expected.headers ?? { 'content-type': 'application/json' } });
    },
    assertExhausted() { if (next !== fixture.responses.length) fail('FIXTURE_UNUSED_RESPONSES'); },
  };
}

function validateDiscoveryResult(result) {
  if (!Array.isArray(result.supportedVersions) || !result.supportedVersions.includes(PROTOCOL_REVISION)
    || result.supportedVersions.some((version) => typeof version !== 'string')
    || new Set(result.supportedVersions).size !== result.supportedVersions.length) fail('DISCOVERY_PROTOCOL_MISMATCH');
  if (result.protocolVersion !== undefined && result.protocolVersion !== PROTOCOL_REVISION) fail('DISCOVERY_PROTOCOL_CONTRADICTION');
  if (result.nextCursor !== undefined) fail('DISCOVERY_UNEXPECTED_PAGINATION');
  if (!object(result.capabilities) || !object(result.capabilities.tools)) fail('TOOLS_CAPABILITY_NOT_OBSERVED', 'UNVERIFIED');
  const server = result._meta?.['io.modelcontextprotocol/serverInfo'];
  if (!object(server) || typeof server.name !== 'string' || !server.name || typeof server.version !== 'string' || !server.version) fail('SERVER_IDENTITY_NOT_OBSERVED', 'UNVERIFIED');
  if (result.instructions !== undefined && typeof result.instructions !== 'string') fail('INVALID_SERVER_INSTRUCTIONS');
  const lists = [{ method: 'tools/list', field: 'tools', identity: 'name' }];
  if (Object.hasOwn(result.capabilities, 'resources')) {
    if (!object(result.capabilities.resources)) fail('INVALID_RESOURCE_CAPABILITY');
    lists.push({ method: 'resources/list', field: 'resources', identity: 'uri' }, { method: 'resources/templates/list', field: 'resourceTemplates', identity: 'uriTemplate' });
  }
  if (Object.hasOwn(result.capabilities, 'prompts')) {
    if (!object(result.capabilities.prompts)) fail('INVALID_PROMPT_CAPABILITY');
    lists.push({ method: 'prompts/list', field: 'prompts', identity: 'name' });
  }
  return lists;
}

async function collectCatalogLists({ lists, profile, request, capture, onPhase }) {
  const collectedTools = [];
  let toolsCache;
  for (const list of lists) {
    const names = new Set();
    const cursors = new Set();
    let cursor;
    let scope;
    let complete = false;
    for (let index = 0; index < profile.max_pages_per_method; index += 1) {
      const observed = await request(list.method, index, cursor);
      onPhase('catalog-page');
      if (!Array.isArray(observed.result[list.field])) fail('CATALOG_LIST_MISSING');
      if (scope !== undefined && scope !== observed.page.cache.scope) fail('CACHE_SCOPE_CHANGED_ACROSS_PAGES');
      scope = observed.page.cache.scope;
      for (const item of observed.result[list.field]) {
        if (!object(item) || typeof item[list.identity] !== 'string' || !item[list.identity]) fail('CATALOG_ITEM_IDENTITY_MISSING');
        if (names.has(item[list.identity])) fail('DUPLICATE_CATALOG_ITEM');
        names.add(item[list.identity]);
      }
      if (list.method === 'tools/list') {
        // Validate raw schemas before redaction can obscure an invalid header
        // or credential literal; retain only sanitized contract values.
        observed.result.tools.forEach(toolContract);
        collectedTools.push(...observed.sanitizedResult.tools.map(toolContract));
        toolsCache = { ...observed.page.cache, ttl_ms: Math.min(toolsCache?.ttl_ms ?? Infinity, observed.page.cache.ttl_ms) };
      }
      const nextCursor = observed.result.nextCursor;
      if (nextCursor === undefined) { complete = true; break; }
      if (cursors.has(nextCursor)) fail('CATALOG_CURSOR_LOOP');
      cursors.add(nextCursor);
      cursor = nextCursor;
    }
    if (!complete) fail('CATALOG_PAGE_BUDGET');
    capture.completed_methods.push(list.method);
    capture.list_applicability.find((item) => item.method === list.method).verdict = 'PASS';
  }
  return { collectedTools, toolsCache };
}

export async function captureCatalog(inputProfile, { transport = null, fetchImpl = fetch, allowNetwork = false, credential = null, now = () => new Date().toISOString() } = {}) {
  const capture = {
    schema_version: CAPTURE_VERSION,
    client: CLIENT,
    source: 'unadmitted',
    verdict: 'UNVERIFIED',
    claim_ceiling: 'no-catalog-evidence',
    catalog_captured: false,
    pages_complete: false,
    profile_sha256: null,
    declared_methods: ['server/discover', 'tools/list'],
    completed_methods: [],
    pages: [],
    request_attempts: [],
    redaction_log: [],
    gaps: [],
    blocker: null,
    snapshot: null,
    live_readiness: 'UNVERIFIED',
    authentication_security: 'UNVERIFIED',
  };
  let phase = 'admission';
  let method = null;
  let pageIndex = null;
  try {
    const profile = validateCaptureProfile(inputProfile);
    capture.source = profile.endpoint_class === 'fixture' ? 'fixture' : 'live-read-only';
    capture.profile = profile;
    capture.profile_sha256 = jsonDigest(profile);
    capture.captured_at_utc = now();
    if (Number.isNaN(Date.parse(capture.captured_at_utc))) fail('INVALID_CAPTURE_TIME');
    if (profile.endpoint_class === 'fixture') {
      if (!transport || allowNetwork || credential) fail('FIXTURE_TRANSPORT_AUTHORITY_MISMATCH');
    } else {
      if (!allowNetwork || transport) fail('LIVE_CAPTURE_NOT_AUTHORIZED', 'UNVERIFIED');
      if (credential) validateCredential(credential, profile.endpoint_uri);
      if (profile.authorization_evidence.mode === 'response_identity' && !credential) fail('REQUIRED_CREDENTIAL_UNAVAILABLE', 'UNVERIFIED');
      if (profile.authorization_evidence.mode === 'anonymous_request' && credential) fail('CREDENTIAL_IN_ANONYMOUS_CAPTURE');
    }
    const secrets = credential ? [credential.authorization, credential.authorization.slice(7)] : [];
    const redactions = capture.redaction_log;
    let requestId = 0;
    let totalBytes = 0;
    const requestHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_REVISION };
    if (credential) requestHeaders.authorization = credential.authorization;
    const sanitizedHeaders = redactCaptureValue(requestHeaders, { secrets, prefix: '/request_headers' });
    redactions.push(...sanitizedHeaders.events);
    const request = async (requestMethod, index, cursor) => {
      phase = 'request'; method = requestMethod; pageIndex = index;
      if (!READ_ONLY_METHODS.includes(method)) fail('MUTATING_METHOD_DENIED');
      const id = ++requestId;
      const body = { jsonrpc: '2.0', id, method, params: sessionlessParams(PROTOCOL_REVISION, CLIENT, cursor === undefined ? {} : { cursor }) };
      const headers = { ...requestHeaders, 'mcp-method': method };
      const started = Date.now();
      capture.request_attempts.push({ method, page_index: index, request_id: id, started_at_utc: now(), response_received: false });
      let response;
      try {
        response = await (transport ? transport.request(profile.endpoint_uri, { body: canonicalJson(body), headers, method: 'POST', redirect: 'error' })
          : fetchImpl(profile.endpoint_uri, { body: canonicalJson(body), headers, method: 'POST', redirect: 'error', signal: AbortSignal.timeout(profile.timeout_ms) }));
      } catch (error) {
        if (error instanceof McpWireError) throw error;
        fail('CATALOG_TRANSPORT_UNAVAILABLE', 'INFRA');
      }
      const page = {
        method, page_index: index, request_id: id, executed: true,
        http_status: response.status, elapsed_ms: null,
        request_cursor_digest: cursor === undefined ? null : jsonDigest(cursor),
        response_cursor_digest: null, response_sha256: null, redacted_response_sha256: null,
        cache: null, authorization: null, verdict: 'UNVERIFIED',
      };
      capture.request_attempts.at(-1).response_received = true;
      capture.pages.push(page);
      const prefix = `/pages/${capture.pages.length - 1}`;
      const sanitizedRequest = redactCaptureValue({ headers, body }, { secrets, prefix: `${prefix}/request` });
      page.request = sanitizedRequest.value;
      redactions.push(...sanitizedRequest.events);
      phase = 'response';
      const raw = await readBoundedResponse(response, profile.max_response_bytes);
      page.response_sha256 = sha256(raw);
      page.response_bytes = Buffer.byteLength(raw);
      totalBytes += page.response_bytes;
      if (totalBytes > profile.max_capture_bytes) fail('CAPTURE_BYTE_BUDGET');
      page.elapsed_ms = Math.max(0, Date.now() - started);
      const responseHeaders = Object.fromEntries(response.headers.entries());
      const sanitizedResponseHeaders = redactCaptureValue(responseHeaders, { secrets, prefix: `${prefix}/response_headers` });
      page.response_headers = sanitizedResponseHeaders.value;
      redactions.push(...sanitizedResponseHeaders.events);
      const parsed = parseRpcBody(raw, response.headers.get('content-type'), id);
      const sanitized = redactCaptureValue(parsed.body, { secrets, prefix: `${prefix}/response` });
      page.response = sanitized.value;
      page.redacted_response_sha256 = jsonDigest(sanitized.value);
      redactions.push(...sanitized.events);
      if (parsed.messages.length > 1) {
        const messages = redactCaptureValue(parsed.messages, { secrets, prefix: `${prefix}/stream_messages` });
        page.stream_messages = messages.value;
        redactions.push(...messages.events);
      }
      if (response.headers.has('mcp-session-id')) fail('SESSIONFUL_RESPONSE');
      if (response.headers.has('mcp-protocol-version') && response.headers.get('mcp-protocol-version') !== PROTOCOL_REVISION) fail('RESPONSE_PROTOCOL_MISMATCH');
      if ([401, 403].includes(response.status)) fail('CATALOG_AUTHORIZATION_UNAVAILABLE', 'UNVERIFIED');
      if (response.status >= 500 || response.status === 429) fail('CATALOG_SERVER_UNAVAILABLE', 'INFRA');
      if (response.status !== 200) fail('CATALOG_HTTP_FAILURE');
      if (parsed.body.error) fail('CATALOG_JSONRPC_ERROR');
      const result = parsed.body.result;
      if (!object(result) || result.resultType !== 'complete') fail('CATALOG_RESULT_NOT_COMPLETE');
      if (Object.hasOwn(result, 'requestState') || Object.hasOwn(result, 'inputRequests')) fail('CATALOG_INTERIM_RESULT');
      page.cache = observeCache(result);
      page.authorization = verifyAuthorization(profile, parsed.body, credential);
      if (result.nextCursor !== undefined) {
        if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 8192) fail('INVALID_CATALOG_CURSOR');
        page.response_cursor_digest = jsonDigest(result.nextCursor);
      }
      page.verdict = 'PASS';
      return { result, sanitizedResult: sanitized.value.result, page };
    };
    const discovery = await request('server/discover', 0);
    phase = 'discovery';
    const lists = validateDiscoveryResult(discovery.result);
    capture.completed_methods.push('server/discover');
    capture.declared_methods = ['server/discover', ...lists.map((list) => list.method)];
    capture.list_applicability = ['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list'].map((listMethod) => ({
      method: listMethod,
      verdict: lists.some((list) => list.method === listMethod) ? 'UNVERIFIED' : 'N/A',
      reason: lists.some((list) => list.method === listMethod) ? 'Advertised capability requires complete execution.' : 'Capability absent from the observed discovery contract before list execution.',
      predeclared_before_list_execution: true,
    }));
    const { collectedTools, toolsCache } = await collectCatalogLists({
      lists,
      profile,
      request,
      capture,
      onPhase: (next) => { phase = next; },
    });
    phase = 'finalize'; method = null; pageIndex = null;
    transport?.assertExhausted();
    if (!collectedTools.length) fail('ZERO_TOOL_CATALOG', 'UNVERIFIED');
    const snapshot = {
      schema_version: 'mcp.catalog-snapshot.v1',
      protocol_revision: PROTOCOL_REVISION,
      endpoint: { endpoint_class: profile.endpoint_class, canonical_uri: profile.endpoint_uri, authorization: profile.authorization, cache: toolsCache },
      instructions: discovery.sanitizedResult.instructions ?? null,
      capabilities: discovery.sanitizedResult.capabilities,
      tools: normalizedTools(collectedTools),
      canonicalization_version: CANONICALIZATION_VERSION,
      canonical_digest: '',
      receipt: {
        captured_at_utc: capture.captured_at_utc,
        command: ['catalog-capture', capture.source, `profile-sha256:${capture.profile_sha256}`],
        client_name: CLIENT.name, client_version: CLIENT.version,
        request_headers: sanitizedHeaders.value,
        pages: capture.pages.map((page) => ({
          method: page.method, page_index: page.page_index,
          request_cursor_digest: page.request_cursor_digest, response_cursor_digest: page.response_cursor_digest,
          response_sha256: page.response_sha256, redacted_response_sha256: page.redacted_response_sha256,
        })),
        redaction_log: redactions,
      },
    };
    snapshot.canonical_digest = catalogDigest(snapshot);
    for (const tool of snapshot.tools) {
      if (tool.output_schema === null) capture.gaps.push({ tool_name: tool.name, code: 'OUTPUT_CONTRACT_ABSENT' });
      if (!tool.description) capture.gaps.push({ tool_name: tool.name, code: 'TOOL_DESCRIPTION_ABSENT' });
      if (!tool.content_envelopes.length) capture.gaps.push({ tool_name: tool.name, code: 'TOOL_CONTENT_ENVELOPES_UNDECLARED' });
    }
    for (const event of redactions) if (/\/(?:inputSchema|outputSchema)\//.test(event.json_pointer)) capture.gaps.push({ code: 'REDACTED_CONTRACT_LITERAL', json_pointer: event.json_pointer });
    capture.snapshot = snapshot;
    capture.pages_complete = true;
    capture.catalog_captured = true;
    capture.verdict = 'PASS';
    capture.claim_ceiling = capture.source === 'fixture' ? 'fixture-only' : 'catalog-contract-only';
  } catch (error) {
    capture.verdict = error instanceof McpWireError ? error.verdict : 'INFRA';
    capture.blocker = { code: error instanceof McpWireError ? error.code : 'CATALOG_INTERNAL_ERROR', verdict: capture.verdict, phase, method, page_index: pageIndex };
    const failedPage = capture.pages.findLast((page) => page.method === method && page.page_index === pageIndex);
    if (failedPage) failedPage.verdict = capture.verdict;
    capture.snapshot = null;
    capture.catalog_captured = false;
    capture.pages_complete = false;
  }
  return capture;
}

export function validateCatalogSnapshot(snapshot) {
  exactKeys(snapshot, ['schema_version', 'protocol_revision', 'endpoint', 'instructions', 'capabilities', 'tools', 'canonicalization_version', 'canonical_digest', 'receipt'], 'INVALID_CATALOG_SHAPE');
  if (snapshot.protocol_revision !== PROTOCOL_REVISION || !HEX.test(snapshot.canonical_digest ?? '') || snapshot.canonical_digest !== catalogDigest(snapshot)) fail('CATALOG_DIGEST_OR_PROTOCOL_MISMATCH');
  if (!Array.isArray(snapshot.tools) || !snapshot.tools.length) fail('ZERO_TOOL_CATALOG', 'UNVERIFIED');
  identity(snapshot.endpoint.authorization);
  const cache = snapshot.endpoint.cache;
  if (!object(cache) || typeof cache.scope !== 'string' || !cache.scope || !Number.isSafeInteger(cache.ttl_ms) || cache.ttl_ms < 0 || typeof cache.varies_by_authorization !== 'boolean') fail('INVALID_SNAPSHOT_CACHE_IDENTITY');
  const names = new Set();
  for (const tool of snapshot.tools) {
    if (typeof tool.name !== 'string' || !tool.name || names.has(tool.name)) fail('DUPLICATE_OR_MISSING_SNAPSHOT_TOOL');
    names.add(tool.name);
    extractHeaderConstraints(tool.input_schema);
    const headers = new Set();
    for (const header of tool.header_constraints) {
      if (!TOKEN.test(header.name) || headers.has(header.name.toLowerCase())) fail('INVALID_OR_DUPLICATE_SNAPSHOT_HEADER');
      headers.add(header.name.toLowerCase());
    }
  }
  const groups = new Map();
  if (!Array.isArray(snapshot.receipt?.pages)) fail('CATALOG_PAGE_RECEIPTS_MISSING', 'UNVERIFIED');
  for (const page of snapshot.receipt.pages) {
    if (!READ_ONLY_METHODS.includes(page.method) || !Number.isSafeInteger(page.page_index) || page.page_index < 0
      || !HEX.test(page.response_sha256) || !HEX.test(page.redacted_response_sha256)
      || [page.request_cursor_digest, page.response_cursor_digest].some((digest) => digest !== null && !HEX.test(digest))) fail('INVALID_CATALOG_PAGE_RECEIPT');
    if (!groups.has(page.method)) groups.set(page.method, []);
    groups.get(page.method).push(page);
  }
  if (!groups.has('server/discover') || !groups.has('tools/list')) fail('CATALOG_REQUIRED_PAGES_MISSING', 'UNVERIFIED');
  for (const [method, pages] of groups) {
    if (method === 'server/discover' && pages.length !== 1) fail('DUPLICATE_DISCOVERY_RECEIPT');
    const cursors = new Set();
    for (const [index, page] of pages.entries()) {
      if (page.page_index !== index || page.request_cursor_digest !== (index ? pages[index - 1].response_cursor_digest : null)) fail('CATALOG_PAGE_CHAIN_INVALID');
      if (index && page.request_cursor_digest === null) fail('CATALOG_PAGE_CHAIN_INVALID');
      if (page.response_cursor_digest !== null) {
        if (cursors.has(page.response_cursor_digest)) fail('CATALOG_CURSOR_LOOP');
        cursors.add(page.response_cursor_digest);
      }
    }
    if (pages.at(-1).response_cursor_digest !== null) fail('CATALOG_PAGE_CHAIN_INCOMPLETE', 'UNVERIFIED');
  }
  if (Object.hasOwn(snapshot.capabilities, 'resources') && (!groups.has('resources/list') || !groups.has('resources/templates/list'))) fail('CATALOG_ADVERTISED_PAGES_MISSING', 'UNVERIFIED');
  if (Object.hasOwn(snapshot.capabilities, 'prompts') && !groups.has('prompts/list')) fail('CATALOG_ADVERTISED_PAGES_MISSING', 'UNVERIFIED');
  return snapshot;
}

function changeClass(path, before, after) {
  if (/\/tools\/[^/]+$/.test(path)) return before === undefined ? 'additive' : after === undefined ? 'breaking' : 'behavioral-risk';
  if (path.includes('/input_schema/')) {
    if (path.endsWith('/required') && Array.isArray(before) && Array.isArray(after)) {
      return after.some((value) => !before.includes(value)) ? 'constraining' : 'additive';
    }
    if (path.endsWith('/enum') && Array.isArray(before) && Array.isArray(after)) {
      return before.some((value) => !after.some((candidate) => canonicalJson(candidate) === canonicalJson(value))) ? 'constraining' : 'additive';
    }
    if (/\/(?:minimum|exclusiveMinimum|minLength|minItems|minProperties)$/.test(path) && typeof before === 'number' && typeof after === 'number') return after > before ? 'constraining' : 'additive';
    if (/\/(?:maximum|exclusiveMaximum|maxLength|maxItems|maxProperties)$/.test(path) && typeof before === 'number' && typeof after === 'number') return after < before ? 'constraining' : 'additive';
    if (before === undefined && !path.includes('/properties/')) return 'constraining';
    if (after === undefined && !path.includes('/properties/')) return 'additive';
    if (before === undefined && /\/properties\/[^/]+$/.test(path)) return 'additive';
    if (after === undefined && /\/properties\/[^/]+$/.test(path)) return 'breaking';
  }
  if (path.endsWith('/output_schema') && after === null) return 'breaking';
  if (path.startsWith('/endpoint/') || path === '/protocol_revision' || path === '/canonicalization_version') return 'breaking';
  return 'behavioral-risk';
}

export function diffCatalogs(beforeInput, afterInput, { impactRegistry = null } = {}) {
  // A capture receipt is verified whole: its supplemental pages are read below and the
  // snapshot alone hashes only the tools.
  for (const input of [beforeInput, afterInput]) {
    if (input?.schema_version === CAPTURE_VERSION || Object.hasOwn(input ?? {}, 'snapshot')) verifyCaptureReceipt(input);
  }
  const before = validateCatalogSnapshot(beforeInput.snapshot ?? beforeInput);
  const after = validateCatalogSnapshot(afterInput.snapshot ?? afterInput);
  if (impactRegistry !== null) {
    exactKeys(impactRegistry, ['schema_version', 'catalog_digest', 'entries'], 'INVALID_IMPACT_REGISTRY');
    if (impactRegistry.schema_version !== 'mcp.catalog-impact-registry.v1' || impactRegistry.catalog_digest !== before.canonical_digest || !Array.isArray(impactRegistry.entries)) fail('IMPACT_REGISTRY_IDENTITY_MISMATCH');
    for (const entry of impactRegistry.entries) {
      exactKeys(entry, ['tool_name', 'json_pointer_prefix', 'obligation_ids', 'gold_scenario_ids'], 'INVALID_IMPACT_ENTRY');
      if (typeof entry.tool_name !== 'string' || typeof entry.json_pointer_prefix !== 'string' || !entry.json_pointer_prefix.startsWith('/')
        || !Array.isArray(entry.obligation_ids) || !Array.isArray(entry.gold_scenario_ids)
        || [...entry.obligation_ids, ...entry.gold_scenario_ids].some((id) => !SAFE_LABEL.test(id) || SECRET_PATTERN.test(id))) fail('INVALID_IMPACT_ENTRY');
    }
  }
  const changes = [];
  const visit = (left, right, path, toolName = null) => {
    if (left !== undefined && right !== undefined && canonicalJson(left) === canonicalJson(right)) return;
    if (object(left) && object(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) visit(left[key], right[key], `${path}/${pointerEscape(key)}`, toolName);
      return;
    }
    const matched = (impactRegistry?.entries ?? []).filter((entry) => (toolName === null || entry.tool_name === toolName)
      && (path === entry.json_pointer_prefix || path.startsWith(`${entry.json_pointer_prefix}/`) || entry.json_pointer_prefix.startsWith(`${path}/`)));
    changes.push({
      json_pointer: path,
      tool_name: toolName,
      classification: changeClass(path, left, right),
      before_sha256: left === undefined ? null : jsonDigest(left),
      after_sha256: right === undefined ? null : jsonDigest(right),
      obligation_ids: [...new Set(matched.flatMap((entry) => entry.obligation_ids))].sort(utf8Order),
      gold_scenario_ids: [...new Set(matched.flatMap((entry) => entry.gold_scenario_ids))].sort(utf8Order),
      impact_evidence: matched.length ? 'PASS' : 'UNVERIFIED',
    });
  };
  for (const field of ['protocol_revision', 'canonicalization_version', 'endpoint', 'instructions', 'capabilities']) visit(before[field], after[field], `/${field}`);
  const oldTools = new Map(before.tools.map((tool) => [tool.name, tool]));
  const newTools = new Map(after.tools.map((tool) => [tool.name, tool]));
  for (const name of [...new Set([...oldTools.keys(), ...newTools.keys()])].sort(utf8Order)) visit(oldTools.get(name), newTools.get(name), `/tools/${pointerEscape(name)}`, name);
  const supplemental = (capture) => Object.fromEntries(READ_ONLY_METHODS.filter((method) => !['server/discover', 'tools/list'].includes(method)).map((method) => [method,
    (capture.pages ?? []).filter((page) => page.method === method).flatMap((page) => Object.values(page.response?.result ?? {}).filter(Array.isArray).flat()).sort((left, right) => utf8Order(canonicalJson(left), canonicalJson(right))),
  ]));
  if (beforeInput.schema_version === CAPTURE_VERSION && afterInput.schema_version === CAPTURE_VERSION) visit(supplemental(beforeInput), supplemental(afterInput), '/supplemental_lists');
  const identityMatched = canonicalJson(before.endpoint) === canonicalJson(after.endpoint) && before.protocol_revision === after.protocol_revision;
  return {
    schema_version: 'mcp.catalog-diff.v1',
    before_catalog_digest: before.canonical_digest,
    after_catalog_digest: after.canonical_digest,
    verdict: changes.length === 0 ? 'PASS' : 'UNVERIFIED',
    changed: changes.length > 0,
    identity_comparison: identityMatched ? 'PASS' : 'UNVERIFIED',
    claim_ceiling: 'catalog-drift-only',
    changes,
    unassigned_changes: changes.filter((change) => change.impact_evidence === 'UNVERIFIED').map((change) => change.json_pointer),
    invalidated_obligation_ids: [...new Set(changes.flatMap((change) => change.obligation_ids))].sort(utf8Order),
    invalidated_gold_scenario_ids: [...new Set(changes.flatMap((change) => change.gold_scenario_ids))].sort(utf8Order),
  };
}

function validateCredential(document, endpointUri) {
  exactKeys(document, ['schema_version', 'endpoint_uri', 'authorization'], 'INVALID_CREDENTIAL_DOCUMENT');
  if (document.schema_version !== 'mcp.catalog-credential.v1' || document.endpoint_uri !== endpointUri) fail('CREDENTIAL_ENDPOINT_MISMATCH');
  if (typeof document.authorization !== 'string' || document.authorization.length > 32768 || !/^Bearer [A-Za-z0-9._~+\/-]{8,}=*$/.test(document.authorization)) fail('INVALID_CREDENTIAL_VALUE');
  return document;
}

export function readCredentialFile(file, endpointUri) {
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || (process.getuid && metadata.uid !== process.getuid()) || metadata.size > 65536) fail('CREDENTIAL_FILE_NOT_OWNER_ONLY');
    return validateCredential(parseStrictJson(readFileSync(descriptor, 'utf8')), endpointUri);
  } catch (error) {
    if (error instanceof McpWireError) throw error;
    fail('CREDENTIAL_FILE_UNAVAILABLE', 'UNVERIFIED');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export async function readCredentialStdin(stream, endpointUri) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += Buffer.byteLength(chunk);
    if (length > 65536) fail('CREDENTIAL_STDIN_BUDGET');
    chunks.push(Buffer.from(chunk));
  }
  return validateCredential(parseStrictJson(Buffer.concat(chunks).toString('utf8')), endpointUri);
}

export function assertSanitizedArtifact(value) {
  const visit = (node, key = '', schema = false) => {
    if (typeof node === 'string' && (SECRET_PATTERN.test(node) || (!schema && sensitiveKey(key) && !safeMarker(node)))) fail('SECRET_BEARING_RETAINED_ARTIFACT');
    if (Array.isArray(node)) node.forEach((child) => visit(child, '', schema));
    else if (object(node)) for (const [childKey, child] of Object.entries(node)) {
      if (SECRET_PATTERN.test(childKey)) fail('SECRET_BEARING_RETAINED_ARTIFACT');
      visit(child, childKey, schema || ['inputSchema', 'outputSchema', 'input_schema', 'output_schema', 'structured_content_schema'].includes(childKey));
    }
  };
  visit(value);
  canonicalJson(value);
}

function externalDirectory(path) {
  if (!isAbsolute(path)) fail('EVIDENCE_PATH_MUST_BE_ABSOLUTE');
  const parent = realpathSync(dirname(path));
  const directory = resolve(parent, relative(dirname(path), path));
  if (directory === parent || directory === REPOSITORY_ROOT || !relative(REPOSITORY_ROOT, directory).startsWith('..')) fail('EVIDENCE_MUST_BE_EXTERNAL');
  for (let current = parent; current !== dirname(current); current = dirname(current)) if (existsSync(join(current, '.git'))) fail('EVIDENCE_INSIDE_A_REPOSITORY');
  // mkdir is exclusive. Existing evidence and even an empty prior directory are
  // never reused, so a retry cannot overwrite a failed capture's original.
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}

function immutableWrite(directory, name, value) {
  assertSanitizedArtifact(value);
  const text = `${canonicalJson(value)}\n`;
  const path = join(directory, name);
  const descriptor = openSync(path, 'wx', 0o600);
  try { writeFileSync(descriptor, text); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  return { path: name, sha256: sha256(text) };
}

export function writeCaptureArtifacts(outputDirectory, capture) {
  assertSanitizedArtifact(capture);
  if (capture.snapshot) verifyCaptureReceipt(capture);
  const directory = externalDirectory(outputDirectory);
  const artifacts = [];
  if (capture.profile) artifacts.push(immutableWrite(directory, 'capture-profile.json', capture.profile));
  if (capture.snapshot) artifacts.push(immutableWrite(directory, 'catalog-snapshot.json', capture.snapshot));
  for (const [index, page] of capture.pages.entries()) artifacts.push(immutableWrite(directory, `page-${String(index + 1).padStart(4, '0')}.json`, page));
  const receipt = immutableWrite(directory, 'capture-receipt.json', { ...capture, artifacts });
  return { verdict: capture.verdict, claim_ceiling: capture.claim_ceiling, directory, receipt: join(directory, receipt.path), catalog_snapshot: capture.snapshot ? join(directory, 'catalog-snapshot.json') : null, artifacts, receipt_sha256: receipt.sha256 };
}

export function writeCatalogDiff(outputDirectory, diff) {
  assertSanitizedArtifact(diff);
  const directory = externalDirectory(outputDirectory);
  const receipt = immutableWrite(directory, 'catalog-diff.json', diff);
  return { verdict: diff.verdict, claim_ceiling: diff.claim_ceiling, directory, receipt: join(directory, receipt.path), receipt_sha256: receipt.sha256 };
}

export function verifyCaptureReceipt(receipt) {
  if (receipt.schema_version !== CAPTURE_VERSION || receipt.verdict !== 'PASS' || !receipt.catalog_captured || !receipt.pages_complete) fail('CAPTURE_NOT_COMPLETE', 'UNVERIFIED');
  validateCatalogSnapshot(receipt.snapshot);
  const profile = validateCaptureProfile(receipt.profile);
  if (receipt.profile_sha256 !== jsonDigest(profile)) fail('CAPTURE_PROFILE_IDENTITY_MISMATCH');
  if (!Array.isArray(receipt.pages) || receipt.pages.length !== receipt.snapshot.receipt.pages.length || receipt.request_attempts.length !== receipt.pages.length) fail('CAPTURE_RECEIPT_DENOMINATOR_MISMATCH');
  for (const [index, page] of receipt.pages.entries()) {
    const catalogPage = receipt.snapshot.receipt.pages[index];
    if (!page.executed || page.verdict !== 'PASS' || !receipt.request_attempts[index]?.response_received || page.request_id !== receipt.request_attempts[index]?.request_id
      || page.method !== receipt.request_attempts[index].method || page.page_index !== receipt.request_attempts[index].page_index
      || page.redacted_response_sha256 !== jsonDigest(page.response)) fail('CAPTURE_PAGE_EVIDENCE_MISMATCH');
    for (const key of Object.keys(catalogPage)) if (canonicalJson(catalogPage[key]) !== canonicalJson(page[key])) fail('CAPTURE_PAGE_BINDING_MISMATCH');
    if (page.request.body.id !== page.request_id || page.request.body.method !== page.method || page.response.id !== page.request_id
      || page.request.headers['mcp-method'] !== page.method || page.request.headers['mcp-protocol-version'] !== PROTOCOL_REVISION
      || page.request.body.params._meta['io.modelcontextprotocol/protocolVersion'] !== PROTOCOL_REVISION) fail('CAPTURE_REQUEST_IDENTITY_MISMATCH');
    if (page.response.result.resultType !== 'complete' || canonicalJson(observeCache(page.response.result)) !== canonicalJson(page.cache)
      || canonicalJson(page.authorization) !== canonicalJson(profile.authorization)) fail('CAPTURE_OBSERVED_IDENTITY_MISMATCH');
    for (const [digest, value] of [[page.request_cursor_digest, page.request.body.params.cursor], [page.response_cursor_digest, page.response.result.nextCursor]]) {
      if (digest === null ? value !== undefined : value !== `[REDACTED:sha256:${digest.slice(0, 16)}]`) fail('CAPTURE_CURSOR_BINDING_MISMATCH');
    }
  }
  if (canonicalJson(receipt.declared_methods) !== canonicalJson(receipt.completed_methods)) fail('CAPTURE_METHOD_NONEXECUTION');
  const discovery = receipt.pages.find((page) => page.method === 'server/discover').response.result;
  if (!discovery.supportedVersions?.includes(PROTOCOL_REVISION)
    || canonicalJson(discovery.capabilities) !== canonicalJson(receipt.snapshot.capabilities)
    || canonicalJson(discovery.instructions ?? null) !== canonicalJson(receipt.snapshot.instructions)) fail('CAPTURE_DISCOVERY_BINDING_MISMATCH');
  const toolPages = receipt.pages.filter((page) => page.method === 'tools/list');
  const reconstructedTools = normalizedTools(toolPages.flatMap((page) => page.response.result.tools.map(toolContract)));
  if (canonicalJson(reconstructedTools) !== canonicalJson(receipt.snapshot.tools)) fail('CAPTURE_TOOL_CONTRACT_BINDING_MISMATCH');
  const toolCache = { ...toolPages[0].cache, ttl_ms: Math.min(...toolPages.map((page) => page.cache.ttl_ms)) };
  const endpoint = { endpoint_class: profile.endpoint_class, canonical_uri: profile.endpoint_uri, authorization: profile.authorization, cache: toolCache };
  if (canonicalJson(endpoint) !== canonicalJson(receipt.snapshot.endpoint)) fail('CAPTURE_ENDPOINT_BINDING_MISMATCH');
  assertSanitizedArtifact(receipt);
  return receipt;
}
