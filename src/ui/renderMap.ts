/**
 * Draws the road network onto a 2D canvas. Pure function of (viewport, state,
 * overlay): no React, no store access, so it is easy to call from a
 * requestAnimationFrame loop.
 *
 * Performance:
 * - Viewport culling: roads whose bounding box is off-screen and nodes outside
 *   the view are skipped.
 * - Batching: all roads of one style go into a single Path2D and are stroked
 *   once (5 strokes total instead of one per road). Nodes are batched the same way.
 * - Level of detail: arrows, labels, node outlines and turn-restriction
 *   markers are dropped when they would be too small to read.
 */

import { edgeCost, TRAFFIC_LEVELS, type GraphEdge, type GraphNode, type TrafficLevel } from '../core/graph';
import type { MapState, Selection } from '../state/mapStore';
import { visibleWorldBounds, type Viewport } from './viewport';

export const CANVAS_COLORS = {
  background: '#0b1220',
  node: '#e2e8f0',
  nodeOutline: '#0b1220',
  blockedFill: '#1e293b',
  blocked: '#f43f5e',
  closed: '#f43f5e',
  accent: '#38bdf8',
  hover: 'rgba(226, 232, 240, 0.35)',
  label: '#cbd5e1',
  labelHalo: 'rgba(11, 18, 32, 0.9)',
  start: '#22c55e',
  end: '#ef4444',
} as const;

/** Transient, canvas-only state drawn on top of the map. */
export interface RenderOverlay {
  hover: Selection | null;
  /** Cursor position in world coordinates (for the rubber-band road). */
  cursor: { x: number; y: number } | null;
  route: RouteLayer | null;
  /** Intersections with no open road (from the network analysis): ringed in red. */
  isolated: readonly string[];
  /** A node being dragged, drawn at this position instead of its stored one. */
  drag: { id: string; x: number; y: number } | null;
  /** Alternative routes (not the main one), drawn dashed under the main route. */
  alternatives: readonly AlternativeLayer[];
  /** An intersection just found or focused: an expanding ring, `t` running 0..1. */
  pulse: { id: string; t: number } | null;
}

export interface AlternativeLayer {
  path: readonly string[];
  color: string;
}

/** A computed route plus how much of its animation to show this frame. */
export interface RouteLayer {
  /** Node ids from start to end (empty when no route was found). */
  path: readonly string[];
  /** Node ids in the order the search settled them. */
  explored: readonly string[];
  /** Bidirectional only: 0 = forward side, 1 = backward side, aligned with `explored`. */
  exploredSides?: Uint8Array;
  /** Number of explored nodes to draw (animation progress). */
  revealed: number;
  /** The last `frontier` revealed nodes are drawn bright: the advancing wave front. */
  frontier: number;
  /** Portion of the route line to draw, 0..1. */
  routeProgress: number;
  showExplored: boolean;
  /** Draw dimmed: the route is out of date and a new one is being computed. */
  faded: boolean;
  /** When there is no route: the cut-off region and the barriers around it. */
  cutOff: CutOffLayer | null;
}

export interface CutOffLayer {
  region: readonly string[];
  closedRoads: readonly string[];
  oneWayRoads: readonly string[];
  blockedNodes: readonly string[];
}

export const ROUTE_COLORS = {
  /** Opaque: violet at ~40% over the background, pre-mixed so no blending is needed. */
  explored: '#3f3a6b',
  frontier: '#b4a7f5',
  /** Bidirectional search, backward side: teal, pre-mixed like `explored`. */
  exploredBackward: '#195f60',
  frontierBackward: '#7fe0cf',
  routeCasing: '#e0e7ff',
  route: '#3b82f6',
  /** Opaque: red at ~35% over the background. */
  cutOff: '#5d2236',
  barrierGlow: 'rgba(244, 63, 94, 0.55)',
  oneWayBarrierGlow: 'rgba(251, 146, 60, 0.6)',
  isolated: '#f43f5e',
  waypoint: '#a855f7',
  turnBan: '#f43f5e',
} as const;

/** Alternative route colours (2nd, 3rd, ... cheapest). Light tints that read over every traffic colour with a dark casing. */
export const ALTERNATIVE_COLORS: readonly string[] = ['#c4b5fd', '#67e8f9', '#f9a8d4', '#fde68a'];

