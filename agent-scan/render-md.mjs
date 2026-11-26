// agent-scan markdown twin — renders a report object (report.mjs shape)
// as the Markdown scorecard, following the agent-score renderMarkdown
// pattern with the tiered breakdown added.

const VERDICT_BADGE = { pass: 'PASS', partial: 'PARTIAL', fail: 'FAIL', info: 'INFO' };
const TIER_ORDER = ['essential', 'recommended', 'bonus'];
const TIER_TITLES = { essential: 'Essential', recommended: 'Recommended', bonus: 'Bonus signals' };

function esc(text) {
  return String(text).replace(/\|/g, '\\|');
}

export function renderMarkdown(report, name) {
  const lines = [];
  lines.push(`# Agent readiness — ${name || report.origin}`);
  lines.push('');
  lines.push(`**Score: ${report.score}/100 (grade ${report.grade} — ${report.label})**`);
  lines.push('');
  lines.push(`Scanned ${report.scannedAt} · ${report.eligibleChecks} eligible checks · source: ${report.engine?.tool || 'agent-scan'}`);
  lines.push('');
  lines.push('| Tier | Points | Pool | Checks passing |');
  lines.push('| --- | --- | --- | --- |');
  const { essential, recommended, bonus } = report.tiers;
  lines.push(`| Essential | ${essential.points} | ${essential.pool} | ${essential.passing} of ${essential.total} |`);
  lines.push(`| Recommended | ${recommended.points} | ${recommended.pool} | ${recommended.passing} of ${recommended.total} |`);
  lines.push(`| Bonus | +${bonus.points} | cap ${bonus.cap} | ${bonus.positiveSignals} positive signal(s) |`);

  for (const tier of TIER_ORDER) {
    const checks = report.checks.filter((c) => c.tier === tier);
    if (checks.length === 0) continue;
    lines.push('');
    lines.push(`## ${TIER_TITLES[tier]}`);
    lines.push('');
    lines.push('| Check | Weight | Verdict | Evidence |');
    lines.push('| --- | --- | --- | --- |');
    for (const c of checks) {
      const badge = c.verdict === 'partial'
        ? `PARTIAL (${Math.round((c.fraction ?? 0.5) * 100)}%)`
        : VERDICT_BADGE[c.verdict] || c.verdict.toUpperCase();
      lines.push(`| ${c.id} | ${c.weight} | ${badge} | ${esc(c.evidence)} |`);
    }
  }

  const issues = report.checks.filter((c) => c.verdict === 'fail' || c.verdict === 'partial');
  if (issues.length > 0) {
    lines.push('');
    lines.push('## Fix these gaps first');
    lines.push('');
    const ranked = [...issues].sort((a, b) => {
      const tierRank = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
      return tierRank !== 0 ? tierRank : b.weight - a.weight;
    });
    ranked.forEach((c, i) => {
      lines.push(`${String(i + 1).padStart(2, '0')}. **${c.name}** (\`${c.id}\`, ${c.tier}) — ${c.fix}`);
    });
  }

  lines.push('');
  return lines.join('\n');
}
