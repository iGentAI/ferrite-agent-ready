#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APPLICABILITY, VERDICT, exitCodeForVerdict, finding, summarize, validateProfile } from './evidence.mjs';
import { callEligibleTool, closeMcpSession, inspectMcpSurface, selectEligibleTool } from './mcp-client.mjs';
import { assertSanitizedArtifact, redactCaptureValue } from './catalog-capture.mjs';
import { canonicalJson } from './mcp-wire.mjs';

export const SCENARIO_INVENTORY = Object.freeze(['mcp_discovery', 'mcp_tools_list', 'mcp_tools_call']);

function mappedFinding(id, result) {
  if (result.kind === 'ok') return finding(id, VERDICT.PASS, result.evidence);
  if (result.kind === 'infra') return finding(id, VERDICT.INFRA, result.evidence);
  return finding(id, VERDICT.FAIL, result.evidence);
}

export async function runStrictServedSurface(origin, rawProfile, { fetchImpl = fetch } = {}) {
  const profile = validateProfile(rawProfile);
  const endpoint = new URL(origin);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/'
    || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)))) {
    throw new TypeError('served-surface origin must be a credential-free HTTPS origin or loopback HTTP fixture');
  }
  const rows = [];
  const trace = [];
  const observed = await inspectMcpSurface(origin, profile, fetchImpl, trace);
  rows.push(mappedFinding('mcp_discovery', observed.discovery));
  if (!observed.list) {
    rows.push(finding('mcp_tools_list', VERDICT.UNVERIFIED, 'tools/list was not attempted because discovery did not complete'));
  } else {
    rows.push(mappedFinding('mcp_tools_list', observed.list));
  }

  const declaration = profile.applicability.mcp_tools_call;
  if (!Array.isArray(observed.tools)) {
    rows.push(declaration.state === APPLICABILITY.NA
      ? finding('mcp_tools_call', VERDICT.NA, declaration.reason, APPLICABILITY.NA, { predeclared: true })
      : finding('mcp_tools_call', VERDICT.UNVERIFIED, 'a real tools/call could not be selected because tools/list evidence is missing'));
  } else {
    const eligible = selectEligibleTool(observed.tools, profile.read_only_tool_allowlist);
    if (declaration.state === APPLICABILITY.NA) {
      rows.push(eligible
        ? finding('mcp_tools_call', VERDICT.FAIL, `predeclared N/A is stale: eligible read-only zero-input tool '${eligible.name}' is advertised`, APPLICABILITY.NA, { predeclared: true })
        : finding('mcp_tools_call', VERDICT.NA, declaration.reason, APPLICABILITY.NA, { predeclared: true }));
    } else if (!eligible) {
      rows.push(finding('mcp_tools_call', VERDICT.UNVERIFIED,
        observed.tools.length === 0
          ? 'tools/list returned zero tools; required real tools/call did not execute'
          : `${observed.tools.length} tool(s) advertised, but no profile-allowlisted read-only zero-input tool is eligible`));
    } else {
      rows.push(mappedFinding('mcp_tools_call', await callEligibleTool(origin, profile, eligible, fetchImpl, observed.next_request_id, trace, observed.transport_session)));
    }
  }

  const cleanup = await closeMcpSession(observed.transport_session, fetchImpl, trace);
  const summary = summarize(rows);
  // Catalog copies, profile fields and findings are as untrusted as the wire
  // trace. Redact the complete retained value, not only one projection of it.
  const sanitized = redactCaptureValue({
    schema_version: 'served-surface-report.v1',
    generated_at: new Date().toISOString(),
    origin,
    profile: {
      id: profile.id,
      endpoint_class: profile.endpoint_class,
      protocol_revision: profile.protocol_revision,
      read_only_tool_allowlist: [...profile.read_only_tool_allowlist],
      max_tool_pages: profile.max_tool_pages,
    },
    catalog_inventory: observed.catalog_inventory ?? { complete: false, pages: [], tool_names: [], catalog_response_sha256: null },
    expected_scenario_inventory: [...SCENARIO_INVENTORY],
    observed_scenario_inventory: rows.map((row) => row.id),
    findings: rows,
    trace,
    cleanup,
    summary,
  });
  const report = sanitized.value;
  const credentialEvents = sanitized.events.filter((event) => /credential|sensitive/.test(event.reason));
  // Credential-bearing evidence is a veto, not extra weighted protocol points.
  // Opaque cursor redaction is expected privacy and does not imply a leak.
  report.summary.vetoes = credentialEvents.length ? ['credential_bearing_evidence'] : [];
  if (credentialEvents.length) report.summary.verdict = VERDICT.FAIL;
  if (cleanup.state !== 'complete') {
    report.summary.vetoes.push('session_cleanup_incomplete');
    if (report.summary.verdict !== VERDICT.FAIL) report.summary.verdict = cleanup.verdict;
  }
  report.trace_sha256 = createHash('sha256').update(canonicalJson(report.trace)).digest('hex');
  report.redaction_events = sanitized.events;
  report.security_evidence = { artifact_scan: { verdict: credentialEvents.length ? VERDICT.FAIL : VERDICT.PASS, credential_redactions: credentialEvents.length } };
  report.claim_ceiling = report.summary.verdict === VERDICT.PASS
      ? 'strict served-surface conformance for this endpoint and profile'
      : 'no served-surface correctness claim';
  assertSanitizedArtifact(report);
  return report;
}