/** Read access to intersections: the store's Map, or a view with a dragged node moved (see MapCanvas). */
export interface NodeLookup {
  get(id: string): GraphNode | undefined;
  values(): Iterable<GraphNode>;
}

export type MapView = Omit<
  Pick<MapState, 'nodes' | 'edges' | 'start' | 'end' | 'waypoints' | 'turnRestrictions' | 'selection' | 'pendingRoadFrom' | 'showLabels'>,
  'nodes'
> & {
  nodes: NodeLookup;
};

/** Above this many visible roads, distance/cost labels are skipped (unreadable and slow). */
const MAX_LABELS = 600;
const LEVELS: readonly TrafficLevel[] = [1, 2, 3, 4];

/** Node radius in screen pixels for a given zoom. */
export function nodeRadiusPx(scale: number): number {
  return Math.min(9, Math.max(1.5, 6 * Math.sqrt(scale)));
}

function roadWidthPx(scale: number): number {
  return Math.min(6, Math.max(1, 3.2 * Math.sqrt(scale)));
}

export function renderMap(ctx: CanvasRenderingContext2D, v: Viewport, dpr: number, s: MapView, overlay: RenderOverlay): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = CANVAS_COLORS.background;
  ctx.fillRect(0, 0, v.width, v.height);

  const { scale, ox, oy } = v;
  const sx = (x: number) => x * scale + ox;
  const sy = (y: number) => y * scale + oy;
  const b = visibleWorldBounds(v, 30);
  const radius = nodeRadiusPx(scale);
  const roadWidth = roadWidthPx(scale);

  // ---- Explored halos and cut-off region (under the roads) -------------------
  const cutOff = overlay.route?.cutOff ?? null;
  if (overlay.route && (overlay.route.showExplored || cutOff)) {
    ctx.save();
    if (overlay.route.faded) ctx.globalAlpha = 0.35;
    if (overlay.route.showExplored) drawExplored(ctx, s, overlay.route, b, sx, sy, radius);
    if (cutOff) fillNodeHalos(ctx, s, cutOff.region, 0, cutOff.region.length, ROUTE_COLORS.cutOff, b, sx, sy, haloRadius(radius));
    // Barriers: a glow under the roads that keep the route from existing.
    drawRoadGlow(ctx, s, cutOff?.closedRoads ?? [], sx, sy, roadWidth + 10, ROUTE_COLORS.barrierGlow);
    drawRoadGlow(ctx, s, cutOff?.oneWayRoads ?? [], sx, sy, roadWidth + 10, ROUTE_COLORS.oneWayBarrierGlow);
    ctx.restore();
  }

  // ---- Roads (batched per style) -------------------------------------------
  const roadPaths = new Map<TrafficLevel, Path2D>(LEVELS.map((l) => [l, new Path2D()]));
  const arrowPaths = new Map<TrafficLevel, Path2D>(LEVELS.map((l) => [l, new Path2D()]));
  const closedPath = new Path2D();
  const closedArrows = new Path2D();
  const closedMarks = new Path2D();
  const labelled: GraphEdge[] = [];
  let visibleRoads = 0;

  for (const e of s.edges.values()) {
    const a = s.nodes.get(e.from);
    const c = s.nodes.get(e.to);
    if (!a || !c) continue;
    // Cull by bounding box.
    if (Math.max(a.x, c.x) < b.minX || Math.min(a.x, c.x) > b.maxX) continue;
    if (Math.max(a.y, c.y) < b.minY || Math.min(a.y, c.y) > b.maxY) continue;
    visibleRoads++;

    const x1 = sx(a.x), y1 = sy(a.y), x2 = sx(c.x), y2 = sy(c.y);
    const path = e.closed ? closedPath : (roadPaths.get(e.trafficLevel) as Path2D);
    path.moveTo(x1, y1);
    path.lineTo(x2, y2);

    const lenPx = Math.hypot(x2 - x1, y2 - y1);
    if (e.oneWay && lenPx > 26) {
      addArrow(e.closed ? closedArrows : (arrowPaths.get(e.trafficLevel) as Path2D), x1, y1, x2, y2, Math.max(4, roadWidth * 1.8));
    }
    if (e.closed && lenPx > 18) addCross(closedMarks, (x1 + x2) / 2, (y1 + y2) / 2, 4);
    if (s.showLabels && labelled.length <= MAX_LABELS) labelled.push(e);
  }

  // Selection / hover halos under the roads.
  drawEdgeHalo(ctx, s, overlay.hover, sx, sy, roadWidth + 6, CANVAS_COLORS.hover);
  drawEdgeHalo(ctx, s, s.selection, sx, sy, roadWidth + 7, CANVAS_COLORS.accent);

  ctx.lineCap = 'butt'; // joins are hidden under the node dots; round caps cost more to raster
  ctx.lineWidth = roadWidth;
  for (const level of LEVELS) {
    ctx.strokeStyle = TRAFFIC_LEVELS[level].color;
    ctx.stroke(roadPaths.get(level) as Path2D);
    ctx.fillStyle = TRAFFIC_LEVELS[level].color;
    ctx.fill(arrowPaths.get(level) as Path2D);
  }

  // Closed roads: dashed red with an x at the midpoint.
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.setLineDash([Math.max(4, 8 * Math.sqrt(scale)), Math.max(3, 6 * Math.sqrt(scale))]);
  ctx.strokeStyle = CANVAS_COLORS.closed;
  ctx.stroke(closedPath);
  ctx.restore();
  ctx.fillStyle = CANVAS_COLORS.closed;
  ctx.fill(closedArrows);
  ctx.lineWidth = 2;
  ctx.strokeStyle = CANVAS_COLORS.closed;
  ctx.stroke(closedMarks);

  // ---- Alternatives, then the route line (over the roads) ----------------------
  if (overlay.alternatives.length > 0) {
    ctx.save();
    if (overlay.route?.faded) ctx.globalAlpha = 0.35;
    // Last first, so the cheaper alternatives end up on top.
    for (let i = overlay.alternatives.length - 1; i >= 0; i--) drawAlternative(ctx, s, overlay.alternatives[i] as AlternativeLayer, sx, sy, roadWidth);
    ctx.restore();
  }
  if (overlay.route) {
    ctx.save();
    if (overlay.route.faded) ctx.globalAlpha = 0.35;
    drawRouteLine(ctx, s, overlay.route, sx, sy, roadWidth);
    ctx.restore();
  }

  // Rubber band while drawing a road.
  const pending = s.pendingRoadFrom ? s.nodes.get(s.pendingRoadFrom) : undefined;
  if (pending && overlay.cursor) {
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = CANVAS_COLORS.accent;
    ctx.beginPath();
    ctx.moveTo(sx(pending.x), sy(pending.y));
    ctx.lineTo(sx(overlay.cursor.x), sy(overlay.cursor.y));
    ctx.stroke();
    ctx.restore();
  }

  // ---- Intersections ---------------------------------------------------------
  // Circles are batched into one Path2D (one fill + one stroke). When zoomed out
  // far enough that nodes are only a few pixels wide, direct fillRect calls are
  // used instead: they skip path rasterisation and are the cheapest primitive.
  const circles = new Path2D();
  const blocked = new Path2D();
  const blockedX = new Path2D();
  const labelledNodes: GraphNode[] = [];
  const useCircles = radius >= 3;
  // Below 2 px, ordinary intersections are too small to see or click and only
  // bury the roads, route and explored region: draw roads only (obstacles stay).
  const drawPlainNodes = radius >= 2;
  ctx.fillStyle = CANVAS_COLORS.node;

  for (const n of s.nodes.values()) {
    if (n.x < b.minX || n.x > b.maxX || n.y < b.minY || n.y > b.maxY) continue;
    const x = sx(n.x), y = sy(n.y);
    if (n.blocked) {
      const r = Math.max(radius, 4);
      blocked.rect(x - r, y - r, 2 * r, 2 * r);
      addCross(blockedX, x, y, r * 0.6);
    } else if (useCircles) {
      circles.moveTo(x + radius, y);
      circles.arc(x, y, radius, 0, Math.PI * 2);
    } else if (drawPlainNodes) {
      ctx.fillRect(x - radius, y - radius, 2 * radius, 2 * radius);
    }
    if (n.label && radius >= 4) labelledNodes.push(n);
  }

  if (useCircles) {
    ctx.fill(circles);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = CANVAS_COLORS.nodeOutline;
    ctx.stroke(circles);
  }
  ctx.fillStyle = CANVAS_COLORS.blockedFill;
  ctx.fill(blocked);
  ctx.lineWidth = 2;
  ctx.strokeStyle = CANVAS_COLORS.blocked;
  ctx.stroke(blocked);
  ctx.stroke(blockedX);

  // Node rings: hover, selection, pending road start.
  drawNodeRing(ctx, s, overlay.hover, sx, sy, radius + 4, CANVAS_COLORS.hover, 3);
  drawNodeRing(ctx, s, s.selection, sx, sy, radius + 4, CANVAS_COLORS.accent, 2.5);
  // Obstacles on a cut-off's boundary, and intersections no open road reaches.
  drawRings(ctx, s, cutOff?.blockedNodes ?? [], b, sx, sy, Math.max(radius, 4) + 6, ROUTE_COLORS.isolated, 3, false);
  drawRings(ctx, s, overlay.isolated, b, sx, sy, Math.max(radius, 3) + 5, ROUTE_COLORS.isolated, 2, true);
  if (pending) drawNodeRing(ctx, s, { kind: 'node', id: pending.id }, sx, sy, radius + 4, CANVAS_COLORS.accent, 2.5);
  if (radius >= 3 && s.turnRestrictions.size > 0) drawTurnBans(ctx, s, b, sx, sy, Math.max(12, radius * 2.6));

  // ---- Labels ---------------------------------------------------------------
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  if (s.showLabels && visibleRoads <= MAX_LABELS) {
    for (const e of labelled) {
      const a = s.nodes.get(e.from) as GraphNode;
      const c = s.nodes.get(e.to) as GraphNode;
      const text = e.trafficLevel === 1 ? e.distance.toFixed(0) : `${e.distance.toFixed(0)} · ${edgeCost(e).toFixed(0)}`;
      haloText(ctx, text, (sx(a.x) + sx(c.x)) / 2, (sy(a.y) + sy(c.y)) / 2 - 9);
    }
  }
  for (const n of labelledNodes) haloText(ctx, n.label as string, sx(n.x), sy(n.y) - radius - 10);

  if (overlay.pulse) drawPulse(ctx, s.nodes.get(overlay.pulse.id), overlay.pulse.t, sx, sy, radius);

  // ---- Waypoint and start / end pins (constant screen size, drawn last) ----
  s.waypoints.forEach((id, i) => drawPin(ctx, s.nodes.get(id), sx, sy, ROUTE_COLORS.waypoint, String(i + 1)));
  drawPin(ctx, s.nodes.get(s.start ?? ''), sx, sy, CANVAS_COLORS.start, 'A');
  drawPin(ctx, s.nodes.get(s.end ?? ''), sx, sy, CANVAS_COLORS.end, 'B');
}

