import { describe, expect, it } from 'vitest';
import { dijkstra } from '../core/dijkstra';
import { DStarLite, dstarLiteSearch } from '../core/dstarLite';
import { compileGraph, setNodeBlocked, setRoadClosed, setRoadTraffic, type SearchGraph, type TrafficLevel } from '../core/graph';
import { toSearchResult, type IndexedSearchResult, type SearchRun } from '../core/search';
import { generateGridMap } from '../utils/mapGenerator';
import { gridNetwork, randomNetwork, seededRandom } from './helpers';
import { sampleNetwork, shortestPathSuite } from './pathSuite';

shortestPathSuite('D* Lite (from scratch)', dstarLiteSearch, {}, { backward: true });

function finish(run: SearchRun): IndexedSearchResult {
  let step = run.next();
  while (!step.done) step = run.next();
  return step.value;
}

/** Runs the persistent instance and returns the id-based result. */
function query(d: DStarLite, g: SearchGraph, startId: string) {
  return toSearchResult(g, finish(d.run(g.nodeIndex.get(startId) as number)), 0);
}

describe('D* Lite: incremental repair', () => {
  it('reuses its search: an unchanged map costs no expansions', () => {
    const g = compileGraph(sampleNetwork());
    const d = new DStarLite(g, g.nodeIndex.get('E') as number, g.nodeIndex.get('A') as number);
    const first = query(d, g, 'A');
    expect(first.cost).toBe(25);
    expect(first.nodesExplored).toBeGreaterThan(0);
    const again = query(d, g, 'A');
    expect(again.cost).toBe(25);
    expect(again.nodesExplored).toBe(0);
  });

  it('repairs after a closure on the route, and after reopening it', () => {
    const g = compileGraph(sampleNetwork());
    const d = new DStarLite(g, g.nodeIndex.get('E') as number, g.nodeIndex.get('A') as number);
    query(d, g, 'A');

    setRoadClosed(g, 'D-E', true);
    d.roadChanged(g.roadIndex.get('D-E') as number);
    const detour = query(d, g, 'A');
    expect(detour.path).toEqual(['A', 'B', 'C', 'E']);
    expect(detour.cost).toBe(30);

    setRoadClosed(g, 'D-E', false);
    d.roadChanged(g.roadIndex.get('D-E') as number);
    const back = query(d, g, 'A');
    expect(back.path).toEqual(['A', 'D', 'E']);
    expect(back.cost).toBe(25);
  });

  it('handles obstacles placed and removed', () => {
    const g = compileGraph(sampleNetwork());
    const d = new DStarLite(g, g.nodeIndex.get('E') as number, g.nodeIndex.get('A') as number);
    query(d, g, 'A');
    const D = g.nodeIndex.get('D') as number;
    setNodeBlocked(g, 'D', true);
    d.nodeChanged(D);
    expect(query(d, g, 'A').path).toEqual(['A', 'B', 'C', 'E']);
    setNodeBlocked(g, 'D', false);
    d.nodeChanged(D);
    expect(query(d, g, 'A').cost).toBe(25);
  });

  it('repairing a closure near the start is far cheaper than the first search', () => {
    // The search grows from the goal, so a change near the start invalidates
    // little; a change near the goal invalidates most of the tree (see README).
    const { network, start, end } = generateGridMap({ cols: 60, rows: 60, seed: 3 });
    const g = compileGraph(network);
    const d = new DStarLite(g, g.nodeIndex.get(end) as number, g.nodeIndex.get(start) as number);
    const first = query(d, g, start);
    const road = g.roadIndex.get(first.pathRoads[Math.floor(first.pathRoads.length * 0.1)] as string) as number;
    g.roadClosed[road] = 1;
    d.roadChanged(road);
    const repaired = query(d, g, start);
    expect(repaired.cost).toBeCloseTo(dijkstra(g, start, end).cost, 9);
    expect(repaired.nodesExplored).toBeLessThan(first.nodesExplored / 10);
  });

  it('matches a fresh Dijkstra through random edits and start moves (property test)', () => {
    const rand = seededRandom(77);
    for (let trial = 0; trial < 60; trial++) {
      const nodes = 6 + Math.floor(rand() * 40);
      const net = randomNetwork(rand, { nodes, roads: Math.floor(nodes * (1 + rand() * 2)), oneWayRate: 0.25, closedRate: 0.1, blockedRate: 0.03 });
      const g = compileGraph(net);
      const goalId = `n${Math.floor(rand() * nodes)}`;
      let startId = `n${Math.floor(rand() * nodes)}`;
      const d = new DStarLite(g, g.nodeIndex.get(goalId) as number, g.nodeIndex.get(startId) as number);

      for (let step = 0; step < 25; step++) {
        const roll = rand();
        if (roll < 0.35 && g.roadCount > 0) {
          const r = Math.floor(rand() * g.roadCount);
          setRoadClosed(g, g.roadIds[r] as string, g.roadClosed[r] === 0);
          d.roadChanged(r);
        } else if (roll < 0.65 && g.roadCount > 0) {
          const r = Math.floor(rand() * g.roadCount);
          setRoadTraffic(g, g.roadIds[r] as string, (1 + Math.floor(rand() * 4)) as TrafficLevel);
          d.roadChanged(r);
        } else if (roll < 0.8) {
          const v = Math.floor(rand() * nodes);
          setNodeBlocked(g, g.nodeIds[v] as string, g.blocked[v] === 0);
          d.nodeChanged(v);
        } else {
          startId = `n${Math.floor(rand() * nodes)}`; // the start moves: km absorbs the heuristic drift
        }
        const expected = dijkstra(g, startId, goalId);
        const got = query(d, g, startId);
        expect(got.found, `trial ${trial} step ${step}`).toBe(expected.found);
        if (expected.found) expect(got.cost, `trial ${trial} step ${step}`).toBeCloseTo(expected.cost, 9);
      }
    }
  });

  it('can be abandoned mid-repair and resumed by the next run', () => {
    const g = compileGraph(gridNetwork(30, 30));
    const goal = g.nodeIndex.get('g29_29') as number;
    const d = new DStarLite(g, goal, 0);
    const run = d.run(0, 5);
    run.next();
    run.next();
    run.return(undefined as never);
    expect(finish(d.run(0, 5)).cost).toBe(580);
  });
});
