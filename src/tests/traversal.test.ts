import { describe, expect, it } from 'vitest';
import { compileGraph, setNodeBlocked, setRoadClosed, type SearchGraph } from '../core/graph';
import { analyzeNetwork, canReach, explainNoRoute, reachableFrom, reachingTo } from '../core/traversal';
import { gridNetwork, makeNetwork, randomNetwork, referenceCost, seededRandom } from './helpers';

const idx = (g: SearchGraph, id: string) => g.nodeIndex.get(id) as number;
const ids = (g: SearchGraph, list: ArrayLike<number>) => Array.from(list, (i) => g.nodeIds[i]).sort();
const roadIds = (g: SearchGraph, list: number[]) => list.map((r) => g.roadIds[r]).sort();

/*
 *   A -- B -- C -- D        E -- F (separate)
 */
const line = () =>
  makeNetwork(
    [['A', 0, 0], ['B', 10, 0], ['C', 20, 0], ['D', 30, 0], ['E', 0, 50], ['F', 10, 50]],
    [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'C', to: 'D' }, { from: 'E', to: 'F' }],
  );

describe('reachability (BFS)', () => {
  it('finds everything reachable, in BFS order', () => {
    const g = compileGraph(line());
    const r = reachableFrom(g, idx(g, 'A'));
    expect(Array.from(r.order, (i) => g.nodeIds[i])).toEqual(['A', 'B', 'C', 'D']);
    expect(canReach(g, idx(g, 'A'), idx(g, 'D'))).toBe(true);
    expect(canReach(g, idx(g, 'A'), idx(g, 'F'))).toBe(false);
  });

  it('respects closures, obstacles and one-way roads', () => {
    const g = compileGraph(makeNetwork([['A', 0, 0], ['B', 10, 0], ['C', 20, 0]], [{ from: 'A', to: 'B' }, { from: 'C', to: 'B', oneWay: true }]));
    expect(canReach(g, idx(g, 'C'), idx(g, 'A'))).toBe(true);
    expect(canReach(g, idx(g, 'A'), idx(g, 'C'))).toBe(false); // one-way C -> B
    setRoadClosed(g, 'A-B', true);
    expect(canReach(g, idx(g, 'C'), idx(g, 'A'))).toBe(false);
    setRoadClosed(g, 'A-B', false);
    setNodeBlocked(g, 'B', true);
    expect(canReach(g, idx(g, 'C'), idx(g, 'A'))).toBe(false);
  });

  it('reachingTo is the reverse: everything that can reach the goal', () => {
    const g = compileGraph(makeNetwork([['A', 0, 0], ['B', 10, 0], ['C', 20, 0]], [{ from: 'A', to: 'B', oneWay: true }, { from: 'B', to: 'C', oneWay: true }]));
    expect(ids(g, reachingTo(g, idx(g, 'C')).order)).toEqual(['A', 'B', 'C']);
    expect(ids(g, reachingTo(g, idx(g, 'A')).order)).toEqual(['A']);
  });

  it('agrees with the Bellman-Ford reference on 300 random networks', () => {
    const rand = seededRandom(77);
    for (let trial = 0; trial < 300; trial++) {
      const nodes = 2 + Math.floor(rand() * 25);
      const net = randomNetwork(rand, { nodes, roads: Math.floor(nodes * (0.5 + rand() * 1.5)), oneWayRate: 0.3, closedRate: 0.15, blockedRate: 0.1 });
      const g = compileGraph(net);
      const s = `n${Math.floor(rand() * nodes)}`;
      for (let t = 0; t < nodes; t++) {
        const expected = referenceCost(net, s, `n${t}`) < Infinity;
        expect(canReach(g, idx(g, s), t), `trial ${trial} ${s}->n${t}`).toBe(expected);
        expect(reachableFrom(g, idx(g, s)).inSet[t] === 1, `trial ${trial}`).toBe(expected);
        expect(reachingTo(g, t).inSet[idx(g, s)] === 1, `trial ${trial}`).toBe(expected);
      }
    }
  });
});