/** Arrowhead at the midpoint of (x1,y1)-(x2,y2), pointing toward (x2,y2). */
function addArrow(p: Path2D, x1: number, y1: number, x2: number, y2: number, size: number): void {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  p.moveTo(mx + ux * size, my + uy * size);
  p.lineTo(mx - ux * size * 0.7 - uy * size * 0.75, my - uy * size * 0.7 + ux * size * 0.75);
  p.lineTo(mx - ux * size * 0.7 + uy * size * 0.75, my - uy * size * 0.7 - ux * size * 0.75);
  p.closePath();
}

function addCross(p: Path2D, x: number, y: number, r: number): void {
  p.moveTo(x - r, y - r);
  p.lineTo(x + r, y + r);
  p.moveTo(x + r, y - r);
  p.lineTo(x - r, y + r);
}

function drawEdgeHalo(
  ctx: CanvasRenderingContext2D,
  s: MapView,
  sel: Selection | null,
  sx: (x: number) => number,
  sy: (y: number) => number,
  width: number,
  color: string,
): void {
  if (sel?.kind !== 'edge') return;
  const e = s.edges.get(sel.id);
  const a = e && s.nodes.get(e.from);
  const c = e && s.nodes.get(e.to);
  if (!a || !c) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(sx(a.x), sy(a.y));
  ctx.lineTo(sx(c.x), sy(c.y));
  ctx.stroke();
  ctx.restore();
}

