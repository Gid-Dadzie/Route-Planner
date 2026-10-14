import { describe, expect, it } from 'vitest';
import { dijkstra } from '../core/dijkstra';
import { compileGraph, setRoadClosed, type RoadNetwork } from '../core/graph';
import { PathEngine, type EngineOptions } from '../worker/engine';
import type { AlternativesResultResponse, RouteResultResponse, WorkerResponse } from '../worker/protocol';
import { generateGridMap } from '../utils/mapGenerator';
import { gridNetwork, makeNetwork } from './helpers';

/** setTimeout-based yield: slow enough that messages reliably interleave with searches. */
const macrotask = () => new Promise<void>((r) => setTimeout(r, 0));

function makeEngine(options: EngineOptions = {}) {
  const posts: WorkerResponse[] = [];
  const engine = new PathEngine((m) => posts.push(m), { yieldToEventLoop: macrotask, ...options });
  const routeResults = () => posts.filter((m): m is RouteResultResponse => m.type === 'routeResult');
  const idle = async () => {
    while (engine.busy) await macrotask();
  };
  return { engine, posts, routeResults, idle };
}

const big = (): RoadNetwork => gridNetwork(100, 100, 10);

describe('PathEngine', () => {
  it('answers findRoute with the same route as Dijkstra on the main thread', async () => {
    const { engine, routeResults, idle } = makeEngine();
    const net = gridNetwork(20, 20);
    engine.handle({ type: 'loadGraph', graph: net });
    engine.handle({ type: 'findRoute', requestId: 1, start: 'g0_0', end: 'g19_19', algorithm: 'astar' });
    await idle();
    const [r] = routeResults();
    const expected = dijkstra(compileGraph(net), 'g0_0', 'g19_19');
    expect(r).toMatchObject({ requestId: 1, algorithm: 'astar', heuristic: 'euclidean', found: true, cost: expected.cost });
    expect(r?.explored[0]).toBe('g0_0');
  });

  it('time-slices long searches, yielding to the event loop', async () => {
    const sliced = makeEngine({ sliceMs: 0, checkEvery: 100 });
    sliced.engine.handle({ type: 'loadGraph', graph: big() });
    sliced.engine.handle({ type: 'findRoute', requestId: 1, start: 'g0_0', end: 'g99_99', algorithm: 'dijkstra' });
    await sliced.idle();
    expect(sliced.engine.stats.yields).toBeGreaterThanOrEqual(99); // ~10,000 expansions / 100

    const unsliced = makeEngine({ sliceMs: Infinity, checkEvery: 100 });
    unsliced.engine.handle({ type: 'loadGraph', graph: big() });
    unsliced.engine.handle({ type: 'findRoute', requestId: 1, start: 'g0_0', end: 'g99_99', algorithm: 'dijkstra' });
    await unsliced.idle();
    expect(unsliced.engine.stats.yields).toBe(0);
    expect(unsliced.routeResults()[0]?.cost).toBe(sliced.routeResults()[0]?.cost);
  });

  it('cancels a superseded search at its next checkpoint and answers only the newest request', async () => {
    const { engine, routeResults, idle } = makeEngine({ sliceMs: 0, checkEvery: 100 });
    engine.handle({ type: 'loadGraph', graph: big() });
    engine.handle({ type: 'findRoute', requestId: 1, start: 'g0_0', end: 'g99_99', algorithm: 'dijkstra' });
    engine.handle({ type: 'findRoute', requestId: 2, start: 'g0_0', end: 'g5_5', algorithm: 'dijkstra' });
    await idle();

    expect(routeResults().map((r) => r.requestId)).toEqual([2]);
    expect(engine.stats).toMatchObject({ started: 2, completed: 1, cancelled: 1 });
    // Request 1 stopped after its first slice instead of running all ~100 slices.
    expect(engine.stats.yields).toBeLessThan(10);
  });

  it('cancels a stale search even when the newer request arrives mid-search', async () => {
    const { engine, routeResults, idle } = makeEngine({ sliceMs: 0, checkEvery: 100 });
    engine.handle({ type: 'loadGraph', graph: big() });
    engine.handle({ type: 'findRoute', requestId: 1, start: 'g0_0', end: 'g99_99', algorithm: 'dijkstra' });
    for (let i = 0; i < 5; i++) await macrotask(); // let request 1 get going
    engine.handle({ type: 'findRoute', requestId: 2, start: 'g99_0', end: 'g0_99', algorithm: 'dijkstra' });
    await idle();
    expect(routeResults().map((r) => r.requestId)).toEqual([2]);
    expect(engine.stats.cancelled).toBe(1);
  });

  it('restarts a paused search when the graph changes, so the result reflects the change', async () => {
    const { engine, routeResults, idle } = makeEngine({ sliceMs: 0, checkEvery: 100 });
    const net = big();
    engine.handle({ type: 'loadGraph', graph: net });
    engine.handle({ type: 'findRoute', requestId: 1, start: 'g0_0', end: 'g99_0', algorithm: 'dijkstra' });
    // Close a road on the straight top-row route while the search is paused.
    engine.handle({ type: 'applyDelta', delta: { op: 'closeEdge', edgeId: 'h50_0' } });
    await idle();

    const g = compileGraph(net);
    setRoadClosed(g, 'h50_0', true);
    const [r] = routeResults();
    expect(engine.stats.restarted).toBe(1);
    expect(r?.cost).toBe(dijkstra(g, 'g0_0', 'g99_0').cost);
    expect(r?.pathRoads).not.toContain('h50_0');
  });

  it('applies every delta type', async () => {
    const { engine, routeResults, idle } = makeEngine();
    const net = makeNetwork(
      [['A', 0, 0], ['B', 10, 0], ['C', 20, 0], ['D', 10, 10]],
      [
        { from: 'A', to: 'B', id: 'ab' },
        { from: 'B', to: 'C', id: 'bc' },
        { from: 'A', to: 'D', id: 'ad', distance: 15 },
        { from: 'D', to: 'C', id: 'dc', distance: 15 },
      ],
    );
    engine.handle({ type: 'loadGraph', graph: net });
    const find = (id: number) => engine.handle({ type: 'findRoute', requestId: id, start: 'A', end: 'C', algorithm: 'dijkstra' });

    engine.handle({ type: 'applyDelta', delta: { op: 'closeEdge', edgeId: 'bc' } });
    find(1);
    engine.handle({ type: 'applyDelta', delta: { op: 'openEdge', edgeId: 'bc' } });
    engine.handle({ type: 'applyDelta', delta: { op: 'setTraffic', edgeId: 'ab', level: 4 } });
    find(2);
    engine.handle({ type: 'applyDelta', delta: { op: 'setTraffic', edgeId: 'ab', level: 1 } });
    engine.handle({ type: 'applyDelta', delta: { op: 'blockNode', nodeId: 'B' } });
    find(3);
    engine.handle({ type: 'applyDelta', delta: { op: 'unblockNode', nodeId: 'B' } });
    find(4);
    await idle();
    // Each findRoute is answered (each is the latest when it runs to completion synchronously).
    expect(routeResults().map((r) => [r.requestId, r.cost])).toEqual([
      [1, 30],
      [2, 30],
      [3, 30],
      [4, 20],
    ]);
  });

  it('applies geometry deltas: setDistance changes costs, moveNode feeds the A* heuristic', async () => {
    const { engine, routeResults, idle } = makeEngine();
    const net = makeNetwork(
      [['A', 0, 0], ['B', 10, 0], ['C', 20, 0], ['D', 10, 10]],
      [
        { from: 'A', to: 'B', id: 'ab' },
        { from: 'B', to: 'C', id: 'bc' },
        { from: 'A', to: 'D', id: 'ad', distance: 15 },
        { from: 'D', to: 'C', id: 'dc', distance: 15 },
      ],
    );
    engine.handle({ type: 'loadGraph', graph: net });
    engine.handle({ type: 'applyDelta', delta: { op: 'setDistance', edgeId: 'bc', distance: 100 } });
    engine.handle({ type: 'findRoute', requestId: 1, start: 'A', end: 'C', algorithm: 'astar' });
    // Move C far away and lengthen its roads to match: A* must still be exact.
    engine.handle({ type: 'applyDelta', delta: { op: 'moveNode', nodeId: 'C', x: 200, y: 0 } });
    engine.handle({ type: 'applyDelta', delta: { op: 'setDistance', edgeId: 'bc', distance: 190 } });
    engine.handle({ type: 'applyDelta', delta: { op: 'setDistance', edgeId: 'dc', distance: 190.3 } });
    engine.handle({ type: 'findRoute', requestId: 2, start: 'A', end: 'C', algorithm: 'astar' });
    await idle();
    expect(routeResults().map((r) => [r.requestId, r.path.join(''), r.cost])).toEqual([
      [1, 'ADC', 30],
      [2, 'ABC', 200],
    ]);
  });

  it('answers "no route" from the reachability check without running the search', async () => {
    const { engine, routeResults, idle } = makeEngine();
    engine.handle({ type: 'loadGraph', graph: big() });
    // Wall off the bottom-right corner node.
    engine.handle({ type: 'applyDelta', delta: { op: 'closeEdge', edgeId: 'h98_99' } });
    engine.handle({ type: 'applyDelta', delta: { op: 'closeEdge', edgeId: 'v99_98' } });
    engine.handle({ type: 'findRoute', requestId: 1, start: 'g0_0', end: 'g99_99', algorithm: 'dijkstra' });
    engine.handle({ type: 'findRoute', requestId: 2, start: 'g0_0', end: 'g50_50', algorithm: 'dijkstra' });
    await idle();
    const [none, found] = routeResults();
    expect(none).toMatchObject({ requestId: 1, found: false, method: 'reachability', nodesExplored: 9999 });
    expect({ ...none?.noRoute, closedRoads: [...(none?.noRoute?.closedRoads ?? [])].sort() }).toEqual({
      reason: 'unreachable',
      side: 'end',
      region: ['g99_99'],
      closedRoads: ['h98_99', 'v99_98'],
      oneWayRoads: [],
      blockedNodes: [],
      startSideCount: 9999,
    });
    expect(found).toMatchObject({ requestId: 2, found: true, method: 'search' });
    expect(found?.noRoute).toBeUndefined();
    expect(engine.stats.reachabilityShortcuts).toBe(1);
    // The no-route answer never entered the time-sliced search (only request 2 yielded).
    expect(engine.stats.cancelled + engine.stats.restarted).toBe(0);
  });

  it('analyze reports regions and isolated intersections', async () => {
    const { engine, posts } = makeEngine();
    const net = gridNetwork(3, 3);
    net.nodes.push({ id: 'lonely', x: 100, y: 100, blocked: false });
    engine.handle({ type: 'loadGraph', graph: net });
    engine.handle({ type: 'applyDelta', delta: { op: 'blockNode', nodeId: 'g1_1' } });
    engine.handle({ type: 'analyze', requestId: 7 });
    expect(posts.at(-1)).toEqual({ type: 'analysisResult', requestId: 7, regions: 2, largestRegion: 8, isolated: ['lonely'], blocked: 1, usable: 9 });
  });

  it('reports errors: invalid graph, missing graph, unknown node, unavailable algorithm', async () => {
    const { engine, posts, idle } = makeEngine();
    engine.handle({ type: 'findRoute', requestId: 1, start: 'A', end: 'B', algorithm: 'dijkstra' });
    engine.handle({ type: 'loadGraph', graph: makeNetwork([['A', 0, 0], ['B', 10, 0]], [{ from: 'A', to: 'B', distance: 1 }]) });
    engine.handle({ type: 'loadGraph', graph: makeNetwork([['A', 0, 0], ['B', 10, 0]], [{ from: 'A', to: 'B' }]) });
    engine.handle({ type: 'findRoute', requestId: 2, start: 'A', end: 'Z', algorithm: 'dijkstra' });
    engine.handle({ type: 'findRoute', requestId: 3, start: 'A', end: 'B', algorithm: 'teleport' as never });
    await idle();
    const errors = posts.filter((m) => m.type === 'error').map((m) => [m.requestId, m.type === 'error' ? m.message : '']);
    expect(errors).toEqual([
      [1, 'No graph loaded.'],
      [-1, expect.stringMatching(/shorter than its straight-line length/)],
      [2, 'Unknown intersection "Z"'],
      [3, 'Algorithm "teleport" is not available.'],
    ]);
  });

  it('compareAll runs every available algorithm and they agree on the cost', async () => {
    const { engine, posts, idle } = makeEngine();
    engine.handle({ type: 'loadGraph', graph: gridNetwork(15, 15) });
    engine.handle({ type: 'compareAll', requestId: 1, start: 'g0_7', end: 'g14_7' });
    await idle();
    const msg = posts.find((m) => m.type === 'compareResult');
    expect(msg?.type === 'compareResult' && msg.results.map((r) => [r.algorithm, r.heuristic, r.cost])).toEqual([
      ['dijkstra', null, 140],
      ['astar', 'euclidean', 140],
      ['bidirectional', null, 140],
      ['dstarlite', null, 140],
    ]);
  });
});

