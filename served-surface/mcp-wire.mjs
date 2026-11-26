// Shared, bounded wire primitives. Transport authority remains with the caller;
// the catalog instrument separately restricts methods to discovery and lists.

export class McpWireError extends Error {
  constructor(code, verdict = 'FAIL') {
    super(code);
    this.name = 'McpWireError';
    this.code = code;
    this.verdict = verdict;
  }
}

export function assertUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new McpWireError('INVALID_UNICODE');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new McpWireError('INVALID_UNICODE');
  }
}

// RFC 8785/JCS uses UTF-16 key ordering and ECMAScript number serialization.
// Building strings directly avoids JSON.stringify's numeric-key enumeration.
export function canonicalJson(value, depth = 0) {
  if (depth > 128) throw new McpWireError('JSON_DEPTH_BUDGET');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    assertUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new McpWireError('NONFINITE_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  if (typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new McpWireError('NON_JSON_VALUE');
  }
  return `{${Object.keys(value).sort().map((key) => {
    assertUnicode(key);
    return `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`;
  }).join(',')}}`;
}

// JSON.parse silently accepts duplicate properties, lone surrogates, and lossy
// integer tokens. A receipt must not collapse those ambiguities into one digest.
export function parseStrictJson(text) {
  if (typeof text !== 'string') throw new McpWireError('INVALID_JSON');
  let index = 0;
  const whitespace = () => { while (/[\t\n\r ]/.test(text[index] ?? '\0')) index += 1; };
  const string = () => {
    const start = index++;
    while (index < text.length) {
      const character = text[index++];
      if (character === '\\') { index += 1; continue; }
      if (character === '"') {
        let value;
        try { value = JSON.parse(text.slice(start, index)); }
        catch { throw new McpWireError('INVALID_JSON_STRING'); }
        assertUnicode(value);
        return value;
      }
    }
    throw new McpWireError('INVALID_JSON_STRING');
  };
  const value = (depth = 0) => {
    if (depth > 128) throw new McpWireError('JSON_DEPTH_BUDGET');
    whitespace();
    if (text[index] === '"') return string();
    if (text[index] === '{') {
      index += 1;
      whitespace();
      const object = Object.create(null);
      const keys = new Set();
      if (text[index] === '}') { index += 1; return object; }
      for (;;) {
        whitespace();
        if (text[index] !== '"') throw new McpWireError('INVALID_JSON_OBJECT');
        const key = string();
        if (keys.has(key)) throw new McpWireError('DUPLICATE_JSON_KEY');
        keys.add(key);
        whitespace();
        if (text[index++] !== ':') throw new McpWireError('INVALID_JSON_OBJECT');
        object[key] = value(depth + 1);
        whitespace();
        const next = text[index++];
        if (next === '}') return object;
        if (next !== ',') throw new McpWireError('INVALID_JSON_OBJECT');
      }
    }
    if (text[index] === '[') {
      index += 1;
      whitespace();
      const array = [];
      if (text[index] === ']') { index += 1; return array; }
      for (;;) {
        array.push(value(depth + 1));
        whitespace();
        const next = text[index++];
        if (next === ']') return array;
        if (next !== ',') throw new McpWireError('INVALID_JSON_ARRAY');
      }
    }
    for (const [token, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(token, index)) { index += token.length; return parsed; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
    if (!match) throw new McpWireError('INVALID_JSON_VALUE');
    const token = match[0];
    index += token.length;
    const number = Number(token);
    if (!Number.isFinite(number)) throw new McpWireError('NONFINITE_NUMBER');
    if (/^-?[0-9]+$/.test(token) && BigInt(token) !== BigInt(number)) {
      throw new McpWireError('LOSSY_INTEGER_TOKEN');
    }
    return number;
  };
  const parsed = value();
  whitespace();
  if (index !== text.length) throw new McpWireError('INVALID_JSON_TRAILING_DATA');
  return parsed;
}

export function jsonPointer(value, path) {
  for (const escaped of path.split('/').slice(1)) {
    const key = escaped.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

export function sessionlessParams(protocolRevision, client, params = {}) {
  return {
    ...params,
    _meta: {
      ...(params._meta ?? {}),
      'io.modelcontextprotocol/protocolVersion': protocolRevision,
      'io.modelcontextprotocol/clientInfo': client,
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  };
}

export function encodeMcpHeader(value) {
  const text = String(value);
  assertUnicode(text);
  if (/^[\x20-\x7e]*$/.test(text) && text.trim() === text && !(text.startsWith('=?base64?') && text.endsWith('?='))) return text;
  return `=?base64?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

export async function readBoundedResponse(response, maxBytes = 8 * 1024 * 1024) {
  if (!response.body?.getReader) throw new McpWireError('RESPONSE_STREAM_UNAVAILABLE', 'INFRA');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new McpWireError('RESPONSE_BYTE_BUDGET');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof McpWireError) throw error;
    throw new McpWireError('RESPONSE_STREAM_INTERRUPTED', 'INFRA');
  } finally { reader.releaseLock(); }
  const body = Buffer.concat(chunks);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(body); }
  catch { throw new McpWireError('INVALID_RESPONSE_UTF8'); }
}

export function parseRpcBody(text, contentType, expectedId) {
  let messages;
  const mediaType = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (mediaType === 'application/json') messages = [parseStrictJson(text)];
  else if (mediaType === 'text/event-stream') {
    // A sessionless stream belongs to this request only. Never reconnect it or
    // use an SSE event ID as evidence that a JSON-RPC result executed.
    const frames = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n\n');
    if (frames.length > 4096) throw new McpWireError('SSE_FRAME_BUDGET');
    messages = frames.flatMap((frame) => {
      const lines = frame.split('\n');
      const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, ''));
      return data.length === 0 ? [] : [parseStrictJson(data.join('\n'))];
    });
  } else throw new McpWireError('UNSUPPORTED_RESPONSE_CONTENT_TYPE');
  const results = [];
  for (const message of messages) {
    if (message?.jsonrpc !== '2.0') throw new McpWireError('INVALID_JSONRPC_VERSION');
    if (message.method !== undefined) {
      if (message.id !== undefined || typeof message.method !== 'string' || !message.method.startsWith('notifications/')) {
        throw new McpWireError('SESSIONLESS_SERVER_REQUEST');
      }
      continue;
    }
    if (message.id !== expectedId) throw new McpWireError('JSONRPC_ID_MISMATCH');
    if (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) throw new McpWireError('AMBIGUOUS_JSONRPC_RESULT');
    results.push(message);
  }
  if (results.length !== 1) throw new McpWireError('MISSING_OR_DUPLICATE_JSONRPC_RESULT');
  return { body: results[0], messages };
}