function drawNodeRing(
  ctx: CanvasRenderingContext2D,
  s: MapView,
  sel: Selection | null,
  sx: (x: number) => number,
  sy: (y: number) => number,
  r: number,
  color: string,
  width: number,
): void {
  if (sel?.kind !== 'node') return;
  const n = s.nodes.get(sel.id);
  if (!n) return;
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(sx(n.x), sy(n.y), r, 0, Math.PI * 2);
  ctx.stroke();
}

function haloText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.lineWidth = 3;
  ctx.strokeStyle = CANVAS_COLORS.labelHalo;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = CANVAS_COLORS.label;
  ctx.fillText(text, x, y);
}

/** Map pin whose tip sits on the node. */
function drawPin(
  ctx: CanvasRenderingContext2D,
  n: GraphNode | undefined,
  sx: (x: number) => number,
  sy: (y: number) => number,
  color: string,
  letter: string,
): void {
  if (!n) return;
  const x = sx(n.x);
  const y = sy(n.y);
  const r = 10;
  const cy = y - 24;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - r * 0.8, cy + r * 0.6);
  ctx.arc(x, cy, r, Math.PI * 0.8, Math.PI * 0.2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#0b1220';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, x, cy + 0.5);
}

type WorldBounds = { minX: number; minY: number; maxX: number; maxY: number };