describe('PathEngine: compareAll options', () => {
  it('includes A* (Manhattan) on request, times repeated runs, and reports route size', async () => {
    const { engine, posts, idle } = makeEngine();
    // Diagonal shortcut map where Manhattan overestimates (see astar.test.ts).
    engine.handle({
      type: 'loadGraph',
      graph: makeNetwork([['S', 0, 0], ['M', 5, 5], ['G', 10, 10]], [{ from: 'S', to: 'M' }, { from: 'M', to: 'G' }, { from: 'S', to: 'G', distance: 16 }]),
    });
    engine.handle({ type: 'compareAll', requestId: 1, start: 'S', end: 'G', includeManhattan: true, repeats: 3 });
    await idle();
    const msg = posts.find((m) => m.type === 'compareResult');
    if (msg?.type !== 'compareResult') throw new Error('no compare result');
    expect(msg.results.map((r) => [r.algorithm, r.heuristic, r.intersections])).toEqual([
      ['dijkstra', null, 3],
      ['astar', 'euclidean', 3],
      ['astar', 'manhattan', 2],
      ['bidirectional', null, 3],
      ['dstarlite', null, 3],
    ]);
    expect(msg.results[2]?.cost).toBe(16);
    expect(msg.results[0]?.cost).toBeCloseTo(Math.hypot(10, 10), 9);
    // 4 algorithms + Manhattan, each 1 warm-up + 3 timed runs = 20 searches, one compare job.
    expect(engine.stats.started).toBe(1);
  });

  it('a newer comparison cancels an older one', async () => {
    const { engine, posts, idle } = makeEngine({ sliceMs: 0, checkEvery: 200 });
    engine.handle({ type: 'loadGraph', graph: big() });
    engine.handle({ type: 'compareAll', requestId: 1, start: 'g0_0', end: 'g99_99', repeats: 1 });
    engine.handle({ type: 'compareAll', requestId: 2, start: 'g0_0', end: 'g5_5', repeats: 1 });
    await idle();
    expect(posts.filter((m) => m.type === 'compareResult').map((m) => m.requestId)).toEqual([2]);
  });
});

