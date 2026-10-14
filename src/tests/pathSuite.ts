/**
 * Correctness suite shared by every optimal shortest-path algorithm.
 * Each algorithm's test file calls `shortestPathSuite` with its search factory,
 * so Dijkstra, A* and bidirectional search are held to identical expectations.
 */

import { describe, expect, it } from 'vitest';
import { compileGraph, setNodeBlocked, setRoadClosed, setRoadTraffic, type RoadNetwork, type SearchResult } from '../core/graph';
import { runSearchSync, type SearchFactory, type SearchRunOptions } from '../core/search';
import { expectValidRoute, gridNetwork, makeNetwork, randomNetwork, referenceCost, seededRandom, type RoadSpec } from './helpers';

/*
 * Hand-computed test map (coordinates in brackets, road lengths on edges):
 *
 *   A(0,0) --10-- B(10,0) --10-- C(20,0)
 *     \             |              |
 *      15           12             10
 *        \          |              |
 *          ------ D(10,10) --10-- E(20,10)        F(50,50) isolated
 *
 * A -> E candidates:  A-D-E = 25,  A-B-C-E = 30,  A-B-D-E = 32.
 */
export function sampleNetwork(overrides: Partial<Record<string, Partial<RoadSpec>>> = {}): RoadNetwork {
  const roads: RoadSpec[] = [
    { from: 'A', to: 'B', distance: 10 },
    { from: 'B', to: 'C', distance: 10 },
    { from: 'C', to: 'E', distance: 10 },
    { from: 'A', to: 'D', distance: 15 },
    { from: 'D', to: 'E', distance: 10 },
    { from: 'B', to: 'D', distance: 12 },
  ].map((r) => ({ ...r, ...overrides[`${r.from}-${r.to}`] }));

  return makeNetwork(
    [
      ['A', 0, 0],
      ['B', 10, 0],
      ['C', 20, 0],
      ['D', 10, 10],
      ['E', 20, 10],
      ['F', 50, 50],
    ],
    roads,
  );
}

export interface SuiteTraits {
  /** The search grows from the goal (D* Lite), so exploration starts there. */
  backward?: boolean;
}

