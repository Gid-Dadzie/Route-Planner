import { describe, expect, it } from 'vitest';
import { BACKWARD, bidirectional, bidirectionalSearch, FORWARD } from '../core/bidirectional';
import { dijkstra } from '../core/dijkstra';
import { compileGraph, type SearchGraph } from '../core/graph';
import { MinHeap } from '../core/priorityQueue';
import { generateGridMap } from '../utils/mapGenerator';
import { expectValidRoute, gridNetwork, makeNetwork, randomNetwork, seededRandom } from './helpers';
import { shortestPathSuite } from './pathSuite';

shortestPathSuite('bidirectional', bidirectionalSearch);

/*
 * The trap: the first node settled by BOTH searches is not on the optimal path.
 *
 *            P(3,2) --4-- Q(7,2)              optimal: S-P-Q-T = 3.61 + 4 + 3.61 = 11.2
 *           /                 \
 *        S(0,0) ---- X(5,0) ---- T(10,0)      via X: 5 x 2.5... = 7.5 + 7.5 = 15
 *              moderate traffic (x1.5)
 *
 * Alternating expansion settles S, T, P, Q, then X from both sides: a naive
 * "stop at the first common node" search returns the 15 route.
 */
const trap = () =>
  makeNetwork(
    [['S', 0, 0], ['X', 5, 0], ['T', 10, 0], ['P', 3, 2], ['Q', 7, 2]],
    [
      { from: 'S', to: 'X', traffic: 2 },
      { from: 'X', to: 'T', traffic: 2 },
      { from: 'S', to: 'P' },
      { from: 'P', to: 'Q' },
      { from: 'Q', to: 'T' },
    ],
  );

/** The textbook mistake: alternate sides and stop at the first node settled by both. */
function naiveBidirectionalCost(g: SearchGraph, s: number, t: number): number {
  const dist = [new Float64Array(g.nodeCount).fill(Infinity), new Float64Array(g.nodeCount).fill(Infinity)];
  const settled = [new Uint8Array(g.nodeCount), new Uint8Array(g.nodeCount)];
  const heaps = [new MinHeap<number>(), new MinHeap<number>()];
  dist[0]![s] = 0;
  dist[1]![t] = 0;
  heaps[0]!.push(s, 0);
  heaps[1]!.push(t, 0);
  for (let side = 0; !heaps[0]!.isEmpty() || !heaps[1]!.isEmpty(); side = 1 - side) {
    const heap = heaps[side]!;
    if (heap.isEmpty()) continue;
    const d = heap.peekPriority();
    const u = heap.pop() as number;
    if (settled[side]![u]) continue;
    settled[side]![u] = 1;
    if (settled[1 - side]![u]) return dist[0]![u]! + dist[1]![u]!; // first common node: WRONG in general
    const adj = side === 0 ? g.out : g.in;
    for (let a = adj.offsets[u]!; a < adj.offsets[u + 1]!; a++) {
      const v = adj.target[a]!;
      const nd = d + g.roadCost[adj.road[a]!]!;
      if (nd < dist[side]![v]!) {
        dist[side]![v] = nd;
        heap.push(v, nd);
      }
    }
  }
  return Infinity;
}

describe('bidirectional: the first meeting point is not necessarily optimal', () => {
  it('a naive "stop at the first common node" search falls into the trap', () => {
    const g = compileGraph(trap());
    expect(naiveBidirectionalCost(g, g.nodeIndex.get('S')!, g.nodeIndex.get('T')!)).toBe(15);
  });

  it('the topF + topB >= mu stopping rule finds the optimal route', () => {
    const net = trap();
    const g = compileGraph(net);
    const r = bidirectional(g, 'S', 'T');
    expect(r.path).toEqual(['S', 'P', 'Q', 'T']);
    expect(r.cost).toBeCloseTo(2 * Math.hypot(3, 2) + 4, 9);
    expect(r.cost).toBeCloseTo(dijkstra(g, 'S', 'T').cost, 9);
    expectValidRoute(net, r, 'S', 'T');
  });
});

