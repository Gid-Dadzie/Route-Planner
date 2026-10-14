import { describe, expect, it } from 'vitest';
import { ALGORITHMS } from '../core/algorithms';
import { compileGraph, edgeCost, setRoadClosed, type RoadNetwork } from '../core/graph';
import type { IndexedSearchResult, SearchRun } from '../core/search';
import { buildTurnGraph, classifyTurn, compileTurnRestrictions, refreshTurnGraph, turnResultToBase, type TurnRestriction } from '../core/turns';
import { makeNetwork, randomNetwork, seededRandom } from './helpers';

function finish(run: SearchRun): IndexedSearchResult {
  let step = run.next();
  while (!step.done) step = run.next();
  return step.value;
}

/** Runs every algorithm on the line graph; returns base-index results. */
function solveAll(net: RoadNetwork, restrictions: TurnRestriction[], s: string, t: string) {
  const g = compileGraph(net);
  const tg = buildTurnGraph(g, compileTurnRestrictions(g, restrictions), g.nodeIndex.get(s) as number, g.nodeIndex.get(t) as number);
  return ALGORITHMS.map((a) => {
    const r = turnResultToBase(tg, finish(a.search!(tg.graph, tg.source, tg.sink, {})));
    return { algorithm: a.id, ...r, path: r.path.map((i) => g.nodeIds[i]), pathRoads: r.pathRoads.map((i) => g.roadIds[i]) };
  });
}

/**
 * Reference: Bellman-Ford over (intersection, road arrived by) states,
 * directly on the editable network. Shares no code with the line graph.
 */
function referenceTurnCost(net: RoadNetwork, restrictions: TurnRestriction[], s: string, t: string): number {
  const blocked = new Set(net.nodes.filter((n) => n.blocked).map((n) => n.id));
  if (blocked.has(s) || blocked.has(t)) return Infinity;
  if (s === t) return 0;
  const banned = new Set(restrictions.map((r) => `${r.fromRoad}>${r.via}>${r.toRoad}`));
  const arcs: Array<{ road: string; from: string; to: string; cost: number }> = [];
  for (const e of net.edges) {
    if (e.closed) continue;
    if (!blocked.has(e.to)) arcs.push({ road: e.id, from: e.from, to: e.to, cost: edgeCost(e) });
    if (!e.oneWay && !blocked.has(e.from)) arcs.push({ road: e.id, from: e.to, to: e.from, cost: edgeCost(e) });
  }
  // dist[i] = cheapest cost of a route that ends by travelling arc i.
  const dist = arcs.map((a) => (a.from === s ? a.cost : Infinity));
  for (let round = 0; round < arcs.length; round++) {
    let changed = false;
    arcs.forEach((a, i) => {
      if (dist[i] === Infinity) return;
      arcs.forEach((b, j) => {
        if (b.from !== a.to || banned.has(`${a.road}>${a.to}>${b.road}`)) return;
        const nd = (dist[i] as number) + b.cost;
        if (nd < (dist[j] as number)) {
          dist[j] = nd;
          changed = true;
        }
      });
    });
    if (!changed) break;
  }
  return Math.min(Infinity, ...arcs.map((a, i) => (a.to === t ? (dist[i] as number) : Infinity)));
}

/*
 * A plus-shaped junction X with a ring road around it:
 *
 *        N(0,-10)
 *          |
 * W(-10,0)-X(0,0)-E(10,0)
 *          |
 *        S(0,10)
 *
 * plus a ring W-N-E-S-W with diagonal roads of length 14.2 (16 for E-S, so ties cannot occur).
 * Driving from S, a left turn at X goes to W.
 */
function junction(): RoadNetwork {
  return makeNetwork(
    [['X', 0, 0], ['N', 0, -10], ['E', 10, 0], ['S', 0, 10], ['W', -10, 0]],
    [
      { from: 'X', to: 'N', id: 'xn' },
      { from: 'X', to: 'E', id: 'xe' },
      { from: 'X', to: 'S', id: 'xs' },
      { from: 'X', to: 'W', id: 'xw' },
      { from: 'W', to: 'N', id: 'wn', distance: 14.2 },
      { from: 'N', to: 'E', id: 'ne', distance: 14.2 },
      { from: 'E', to: 'S', id: 'es', distance: 16 },
      { from: 'S', to: 'W', id: 'sw', distance: 14.2 },
    ],
  );
}

