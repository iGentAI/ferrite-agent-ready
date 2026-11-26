#!/usr/bin/env node
// agent-conformance — scenario conformance for the agent-ready HTTP surfaces,
// shaped like an MCP conformance lane (run + baseline + report).
//
// WHY SEQUENTIAL
//
// Scenarios driven concurrently against one serving front can produce verdicts
// that move under load, so scenarios here run one at a time for reproducible,
// quotable evidence, matching the single-threaded fixture bench (`agent-ready-bench`).
//
// WHY A TWO-WAY BASELINE
//
// The baseline is enforced in BOTH directions, the official runner's exit
// rules exactly:
//
//   fails + listed    -> expected failure, tolerated
//   fails + unlisted  -> a REGRESSION, exit 1
//   passes + listed   -> a STALE entry, exit 1
//
// So an entry cannot quietly outlive its reason: the day a scenario starts
// passing, every scan fails until somebody deletes the line. 'info' checks
// never participate — there is no failure to excuse — so a baseline entry
// naming one is reported as stale.
//
// Usage:
//   node agent-conformance/agent-conformance.mjs scan <origin> --name <label> \
//     [--baseline agent-conformance/baseline.yml] [--out DIR] [--priced] [--x402-key KEY]
//
// Exit codes:
//   0  clean — every failure baselined, no stale entries
//   1  regression or stale baseline entry
//   2  the evidence is missing (unreachable origin, absent/unreadable baseline)
//      — kept distinct from 1 because "the evidence says we failed" and "there
//      is no evidence" must never be confused by a caller.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCENARIOS, TIER_ORDER, runScenarios } from './scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Parse the baseline file (`<name>:` sections holding `- scenario-id` or
 * `- scenario-id:check-id` entries, with `#` comments). Returns `{ sections, problems }`;
 * a malformed line is reported as a problem rather than skipped.
 */
export function parseBaseline(text) {
  const sections = new Map();
  const problems = [];
  let current = null;
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/\r$/, '').replace(/#.*$/, '').trimEnd();
    if (!stripped.trim()) continue;
    const head = /^([A-Za-z0-9._-]+):\s*$/.exec(stripped);
    if (head) {
      current = head[1];
      if (!sections.has(current)) sections.set(current, new Set());
      continue;
    }
    const item = /^\s+-\s+(\S+)\s*$/.exec(stripped);
    if (item && current) {
      sections.get(current).add(item[1]);
      continue;
    }
    problems.push(`line ${i + 1}: not a \`name:\` section or \`- entry\` item: ${stripped.trim()}`);
  }
  return { sections, problems };
}

/**
 * Compare a run's failing checks against the expected-failure entries, both ways.
 * `results` is `runScenarios()` output; `expected` is a Set of bare scenario ids
 * or `scenario:check` keys.
 */
export function enforceBaseline(results, expected) {
  const failures = [];
  for (const s of results) {
    for (const c of s.checks) {
      if (c.status === 'fail') failures.push({ scenario: s.id, check: c.id });
    }
  }
  const regressions = failures
    .filter((f) => !expected.has(f.scenario) && !expected.has(`${f.scenario}:${f.check}`))
    .map((f) => `${f.scenario}:${f.check}`)
    .sort();
  // An entry is stale when nothing this run failed under it — including an
  // entry naming a check that has gone 'info': info is never baselined.
  const used = (entry) => (entry.includes(':')
    ? failures.some((f) => `${f.scenario}:${f.check}` === entry)
    : failures.some((f) => f.scenario === entry));
  const stale = [...expected].filter((e) => !used(e)).sort();
  return {
    ok: regressions.length === 0 && stale.length === 0,
    regressions,
    stale,
    failures: failures.map((f) => `${f.scenario}:${f.check}`),
  };
}

function tally(scenarios) {
  const t = { pass: 0, fail: 0, info: 0, checks: 0 };
  for (const s of scenarios) {
    for (const c of s.checks) {
      t.checks += 1;
      t[c.status] += 1;
    }
  }
  return t;
}

/**
 * The markdown scorecard: tier-grouped so a docs site's dormant PAYABLE tier
 * reads as inapplicable rather than as alarm, followed by the baseline verdict.
 */
export function renderMarkdown(report) {
  const t = tally(report.scenarios);
  const lines = [];
  lines.push(`# Agent conformance — ${report.name}`);
  lines.push('');
  lines.push(`Origin: ${report.origin} — generated ${report.generated_at}`);
  lines.push('');
  lines.push(`**${t.fail === 0 ? 'No failing checks' : `${t.fail} failing check(s)`}** — ${t.pass} pass / ${t.fail} fail / ${t.info} info across ${report.scenarios.length} scenario(s), ${t.checks} check(s).`);
  for (const tier of TIER_ORDER) {
    const rows = report.scenarios.filter((s) => s.tier === tier);
    if (rows.length === 0) continue;
    const tt = tally(rows);
    lines.push('');
    lines.push(`## ${tier} — ${rows.length} scenario(s): ${tt.pass} pass, ${tt.fail} fail, ${tt.info} info`);
    lines.push('');
    lines.push('| Scenario | Check | Status | Evidence |');
    lines.push('| --- | --- | --- | --- |');
    for (const s of rows) {
      for (const c of s.checks) {
        lines.push(`| ${s.id} | ${c.id} | ${c.status.toUpperCase()} | ${String(c.evidence).replace(/\|/g, '\\|')} |`);
      }
    }
  }
  lines.push('');
  lines.push('## Baseline verdict');
  lines.push('');
  const b = report.baseline;
  if (b.regressions.length === 0 && b.stale.length === 0) {
    lines.push(`Baseline agrees: ${b.expected.length} expected failure(s), none unaccounted for.`);
  } else {
    for (const e of b.regressions) lines.push(`- REGRESSION \`${e}\` — failing, and no baseline entry expects it.`);
    for (const e of b.stale) lines.push(`- STALE \`${e}\` — in the baseline, but nothing failed under it; either it passes now (delete the line) or it went info (info is never baselined).`);
  }
  lines.push('');
  return lines.join('\n');
}

