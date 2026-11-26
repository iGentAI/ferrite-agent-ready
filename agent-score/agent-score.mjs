#!/usr/bin/env node
// agent-score — the Ferrite agent-readiness and performance suite.
//
// Usage:
//   node agent-score/agent-score.mjs scan <origin> [--out DIR] [--perf] [--samples N]
//
// Probes SERVED behaviour on any HTTP origin (a local bench harness, a
// deployed Ferrite app, or a third-party site), scores the check battery in
// checks.mjs, and writes report.json + report.md scorecards.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runChecks, runPerformance } from './checks.mjs';

function usage(code = 2) {
  console.error('usage: agent-score.mjs scan <origin> [--out DIR] [--perf] [--samples N] [--name LABEL] [--mcp-profile FILE]');
  process.exit(code);
}

export function renderMarkdown(card, perf, name) {
  const lines = [];
  lines.push(`# Agent readiness — ${name || card.origin}`);
  lines.push('');
  lines.push(`**Score: ${card.score}/100 (grade ${card.grade})** — ${card.earned}/${card.available} weighted points`);
  lines.push('');
  lines.push('| Category | Earned | Available |');
  lines.push('| --- | --- | --- |');
  for (const [cat, v] of Object.entries(card.byCategory)) {
    lines.push(`| ${cat} | ${v.earned} | ${v.available} |`);
  }
  lines.push('');
  lines.push('| Check | Category | Weight | Status | Evidence |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const c of card.checks) {
    const badge = c.status === 'pass' ? 'PASS' : c.status === 'info' ? 'INFO' : 'FAIL';
    lines.push(`| ${c.id} | ${c.category} | ${c.weight} | ${badge} | ${c.evidence.replace(/\|/g, '\\|')} |`);
  }
  if (perf) {
    lines.push('');
    lines.push('## Performance');
    lines.push('');
    lines.push('| Surface | Path | Status | Bytes | p50 ms | p95 ms |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const s of perf.surfaces) {
      lines.push(`| ${s.id} | ${s.path} | ${s.status} | ${s.bytes} | ${s.p50_ms} | ${s.p95_ms} |`);
    }
    if (perf.agent_tax_markdown_vs_html != null) {
      lines.push('');
      lines.push(`Agent tax (markdown bytes / html bytes for the landing page): **${perf.agent_tax_markdown_vs_html}** — below 1.0 means agents read fewer bytes than browsers.`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export async function scan(origin, { out, perf: wantPerf, samples, name, mcpProfile } = {}) {
  const card = await runChecks(origin, { mcpProfile });
  const perf = wantPerf ? await runPerformance(origin, { samples }) : null;
  const report = { generated_at: new Date().toISOString(), name: name || null, ...card, performance: perf };
  if (out) {
    mkdirSync(out, { recursive: true });
    const base = name || 'report';
    writeFileSync(join(out, `${base}.report.json`), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(out, `${base}.report.md`), renderMarkdown(card, perf, name));
  }
  return report;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const [cmd, origin, ...rest] = process.argv.slice(2);
  if (cmd !== 'scan' || !origin) usage();
  const opts = { perf: false, samples: 20, out: null, name: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--out') opts.out = rest[++i];
    else if (rest[i] === '--perf') opts.perf = true;
    else if (rest[i] === '--samples') opts.samples = Number(rest[++i]) || 20;
    else if (rest[i] === '--name') opts.name = rest[++i];
    else if (rest[i] === '--mcp-profile') opts.mcpProfile = JSON.parse(readFileSync(rest[++i], 'utf8'));
    else usage();
  }
  const report = await scan(origin, opts);
  console.log(`${report.name || origin}: score ${report.score}/100 (grade ${report.grade})`);
  for (const c of report.checks) {
    console.log(`  ${c.status.padEnd(4)} ${String(c.weight).padStart(2)}  ${c.id}: ${c.evidence}`);
  }
  if (report.performance) {
    for (const s of report.performance.surfaces) {
      console.log(`  perf ${s.id}: p50 ${s.p50_ms}ms p95 ${s.p95_ms}ms ${s.bytes}B`);
    }
    console.log(`  agent-tax md/html: ${report.performance.agent_tax_markdown_vs_html}`);
  }
  process.exit(report.score >= 55 ? 0 : 1);
}
