import { describe, expect, it } from 'vitest';
import {
  compileGraph,
  defaultRoadDistance,
  edgeCost,
  GraphValidationError,
  isArcOpen,
  MIN_ROAD_DISTANCE,
  setNodeBlocked,
  setRoadClosed,
  setRoadTraffic,
  trafficMultiplier,
  validateNetwork,
  type SearchGraph,
  type ValidationCode,
} from '../core/graph';
import { makeNetwork } from './helpers';

/** Neighbour ids reachable from `id` via arcs in the given direction. */
function neighbours(g: SearchGraph, id: string, dir: 'out' | 'in'): string[] {
  const adj = g[dir];
  const u = g.nodeIndex.get(id) as number;
  const ids: string[] = [];
  for (let a = adj.offsets[u]; a < adj.offsets[u + 1]; a++) ids.push(g.nodeIds[adj.target[a]] as string);
  return ids.sort();
}

function codes(network: Parameters<typeof validateNetwork>[0]): ValidationCode[] {
  return validateNetwork(network).map((i) => i.code);
}

// A--B is two-way, B->C is one-way, A--D is two-way.
const sample = () =>
  makeNetwork(
    [
      ['A', 0, 0],
      ['B', 3, 4],
      ['C', 6, 4],
      ['D', 0, 10],
    ],
    [
      { from: 'A', to: 'B', traffic: 2 },
      { from: 'B', to: 'C', oneWay: true },
      { from: 'A', to: 'D', distance: 12 },
    ],
  );

describe('traffic and cost', () => {
  it('uses the documented multipliers', () => {
    expect([1, 2, 3, 4].map((l) => trafficMultiplier(l as 1 | 2 | 3 | 4))).toEqual([1.0, 1.5, 2.5, 4.0]);
  });

  it('cost = distance x multiplier', () => {
    expect(edgeCost({ distance: 10, trafficLevel: 1 })).toBe(10);
    expect(edgeCost({ distance: 10, trafficLevel: 3 })).toBe(25);
    expect(edgeCost({ distance: 10, trafficLevel: 4 })).toBe(40);
  });

  it('default road distance is the straight-line length, with a positive minimum', () => {
    const a = { id: 'a', x: 0, y: 0, blocked: false };
    expect(defaultRoadDistance(a, { id: 'b', x: 3, y: 4, blocked: false })).toBe(5);
    // Coincident intersections ("zero-length road") still get a positive distance.
    expect(defaultRoadDistance(a, { id: 'c', x: 0, y: 0, blocked: false })).toBe(MIN_ROAD_DISTANCE);
  });
});

describe('validateNetwork', () => {
  it('accepts a valid network', () => {
    expect(validateNetwork(sample())).toEqual([]);
  });

  it('accepts a distance longer than the straight line (winding road)', () => {
    expect(codes(makeNetwork([['A', 0, 0], ['B', 3, 4]], [{ from: 'A', to: 'B', distance: 50 }]))).toEqual([]);
  });

  it('rejects a distance shorter than the straight line (would break A* admissibility)', () => {
    expect(codes(makeNetwork([['A', 0, 0], ['B', 3, 4]], [{ from: 'A', to: 'B', distance: 4.9 }]))).toEqual([
      'distance-below-euclidean',
    ]);
  });

  it('rejects zero and negative distances', () => {
    const nodes: Array<[string, number, number]> = [['A', 0, 0], ['B', 0, 0]];
    expect(codes(makeNetwork(nodes, [{ from: 'A', to: 'B', distance: 0 }]))).toEqual(['non-positive-distance']);
    expect(codes(makeNetwork(nodes, [{ from: 'A', to: 'B', distance: -3 }]))).toEqual(['non-positive-distance']);
    expect(codes(makeNetwork(nodes, [{ from: 'A', to: 'B', distance: NaN }]))).toEqual(['non-positive-distance']);
  });

  it('rejects missing endpoints and self-loops', () => {
    expect(codes(makeNetwork([['A', 0, 0]], [{ from: 'A', to: 'Z', distance: 1 }]))).toEqual(['missing-endpoint']);
    expect(codes(makeNetwork([['A', 0, 0]], [{ from: 'A', to: 'A', distance: 1 }]))).toEqual(['self-loop']);
  });

  it('rejects duplicate ids', () => {
    const net = makeNetwork(
      [['A', 0, 0], ['A', 1, 1], ['B', 5, 0]],
      [
        { from: 'A', to: 'B', id: 'r', distance: 10 },
        { from: 'B', to: 'A', id: 'r', distance: 10 },
      ],
    );
    expect(codes(net)).toEqual(['duplicate-node-id', 'duplicate-edge-id']);
  });

  it('rejects invalid coordinates and traffic levels', () => {
    const net = makeNetwork([['A', NaN, 0], ['B', 5, 0]], [{ from: 'A', to: 'B', distance: 5 }]);
    expect(codes(net)).toContain('invalid-coordinates');

    const bad = makeNetwork([['A', 0, 0], ['B', 5, 0]], [{ from: 'A', to: 'B' }]);
    (bad.edges[0] as { trafficLevel: number }).trafficLevel = 7;
    expect(codes(bad)).toEqual(['invalid-traffic-level']);
  });
});

