/**
 * Search for intersections by id or label, for the map's "Find" box.
 *
 * Ranking (best first): exact id, id prefix, label prefix, label substring,
 * id substring. Ties go to the shorter id, then natural order ("n9" before
 * "n10"). Case-insensitive. A linear scan: about 1 ms for 10,000 nodes, so it
 * runs on every keystroke without an index.
 */

import type { GraphNode } from '../core/graph';

export interface FoundIntersection {
  node: GraphNode;
  /** Which part matched (for highlighting in the results list). */
  matched: 'id' | 'label';
}

export function findIntersections(nodes: Iterable<GraphNode>, query: string, limit = 8): FoundIntersection[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: Array<FoundIntersection & { rank: number }> = [];
  for (const node of nodes) {
    const id = node.id.toLowerCase();
    const label = node.label?.toLowerCase() ?? '';
    let rank: number;
    let matched: 'id' | 'label' = 'id';
    if (id === q) rank = 0;
    else if (id.startsWith(q)) rank = 1;
    else if (label.startsWith(q)) (rank = 2), (matched = 'label');
    else if (label.includes(q)) (rank = 3), (matched = 'label');
    else if (id.includes(q)) rank = 4;
    else continue;
    hits.push({ node, matched, rank });
  }
  hits.sort((a, b) => a.rank - b.rank || a.node.id.length - b.node.id.length || a.node.id.localeCompare(b.node.id, undefined, { numeric: true }));
  return hits.slice(0, limit).map(({ node, matched }) => ({ node, matched }));
}