describe('explainNoRoute', () => {
  it('returns null when a route exists', () => {
    const g = compileGraph(line());
    expect(explainNoRoute(g, idx(g, 'A'), idx(g, 'D'))).toBeNull();
  });

  it('closing every road into the destination highlights it and lists those roads', () => {
    const g = compileGraph(gridNetwork(5, 5));
    const dest = 'g2_2';
    for (const r of ['h1_2', 'h2_2', 'v2_1', 'v2_2']) setRoadClosed(g, r, true);
    const cut = explainNoRoute(g, idx(g, 'g0_0'), idx(g, dest));
    expect(cut).toMatchObject({ reason: 'unreachable', side: 'end', startSideCount: 24 });
    expect(ids(g, cut!.region)).toEqual([dest]);
    expect(roadIds(g, cut!.barrierRoads)).toEqual(['h1_2', 'h2_2', 'v2_1', 'v2_2']);
  });

  it('a trapped start highlights the start side instead (the smaller side)', () => {
    const g = compileGraph(gridNetwork(5, 5));
    // Wall off the 2x2 top-left corner.
    for (const r of ['h1_0', 'h1_1', 'v0_1', 'v1_1']) setRoadClosed(g, r, true);
    const cut = explainNoRoute(g, idx(g, 'g0_0'), idx(g, 'g4_4'));
    expect(cut?.side).toBe('start');
    expect(ids(g, cut!.region)).toEqual(['g0_0', 'g0_1', 'g1_0', 'g1_1']);
    expect(roadIds(g, cut!.barrierRoads)).toEqual(['h1_0', 'h1_1', 'v0_1', 'v1_1']);
  });

  it('reports obstacles and wrong-way one-way roads on the boundary', () => {
    // D can only be left, never entered: B blocked, D -> C one-way out.
    const g = compileGraph(
      makeNetwork(
        [['A', 0, 0], ['B', 10, 0], ['C', 0, 10], ['D', 10, 10]],
        [{ from: 'A', to: 'B' }, { from: 'B', to: 'D' }, { from: 'A', to: 'C' }, { from: 'D', to: 'C', oneWay: true }],
      ),
    );
    setNodeBlocked(g, 'B', true);
    const cut = explainNoRoute(g, idx(g, 'A'), idx(g, 'D'));
    expect(cut?.side).toBe('end');
    expect(ids(g, cut!.region)).toEqual(['D']);
    expect(ids(g, cut!.barrierNodes)).toEqual(['B']);
    expect(roadIds(g, cut!.barrierRoads)).toEqual(['D-C']); // open, but points the wrong way
  });

  it('explains blocked endpoints', () => {
    const g = compileGraph(line());
    setNodeBlocked(g, 'D', true);
    expect(explainNoRoute(g, idx(g, 'A'), idx(g, 'D'))).toMatchObject({ reason: 'blocked-end', barrierNodes: [idx(g, 'D')] });
    setNodeBlocked(g, 'A', true);
    expect(explainNoRoute(g, idx(g, 'A'), idx(g, 'D'))).toMatchObject({ reason: 'blocked-start' });
  });
});

describe('analyzeNetwork (DFS)', () => {
  it('counts regions and finds isolated intersections', () => {
    const net = line();
    net.nodes.push({ id: 'Z', x: 99, y: 99, blocked: false });
    const report = analyzeNetwork(compileGraph(net));
    expect(report).toMatchObject({ regions: 3, largestRegion: 4, blocked: 0 });
    expect(report.isolated.length).toBe(1);
  });

  it('closures and obstacles split regions; direction is ignored', () => {
    const g = compileGraph(makeNetwork([['A', 0, 0], ['B', 10, 0], ['C', 20, 0]], [{ from: 'A', to: 'B', oneWay: true }, { from: 'C', to: 'B', oneWay: true }]));
    expect(analyzeNetwork(g).regions).toBe(1);
    setNodeBlocked(g, 'B', true);
    const r = analyzeNetwork(g);
    expect(r).toMatchObject({ regions: 2, blocked: 1 });
    expect(ids(g, r.isolated)).toEqual(['A', 'C']);
  });

  it('a connected grid is one region with nothing isolated', () => {
    expect(analyzeNetwork(compileGraph(gridNetwork(20, 20)))).toEqual({ regions: 1, largestRegion: 400, isolated: [], blocked: 0 });
  });
});