/** Halo radius for a node radius: 12 px at 1x zoom, shrinking as you zoom out. */
function haloRadius(nodeRadius: number): number {
  return Math.max(nodeRadius * 2, 2);
}

/**
 * Fills halos for `ids[from..to)`. Opaque colours, so there is no alpha
 * blending even when 10,000 halos overlap. Zoomed in: batched circles. Zoomed
 * out: pixel-aligned fillRect, the cheapest canvas primitive (no path
 * rasterisation, no anti-aliasing); the squares merge into one region anyway.
 */
function fillNodeHalos(
  ctx: CanvasRenderingContext2D,
  s: MapView,
  ids: readonly string[],
  from: number,
  to: number,
  color: string,
  b: WorldBounds,
  sx: (x: number) => number,
  sy: (y: number) => number,
  r: number,
  /** If given, only entries whose side equals `side` are drawn. */
  sides?: Uint8Array,
  side?: number,
): void {
  ctx.fillStyle = color;
  if (r >= 6) {
    const p = new Path2D();
    for (let i = from; i < to; i++) {
      if (sides && sides[i] !== side) continue;
      const n = s.nodes.get(ids[i] as string);
      if (!n || n.x < b.minX || n.x > b.maxX || n.y < b.minY || n.y > b.maxY) continue;
      const x = sx(n.x), y = sy(n.y);
      p.moveTo(x + r, y);
      p.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill(p);
    return;
  }
  const size = Math.round(2 * r);
  const half = size / 2;
  for (let i = from; i < to; i++) {
    if (sides && sides[i] !== side) continue;
    const n = s.nodes.get(ids[i] as string);
    if (!n || n.x < b.minX || n.x > b.maxX || n.y < b.minY || n.y > b.maxY) continue;
    ctx.fillRect(Math.round(sx(n.x) - half), Math.round(sy(n.y) - half), size, size);
  }
}

/**
 * Explored intersections as halos drawn UNDER the roads. Settled nodes use a
 * dim tint; the most recently revealed `frontier` nodes are bright, so the
 * search reads as a moving wave. For bidirectional search the two sides get
 * their own colours (violet from the start, teal from the destination).
 */
function drawExplored(
  ctx: CanvasRenderingContext2D,
  s: MapView,
  layer: RouteLayer,
  b: WorldBounds,
  sx: (x: number) => number,
  sy: (y: number) => number,
  nodeRadius: number,
): void {
  const r = haloRadius(nodeRadius);
  const frontierStart = layer.revealed - layer.frontier;
  const sides = layer.exploredSides;
  if (!sides) {
    fillNodeHalos(ctx, s, layer.explored, 0, frontierStart, ROUTE_COLORS.explored, b, sx, sy, r);
    fillNodeHalos(ctx, s, layer.explored, frontierStart, layer.revealed, ROUTE_COLORS.frontier, b, sx, sy, r);
    return;
  }
  fillNodeHalos(ctx, s, layer.explored, 0, frontierStart, ROUTE_COLORS.explored, b, sx, sy, r, sides, 0);
  fillNodeHalos(ctx, s, layer.explored, 0, frontierStart, ROUTE_COLORS.exploredBackward, b, sx, sy, r, sides, 1);
  fillNodeHalos(ctx, s, layer.explored, frontierStart, layer.revealed, ROUTE_COLORS.frontier, b, sx, sy, r, sides, 0);
  fillNodeHalos(ctx, s, layer.explored, frontierStart, layer.revealed, ROUTE_COLORS.frontierBackward, b, sx, sy, r, sides, 1);
}

/** A wide translucent stroke under the given roads (batched into one path). */
function drawRoadGlow(
  ctx: CanvasRenderingContext2D,
  s: MapView,
  roadIds: readonly string[],
  sx: (x: number) => number,
  sy: (y: number) => number,
  width: number,
  color: string,
): void {
  if (roadIds.length === 0) return;
  const p = new Path2D();
  for (const id of roadIds) {
    const e = s.edges.get(id);
    const a = e && s.nodes.get(e.from);
    const c = e && s.nodes.get(e.to);
    if (!a || !c) continue;
    p.moveTo(sx(a.x), sy(a.y));
    p.lineTo(sx(c.x), sy(c.y));
  }
  ctx.lineCap = 'round';
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke(p);
}

/** Rings around the given intersections (batched), optionally dashed. */
function drawRings(
  ctx: CanvasRenderingContext2D,
  s: MapView,
  ids: readonly string[],
  b: WorldBounds,
  sx: (x: number) => number,
  sy: (y: number) => number,
  r: number,
  color: string,
  width: number,
  dashed: boolean,
): void {
  if (ids.length === 0) return;
  const p = new Path2D();
  for (const id of ids) {
    const n = s.nodes.get(id);
    if (!n || n.x < b.minX || n.x > b.maxX || n.y < b.minY || n.y > b.maxY) continue;
    const x = sx(n.x), y = sy(n.y);
    p.moveTo(x + r, y);
    p.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.save();
  if (dashed) ctx.setLineDash([3, 3]);
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke(p);
  ctx.restore();
}

/** The route as a thick cased line, drawn up to `routeProgress` of its screen length. */
function drawRouteLine(
  ctx: CanvasRenderingContext2D,
  s: MapView,
  layer: RouteLayer,
  sx: (x: number) => number,
  sy: (y: number) => number,
  roadWidth: number,
): void {
  if (layer.path.length < 2 || layer.routeProgress <= 0) return;

  const pts: Array<[number, number]> = [];
  for (const id of layer.path) {
    const n = s.nodes.get(id);
    if (n) pts.push([sx(n.x), sy(n.y)]);
  }
  if (pts.length < 2) return;

  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  let remaining = total * layer.routeProgress;

  const line = new Path2D();
  line.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length && remaining > 0; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    const seg = Math.hypot(x1 - x0, y1 - y0);
    if (seg <= remaining) {
      line.lineTo(x1, y1);
      remaining -= seg;
    } else {
      const t = remaining / seg;
      line.lineTo(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      remaining = 0;
    }
  }

  const width = Math.max(4, roadWidth * 1.9);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = width + 4;
  ctx.strokeStyle = ROUTE_COLORS.routeCasing;
  ctx.stroke(line);
  ctx.lineWidth = width;
  ctx.strokeStyle = ROUTE_COLORS.route;
  ctx.stroke(line);
}

/** An alternative route: a dark casing with a dashed light line on top. */
function drawAlternative(
  ctx: CanvasRenderingContext2D,
  s: MapView,
  alt: AlternativeLayer,
  sx: (x: number) => number,
  sy: (y: number) => number,
  roadWidth: number,
): void {
  if (alt.path.length < 2) return;
  const line = new Path2D();
  let first = true;
  for (const id of alt.path) {
    const n = s.nodes.get(id);
    if (!n) continue;
    if (first) line.moveTo(sx(n.x), sy(n.y));
    else line.lineTo(sx(n.x), sy(n.y));
    first = false;
  }
  const width = Math.max(3, roadWidth * 1.3);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  ctx.lineWidth = width + 3;
  ctx.strokeStyle = CANVAS_COLORS.background;
  ctx.stroke(line);
  ctx.setLineDash([width * 2.2, width * 1.6]);
  ctx.lineWidth = width;
  ctx.strokeStyle = alt.color;
  ctx.stroke(line);
  ctx.setLineDash([]);
}

/**
 * A "no turn" marker for each banned turn: a red arc from the arriving road
 * to the forbidden one, curving through the corner, with a bar across its
 * middle. A banned U-turn is a small loop on its road. Batched into one path.
 */
function drawTurnBans(
  ctx: CanvasRenderingContext2D,
  s: MapView,
  b: WorldBounds,
  sx: (x: number) => number,
  sy: (y: number) => number,
  armPx: number,
): void {
  const arcs = new Path2D();
  const bars = new Path2D();
  /** Unit vector (screen space) from the via node along `roadId` toward its far end. */
  const arm = (roadId: string, via: GraphNode): [number, number] | null => {
    const e = s.edges.get(roadId);
    if (!e) return null;
    const other = s.nodes.get(e.from === via.id ? e.to : e.from);
    if (!other) return null;
    const dx = sx(other.x) - sx(via.x);
    const dy = sy(other.y) - sy(via.y);
    const len = Math.hypot(dx, dy);
    return len > 0 ? [dx / len, dy / len] : null;
  };

  for (const t of s.turnRestrictions.values()) {
    const v = s.nodes.get(t.via);
    if (!v || v.x < b.minX || v.x > b.maxX || v.y < b.minY || v.y > b.maxY) continue;
    const a = arm(t.fromRoad, v);
    const c = arm(t.toRoad, v);
    if (!a || !c) continue;
    const vx = sx(v.x), vy = sy(v.y);

    if (t.fromRoad === t.toRoad) {
      // U-turn: a loop on the road, bar through it.
      const cx = vx + a[0] * armPx * 0.85;
      const cy = vy + a[1] * armPx * 0.85;
      const r = armPx * 0.4;
      arcs.moveTo(cx + r, cy);
      arcs.arc(cx, cy, r, 0, Math.PI * 2);
      bars.moveTo(cx - a[1] * r * 1.4, cy + a[0] * r * 1.4);
      bars.lineTo(cx + a[1] * r * 1.4, cy - a[0] * r * 1.4);
      continue;
    }

    const x1 = vx + a[0] * armPx, y1 = vy + a[1] * armPx;
    const x2 = vx + c[0] * armPx, y2 = vy + c[1] * armPx;
    // Control point pulled toward the node so the arc hugs the corner.
    const qx = vx + (a[0] + c[0]) * armPx * 0.25;
    const qy = vy + (a[1] + c[1]) * armPx * 0.25;
    arcs.moveTo(x1, y1);
    arcs.quadraticCurveTo(qx, qy, x2, y2);
    // Bar across the arc's midpoint, perpendicular to its direction there.
    const mx = 0.25 * x1 + 0.5 * qx + 0.25 * x2;
    const my = 0.25 * y1 + 0.5 * qy + 0.25 * y2;
    const tx = x2 - x1, ty = y2 - y1;
    const tl = Math.hypot(tx, ty) || 1;
    const half = armPx * 0.3;
    bars.moveTo(mx - (ty / tl) * half, my + (tx / tl) * half);
    bars.lineTo(mx + (ty / tl) * half, my - (tx / tl) * half);
  }

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = 4.5;
  ctx.strokeStyle = CANVAS_COLORS.background;
  ctx.stroke(arcs);
  ctx.stroke(bars);
  ctx.lineWidth = 2;
  ctx.strokeStyle = ROUTE_COLORS.turnBan;
  ctx.stroke(arcs);
  ctx.stroke(bars);
  ctx.restore();
}

/** Two expanding, fading rings around a focused intersection. */
function drawPulse(
  ctx: CanvasRenderingContext2D,
  n: GraphNode | undefined,
  t: number,
  sx: (x: number) => number,
  sy: (y: number) => number,
  radius: number,
): void {
  if (!n) return;
  ctx.save();
  ctx.strokeStyle = CANVAS_COLORS.accent;
  for (const offset of [0, 0.35]) {
    const k = t - offset;
    if (k <= 0 || k >= 1) continue;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sx(n.x), sy(n.y), radius + 6 + k * 34, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
