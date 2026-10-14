/**
 * Diffing two snapshots of the editable map, for two purposes:
 *
 * 1. Graph sync: turn the edits since the worker's last copy into small
 *    `GraphDelta`s instead of re-sending the whole graph.
 * 2. Skipping work: decide whether the current route is still optimal after
 *    those edits (closures, worse traffic or obstacles that avoid the route).
 *
 * The map store is copy-on-write, so unchanged nodes and roads keep their
 * object identity and the diff only inspects objects that actually changed.
 */

import type { GraphEdge, GraphNode, SearchResult } from '../core/graph';
import type { GraphDelta } from './protocol';

/**
 * Deltas that turn (prevNodes, prevEdges) into (nodes, edges), or null if the
 * graph's shape changed (elements added/removed, a road's endpoints or
 * direction changed) and it must be reloaded instead. Moves and distance
 * edits keep the shape, so they become moveNode / setDistance deltas.
 */
export function diffDynamic(
  prevNodes: ReadonlyMap<string, GraphNode>,
  prevEdges: ReadonlyMap<string, GraphEdge>,
  nodes: ReadonlyMap<string, GraphNode>,
  edges: ReadonlyMap<string, GraphEdge>,
): GraphDelta[] | null {
  if (prevNodes.size !== nodes.size || prevEdges.size !== edges.size) return null;
  const deltas: GraphDelta[] = [];

  if (prevNodes !== nodes) {
    for (const [id, n] of nodes) {
      const p = prevNodes.get(id);
      if (!p) return null;
      if (p === n) continue;
      if (p.x !== n.x || p.y !== n.y) deltas.push({ op: 'moveNode', nodeId: id, x: n.x, y: n.y });
      if (p.blocked !== n.blocked) deltas.push({ op: n.blocked ? 'blockNode' : 'unblockNode', nodeId: id });
    }
  }

  if (prevEdges !== edges) {
    for (const [id, e] of edges) {
      const p = prevEdges.get(id);
      if (!p) return null;
      if (p === e) continue;
      if (p.from !== e.from || p.to !== e.to || p.oneWay !== e.oneWay) return null;
      if (p.distance !== e.distance) deltas.push({ op: 'setDistance', edgeId: id, distance: e.distance });
      if (p.closed !== e.closed) deltas.push({ op: e.closed ? 'closeEdge' : 'openEdge', edgeId: id });
      if (p.trafficLevel !== e.trafficLevel) deltas.push({ op: 'setTraffic', edgeId: id, level: e.trafficLevel });
    }
  }

  return deltas;
}

/**
 * True if `result` is still optimal after `deltas`. That holds when every
 * delta only makes roads worse (close, more traffic, block) AND does not touch
 * the route: the route's own cost is unchanged and no alternative got cheaper.
 *
 * Any improvement (reopen, less traffic, unblock) may create a better route,
 * geometry edits (moves, distances) can go either way,
 * and any worsening on the route changes its cost, so all of these need a recompute.
 * If no route was found, worsening changes cannot create one, so they are safe.
 */
export function routeUnaffected(deltas: readonly GraphDelta[], result: SearchResult, prevEdges: ReadonlyMap<string, GraphEdge>): boolean {
  const roadsOnRoute = new Set(result.pathRoads);
  const nodesOnRoute = new Set(result.path);

  for (const d of deltas) {
    switch (d.op) {
      case 'closeEdge':
        if (roadsOnRoute.has(d.edgeId)) return false;
        break;
      case 'setTraffic': {
        const before = prevEdges.get(d.edgeId)?.trafficLevel;
        if (before === undefined || d.level < before || roadsOnRoute.has(d.edgeId)) return false;
        break;
      }
      case 'blockNode':
        if (nodesOnRoute.has(d.nodeId)) return false;
        break;
      case 'openEdge':
      case 'unblockNode':
      case 'moveNode':
      case 'setDistance':
        return false;
    }
  }
  return true;
}
