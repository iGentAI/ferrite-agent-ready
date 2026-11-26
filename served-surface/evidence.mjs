export const VERDICT = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  UNVERIFIED: 'UNVERIFIED',
  NA: 'N/A',
  INFRA: 'INFRA',
});

export const APPLICABILITY = Object.freeze({
  REQUIRED: 'REQUIRED',
  NA: 'N/A',
});

export const LIFECYCLE = Object.freeze({
  PLANNED: 'planned',
  STARTED: 'started',
  COMPLETED: 'completed',
  EXPORTED: 'exported',
  GRADED: 'graded',
});

const VALID_ENDPOINT_CLASSES = new Set(['mcp-2025-06-18', 'mcp-2025-11-25', 'mcp-2026-07-28']);

export function validateProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new TypeError('served-surface profile must be an object');
  }
  if (profile.schema_version !== 'served-surface-profile.v1') {
    throw new TypeError('served-surface profile schema_version must be served-surface-profile.v1');
  }
  if (typeof profile.id !== 'string' || !profile.id.trim()) {
    throw new TypeError('served-surface profile id must be a non-empty string');
  }
  if (!VALID_ENDPOINT_CLASSES.has(profile.endpoint_class)) {
    throw new TypeError(`unsupported endpoint_class ${String(profile.endpoint_class)}`);
  }
  if (typeof profile.protocol_revision !== 'string' || !profile.protocol_revision.trim()) {
    throw new TypeError('served-surface profile protocol_revision must be a non-empty string');
  }
  const endpointRevision = profile.endpoint_class.slice('mcp-'.length);
  if (profile.protocol_revision !== endpointRevision) {
    throw new TypeError(`protocol_revision ${profile.protocol_revision} does not match endpoint_class ${profile.endpoint_class}`);
  }
  if (!Array.isArray(profile.read_only_tool_allowlist)
    || profile.read_only_tool_allowlist.some((name) => typeof name !== 'string' || !name.trim() || name.length > 512 || /[\x00-\x1f]/.test(name))
    || new Set(profile.read_only_tool_allowlist).size !== profile.read_only_tool_allowlist.length) {
    throw new TypeError('read_only_tool_allowlist must explicitly declare unique approved tool names; annotations do not authorize calls');
  }
  if (profile.max_tool_pages !== undefined
    && (!Number.isSafeInteger(profile.max_tool_pages) || profile.max_tool_pages < 1 || profile.max_tool_pages > 128)) {
    throw new TypeError('max_tool_pages must be an integer from 1 through 128');
  }
  const declared = profile.applicability?.mcp_tools_call;
  if (!declared || !Object.values(APPLICABILITY).includes(declared.state)) {
    throw new TypeError('applicability.mcp_tools_call.state must be REQUIRED or N/A');
  }
  if (declared.state === APPLICABILITY.NA && (typeof declared.reason !== 'string' || !declared.reason.trim())) {
    throw new TypeError('a predeclared N/A tools/call lane requires a non-empty reason');
  }
  if (declared.state === APPLICABILITY.REQUIRED && declared.reason !== undefined) {
    throw new TypeError('a REQUIRED tools/call lane must not carry an N/A reason');
  }
  return { ...profile, max_tool_pages: profile.max_tool_pages ?? 32 };
}

export function finding(id, verdict, evidence, applicability = APPLICABILITY.REQUIRED, extra = {}) {
  if (!Object.values(VERDICT).includes(verdict)) throw new TypeError(`unknown verdict ${verdict}`);
  if (!Object.values(APPLICABILITY).includes(applicability)) throw new TypeError(`unknown applicability ${applicability}`);
  return {
    id,
    applicability,
    lifecycle: LIFECYCLE.GRADED,
    verdict,
    evidence: String(evidence),
    ...extra,
  };
}

export function summarize(findings) {
  const counts = Object.fromEntries(Object.values(VERDICT).map((v) => [v, 0]));
  for (const row of findings) counts[row.verdict] += 1;
  let verdict = VERDICT.PASS;
  if (counts[VERDICT.FAIL] > 0) verdict = VERDICT.FAIL;
  else if (counts[VERDICT.INFRA] > 0) verdict = VERDICT.INFRA;
  else if (counts[VERDICT.UNVERIFIED] > 0) verdict = VERDICT.UNVERIFIED;
  else if (counts[VERDICT.PASS] === 0) verdict = VERDICT.NA;
  return {
    verdict,
    counts,
    pass_denominator: counts[VERDICT.PASS] + counts[VERDICT.FAIL],
    required_nonpassing: findings
      .filter((row) => row.applicability === APPLICABILITY.REQUIRED && row.verdict !== VERDICT.PASS)
      .map((row) => row.id),
  };
}

export function exitCodeForVerdict(verdict) {
  if (verdict === VERDICT.PASS || verdict === VERDICT.NA) return 0;
  if (verdict === VERDICT.FAIL) return 1;
  return 2;
}
