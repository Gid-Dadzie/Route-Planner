/**
 * Save and load maps as JSON.
 *
 * File format (version 1):
 *   {
 *     "format": "route-planner-map", "version": 1, "savedAt": "2026-10-14T…",
 *     "nodes": [{ "id", "x", "y", "blocked", "label"? }],
 *     "edges": [{ "id", "from", "to", "distance", "trafficLevel", "oneWay", "closed" }],
 *     "start": id | null, "end": id | null, "waypoints": [id],
 *     "turnRestrictions": [{ "fromRoad", "via", "toRoad" }]
 *   }
 *
 * Loading is forgiving where it is safe and strict where it is not:
 * - A bare `{ nodes, edges }` object is accepted too.
 * - Missing flags default to false, a missing traffic level to 1 and a missing
 *   distance to the straight-line length.
 * - A distance below the straight-line length is raised to it (with a
 *   warning), because a shorter one would make the A* heuristic overestimate.
 * - Pins, waypoints and turn restrictions that point at missing elements are
 *   dropped with a warning.
 * - Anything structural (bad JSON, missing ids or coordinates, duplicate ids,
 *   roads to missing intersections, self-loops, bad traffic levels) is an
 *   error, and nothing is loaded.
 */

import { isTrafficLevel, minAllowedDistance, validateNetwork, type GraphEdge, type GraphNode, type RoadNetwork } from '../core/graph';
import type { TurnRestriction } from '../core/turns';

export const MAP_FORMAT = 'route-planner-map';
export const MAP_FORMAT_VERSION = 1;

export interface SavedMap {
  format: typeof MAP_FORMAT;
  version: number;
  savedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  start: string | null;
  end: string | null;
  waypoints: string[];
  turnRestrictions: TurnRestriction[];
}

export interface MapDocument {
  network: RoadNetwork;
  start: string | null;
  end: string | null;
  waypoints: string[];
  turnRestrictions: TurnRestriction[];
}

export type ParseResult = { ok: true; map: MapDocument; warnings: string[] } | { ok: false; errors: string[] };

/** Most errors listed before "...and N more". */
const MAX_LISTED = 8;

/** Serializes a map. Small maps are indented for readability; large ones are compact. */
export function serializeMap(map: MapDocument, savedAt: Date = new Date()): string {
  const doc: SavedMap = {
    format: MAP_FORMAT,
    version: MAP_FORMAT_VERSION,
    savedAt: savedAt.toISOString(),
    nodes: map.network.nodes,
    edges: map.network.edges,
    start: map.start,
    end: map.end,
    waypoints: map.waypoints,
    turnRestrictions: map.turnRestrictions,
  };
  return JSON.stringify(doc, null, map.network.nodes.length <= 500 ? 2 : undefined);
}

