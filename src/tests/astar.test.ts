import { describe, expect, it } from 'vitest';
import { astar, astarSearch } from '../core/astar';
import { dijkstra } from '../core/dijkstra';
import { compileGraph } from '../core/graph';
import { euclideanHeuristic, manhattanHeuristic } from '../core/heuristics';
import { generateGridMap } from '../utils/mapGenerator';
import { gridNetwork, makeNetwork, randomNetwork, seededRandom } from './helpers';
import { shortestPathSuite } from './pathSuite';

// The default (Euclidean) A* must pass every test Dijkstra passes.
shortestPathSuite('astar', astarSearch);

describe('heuristics', () => {
  it('compute straight-line and grid distance', () => {
    expect(euclideanHeuristic(0, 0, 3, 4)).toBe(5);
    expect(manhattanHeuristic(0, 0, 3, -4)).toBe(7);
  });
});

describe('astar: equals Dijkstra', () => {
  it('returns the same cost as Dijkstra on 500 random networks', () => {
    const rand = seededRandom(99);
    for (let trial = 0; trial < 500; trial++) {
      const nodes = 2 + Math.floor(rand() * 60);
      const g = compileGraph(
        randomNetwork(rand, { nodes, roads: Math.floor(nodes * (1 + rand() * 2)), oneWayRate: 0.2, closedRate: 0.1, blockedRate: 0.05, size: 500 }),
      );
      const s = `n${Math.floor(rand() * nodes)}`;
      const t = `n${Math.floor(rand() * nodes)}`;
      const a = astar(g, s, t);
      const d = dijkstra(g, s, t);
      expect(a.found, `trial ${trial}`).toBe(d.found);
      if (d.found) expect(a.cost, `trial ${trial}`).toBeCloseTo(d.cost, 9);
    }
  });

  it('matches Dijkstra on generated city maps with heavy traffic variation', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { network, start, end } = generateGridMap({ cols: 20, rows: 15, seed, oneWayRate: 0.2, diagonalRate: 0.3 });
      const g = compileGraph(network);
      expect(astar(g, start, end).cost, `seed ${seed}`).toBeCloseTo(dijkstra(g, start, end).cost, 9);
    }
  });
});

describe('astar: explores less than Dijkstra', () => {
  it('a straight run across a 100x100 grid explores a small fraction of what Dijkstra does', () => {
    const g = compileGraph(gridNetwork(100, 100));
    const a = astar(g, 'g0_50', 'g99_50');
    const d = dijkstra(g, 'g0_50', 'g99_50');
    expect(a.cost).toBe(d.cost);
    expect(a.nodesExplored).toBeLessThan(d.nodesExplored * 0.1);
  });

  it('explores fewer nodes in total across random city maps', () => {
    let aTotal = 0;
    let dTotal = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const { network } = generateGridMap({ cols: 30, rows: 30, seed });
      const g = compileGraph(network);
      // Mid-left to mid-right: a typical point-to-point trip.
      const s = `n${15 * 30}`;
      const t = `n${15 * 30 + 29}`;
      aTotal += astar(g, s, t).nodesExplored;
      dTotal += dijkstra(g, s, t).nodesExplored;
    }
    expect(aTotal).toBeLessThan(dTotal * 0.6);
  });
});

describe('astar: Manhattan heuristic', () => {
  it('is optimal on an axis-aligned grid, where it never overestimates', () => {
    const g = compileGraph(gridNetwork(30, 30));
    for (const [s, t] of [['g0_0', 'g29_29'], ['g3_17', 'g25_2'], ['g10_10', 'g10_20']] as const) {
      expect(astar(g, s, t, { heuristic: 'manhattan' }).cost).toBe(dijkstra(g, s, t).cost);
    }
  });

  it('can return a longer route when roads are diagonal (it overestimates)', () => {
    // Optimal: S -> M -> G along the diagonal, 2 x 7.07 = 14.14.
    // Alternative: a winding direct road S -> G of length 16.
    // Manhattan says h(M) = 10 (true remaining cost 7.07), so f(M) = 17.07 > 16
    // and A* pops G via the winding road first.
    const net = makeNetwork(
      [['S', 0, 0], ['M', 5, 5], ['G', 10, 10]],
      [{ from: 'S', to: 'M' }, { from: 'M', to: 'G' }, { from: 'S', to: 'G', distance: 16 }],
    );
    const g = compileGraph(net);
    expect(dijkstra(g, 'S', 'G').cost).toBeCloseTo(Math.hypot(10, 10), 9);
    expect(astar(g, 'S', 'G').cost).toBeCloseTo(Math.hypot(10, 10), 9);
    expect(astar(g, 'S', 'G', { heuristic: 'manhattan' }).cost).toBe(16);
  });
});

describe('astar: performance', () => {
  it('10,000-node city map in well under 200 ms', () => {
    const { network, start, end } = generateGridMap({ cols: 100, rows: 100, seed: 5 });
    const g = compileGraph(network);
    astar(g, start, end); // warm-up (JIT)
    const r = astar(g, start, end);
    expect(r.found).toBe(true);
    expect(r.timeMs).toBeLessThan(200);
  });
});