describe('bidirectional: equals Dijkstra (property test)', () => {
  it('1,000 random networks, including one-way-heavy ones', () => {
    const rand = seededRandom(8);
    for (let trial = 0; trial < 1000; trial++) {
      const nodes = 2 + Math.floor(rand() * 50);
      const net = randomNetwork(rand, {
        nodes,
        roads: Math.floor(nodes * (0.8 + rand() * 2.5)),
        oneWayRate: trial % 3 === 0 ? 0.7 : 0.2,
        closedRate: 0.1,
        blockedRate: 0.05,
        size: 400,
      });
      const g = compileGraph(net);
      const s = `n${Math.floor(rand() * nodes)}`;
      const t = `n${Math.floor(rand() * nodes)}`;
      const b = bidirectional(g, s, t);
      const d = dijkstra(g, s, t);
      expect(b.found, `trial ${trial}`).toBe(d.found);
      if (d.found) {
        expect(b.cost, `trial ${trial}`).toBeCloseTo(d.cost, 9);
        expectValidRoute(net, b, s, t);
      }
    }
  });

  it('matches Dijkstra on generated cities with one-way streets', () => {
    let found = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const { network, start, end } = generateGridMap({ cols: 25, rows: 18, seed, oneWayRate: 0.3, diagonalRate: 0.3 });
      const g = compileGraph(network);
      const b = bidirectional(g, start, end);
      const d = dijkstra(g, start, end);
      // With 30% one-way streets some corners are genuinely unreachable.
      expect(b.found, `seed ${seed}`).toBe(d.found);
      if (!d.found) continue;
      found++;
      expect(b.cost, `seed ${seed}`).toBeCloseTo(d.cost, 9);
      expectValidRoute(network, b, start, end);
    }
    expect(found).toBeGreaterThan(10);
  });
});

describe('bidirectional: one-way roads on the backward side', () => {
  it('the backward search follows reversed arcs, so it never uses a one-way road against its direction', () => {
    // A -> B -> C is one-way; C -> A is a long two-way detour.
    const net = makeNetwork(
      [['A', 0, 0], ['B', 10, 0], ['C', 20, 0]],
      [{ from: 'A', to: 'B', oneWay: true }, { from: 'B', to: 'C', oneWay: true }, { from: 'C', to: 'A', distance: 50 }],
    );
    const g = compileGraph(net);
    expect(bidirectional(g, 'A', 'C').path).toEqual(['A', 'B', 'C']);
    const back = bidirectional(g, 'C', 'A');
    expect(back.path).toEqual(['C', 'A']);
    expect(back.cost).toBe(50);
  });
});

describe('bidirectional: exploration', () => {
  it('records which side settled each node; both sides take part', () => {
    const g = compileGraph(gridNetwork(20, 20));
    const r = bidirectional(g, 'g0_10', 'g19_10');
    expect(r.exploredSides).toBeDefined();
    expect(r.exploredSides!.length).toBe(r.exploredInOrder.length);
    const sides = Array.from(r.exploredSides!);
    expect(sides).toContain(FORWARD);
    expect(sides).toContain(BACKWARD);
    expect(r.exploredInOrder[0]).toBe('g0_10');
    expect(new Set(r.exploredInOrder).size).toBe(r.exploredInOrder.length);
  });

  it('balances the two sides', () => {
    const g = compileGraph(gridNetwork(60, 60));
    const r = bidirectional(g, 'g0_30', 'g59_30');
    const forward = Array.from(r.exploredSides!).filter((s) => s === FORWARD).length;
    const backward = r.exploredSides!.length - forward;
    expect(Math.abs(forward - backward)).toBeLessThan(0.1 * r.nodesExplored);
  });

  it('explores fewer nodes than Dijkstra: two small circles instead of one big one', () => {
    let bTotal = 0;
    let dTotal = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const { network } = generateGridMap({ cols: 40, rows: 40, seed });
      const g = compileGraph(network);
      const s = `n${20 * 40 + 5}`;
      const t = `n${20 * 40 + 34}`;
      bTotal += bidirectional(g, s, t).nodesExplored;
      dTotal += dijkstra(g, s, t).nodesExplored;
    }
    expect(bTotal).toBeLessThan(dTotal * 0.75);
  });
});

describe('bidirectional: performance', () => {
  it('10,000-node city map in well under 200 ms', () => {
    const { network, start, end } = generateGridMap({ cols: 100, rows: 100, seed: 5 });
    const g = compileGraph(network);
    bidirectional(g, start, end); // warm-up (JIT)
    const r = bidirectional(g, start, end);
    expect(r.found).toBe(true);
    expect(r.timeMs).toBeLessThan(200);
  });
});
