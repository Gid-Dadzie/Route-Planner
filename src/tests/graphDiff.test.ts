import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode, SearchResult } from '../core/graph';
import { diffDynamic, routeUnaffected } from '../worker/graphDiff';
import type { GraphDelta } from '../worker/protocol';
import { makeNetwork } from './helpers';

function maps() {
  const net = makeNetwork(
    [['A', 0, 0], ['B', 10, 0], ['C', 20, 0]],
    [
      { from: 'A', to: 'B', id: 'ab', traffic: 2 },
      { from: 'B', to: 'C', id: 'bc' },
    ],
  );
  return {
    nodes: new Map<string, GraphNode>(net.nodes.map((n) => [n.id, n])),
    edges: new Map<string, GraphEdge>(net.edges.map((e) => [e.id, e])),
  };
}

const edit = <T extends object>(m: Map<string, T>, id: string, patch: Partial<T>) => {
  const copy = new Map(m);
  copy.set(id, { ...(m.get(id) as T), ...patch });
  return copy;
};

describe('diffDynamic', () => {
  it('returns no deltas for identical snapshots', () => {
    const { nodes, edges } = maps();
    expect(diffDynamic(nodes, edges, nodes, edges)).toEqual([]);
  });

  it('emits closures, traffic and obstacle changes', () => {
    const { nodes, edges } = maps();
    const e2 = edit(edit(edges, 'ab', { closed: true }), 'bc', { trafficLevel: 4 });
    const n2 = edit(nodes, 'B', { blocked: true });
    expect(diffDynamic(nodes, edges, n2, e2)).toEqual([
      { op: 'blockNode', nodeId: 'B' },
      { op: 'closeEdge', edgeId: 'ab' },
      { op: 'setTraffic', edgeId: 'bc', level: 4 },
    ]);
  });

  it('ignores label changes', () => {
    const { nodes, edges } = maps();
    expect(diffDynamic(nodes, edges, edit(nodes, 'A', { label: 'Home' }), edges)).toEqual([]);
  });

  it('turns moves and distance edits into geometry deltas (the graph keeps its shape)', () => {
    const { nodes, edges } = maps();
    expect(diffDynamic(nodes, edges, edit(nodes, 'A', { x: -5, y: 2 }), edit(edges, 'ab', { distance: 99 }))).toEqual([
      { op: 'moveNode', nodeId: 'A', x: -5, y: 2 },
      { op: 'setDistance', edgeId: 'ab', distance: 99 },
    ]);
  });

  it('returns null when the shape changes: added/removed elements, endpoints or direction', () => {
    const { nodes, edges } = maps();
    expect(diffDynamic(nodes, edges, nodes, edit(edges, 'ab', { oneWay: true }))).toBeNull();
    expect(diffDynamic(nodes, edges, nodes, edit(edges, 'ab', { from: 'B', to: 'A' }))).toBeNull();
    const fewer = new Map(edges);
    fewer.delete('bc');
    expect(diffDynamic(nodes, edges, nodes, fewer)).toBeNull();
    const more = new Map(nodes);
    more.set('D', { id: 'D', x: 5, y: 5, blocked: false });
    expect(diffDynamic(nodes, edges, more, edges)).toBeNull();
  });
});

describe('routeUnaffected', () => {
  const route: SearchResult = {
    path: ['A', 'B'],
    pathRoads: ['ab'],
    cost: 15,
    distance: 10,
    found: true,
    exploredInOrder: [],
    nodesExplored: 0,
    timeMs: 0,
  };
  const { edges } = maps(); // ab at level 2, bc at level 1
  const check = (...deltas: GraphDelta[]) => routeUnaffected(deltas, route, edges);

  it('worsening changes off the route are safe to skip', () => {
    expect(check({ op: 'closeEdge', edgeId: 'bc' })).toBe(true);
    expect(check({ op: 'setTraffic', edgeId: 'bc', level: 3 })).toBe(true);
    expect(check({ op: 'blockNode', nodeId: 'C' })).toBe(true);
    expect(check()).toBe(true);
  });

  it('any change on the route needs a recompute', () => {
    expect(check({ op: 'closeEdge', edgeId: 'ab' })).toBe(false);
    expect(check({ op: 'setTraffic', edgeId: 'ab', level: 4 })).toBe(false);
    expect(check({ op: 'blockNode', nodeId: 'B' })).toBe(false);
  });

  it('any improvement needs a recompute', () => {
    expect(check({ op: 'openEdge', edgeId: 'bc' })).toBe(false);
    expect(check({ op: 'unblockNode', nodeId: 'C' })).toBe(false);
    expect(check({ op: 'setTraffic', edgeId: 'ab', level: 1 })).toBe(false);
  });

  it('geometry edits always need a recompute', () => {
    expect(check({ op: 'moveNode', nodeId: 'C', x: 1, y: 1 })).toBe(false);
    expect(check({ op: 'setDistance', edgeId: 'bc', distance: 50 })).toBe(false);
  });

  it('one bad delta in a batch is enough', () => {
    expect(check({ op: 'closeEdge', edgeId: 'bc' }, { op: 'closeEdge', edgeId: 'ab' })).toBe(false);
  });

  it('without a route, worsening changes cannot create one', () => {
    const none: SearchResult = { ...route, found: false, path: [], pathRoads: [] };
    expect(routeUnaffected([{ op: 'closeEdge', edgeId: 'ab' }], none, edges)).toBe(true);
    expect(routeUnaffected([{ op: 'openEdge', edgeId: 'ab' }], none, edges)).toBe(false);
  });
});