describe('turn restrictions', () => {
  it('a banned left turn forces the route around it', () => {
    const net = junction();
    expect(solveAll(net, [], 'S', 'W').every((r) => r.cost === 14.2)).toBe(true); // direct ring road
    // Close the ring road so the only short way is the left turn at X.
    net.edges = net.edges.map((e) => (e.id === 'sw' ? { ...e, closed: true } : e));
    expect(solveAll(net, [], 'S', 'W').map((r) => r.cost)).toEqual([20, 20, 20, 20]); // S-X-W
    const results = solveAll(net, [{ fromRoad: 'xs', via: 'X', toRoad: 'xw' }], 'S', 'W');
    for (const r of results) {
      // Straight over X to N, then the ring road N-W: 10 + 10 + 14.2.
      expect(r.cost, r.algorithm).toBeCloseTo(34.2, 9);
      expect(r.path, r.algorithm).toEqual(['S', 'X', 'N', 'W']);
      expect(r.pathRoads, r.algorithm).toEqual(['xs', 'xn', 'wn']);
    }
  });

  it('a banned turn can force a U-turn further on, and banning that too leaves no route', () => {
    //   A(0,0) -- B(10,0) -- C(20,0)
    //               |
    //             D(10,10)
    const net = makeNetwork(
      [['A', 0, 0], ['B', 10, 0], ['C', 20, 0], ['D', 10, 10]],
      [{ from: 'A', to: 'B', id: 'ab' }, { from: 'B', to: 'C', id: 'bc' }, { from: 'B', to: 'D', id: 'bd' }],
    );
    const noTurnToD: TurnRestriction = { fromRoad: 'ab', via: 'B', toRoad: 'bd' };
    for (const r of solveAll(net, [noTurnToD], 'A', 'D')) {
      // Go on to C, turn around, come back to B and turn into D: 10 + 10 + 10 + 10.
      expect(r.path, r.algorithm).toEqual(['A', 'B', 'C', 'B', 'D']);
      expect(r.cost, r.algorithm).toBe(40);
    }
    const noUTurnAtC: TurnRestriction = { fromRoad: 'bc', via: 'C', toRoad: 'bc' };
    expect(solveAll(net, [noTurnToD, noUTurnAtC], 'A', 'D').every((r) => !r.found)).toBe(true);
    // The ban is directional: D -> A is unaffected.
    expect(solveAll(net, [noTurnToD, noUTurnAtC], 'D', 'A').every((r) => r.found && r.cost === 20)).toBe(true);
  });

  it('start == goal is a zero-cost route even with restrictions', () => {
    for (const r of solveAll(junction(), [{ fromRoad: 'xs', via: 'X', toRoad: 'xw' }], 'X', 'X')) {
      expect(r).toMatchObject({ found: true, cost: 0, path: ['X'], pathRoads: [] });
    }
  });

  it('ignores restrictions on roads that do not meet at the intersection', () => {
    const g = compileGraph(junction());
    expect(compileTurnRestrictions(g, [{ fromRoad: 'wn', via: 'X', toRoad: 'xe' }, { fromRoad: 'nope', via: 'X', toRoad: 'xe' }]).count).toBe(0);
    expect(compileTurnRestrictions(g, [{ fromRoad: 'xs', via: 'X', toRoad: 'xw' }]).count).toBe(1);
  });

  it('refresh picks up closures made after the line graph was built', () => {
    const net = junction();
    const g = compileGraph(net);
    const tg = buildTurnGraph(g, compileTurnRestrictions(g, []), g.nodeIndex.get('S') as number, g.nodeIndex.get('W') as number);
    const dijkstraSearch = ALGORITHMS[0]!.search!;
    expect(finish(dijkstraSearch(tg.graph, tg.source, tg.sink)).cost).toBeCloseTo(14.2, 9);
    setRoadClosed(g, 'sw', true);
    refreshTurnGraph(tg);
    expect(finish(dijkstraSearch(tg.graph, tg.source, tg.sink)).cost).toBe(20);
  });

  it('all algorithms match a state-space Bellman-Ford on random networks with random bans', () => {
    const rand = seededRandom(31);
    for (let trial = 0; trial < 150; trial++) {
      const nodes = 3 + Math.floor(rand() * 18);
      const net = randomNetwork(rand, { nodes, roads: Math.floor(nodes * (1 + rand() * 1.5)), oneWayRate: 0.2, closedRate: 0.05, blockedRate: 0.03 });
      // Ban ~30% of the possible turns.
      const restrictions: TurnRestriction[] = [];
      for (const a of net.edges) {
        for (const b of net.edges) {
          for (const via of [a.from, a.to]) {
            if ((b.from === via || b.to === via) && rand() < 0.3) restrictions.push({ fromRoad: a.id, via, toRoad: b.id });
          }
        }
      }
      const s = `n${Math.floor(rand() * nodes)}`;
      const t = `n${Math.floor(rand() * nodes)}`;
      const expected = referenceTurnCost(net, restrictions, s, t);
      for (const r of solveAll(net, restrictions, s, t)) {
        if (expected === Infinity) expect(r.found, `trial ${trial} ${r.algorithm}`).toBe(false);
        else expect(r.cost, `trial ${trial} ${r.algorithm}`).toBeCloseTo(expected, 9);
      }
    }
  });
});

describe('classifyTurn (screen coordinates, y down)', () => {
  it('names turns from the driver’s point of view', () => {
    // Heading east along y = 0, arriving at (0, 0).
    expect(classifyTurn(-10, 0, 0, 0, 10, 0)).toBe('straight');
    expect(classifyTurn(-10, 0, 0, 0, 0, -10)).toBe('left'); // up on screen = north
    expect(classifyTurn(-10, 0, 0, 0, 0, 10)).toBe('right');
    expect(classifyTurn(-10, 0, 0, 0, -10, 0)).toBe('uturn');
  });
});