function usage(code = 2) {
  console.error('usage: agent-conformance.mjs scan <origin> --name <label> [--baseline FILE] [--out DIR] [--priced] [--x402-key KEY] [--mcp-profile FILE]');
  process.exit(code);
}

async function main() {
  const [cmd, origin, ...rest] = process.argv.slice(2);
  if (cmd !== 'scan' || !origin) usage();
  const opts = { name: null, out: null, baseline: join(HERE, 'baseline.yml'), priced: false, x402Key: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--name') opts.name = rest[++i];
    else if (rest[i] === '--baseline') opts.baseline = rest[++i];
    else if (rest[i] === '--out') opts.out = rest[++i];
    else if (rest[i] === '--priced') opts.priced = true;
    else if (rest[i] === '--x402-key') opts.x402Key = rest[++i];
    else if (rest[i] === '--mcp-profile') opts.mcpProfile = JSON.parse(readFileSync(rest[++i], 'utf8'));
    else usage();
  }
  if (!opts.name) usage();

  // Load the baseline before anything runs so no exit-1 path can be reached
  // while "expected" has no definition.
  if (!existsSync(opts.baseline)) {
    console.error(`cannot verify expectations: no baseline file at ${opts.baseline}`);
    console.error('Without it this run says nothing about which failures were expected, so it is not a verdict.');
    process.exit(2);
  }
  const { sections, problems } = parseBaseline(readFileSync(opts.baseline, 'utf8'));
  if (problems.length > 0) {
    console.error(`baseline at ${opts.baseline} is not parseable:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(2);
  }
  const expected = sections.get(opts.name) ?? null;
  if (expected === null) {
    // Loud but not fatal: no section means zero expected failures, which is
    // the strictest reading — the safe direction for a typo'd --name.
    console.error(`note: no \`${opts.name}:\` section in ${opts.baseline} — every failure will be a regression`);
  }

  // Checked with a real request, not a port probe: a listener that cannot
  // answer anything would otherwise produce fourteen scenarios of uniform
  // nonsense that read like conformance failures.
  try {
    await fetch(origin, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    console.error(`the origin is not answering at ${origin} (${err})`);
    console.error('supply an explicit live endpoint, or run the in-process fixtures: node --test agent-conformance/agent-conformance.test.mjs');
    process.exit(2);
  }

  const ctx = { pricesOps: opts.priced || Boolean(opts.x402Key), facilitatorKey: opts.x402Key, mcpProfile: opts.mcpProfile };
  console.log(`running ${SCENARIOS.length} scenario(s) against ${origin}, one at a time`);
  console.log('');
  const scenarios = await runScenarios(origin, ctx);
  for (const s of scenarios) {
    const t = tally([s]);
    const mark = t.fail > 0 ? '\u2717' : t.pass > 0 ? '\u2713' : '\u25cb';
    console.log(`  ${mark} ${s.id.padEnd(28)} [${s.tier.padEnd(10)}] ${t.pass} pass  ${t.fail} fail  ${t.info} info`);
    for (const c of s.checks) {
      if (c.status === 'fail') console.log(`      ┗ ${c.id}: ${c.evidence}`);
    }
  }

  const verdict = enforceBaseline(scenarios, expected ?? new Set());
  const report = {
    generated_at: new Date().toISOString(),
    name: opts.name,
    origin,
    // The credential itself never lands in a report — only whether one was
    // supplied, which is what a reader needs to interpret the payment loop.
    ctx: { pricesOps: ctx.pricesOps, facilitatorKeySupplied: Boolean(ctx.facilitatorKey) },
    summary: tally(scenarios),
    scenarios,
    baseline: {
      path: opts.baseline,
      expected: [...(expected ?? new Set())].sort(),
      regressions: verdict.regressions,
      stale: verdict.stale,
    },
  };
  if (opts.out) {
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, `${opts.name}.conformance.json`), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(opts.out, `${opts.name}.conformance.md`), renderMarkdown(report));
    console.log(`\nreports: ${join(opts.out, `${opts.name}.conformance.{json,md}`)}`);
  }

  if (verdict.regressions.length > 0) {
    console.log('\nREGRESSIONS — failing, and no baseline entry expects them:');
    for (const e of verdict.regressions) console.log(`  + ${e}`);
  }
  if (verdict.stale.length > 0) {
    console.log('\nSTALE baseline entries — nothing failed under them:');
    for (const e of verdict.stale) console.log(`  - ${e}  (passes now? delete the line. went info? info is never baselined.)`);
  }
  if (verdict.ok) {
    console.log(`\nbaseline agrees: ${(expected ?? new Set()).size} expected failure(s), none unaccounted for.`);
  }
  process.exit(verdict.ok ? 0 : 1);
}

// Same import-safety guard agent-score uses: the module is importable by the
// test suite without running the CLI.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  await main();
}