describe('compileGraph', () => {
  it('throws GraphValidationError on an invalid network', () => {
    const net = makeNetwork([['A', 0, 0], ['B', 3, 4]], [{ from: 'A', to: 'B', distance: 1 }]);
    expect(() => compileGraph(net)).toThrow(GraphValidationError);
  });

  it('assigns dense indices to nodes and roads', () => {
    const g = compileGraph(sample());
    expect(g.nodeCount).toBe(4);
    expect(g.roadCount).toBe(3);
    expect(g.nodeIds).toEqual(['A', 'B', 'C', 'D']);
    expect(g.nodeIndex.get('C')).toBe(2);
    expect(g.roadIndex.get('B-C')).toBe(1);
    expect(Array.from(g.x)).toEqual([0, 3, 6, 0]);
  });

  it('stores two-way roads as two arcs and one-way roads as one', () => {
    const g = compileGraph(sample());
    // 2 (A-B) + 1 (B->C) + 2 (A-D) = 5 directed arcs
    expect(g.out.target.length).toBe(5);
    expect(g.in.target.length).toBe(5);

    expect(neighbours(g, 'A', 'out')).toEqual(['B', 'D']);
    expect(neighbours(g, 'B', 'out')).toEqual(['A', 'C']);
    expect(neighbours(g, 'C', 'out')).toEqual([]); // one-way: no way back from C
    expect(neighbours(g, 'D', 'out')).toEqual(['A']);
  });

  it('builds the reversed graph for backward search, respecting one-way roads', () => {
    const g = compileGraph(sample());
    // Arcs INTO C come only from B; arcs into B come only from A (B->C is one-way).
    expect(neighbours(g, 'C', 'in')).toEqual(['B']);
    expect(neighbours(g, 'B', 'in')).toEqual(['A']);
    expect(neighbours(g, 'A', 'in')).toEqual(['B', 'D']);
  });

  it('caches cost per road and links both arcs of a two-way road to the same road', () => {
    const g = compileGraph(sample());
    const ab = g.roadIndex.get('A-B') as number;
    expect(g.roadDistance[ab]).toBe(5);
    expect(g.roadCost[ab]).toBe(7.5); // 5 x 1.5
    expect(g.roadCost[g.roadIndex.get('A-D') as number]).toBe(12);

    const roadsUsed = Array.from(g.out.road).filter((r) => r === ab);
    expect(roadsUsed.length).toBe(2);
  });

  it('copies initial closed and blocked flags', () => {
    const net = makeNetwork(
      [['A', 0, 0], ['B', 1, 0, true]],
      [{ from: 'A', to: 'B', closed: true }],
    );
    const g = compileGraph(net);
    expect(g.blocked[1]).toBe(1);
    expect(g.roadClosed[0]).toBe(1);
  });

  it('handles an empty network', () => {
    const g = compileGraph({ nodes: [], edges: [] });
    expect(g.nodeCount).toBe(0);
    expect(Array.from(g.out.offsets)).toEqual([0]);
  });
});

describe('in-place deltas', () => {
  it('closing a road closes both directions; reopening restores them', () => {
    const g = compileGraph(sample());
    const ab = g.roadIndex.get('A-B') as number;
    const A = g.nodeIndex.get('A') as number;
    const B = g.nodeIndex.get('B') as number;

    expect(isArcOpen(g, ab, B)).toBe(true);
    expect(setRoadClosed(g, 'A-B', true)).toBe(true);
    expect(isArcOpen(g, ab, B)).toBe(false);
    expect(isArcOpen(g, ab, A)).toBe(false);

    setRoadClosed(g, 'A-B', false);
    expect(isArcOpen(g, ab, A)).toBe(true);
  });

  it('setting traffic updates the cached cost', () => {
    const g = compileGraph(sample());
    const ab = g.roadIndex.get('A-B') as number;
    expect(setRoadTraffic(g, 'A-B', 4)).toBe(true);
    expect(g.roadTraffic[ab]).toBe(4);
    expect(g.roadCost[ab]).toBe(20);
  });

  it('blocking a node closes every arc into it', () => {
    const g = compileGraph(sample());
    const B = g.nodeIndex.get('B') as number;
    expect(setNodeBlocked(g, 'B', true)).toBe(true);
    expect(isArcOpen(g, g.roadIndex.get('A-B') as number, B)).toBe(false);
    setNodeBlocked(g, 'B', false);
    expect(isArcOpen(g, g.roadIndex.get('A-B') as number, B)).toBe(true);
  });

  it('returns false for unknown ids and leaves the graph untouched', () => {
    const g = compileGraph(sample());
    const before = Array.from(g.roadCost);
    expect(setRoadClosed(g, 'nope', true)).toBe(false);
    expect(setRoadTraffic(g, 'nope', 2)).toBe(false);
    expect(setNodeBlocked(g, 'nope', true)).toBe(false);
    expect(Array.from(g.roadCost)).toEqual(before);
    expect(Array.from(g.roadClosed)).toEqual([0, 0, 0]);
  });
});
