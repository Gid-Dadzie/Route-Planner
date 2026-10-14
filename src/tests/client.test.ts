import { describe, expect, it } from 'vitest';
import type { SearchResult } from '../core/graph';
import { RouteClient, type MapSnapshot } from '../worker/client';
import type { RouteResultResponse, WorkerRequest, WorkerResponse } from '../worker/protocol';
import type { RouteTransport } from '../worker/transport';
import { makeNetwork } from './helpers';

/** A transport whose responses the test delivers by hand, in any order. */
function manualTransport() {
  const sent: WorkerRequest[] = [];
  let listener: (m: WorkerResponse) => void = () => {};
  const transport: RouteTransport = {
    post: (m) => sent.push(m),
    onMessage: (l) => {
      listener = l;
    },
    onFatalError: () => {},
    terminate: () => {},
  };
  return { transport, sent, deliver: (m: WorkerResponse) => listener(m) };
}

const routeResult = (requestId: number, cost: number): RouteResultResponse => ({
  type: 'routeResult',
  requestId,
  algorithm: 'dijkstra',
  heuristic: 'euclidean',
  legs: 1,
  turnRestricted: false,
  found: true,
  path: ['A', 'B'],
  pathRoads: ['ab'],
  cost,
  distance: cost,
  explored: ['A', 'B'],
  nodesExplored: 2,
  timeMs: 0.1,
  method: 'search',
});

function snapshot(): MapSnapshot {
  const net = makeNetwork([['A', 0, 0], ['B', 10, 0]], [{ from: 'A', to: 'B', id: 'ab' }]);
  return { nodes: new Map(net.nodes.map((n) => [n.id, n])), edges: new Map(net.edges.map((e) => [e.id, e])) };
}

function makeClient() {
  const t = manualTransport();
  const routes: Array<[number, SearchResult]> = [];
  const errors: Array<[number, string]> = [];
  const client = new RouteClient(t.transport, {
    onRoute: (id, r) => routes.push([id, r]),
    onError: (id, m) => errors.push([id, m]),
  });
  return { ...t, client, routes, errors };
}

const query = { start: 'A', end: 'B', algorithm: 'dijkstra', heuristic: 'euclidean' } as const;

describe('RouteClient', () => {
  it('delivers only the latest response; stale ones are dropped even if they arrive last', () => {
    const c = makeClient();
    const map = snapshot();
    const id1 = c.client.findRoute(map, query);
    const id2 = c.client.findRoute(map, query);
    expect(id2).toBeGreaterThan(id1);

    c.deliver(routeResult(id2, 20));
    c.deliver(routeResult(id1, 99)); // late, stale
    expect(c.routes.map(([id, r]) => [id, r.cost])).toEqual([[id2, 20]]);
    expect(c.client.stats.staleDropped).toBe(1);
  });

  it('maps the worker response to a SearchResult', () => {
    const c = makeClient();
    const id = c.client.findRoute(snapshot(), query);
    c.deliver(routeResult(id, 10));
    expect(c.routes[0]?.[1]).toEqual({
      path: ['A', 'B'],
      pathRoads: ['ab'],
      cost: 10,
      distance: 10,
      found: true,
      exploredInOrder: ['A', 'B'],
      nodesExplored: 2,
      timeMs: 0.1,
    });
  });

  it('cancelRoute makes the in-flight response stale', () => {
    const c = makeClient();
    const id = c.client.findRoute(snapshot(), query);
    c.client.cancelRoute();
    c.deliver(routeResult(id, 10));
    expect(c.routes).toHaveLength(0);
  });

  it('loads the graph once, then sends only deltas, and nothing when unchanged', () => {
    const c = makeClient();
    const map = snapshot();
    c.client.findRoute(map, query);
    c.client.findRoute(map, query);
    expect(c.sent.map((m) => m.type)).toEqual(['loadGraph', 'findRoute', 'findRoute']);

    const edges = new Map(map.edges);
    edges.set('ab', { ...(edges.get('ab') as NonNullable<ReturnType<typeof edges.get>>), closed: true, trafficLevel: 3 });
    c.client.findRoute({ ...map, edges }, query);
    expect(c.sent.slice(3)).toEqual([
      { type: 'applyDelta', delta: { op: 'closeEdge', edgeId: 'ab' } },
      { type: 'applyDelta', delta: { op: 'setTraffic', edgeId: 'ab', level: 3 } },
      expect.objectContaining({ type: 'findRoute' }),
    ]);
  });

  it('reloads the graph when its shape changes (an intersection is added)', () => {
    const c = makeClient();
    const map = snapshot();
    c.client.findRoute(map, query);
    const nodes = new Map(map.nodes);
    nodes.set('C', { id: 'C', x: 5, y: 5, blocked: false });
    c.client.findRoute({ ...map, nodes }, query);
    expect(c.sent.filter((m) => m.type === 'loadGraph')).toHaveLength(2);
    expect(c.client.stats.graphLoads).toBe(2);
  });

  it('forwards errors for the latest request and graph errors; drops errors for stale requests', () => {
    const c = makeClient();
    const map = snapshot();
    const id1 = c.client.findRoute(map, query);
    const id2 = c.client.findRoute(map, query);
    c.deliver({ type: 'error', requestId: id1, message: 'old' });
    c.deliver({ type: 'error', requestId: id2, message: 'current' });
    c.deliver({ type: 'error', requestId: -1, message: 'bad graph' });
    expect(c.errors).toEqual([
      [id2, 'current'],
      [-1, 'bad graph'],
    ]);
    // After a graph error the next request reloads the graph.
    c.client.findRoute(map, query);
    expect(c.sent.filter((m) => m.type === 'loadGraph')).toHaveLength(2);
  });
});

