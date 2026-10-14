/**
 * Registry of route-finding algorithms. The UI lists these; `search` is null
 * for algorithms not implemented yet,
 * which the UI shows as disabled.
 */

import { astarSearch } from './astar';
import { bidirectionalSearch } from './bidirectional';
import { dijkstraSearch } from './dijkstra';
import { dstarLiteSearch } from './dstarLite';
import type { AlgorithmId } from './graph';
import type { SearchFactory } from './search';

export interface AlgorithmInfo {
  id: AlgorithmId;
  label: string;
  description: string;
  search: SearchFactory | null;
}

export const ALGORITHMS: readonly AlgorithmInfo[] = [
  {
    id: 'dijkstra',
    label: 'Dijkstra',
    description: 'Expands outward in order of distance from the start. Optimal, but explores in every direction.',
    search: dijkstraSearch,
  },
  {
    id: 'astar',
    label: 'A*',
    description: 'Dijkstra guided toward the goal by a straight-line distance estimate.',
    search: astarSearch,
  },
  {
    id: 'bidirectional',
    label: 'Bidirectional',
    description: 'Searches forward from the start and backward from the goal until the two meet.',
    search: bidirectionalSearch,
  },
  {
    id: 'dstarlite',
    label: 'D* Lite',
    description: 'Incremental: searches back from the destination and keeps its work, so after a closure or traffic change it repairs only the affected part.',
    search: dstarLiteSearch,
  },
];

export function getAlgorithm(id: AlgorithmId): AlgorithmInfo {
  return ALGORITHMS.find((a) => a.id === id) as AlgorithmInfo;
}
