/**
 * Uniform-grid spatial index for hit testing (hover, click) on large maps.
 *
 * Nodes are bucketed by the cell containing them; roads by every cell their
 * bounding box covers. Very long roads (covering many cells) go into a small
 * list that every query checks, so they don't bloat the grid.
 *
 * The index is immutable: build a new one when the map changes. Building is
 * O(V + E); a query touches only the few cells around the cursor.
 */

import type { GraphEdge, GraphNode } from '../core/graph';

/** Roads whose bounding box covers more cells than this are kept in `longEdges`. */
const MAX_CELLS_PER_EDGE = 64;

/** Cell coordinates packed into one number (|cy| < 2^19 is ample for any map). */
const cellKey = (cx: number, cy: number): number => cx * 1_048_576 + cy;

/** Shortest distance from point P to segment AB. */
export function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return Math.sqrt(cx * cx + cy * cy);
}

export class SpatialIndex {
  readonly cellSize: number;
  private readonly nodeCells = new Map<number, GraphNode[]>();
  private readonly edgeCells = new Map<number, GraphEdge[]>();
  private readonly longEdges: GraphEdge[] = [];

  constructor(
    private readonly nodes: ReadonlyMap<string, GraphNode>,
    edges: ReadonlyMap<string, GraphEdge>,
  ) {
    // Cell size ~ 2x the average spacing between intersections.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes.values()) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    const area = nodes.size > 0 ? Math.max(1, (maxX - minX) * (maxY - minY)) : 1;
    this.cellSize = Math.max(10, Math.sqrt(area / Math.max(1, nodes.size)) * 2);

    for (const n of nodes.values()) {
      const key = cellKey(this.cell(n.x), this.cell(n.y));
      const bucket = this.nodeCells.get(key);
      if (bucket) bucket.push(n);
      else this.nodeCells.set(key, [n]);
    }

    for (const e of edges.values()) {
      const a = nodes.get(e.from);
      const b = nodes.get(e.to);
      if (!a || !b) continue;
      const cx0 = this.cell(Math.min(a.x, b.x));
      const cx1 = this.cell(Math.max(a.x, b.x));
      const cy0 = this.cell(Math.min(a.y, b.y));
      const cy1 = this.cell(Math.max(a.y, b.y));
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > MAX_CELLS_PER_EDGE) {
        this.longEdges.push(e);
        continue;
      }
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = cellKey(cx, cy);
          const bucket = this.edgeCells.get(key);
          if (bucket) bucket.push(e);
          else this.edgeCells.set(key, [e]);
        }
      }
    }
  }

  private cell(v: number): number {
    return Math.floor(v / this.cellSize);
  }

  /** Closest node within `radius` of (x, y), or null. */
  nearestNode(x: number, y: number, radius: number): GraphNode | null {
    let best: GraphNode | null = null;
    let bestDist = radius;
    this.forCells(this.nodeCells, x, y, radius, (n) => {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d <= bestDist) {
        best = n;
        bestDist = d;
      }
    });
    return best;
  }

  /** Closest road within `radius` of (x, y), or null. */
  nearestEdge(x: number, y: number, radius: number): GraphEdge | null {
    let best: GraphEdge | null = null;
    let bestDist = radius;
    const consider = (e: GraphEdge): void => {
      const a = this.nodes.get(e.from);
      const b = this.nodes.get(e.to);
      if (!a || !b) return;
      const d = pointSegmentDistance(x, y, a.x, a.y, b.x, b.y);
      if (d <= bestDist) {
        best = e;
        bestDist = d;
      }
    };
    this.forCells(this.edgeCells, x, y, radius, consider);
    for (const e of this.longEdges) consider(e);
    return best;
  }

  private forCells<T>(cells: Map<number, T[]>, x: number, y: number, radius: number, fn: (item: T) => void): void {
    const cx0 = this.cell(x - radius);
    const cx1 = this.cell(x + radius);
    const cy0 = this.cell(y - radius);
    const cy1 = this.cell(y + radius);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const bucket = cells.get(cellKey(cx, cy));
        if (bucket) for (const item of bucket) fn(item);
      }
    }
  }
}
