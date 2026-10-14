/**
 * The comparison panel's correctness check. Dijkstra, A* (Euclidean) and
 * bidirectional search are all optimal, so on the same map and endpoints they
 * must agree on whether a route exists and on its cost. Any disagreement is a
 * bug. A* with the Manhattan heuristic is not guaranteed optimal (it can
 * overestimate), so a higher cost there is expected, not a bug.
 */

import { ALGORITHMS } from '../core/algorithms';
import { getHeuristic } from '../core/heuristics';
import type { CompareEntry } from '../worker/protocol';

/** Relative tolerance for floating-point cost comparisons (sums in different orders). */
const COST_EPSILON = 1e-9;

export function sameCost(a: number, b: number): boolean {
  if (a === b) return true; // includes Infinity === Infinity
  return Math.abs(a - b) <= COST_EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}

export function isOptimal(entry: Pick<CompareEntry, 'heuristic'>): boolean {
  return entry.heuristic === null || getHeuristic(entry.heuristic).admissible;
}

export function entryLabel(entry: Pick<CompareEntry, 'algorithm' | 'heuristic'>): string {
  const base = ALGORITHMS.find((a) => a.id === entry.algorithm)?.label ?? entry.algorithm;
  return entry.algorithm === 'astar' && entry.heuristic ? `${base} (${getHeuristic(entry.heuristic).label})` : base;
}

export type Agreement =
  | { status: 'empty' }
  | { status: 'match'; found: boolean; cost: number }
  | {
      status: 'mismatch';
      message: string;
      /** The optimal results that disagree with the majority (all of them if there is no majority). */
      offenders: CompareEntry[];
      /** The answer most optimal algorithms gave, when a strict majority agrees. */
      consensus: { found: boolean; cost: number } | null;
    };

/**
 * Do the optimal algorithms agree? With three of them, a strict majority
 * pinpoints which one is wrong; without one, every optimal result is suspect.
 */
export function checkAgreement(results: readonly CompareEntry[]): Agreement {
  const optimal = results.filter(isOptimal);
  if (optimal.length === 0) return { status: 'empty' };

  const agrees = (a: CompareEntry, b: CompareEntry) => a.found === b.found && sameCost(a.cost, b.cost);
  // Largest group of mutually agreeing results.
  let best: CompareEntry[] = [];
  for (const candidate of optimal) {
    const group = optimal.filter((e) => agrees(e, candidate));
    if (group.length > best.length) best = group;
  }
  const leader = best[0] as CompareEntry;
  if (best.length === optimal.length) return { status: 'match', found: leader.found, cost: leader.cost };

  const majority = best.length * 2 > optimal.length;
  const offenders = majority ? optimal.filter((e) => !best.includes(e)) : optimal;
  const describe = (e: CompareEntry) => `${entryLabel(e)}: ${e.found ? e.cost.toFixed(4) : 'no route'}`;
  const message = majority
    ? `${offenders.map(describe).join(', ')} disagrees with ${best.map((e) => entryLabel(e)).join(' and ')} (${leader.found ? leader.cost.toFixed(4) : 'no route'}). Optimal algorithms must agree, so this indicates a bug.`
    : `Optimal algorithms disagree (${optimal.map(describe).join(', ')}). This indicates a bug.`;
  return { status: 'mismatch', message, offenders, consensus: majority ? { found: leader.found, cost: leader.cost } : null };
}

/**
 * For a non-optimal variant: how much more its route costs than the optimum
 * (the agreed cost, or the majority's), as a fraction (0.05 = 5% worse), or 0
 * when it matched. Null when there is no trustworthy optimum to compare with.
 */
export function excessCost(entry: CompareEntry, agreement: Agreement): number | null {
  const reference = agreement.status === 'match' ? agreement : agreement.status === 'mismatch' ? agreement.consensus : null;
  if (!reference) return null;
  if (!reference.found || !entry.found) return 0;
  return sameCost(entry.cost, reference.cost) ? 0 : entry.cost / reference.cost - 1;
}