export function parseMap(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!isObject(data)) return { ok: false, errors: ['Expected a JSON object with "nodes" and "edges".'] };
  if ('format' in data && data.format !== MAP_FORMAT) return { ok: false, errors: [`Unknown file format "${String(data.format)}".`] };
  if (typeof data.version === 'number' && data.version > MAP_FORMAT_VERSION) {
    return { ok: false, errors: [`This file was saved by a newer version (format ${data.version}); this app reads format ${MAP_FORMAT_VERSION}.`] };
  }
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) return { ok: false, errors: ['Expected "nodes" and "edges" arrays.'] };

  const errors: string[] = [];
  const warnings: string[] = [];

  // ---- Intersections ----
  const nodes: GraphNode[] = [];
  data.nodes.forEach((raw, i) => {
    const where = `Intersection #${i + 1}`;
    if (!isObject(raw)) return void errors.push(`${where} is not an object.`);
    if (typeof raw.id !== 'string' || raw.id === '') return void errors.push(`${where} needs a non-empty string "id".`);
    if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y)) return void errors.push(`Intersection "${raw.id}" needs numeric "x" and "y".`);
    const node: GraphNode = { id: raw.id, x: raw.x, y: raw.y, blocked: raw.blocked === true };
    if (typeof raw.label === 'string' && raw.label.trim()) node.label = raw.label.trim();
    nodes.push(node);
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // ---- Roads ----
  const edges: GraphEdge[] = [];
  let raised = 0;
  data.edges.forEach((raw, i) => {
    const where = `Road #${i + 1}`;
    if (!isObject(raw)) return void errors.push(`${where} is not an object.`);
    if (typeof raw.id !== 'string' || raw.id === '') return void errors.push(`${where} needs a non-empty string "id".`);
    if (typeof raw.from !== 'string' || typeof raw.to !== 'string') return void errors.push(`Road "${raw.id}" needs string "from" and "to".`);
    const level = raw.trafficLevel ?? 1;
    if (!isTrafficLevel(level)) return void errors.push(`Road "${raw.id}" has traffic level ${JSON.stringify(level)}; expected 1, 2, 3 or 4.`);
    if (raw.distance !== undefined && !isFiniteNumber(raw.distance)) return void errors.push(`Road "${raw.id}" has a non-numeric distance.`);

    const a = byId.get(raw.from);
    const b = byId.get(raw.to);
    // Endpoint problems are reported once, by validateNetwork below.
    const min = a && b ? minAllowedDistance(a, b) : 1;
    let distance = (raw.distance as number | undefined) ?? min;
    if (distance < min) {
      distance = min;
      raised++;
    }
    edges.push({ id: raw.id, from: raw.from, to: raw.to, distance, trafficLevel: level, oneWay: raw.oneWay === true, closed: raw.closed === true });
  });
  if (raised > 0) warnings.push(`${raised} road distance${raised === 1 ? ' was' : 's were'} shorter than the straight line and raised to it, so the A* heuristic stays admissible.`);

  const network: RoadNetwork = { nodes, edges };
  if (errors.length === 0) for (const issue of validateNetwork(network)) errors.push(issue.message);
  if (errors.length > 0) return { ok: false, errors: limit(errors) };

  // ---- Pins, waypoints, turn restrictions ----
  const pin = (key: 'start' | 'end'): string | null => {
    const id = data[key];
    if (id === undefined || id === null) return null;
    if (typeof id === 'string' && byId.has(id)) return id;
    warnings.push(`The ${key === 'start' ? 'start' : 'destination'} pin pointed at a missing intersection and was dropped.`);
    return null;
  };
  const start = pin('start');
  const end = pin('end');

  const rawWaypoints: unknown[] = Array.isArray(data.waypoints) ? data.waypoints : [];
  const waypoints = rawWaypoints.filter((id): id is string => typeof id === 'string' && byId.has(id));
  if (waypoints.length < rawWaypoints.length) warnings.push(`${rawWaypoints.length - waypoints.length} waypoint(s) pointed at missing intersections and were dropped.`);

  const roadIds = new Set(edges.map((e) => e.id));
  const rawTurns: unknown[] = Array.isArray(data.turnRestrictions) ? data.turnRestrictions : [];
  const turnRestrictions = rawTurns.filter(
    (t): t is TurnRestriction =>
      isObject(t) && typeof t.fromRoad === 'string' && typeof t.via === 'string' && typeof t.toRoad === 'string' && roadIds.has(t.fromRoad) && roadIds.has(t.toRoad) && byId.has(t.via),
  ).map(({ fromRoad, via, toRoad }) => ({ fromRoad, via, toRoad }));
  if (turnRestrictions.length < rawTurns.length) warnings.push(`${rawTurns.length - turnRestrictions.length} turn restriction(s) referred to missing roads or intersections and were dropped.`);

  return { ok: true, map: { network, start, end, waypoints, turnRestrictions }, warnings };
}

/** A file name like "route-planner-map-2026-10-14.json". */
export function suggestedFileName(date: Date = new Date()): string {
  return `route-planner-map-${date.toISOString().slice(0, 10)}.json`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function limit(list: string[]): string[] {
  return list.length <= MAX_LISTED ? list : [...list.slice(0, MAX_LISTED), `…and ${list.length - MAX_LISTED} more.`];
}