export function shortestPathSuite(name: string, factory: SearchFactory, options: SearchRunOptions = {}, traits: SuiteTraits = {}): void {
  const run = (net: RoadNetwork | ReturnType<typeof compileGraph>, s: string, t: string): SearchResult =>
    runSearchSync(factory, 'nodes' in net ? compileGraph(net) : net, s, t, options);

  describe(`${name}: hand-computed routes`, () => {
    it('finds the cheapest route', () => {
      const net = sampleNetwork();
      const r = run(net, 'A', 'E');
      expect(r.path).toEqual(['A', 'D', 'E']);
      expect(r.pathRoads).toEqual(['A-D', 'D-E']);
      expect(r.cost).toBe(25);
      expect(r.distance).toBe(25);
      expectValidRoute(net, r, 'A', 'E');
    });

    it('works in the reverse direction on two-way roads', () => {
      const r = run(sampleNetwork(), 'E', 'A');
      expect(r.path).toEqual(['E', 'D', 'A']);
      expect(r.cost).toBe(25);
    });

    it('traffic changes the route: cost uses the multiplier, distance does not', () => {
      // A-D at level 2: A-D-E = 15*1.5 + 10 = 32.5, so A-B-C-E (30) wins.
      const r = run(sampleNetwork({ 'A-D': { traffic: 2 } }), 'A', 'E');
      expect(r.path).toEqual(['A', 'B', 'C', 'E']);
      expect(r.cost).toBe(30);
      expect(r.distance).toBe(30);
    });

    it('distance and cost diverge when the chosen route has traffic', () => {
      const r = run(sampleNetwork({ 'A-D': { traffic: 2 }, 'A-B': { traffic: 4 } }), 'A', 'E');
      expect(r.path).toEqual(['A', 'D', 'E']);
      expect(r.cost).toBe(32.5);
      expect(r.distance).toBe(25);
    });

    it('replaces a worse tentative distance (lazy deletion of stale heap entries)', () => {
      // C is first reached via the winding A-C road (50), then improved via B (2).
      const net = makeNetwork(
        [['A', 0, 0], ['B', 1, 0], ['C', 2, 0]],
        [
          { from: 'A', to: 'C', distance: 50 },
          { from: 'A', to: 'B', distance: 1 },
          { from: 'B', to: 'C', distance: 1 },
        ],
      );
      const r = run(net, 'A', 'C');
      expect(r.path).toEqual(['A', 'B', 'C']);
      expect(r.cost).toBe(2);
      expect(r.exploredInOrder.filter((id) => id === 'C')).toHaveLength(1);
    });
  });

  describe(`${name}: edge cases`, () => {
    it('start == end returns a zero-cost single-node route', () => {
      const r = run(sampleNetwork(), 'B', 'B');
      expect(r).toMatchObject({ found: true, path: ['B'], pathRoads: [], cost: 0, distance: 0 });
    });

    it('disconnected graph: no route', () => {
      const r = run(sampleNetwork(), 'A', 'F');
      expect(r).toMatchObject({ found: false, path: [], pathRoads: [], cost: Infinity, distance: 0 });
      // One-directional searches never see F; bidirectional settles it from the
      // goal side. Either way nothing is explored twice.
      expect(new Set(r.exploredInOrder).size).toBe(r.exploredInOrder.length);
    });

    it('closed roads are skipped', () => {
      const r = run(sampleNetwork({ 'D-E': { closed: true } }), 'A', 'E');
      expect(r.path).toEqual(['A', 'B', 'C', 'E']);
      expect(r.cost).toBe(30);
    });

    it('closing every road into the goal gives no route', () => {
      expect(run(sampleNetwork({ 'D-E': { closed: true }, 'C-E': { closed: true } }), 'A', 'E').found).toBe(false);
    });

    it('blocked intersections are avoided', () => {
      const g = compileGraph(sampleNetwork());
      setNodeBlocked(g, 'D', true);
      const r = run(g, 'A', 'E');
      expect(r.path).toEqual(['A', 'B', 'C', 'E']);
      expect(r.exploredInOrder).not.toContain('D');
    });

    it('a blocked start or goal means no route', () => {
      const g = compileGraph(sampleNetwork());
      setNodeBlocked(g, 'A', true);
      expect(run(g, 'A', 'E').found).toBe(false);
      setNodeBlocked(g, 'A', false);
      setNodeBlocked(g, 'E', true);
      expect(run(g, 'A', 'E').found).toBe(false);
    });

    it('one-way roads are only travelled in their direction', () => {
      const net = sampleNetwork({ 'D-E': { from: 'E', to: 'D', oneWay: true } });
      const g = compileGraph(net);
      const forward = run(g, 'A', 'E');
      expect(forward.path).toEqual(['A', 'B', 'C', 'E']); // cannot use D -> E
      expectValidRoute(net, forward, 'A', 'E');
      const back = run(g, 'E', 'A');
      expect(back.path).toEqual(['E', 'D', 'A']); // E -> D is allowed
      expect(back.cost).toBe(25);
    });

    it('a one-way road against the only route gives no route', () => {
      const g = compileGraph(makeNetwork([['A', 0, 0], ['B', 5, 0]], [{ from: 'B', to: 'A', oneWay: true }]));
      expect(run(g, 'A', 'B').found).toBe(false);
      expect(run(g, 'B', 'A').found).toBe(true);
    });

    it('roads between coincident intersections (minimum length) work', () => {
      const net = makeNetwork([['A', 0, 0], ['B', 0, 0], ['C', 10, 0]], [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }]);
      const r = run(net, 'A', 'C');
      expect(r.path).toEqual(['A', 'B', 'C']);
      expect(r.cost).toBe(11); // 1 (minimum) + 10
    });

    it('throws on unknown intersection ids', () => {
      expect(() => run(sampleNetwork(), 'A', 'nope')).toThrow(/Unknown intersection "nope"/);
    });
  });

  describe(`${name}: deltas applied to a compiled graph`, () => {
    it('reroutes after closing, reopening and changing traffic', () => {
      const g = compileGraph(sampleNetwork());
      expect(run(g, 'A', 'E').cost).toBe(25);
      setRoadClosed(g, 'A-D', true);
      expect(run(g, 'A', 'E').path).toEqual(['A', 'B', 'C', 'E']);
      setRoadClosed(g, 'A-D', false);
      expect(run(g, 'A', 'E').cost).toBe(25);
      setRoadTraffic(g, 'D-E', 4); // A-D-E = 15 + 40 = 55
      expect(run(g, 'A', 'E').cost).toBe(30);
    });
  });

  describe(`${name}: exploration record`, () => {
    it('starts where the search grows from, includes the other end, has no repeats', () => {
      const r = run(sampleNetwork(), 'A', 'E');
      expect(r.exploredInOrder[0]).toBe(traits.backward ? 'E' : 'A');
      // One-directional searches end on the goal; bidirectional settles it first from the goal side.
      expect(r.exploredInOrder).toContain(traits.backward ? 'A' : 'E');
      expect(new Set(r.exploredInOrder).size).toBe(r.exploredInOrder.length);
      expect(r.nodesExplored).toBe(r.exploredInOrder.length);
    });
  });

  describe(`${name}: matches a Bellman-Ford reference on random graphs`, () => {
    it('300 random networks with traffic, one-way roads, closures and obstacles', () => {
      const rand = seededRandom(2024);
      for (let trial = 0; trial < 300; trial++) {
        const nodes = 2 + Math.floor(rand() * 40);
        const net = randomNetwork(rand, {
          nodes,
          roads: Math.floor(nodes * (0.8 + rand() * 2)),
          oneWayRate: 0.25,
          closedRate: 0.1,
          blockedRate: 0.05,
        });
        const g = compileGraph(net);
        const s = `n${Math.floor(rand() * nodes)}`;
        const t = `n${Math.floor(rand() * nodes)}`;

        const r = run(g, s, t);
        const expected = referenceCost(net, s, t);
        if (expected === Infinity) {
          expect(r.found, `trial ${trial}`).toBe(false);
        } else {
          expect(r.cost, `trial ${trial}`).toBeCloseTo(expected, 9);
          expectValidRoute(net, r, s, t);
        }
      }
    });
  });

  describe(`${name}: resumable search`, () => {
    it('gives the same answer when paused every few expansions', () => {
      const g = compileGraph(gridNetwork(10, 10));
      const start = g.nodeIndex.get('g0_0') as number;
      const goal = g.nodeIndex.get('g9_9') as number;
      const search = factory(g, start, goal, { ...options, yieldEvery: 3 });
      let pauses = 0;
      let step = search.next();
      while (!step.done) {
        pauses++;
        step = search.next();
      }
      expect(pauses).toBeGreaterThan(0);
      expect(step.value.cost).toBe(180);
    });

    it('can be abandoned at a pause (basis for cooperative cancellation)', () => {
      const g = compileGraph(gridNetwork(10, 10));
      const search = factory(g, 0, 99, { ...options, yieldEvery: 2 });
      expect(search.next().done).toBe(false);
      expect(search.return(undefined as never).done).toBe(true);
      expect(search.next().done).toBe(true);
    });
  });
}
