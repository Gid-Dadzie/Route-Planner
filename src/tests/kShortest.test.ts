import { describe, expect, it } from 'vitest';
import { compileGraph, edgeCost, type RoadNetwork } from '../core/graph';
import { yenKShortest, type KShortestResult } from '../core/kShortest';
import { makeNetwork, randomNetwork, referenceCost, seededRandom } from './helpers';
import { sampleNetwork } from './pathSuite';

function kShortest(net: RoadNetwork, s: string, t: string, k: number): KShortestResult & { ids: string[][] } {
  const g = compileGraph(net);
  const run = yenKShortest(g, g.nodeIndex.get(s) as number, g.nodeIndex.get(t) as number, k, { yieldEvery: 7 });
  let step = run.next();
  while (!step.done) step = run.next();
  return { ...step.value, ids: step.value.paths.map((p) => p.path.map((i) => g.nodeIds[i] as string)) };
}

/** Every loopless route from s to t with its cost, by brute force (small graphs only). */
function allSimpleRouteCosts(net: RoadNetwork, s: string, t: string): number[] {
  const blocked = new Set(net.nodes.filter((n) => n.blocked).map((n) => n.id));
  const out = new Map<string, Array<{ to: string; cost: number }>>();
  const add = (u: string, v: string, c: number) => out.set(u, [...(out.get(u) ?? []), { to: v, cost: c }]);
  for (const e of net.edges) {
    if (e.closed) continue;
    if (!blocked.has(e.to)) add(e.from, e.to, edgeCost(e));
    if (!e.oneWay && !blocked.has(e.from)) add(e.to, e.from, edgeCost(e));
  }
  const costs: number[] = [];
  if (blocked.has(s) || blocked.has(t)) return costs;
  const visit = (u: string, seen: Set<string>, cost: number) => {
    if (u === t) {
      costs.push(cost);
      return;
    }
    for (const { to, cost: c } of out.get(u) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      visit(to, seen, cost + c);
      seen.delete(to);
    }
  };
  visit(s, new Set([s]), 0);
  return costs.sort((a, b) => a - b);
}

describe("Yen's k-shortest paths", () => {
  it('lists the routes of the sample map in cost order', () => {
    // A -> E: A-D-E = 25, A-B-C-E = 30, A-B-D-E = 32, then A-D-B-C-E = 47.
    const r = kShortest(sampleNetwork(), 'A', 'E', 4);
    expect(r.ids).toEqual([
      ['A', 'D', 'E'],
      ['A', 'B', 'C', 'E'],
      ['A', 'B', 'D', 'E'],
      ['A', 'D', 'B', 'C', 'E'],
    ]);
    expect(r.paths.map((p) => p.cost)).toEqual([25, 30, 32, 47]);
  });

  it('returns fewer routes when fewer exist', () => {
    const net = makeNetwork([['A', 0, 0], ['B', 10, 0], ['C', 20, 0]], [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }]);
    expect(kShortest(net, 'A', 'C', 3).ids).toEqual([['A', 'B', 'C']]);
  });

  it('no route: empty list; start == end: the single empty route', () => {
    expect(kShortest(sampleNetwork(), 'A', 'F', 3).paths).toEqual([]);
    expect(kShortest(sampleNetwork(), 'B', 'B', 3).ids).toEqual([['B']]);
  });

  it('routes are loopless, distinct and legal', () => {
    const r = kShortest(sampleNetwork(), 'A', 'E', 10);
    const keys = new Set(r.ids.map((p) => p.join('>')));
    expect(keys.size).toBe(r.ids.length);
    for (const p of r.ids) expect(new Set(p).size).toBe(p.length);
  });

  it('matches brute-force enumeration of loopless routes on random graphs', () => {
    const rand = seededRandom(5);
    for (let trial = 0; trial < 120; trial++) {
      const nodes = 3 + Math.floor(rand() * 7);
      const net = randomNetwork(rand, { nodes, roads: Math.floor(nodes * (1 + rand())), oneWayRate: 0.2, closedRate: 0.05, blockedRate: 0.03 });
      // Parallel roads between the same pair would make "routes" ambiguous in node terms; drop them.
      const seenPairs = new Set<string>();
      net.edges = net.edges.filter((e) => {
        const key = [e.from, e.to].sort().join('|');
        if (seenPairs.has(key)) return false;
        seenPairs.add(key);
        return true;
      });
      const s = `n${Math.floor(rand() * nodes)}`;
      let t = `n${Math.floor(rand() * nodes)}`;
      if (t === s) t = `n${(Number(s.slice(1)) + 1) % nodes}`;
      const k = 1 + Math.floor(rand() * 5);
      const expected = allSimpleRouteCosts(net, s, t).slice(0, k);
      const got = kShortest(net, s, t, k).paths.map((p) => p.cost);
      expect(got.length, `trial ${trial}`).toBe(expected.length);
      got.forEach((c, i) => expect(c, `trial ${trial} route ${i}`).toBeCloseTo(expected[i] as number, 9));
      if (expected.length > 0) expect(got[0]).toBeCloseTo(referenceCost(net, s, t), 9);
    }
  });
});