describe('PathEngine: Phase 10 (waypoints, turn restrictions, D* Lite, alternatives)', () => {
  /*
   *   A --10-- B --10-- C        A-B-C = 20
   *    \               /         A-D-C = 30
   *     15           15
   *       \         /
   *        -- D ---
   */
  const diamond = () =>
    makeNetwork(
      [['A', 0, 0], ['B', 10, 0], ['C', 20, 0], ['D', 10, 10]],
      [
        { from: 'A', to: 'B', id: 'ab', distance: 10 },
        { from: 'B', to: 'C', id: 'bc', distance: 10 },
        { from: 'A', to: 'D', id: 'ad', distance: 15 },
        { from: 'D', to: 'C', id: 'dc', distance: 15 },
      ],
    );

  it('routes through waypoints leg by leg', async () => {
    const { engine, routeResults, idle } = makeEngine();
    engine.handle({ type: 'loadGraph', graph: diamond() });
    engine.handle({ type: 'findRoute', requestId: 1, start: 'A', end: 'C', algorithm: 'astar', waypoints: ['D'] });
    await idle();
    const [r] = routeResults();
    expect(r).toMatchObject({ found: true, path: ['A', 'D', 'C'], pathRoads: ['ad', 'dc'], cost: 30, distance: 30, legs: 2, turnRestricted: false });
  });

  it('a route may pass the same intersection on different legs', async () => {
    const { engine, routeResults, idle } = makeEngine();
    engine.handle({ type: 'loadGraph', graph: diamond() });
    engine.handle({ type: 'findRoute', requestId: 1, start: 'A', end: 'A', algorithm: 'dijkstra', waypoints: ['C'] });
    await idle();
    expect(routeResults()[0]).toMatchObject({ found: true, path: ['A', 'B', 'C', 'B', 'A'], cost: 40, legs: 2 });
  });

  it('names the leg that has no route', async () => {
    const { engine, routeResults, idle } = makeEngine();
    const net = diamond();
    net.nodes.push({ id: 'Z', x: 50, y: 50, blocked: false });
    engine.handle({ type: 'loadGraph', graph: net });
    engine.handle({ type: 'findRoute', requestId: 1, start: 'A', end: 'Z', algorithm: 'dijkstra', waypoints: ['C'] });
    await idle();
    expect(routeResults()[0]).toMatchObject({ found: false, method: 'reachability', legs: 2, failedLeg: 1 });
  });

  it('enforces turn restrictions sent with the graph and as a delta', async () => {
    const { engine, routeResults, idle } = makeEngine();
    // Ban the turn A-B -> B-C at B: the route must go round via D.
    const ban = { fromRoad: 'ab', via: 'B', toRoad: 'bc' };
    engine.handle({ type: 'loadGraph', graph: { ...diamond(), turnRestrictions: [ban] } });
    engine.handle({ type: 'findRoute', requestId: 1, start: 'A', end: 'C', algorithm: 'bidirectional' });
    await idle();
    expect(routeResults()[0]).toMatchObject({ found: true, path: ['A', 'D', 'C'], cost: 30, turnRestricted: true });

    engine.handle({ type: 'applyDelta', delta: { op: 'setTurnRestrictions', restrictions: [] } });
    engine.handle({ type: 'findRoute', requestId: 2, start: 'A', end: 'C', algorithm: 'bidirectional' });
    await idle();
    expect(routeResults()[1]).toMatchObject({ found: true, path: ['A', 'B', 'C'], cost: 20, turnRestricted: false });
  });

  it('reports "only via banned turns" when the goal is reachable but every way is banned', async () => {
    const { engine, routeResults, idle } = makeEngine();
    engine.handle({ type: 'loadGraph', graph: { ...diamond(), turnRestrictions: [{ fromRoad: 'ab', via: 'B', toRoad: 'bc' }, { fromRoad: 'ad', via: 'D', toRoad: 'dc' }] } });
    engine.handle({ type: 'findRoute', requestId: 1, start: 'A', end: 'C', algorithm: 'dijkstra' });
    await idle();
    expect(routeResults()[0]).toMatchObject({ found: false, method: 'search', noRoute: { reason: 'turn-restrictions' } });
  });

  it('D* Lite keeps its search: repeats cost nothing, closures are repaired, results match Dijkstra', async () => {
    const { engine, routeResults, idle } = makeEngine();
    const net = generateGridMap({ cols: 40, rows: 40, seed: 2 });
    engine.handle({ type: 'loadGraph', graph: net.network });
    const ask = async (id: number) => {
      engine.handle({ type: 'findRoute', requestId: id, start: net.start, end: net.end, algorithm: 'dstarlite' });
      await idle();
      return routeResults().at(-1) as RouteResultResponse;
    };
    const first = await ask(1);
    expect(first).toMatchObject({ found: true, reused: false });

    const again = await ask(2);
    expect(again).toMatchObject({ reused: true, nodesExplored: 0, cost: first.cost });

    // Close a road near the start of the route.
    const road = first.pathRoads[2] as string;
    engine.handle({ type: 'applyDelta', delta: { op: 'closeEdge', edgeId: road } });
    const repaired = await ask(3);
    const g = compileGraph(net.network);
    setRoadClosed(g, road, true);
    expect(repaired.reused).toBe(true);
    expect(repaired.cost).toBeCloseTo(dijkstra(g, net.start, net.end).cost, 9);
    expect(repaired.pathRoads).not.toContain(road);
    expect(repaired.nodesExplored).toBeLessThan(first.nodesExplored);
    expect(engine.stats.incrementalReuses).toBe(2);

    // Moving an intersection changes the heuristic: the next search starts afresh.
    engine.handle({ type: 'applyDelta', delta: { op: 'moveNode', nodeId: net.start, x: -5, y: -5 } });
    expect(await ask(4)).toMatchObject({ reused: false });
  });

  it('finds alternative routes, cheapest first (respecting turn restrictions)', async () => {
    const { engine, posts, idle } = makeEngine();
    engine.handle({ type: 'loadGraph', graph: diamond() });
    engine.handle({ type: 'findAlternatives', requestId: 1, start: 'A', end: 'C', k: 3 });
    await idle();
    const alt = posts.find((m): m is AlternativesResultResponse => m.type === 'alternativesResult');
    expect(alt?.routes.map((r) => [r.path, r.cost, r.distance])).toEqual([
      [['A', 'B', 'C'], 20, 20],
      [['A', 'D', 'C'], 30, 30],
    ]);

    engine.handle({ type: 'applyDelta', delta: { op: 'setTurnRestrictions', restrictions: [{ fromRoad: 'ab', via: 'B', toRoad: 'bc' }] } });
    engine.handle({ type: 'findAlternatives', requestId: 2, start: 'A', end: 'C', k: 3 });
    await idle();
    const restricted = posts.filter((m): m is AlternativesResultResponse => m.type === 'alternativesResult').at(-1);
    expect(restricted?.routes.map((r) => r.path)).toEqual([['A', 'D', 'C']]);
  });

  it('D* Lite starts afresh after a bulk change (cheaper than repairing most of the search)', async () => {
    const { engine, routeResults, idle } = makeEngine();
    const net = generateGridMap({ cols: 30, rows: 30, seed: 4 });
    engine.handle({ type: 'loadGraph', graph: net.network });
    const ask = async (id: number) => {
      engine.handle({ type: 'findRoute', requestId: id, start: net.start, end: net.end, algorithm: 'dstarlite' });
      await idle();
      return routeResults().at(-1) as RouteResultResponse;
    };
    await ask(1);
    engine.handle({ type: 'applyDeltas', deltas: net.network.edges.map((e) => ({ op: 'setTraffic' as const, edgeId: e.id, level: 3 as const })) });
    const after = await ask(2);
    const g = compileGraph(net.network);
    for (const e of net.network.edges) g.roadCost[g.roadIndex.get(e.id) as number] = e.distance * 2.5;
    expect(after.reused).toBe(false);
    expect(after.cost).toBeCloseTo(dijkstra(g, net.start, net.end).cost, 9);
  });

  it('applies a batch of deltas in one message', async () => {
    const { engine, routeResults, idle } = makeEngine();
    engine.handle({ type: 'loadGraph', graph: diamond() });
    engine.handle({
      type: 'applyDeltas',
      deltas: [
        { op: 'setTraffic', edgeId: 'ab', level: 4 },
        { op: 'setTraffic', edgeId: 'bc', level: 4 },
      ],
    });
    engine.handle({ type: 'findRoute', requestId: 1, start: 'A', end: 'C', algorithm: 'dijkstra' });
    await idle();
    expect(routeResults()[0]).toMatchObject({ path: ['A', 'D', 'C'], cost: 30 });
  });

  it('compareAll with waypoints and turn restrictions: every optimal algorithm agrees', async () => {
    const { engine, posts, idle } = makeEngine();
    const net = generateGridMap({ cols: 15, rows: 15, seed: 6 });
    const via = (net.network.nodes[112] as { id: string }).id;
    // Ban one turn from each road arriving at the waypoint.
    const roadsAtVia = net.network.edges.filter((e) => e.from === via || e.to === via);
    const restrictions = roadsAtVia.flatMap((a) =>
      roadsAtVia
        .filter((b) => b !== a)
        .slice(0, 1)
        .map((b) => ({ fromRoad: a.id, via, toRoad: b.id })),
    );
    engine.handle({ type: 'loadGraph', graph: { ...net.network, turnRestrictions: restrictions } });
    engine.handle({ type: 'compareAll', requestId: 1, start: net.start, end: net.end, waypoints: [via], repeats: 1 });
    await idle();
    const msg = posts.find((m) => m.type === 'compareResult');
    if (msg?.type !== 'compareResult') throw new Error('no compare result');
    expect(msg.results.map((r) => r.algorithm)).toEqual(['dijkstra', 'astar', 'bidirectional', 'dstarlite']);
    const costs = msg.results.map((r) => r.cost);
    expect(Number.isFinite(costs[0])).toBe(true);
    for (const c of costs) expect(c).toBeCloseTo(costs[0] as number, 9);
  });
});
