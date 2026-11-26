#!/usr/bin/env node
// agent-scan — the tiered agent-readiness scanner CLI (plan 16 catalogue:
// 20 checks in three pools; extends agent-score, which stays
// untouched as the 13-check parity oracle).
//
// Usage:
//   node agent-scan/agent-scan.mjs scan <origin> [--json|--md] [--out DIR] [--name LABEL]
//
// Default output is the human summary; --json prints the report JSON,
// --md prints the Markdown twin. --out writes <name>.report.{json,md}.
// Exit code: 0 when the grade is C or better (score >= 55), 1 otherwise.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runReport } from './report.mjs';
import { renderMarkdown } from './render-md.mjs';

function usage(code = 2) {
  console.error('usage: agent-scan.mjs scan <origin> [--json|--md] [--out DIR] [--name LABEL] [--mcp-profile FILE]');
  process.exit(code);
}

export async function scan(origin, { out, name, mcpProfile } = {}) {
  const report = await runReport(origin, { mcpProfile });
  if (out) {
    mkdirSync(out, { recursive: true });
    const base = name || 'report';
    writeFileSync(join(out, `${base}.report.json`), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(out, `${base}.report.md`), renderMarkdown(report, name));
  }
  return report;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const [cmd, origin, ...rest] = process.argv.slice(2);
  if (cmd !== 'scan' || !origin) usage();
  const opts = { out: null, name: null, format: 'text' };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--out') opts.out = rest[++i];
    else if (rest[i] === '--name') opts.name = rest[++i];
    else if (rest[i] === '--mcp-profile') opts.mcpProfile = JSON.parse(readFileSync(rest[++i], 'utf8'));
    else if (rest[i] === '--json') opts.format = 'json';
    else if (rest[i] === '--md') opts.format = 'md';
    else usage();
  }
  const report = await scan(origin, opts);
  if (opts.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else if (opts.format === 'md') {
    console.log(renderMarkdown(report, opts.name));
  } else {
    console.log(`${opts.name || origin}: score ${report.score}/100 (grade ${report.grade} — ${report.label})`);
    const t = report.tiers;
    console.log(`  essential ${t.essential.points}/${t.essential.pool} · recommended ${t.recommended.points}/${t.recommended.pool} · bonus +${t.bonus.points}`);
    for (const c of report.checks) {
      const v = c.verdict === 'partial' ? `part(${Math.round((c.fraction ?? 0.5) * 100)}%)` : c.verdict;
      console.log(`  ${v.padEnd(9)} ${String(c.weight).padStart(2)}  ${c.tier.padEnd(11)} ${c.id}: ${c.evidence}`);
    }
  }
  process.exit(report.score >= 55 ? 0 : 1);
}