/**
 * Refuse a write target that is not a canonical absolute path, that crosses a
 * symlink anywhere along it (dangling ones included), or whose existing
 * prefix lies inside a Git repository (a `.git` or a bare `HEAD`+`objects`).
 * Returns the path to use, unchanged.
 */
export function assertCanonicalExternalPath(path, { outside = [] } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError('path must be canonical and absolute (no `..`, `.` or repeated separators)');
  }
  let existing = null;
  for (let current = path; ; current = dirname(current)) {
    let stat = null;
    try { stat = lstatSync(current); } catch { stat = null; }
    if (stat?.isSymbolicLink()) throw new TypeError('path crosses a symlink; use a canonical external path');
    if (stat && existing === null) existing = current;
    if (current === dirname(current)) break;
  }
  const real = realpathSync(existing);
  if (real !== existing) throw new TypeError('path crosses a symlink; use a canonical external path');
  for (let current = real; ; current = dirname(current)) {
    if (existsSync(join(current, '.git')) || (existsSync(join(current, 'HEAD')) && existsSync(join(current, 'objects')))) {
      throw new TypeError('path must be outside every repository');
    }
    if (current === dirname(current)) break;
  }
  for (const root of outside) {
    const rel = relative(realpathSync(root), real);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw new TypeError('path must be outside the repository');
  }
  return path;
}

/** Immutable reports are external; never replace an original or retain in Git. */
export function writeServedSurfaceReport(path, report) {
  // The writer is a separate retention boundary; callers cannot bypass the
  // scanner by constructing their own report object or adding a later field.
  assertSanitizedArtifact(report);
  if (!isAbsolute(path)) throw new TypeError('report path must be absolute and external to repositories');
  // Checked on the very path that is created and opened, component by
  // component: a lexical resolve would collapse `link/..` that the kernel
  // follows.
  assertCanonicalExternalPath(path);
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > 64 * 1024 * 1024) throw new TypeError('report exceeds the retention budget');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(descriptor, encoded);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}

function usage() {
  console.error('usage: served-surface.mjs scan <origin> --profile FILE [--out FILE]');
  process.exit(2);
}

async function main() {
  const [command, origin, ...args] = process.argv.slice(2);
  if (command !== 'scan' || !origin) usage();
  let profilePath = null;
  let outPath = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--profile') profilePath = args[++i];
    else if (args[i] === '--out') outPath = args[++i];
    else usage();
  }
  if (!profilePath) usage();
  let profile;
  try {
    profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  } catch (error) {
    console.error(`cannot load served-surface profile ${profilePath}: ${error.message}`);
    process.exit(2);
  }
  let report;
  try {
    report = await runStrictServedSurface(origin, profile);
  } catch (error) {
    console.error(`invalid served-surface profile: ${error.message}`);
    process.exit(2);
  }
  if (outPath) {
    try {
      writeServedSurfaceReport(outPath, report);
    } catch (error) {
      console.error(`cannot retain served-surface report ${outPath}: ${error.message}`);
      process.exit(2);
    }
  }
  console.log(`${report.summary.verdict} ${report.profile.id}: ${report.summary.counts.PASS} PASS, ${report.summary.counts.FAIL} FAIL, ${report.summary.counts.UNVERIFIED} UNVERIFIED, ${report.summary.counts['N/A']} N/A, ${report.summary.counts.INFRA} INFRA`);
  for (const row of report.findings) console.log(`  ${row.verdict.padEnd(10)} ${row.id}: ${row.evidence}`);
  process.exit(exitCodeForVerdict(report.summary.verdict));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
