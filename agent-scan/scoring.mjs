// agent-scan scoring — plan 16 §10.4, complete and deterministic.
//
// Per-tier pools: essential 80, recommended 20, bonus +5 cap.
// Per check: fraction = 1.0 (pass), 0.0 (fail), f∈(0,1) (partial).
// 'info' = not applicable: excluded from both earned and available.
// Grade bands are the agent-score bands (GRADE_BANDS, checks.mjs L278):
// A ≥90, B ≥75, C ≥55, D ≥35, F below.

import { grade as gradeOf, GRADE_BANDS } from '../agent-score/checks.mjs';

export { GRADE_BANDS };

export const POOLS = { essential: 80, recommended: 20 };
export const BONUS_CAP = 5;

export const GRADE_LABELS = {
  A: 'Agent-ready',
  B: 'Strong baseline',
  C: 'Usable with gaps',
  D: 'Hard for agents',
  F: 'Not agent-readable',
};

/** fraction earned by one check result. */
export function fractionOf(result) {
  if (result.verdict === 'pass') return 1;
  if (result.verdict === 'partial') return typeof result.fraction === 'number' ? result.fraction : 0.5;
  return 0; // fail and info both earn 0; info is excluded from pools upstream
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Score a list of check results, each { id, tier, weight, verdict, fraction? }.
 * Returns { score, grade, label, eligibleChecks, tiers } where tiers carries
 * per-tier { earned, available, points, pool, passing, total } (bonus:
 * { points, cap, positiveSignals, total }).
 */
export function score(results) {
  const tiers = {};
  for (const tier of ['essential', 'recommended']) {
    const pool = POOLS[tier];
    const inTier = results.filter((r) => r.tier === tier);
    const eligible = inTier.filter((r) => r.verdict !== 'info');
    const earned = eligible.reduce((a, r) => a + r.weight * fractionOf(r), 0);
    const available = eligible.reduce((a, r) => a + r.weight, 0);
    const points = available === 0 ? 0 : round1((pool * earned) / available);
    tiers[tier] = {
      pool,
      points,
      earned: round1(earned),
      available,
      passing: eligible.filter((r) => r.verdict === 'pass').length,
      total: eligible.length,
    };
  }
  const bonus = results.filter((r) => r.tier === 'bonus');
  const positive = bonus.filter((r) => r.verdict === 'pass');
  const bonusPoints = Math.min(BONUS_CAP, positive.reduce((a, r) => a + r.weight, 0));
  tiers.bonus = { cap: BONUS_CAP, points: bonusPoints, positiveSignals: positive.length, total: bonus.length };

  const total = Math.min(100, Math.round(tiers.essential.points + tiers.recommended.points + bonusPoints));
  const g = gradeOf(total);
  return {
    score: total,
    grade: g,
    label: GRADE_LABELS[g],
    eligibleChecks: results.filter((r) => r.verdict !== 'info').length,
    tiers,
  };
}
