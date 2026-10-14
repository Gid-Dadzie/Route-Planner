import { describe, expect, it } from 'vitest';
import { checkAgreement, entryLabel, excessCost, sameCost } from '../state/comparison';
import type { CompareEntry } from '../worker/protocol';

const entry = (algorithm: CompareEntry['algorithm'], cost: number, heuristic: CompareEntry['heuristic'] = null, found = true): CompareEntry => ({
  algorithm,
  heuristic,
  found,
  cost: found ? cost : Infinity,
  distance: found ? cost : 0,
  intersections: found ? 3 : 0,
  nodesExplored: 10,
  timeMs: 0.1,
});

describe('comparison agreement check', () => {
  it('agrees when every optimal algorithm reports the same cost (within float noise)', () => {
    const a = checkAgreement([entry('dijkstra', 100), entry('astar', 100 + 1e-12, 'euclidean'), entry('bidirectional', 100)]);
    expect(a).toEqual({ status: 'match', found: true, cost: 100 });
  });

  it('flags any optimal algorithm with a different cost as a bug', () => {
    const results = [entry('dijkstra', 100), entry('astar', 100, 'euclidean'), entry('bidirectional', 104)];
    const a = checkAgreement(results);
    expect(a.status).toBe('mismatch');
    if (a.status !== 'mismatch') return;
    expect(a.offenders.map((e) => e.algorithm)).toEqual(['bidirectional']); // the majority pinpoints it
    expect(a.consensus).toEqual({ found: true, cost: 100 });
    expect(a.message).toMatch(/Bidirectional: 104\.0000 disagrees with Dijkstra and A\* \(Euclidean\)/);
    expect(a.message).toMatch(/bug/);
  });

  it('without a majority every optimal result is suspect', () => {
    const a = checkAgreement([entry('dijkstra', 100), entry('bidirectional', 104)]);
    expect(a.status).toBe('mismatch');
    if (a.status !== 'mismatch') return;
    expect(a.offenders).toHaveLength(2);
    expect(a.consensus).toBeNull();
    expect(excessCost(entry('astar', 103, 'manhattan'), a)).toBeNull();
  });

  it('during a mismatch, Manhattan is still measured against the majority', () => {
    const a = checkAgreement([entry('dijkstra', 100), entry('astar', 100, 'euclidean'), entry('bidirectional', 104)]);
    expect(excessCost(entry('astar', 110, 'manhattan'), a)).toBeCloseTo(0.1, 9);
  });

  it('flags a found / not-found disagreement', () => {
    expect(checkAgreement([entry('dijkstra', 100), entry('bidirectional', 0, null, false)]).status).toBe('mismatch');
  });

  it('agrees on "no route"', () => {
    expect(checkAgreement([entry('dijkstra', 0, null, false), entry('astar', 0, 'euclidean', false)])).toEqual({ status: 'match', found: false, cost: Infinity });
  });

  it('ignores the inadmissible Manhattan variant, and measures how much worse it is', () => {
    const manhattan = entry('astar', 103, 'manhattan');
    const results = [entry('dijkstra', 100), entry('astar', 100, 'euclidean'), manhattan];
    const a = checkAgreement(results);
    expect(a.status).toBe('match');
    expect(excessCost(manhattan, a)).toBeCloseTo(0.03, 9);
    expect(excessCost(entry('astar', 100, 'manhattan'), a)).toBe(0);
  });

  it('labels and float comparison', () => {
    expect(entryLabel(entry('astar', 1, 'manhattan'))).toBe('A* (Manhattan)');
    expect(entryLabel(entry('bidirectional', 1))).toBe('Bidirectional');
    expect(sameCost(Infinity, Infinity)).toBe(true);
    expect(sameCost(1e6, 1e6 + 1e-4)).toBe(true);
    expect(sameCost(10, 10.001)).toBe(false);
  });

  it('is empty without results', () => {
    expect(checkAgreement([])).toEqual({ status: 'empty' });
  });
});
