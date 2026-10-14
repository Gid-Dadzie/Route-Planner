import { describe, expect, it } from 'vitest';
import { dijkstra, dijkstraSearch } from '../core/dijkstra';
import { compileGraph } from '../core/graph';
import { gridNetwork, referenceCost } from './helpers';
import { sampleNetwork, shortestPathSuite } from './pathSuite';

shortestPathSuite('dijkstra', dijkstraSearch);

describe('dijkstra: specifics', () => {
  it('settles nodes in non-decreasing distance order', () => {
    const net = sampleNetwork();
    const r = dijkstra(compileGraph(net), 'A', 'E');
    const dists = r.exploredInOrder.map((id) => referenceCost(net, 'A', id));
    for (let i = 1; i < dists.length; i++) expect(dists[i]).toBeGreaterThanOrEqual(dists[i - 1] as number);
  });

  it('a failed search explores exactly the reachable component', () => {
    const r = dijkstra(compileGraph(sampleNetwork()), 'A', 'F');
    expect(new Set(r.exploredInOrder)).toEqual(new Set(['A', 'B', 'C', 'D', 'E']));
  });

  it('pauses exactly once per `yieldEvery` expansions', () => {
    const g = compileGraph(gridNetwork(10, 10));
    const run = dijkstraSearch(g, 0, 99, { yieldEvery: 7 });
    let pauses = 0;
    let step = run.next();
    while (!step.done) {
      pauses++;
      step = run.next();
    }
    // The goal's expansion returns before the pause check.
    expect(pauses).toBe(Math.floor((step.value.explored.length - 1) / 7));
  });

  it('10,000-node grid, corner to corner, in well under 200 ms', () => {
    const g = compileGraph(gridNetwork(100, 100));
    dijkstra(g, 'g0_0', 'g99_99'); // warm-up (JIT)
    const r = dijkstra(g, 'g0_0', 'g99_99');
    expect(r.cost).toBe(1980);
    expect(r.timeMs).toBeLessThan(200);
  });
});
