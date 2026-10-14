import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '../core/graph';
import { pointSegmentDistance, SpatialIndex } from '../utils/spatialIndex';
import { gridNetwork, makeNetwork, randomNetwork, seededRandom } from './helpers';

function indexOf(net: { nodes: GraphNode[]; edges: GraphEdge[] }): SpatialIndex {
  return new SpatialIndex(new Map(net.nodes.map((n) => [n.id, n])), new Map(net.edges.map((e) => [e.id, e])));
}

describe('pointSegmentDistance', () => {
  it('measures to the interior, the endpoints and degenerate segments', () => {
    expect(pointSegmentDistance(5, 3, 0, 0, 10, 0)).toBe(3);
    expect(pointSegmentDistance(-3, 4, 0, 0, 10, 0)).toBe(5);
    expect(pointSegmentDistance(13, 4, 0, 0, 10, 0)).toBe(5);
    expect(pointSegmentDistance(3, 4, 0, 0, 0, 0)).toBe(5);
  });
});

describe('SpatialIndex', () => {
  it('finds the nearest node within the radius only', () => {
    const idx = indexOf(gridNetwork(5, 5, 10));
    expect(idx.nearestNode(21, 19, 3)?.id).toBe('g2_2');
    expect(idx.nearestNode(25, 25, 3)).toBeNull();
  });

  it('finds the nearest road', () => {
    const idx = indexOf(gridNetwork(5, 5, 10));
    expect(idx.nearestEdge(15, 1, 2)?.id).toBe('h1_0');
    expect(idx.nearestEdge(15, 5, 2)).toBeNull();
  });

  it('handles very long roads spanning many cells', () => {
    const net = makeNetwork(
      [['A', 0, 0], ['B', 1, 0], ['C', 10000, 10000], ['D', 9999, 10000]],
      [{ from: 'A', to: 'C' }, { from: 'A', to: 'B' }, { from: 'C', to: 'D' }],
    );
    expect(indexOf(net).nearestEdge(5000, 5001, 3)?.id).toBe('A-C');
  });

  it('matches brute force on random maps', () => {
    const rand = seededRandom(3);
    const net = randomNetwork(rand, { nodes: 400, roads: 800, size: 1000 });
    const idx = indexOf(net);
    const byId = new Map(net.nodes.map((n) => [n.id, n]));

    for (let q = 0; q < 300; q++) {
      const x = rand() * 1000;
      const y = rand() * 1000;
      const r = 5 + rand() * 40;

      const bruteNodeDist = Math.min(...net.nodes.map((n) => Math.hypot(n.x - x, n.y - y)));
      const node = idx.nearestNode(x, y, r);
      if (bruteNodeDist <= r) expect(Math.hypot(node!.x - x, node!.y - y)).toBeCloseTo(bruteNodeDist, 9);
      else expect(node).toBeNull();

      const edgeDist = (e: GraphEdge) => {
        const a = byId.get(e.from) as GraphNode;
        const b = byId.get(e.to) as GraphNode;
        return pointSegmentDistance(x, y, a.x, a.y, b.x, b.y);
      };
      const bruteEdgeDist = Math.min(...net.edges.map(edgeDist));
      const edge = idx.nearestEdge(x, y, r);
      if (bruteEdgeDist <= r) expect(edgeDist(edge!)).toBeCloseTo(bruteEdgeDist, 9);
      else expect(edge).toBeNull();
    }
  });
});