describe('RouteClient: Phase 10 sync', () => {
  const twoRoads = () => {
    const net = makeNetwork([['A', 0, 0], ['B', 10, 0], ['C', 20, 0]], [{ from: 'A', to: 'B', id: 'ab' }, { from: 'B', to: 'C', id: 'bc' }]);
    return { nodes: new Map(net.nodes.map((n) => [n.id, n])), edges: new Map(net.edges.map((e) => [e.id, e])) };
  };
  const q = { start: 'A', end: 'C', algorithm: 'dijkstra' as const, heuristic: 'euclidean' as const };

  it('sends turn restrictions with the graph, then as a single delta when only they change', () => {
    const c = manualTransport();
    const client = new RouteClient(c.transport, { onRoute: () => {}, onError: () => {} });
    const map = twoRoads();
    const ban = { fromRoad: 'ab', via: 'B', toRoad: 'bc' };
    client.findRoute({ ...map, turnRestrictions: new Map([['k', ban]]) }, q);
    expect(c.sent[0]).toMatchObject({ type: 'loadGraph', graph: { turnRestrictions: [ban] } });

    client.findRoute({ ...map, turnRestrictions: new Map() }, q);
    expect(c.sent.slice(2)).toEqual([
      { type: 'applyDelta', delta: { op: 'setTurnRestrictions', restrictions: [] } },
      expect.objectContaining({ type: 'findRoute' }),
    ]);
  });

  it('batches large delta bursts into one applyDeltas message', () => {
    const c = manualTransport();
    const client = new RouteClient(c.transport, { onRoute: () => {}, onError: () => {} });
    const nodes = new Map(Array.from({ length: 60 }, (_, i) => [`n${i}`, { id: `n${i}`, x: i * 10, y: 0, blocked: false }]));
    const edges = new Map(
      Array.from({ length: 59 }, (_, i) => [`r${i}`, { id: `r${i}`, from: `n${i}`, to: `n${i + 1}`, distance: 10, trafficLevel: 1 as const, oneWay: false, closed: false }]),
    );
    client.findRoute({ nodes, edges }, { ...q, start: 'n0', end: 'n59' });
    const heavy = new Map([...edges].map(([id, e]) => [id, { ...e, trafficLevel: 3 as const }]));
    client.findRoute({ nodes, edges: heavy }, { ...q, start: 'n0', end: 'n59' });
    const batch = c.sent.filter((m) => m.type === 'applyDeltas');
    expect(batch).toHaveLength(1);
    expect(batch[0]?.type === 'applyDeltas' && batch[0].deltas).toHaveLength(59);
    expect(c.sent.some((m) => m.type === 'applyDelta')).toBe(false);
  });

  it('sends waypoints only when there are some, and drops stale alternatives', () => {
    const c = manualTransport();
    const alts: number[] = [];
    const client = new RouteClient(c.transport, { onRoute: () => {}, onError: () => {}, onAlternatives: (id) => alts.push(id) });
    const map = twoRoads();
    client.findRoute(map, { ...q, waypoints: [] });
    client.findRoute(map, { ...q, waypoints: ['B'] });
    const routes = c.sent.filter((m) => m.type === 'findRoute');
    expect(routes[0]).not.toHaveProperty('waypoints');
    expect(routes[1]).toMatchObject({ waypoints: ['B'] });

    const old = client.findAlternatives(map, 'A', 'C', 3);
    const latest = client.findAlternatives(map, 'A', 'C', 3);
    const reply = (requestId: number) => c.deliver({ type: 'alternativesResult', requestId, routes: [], spurSearches: 0, timeMs: 0 });
    reply(old);
    reply(latest);
    expect(alts).toEqual([latest]);
  });
});
