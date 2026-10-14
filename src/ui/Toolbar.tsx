/**
 * Top toolbar: editing tools, traffic brush, view controls and map actions.
 * Also owns the global keyboard shortcuts.
 */

import { useEffect } from 'react';
import { TRAFFIC_LEVELS, type TrafficLevel } from '../core/graph';
import { mapStore, useMapStore, type Tool } from '../state/mapStore';
import { demoMap } from '../utils/mapGenerator';

interface ToolDef {
  id: Tool;
  label: string;
  key: string;
}

export const TOOLS: readonly ToolDef[] = [
  { id: 'select', label: 'Select', key: 'V' },
  { id: 'addNode', label: 'Add intersection', key: 'N' },
  { id: 'addRoad', label: 'Draw road', key: 'R' },
  { id: 'oneWay', label: 'One-way', key: 'O' },
  { id: 'traffic', label: 'Traffic', key: 'T' },
  { id: 'obstacle', label: 'Obstacle', key: 'B' },
  { id: 'closeRoad', label: 'Close road', key: 'C' },
  { id: 'move', label: 'Move', key: 'M' },
  { id: 'delete', label: 'Delete', key: 'X' },
  { id: 'setStart', label: 'Start (A)', key: 'S' },
  { id: 'setEnd', label: 'End (B)', key: 'E' },
  { id: 'waypoint', label: 'Stop', key: 'W' },
];

const LEVELS: readonly TrafficLevel[] = [1, 2, 3, 4];

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

/** Global shortcuts: tool keys, 1-4 traffic brush, Esc, Delete, L labels, F fit. */
function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const s = mapStore.getState();
      const key = e.key.toUpperCase();

      const tool = TOOLS.find((t) => t.key === key);
      if (tool) {
        s.setTool(tool.id);
      } else if (key >= '1' && key <= '4') {
        s.setTrafficBrush(Number(key) as TrafficLevel);
      } else if (e.key === 'Escape') {
        s.setPendingRoadFrom(null);
        s.select(null);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        s.deleteSelection();
      } else if (key === 'L') {
        s.toggleLabels();
      } else if (key === 'F') {
        s.requestFit();
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function Toolbar() {
  useShortcuts();
  const tool = useMapStore((s) => s.tool);
  const brush = useMapStore((s) => s.trafficBrush);
  const showLabels = useMapStore((s) => s.showLabels);
  const nodeCount = useMapStore((s) => s.nodes.size);
  const roadCount = useMapStore((s) => s.edges.size);
  const { setTool, setTrafficBrush, toggleLabels, requestFit, loadNetwork, clearMap } = mapStore.getState();

  const loadDemo = () => {
    const demo = demoMap();
    loadNetwork(demo.network, { start: demo.start, end: demo.end });
  };

  const confirmClear = () => {
    if (nodeCount === 0 || window.confirm('Clear the whole map? This cannot be undone.')) clearMap();
  };

  return (
    <header className="toolbar">
      <div className="toolbar-title">Route Planner</div>

      <div className="tool-group" role="toolbar" aria-label="Editing tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`tool-btn${tool === t.id ? ' active' : ''}`}
            onClick={() => setTool(t.id)}
            title={`${t.label} (${t.key})`}
            aria-pressed={tool === t.id}
          >
            {t.label}
            <kbd>{t.key}</kbd>
          </button>
        ))}
      </div>

      <div className="tool-group" role="radiogroup" aria-label="Traffic level">
        {LEVELS.map((level) => (
          <button
            key={level}
            role="radio"
            aria-checked={brush === level}
            className={`swatch-btn${brush === level ? ' active' : ''}`}
            onClick={() => {
              setTrafficBrush(level);
              setTool('traffic');
            }}
            title={`${TRAFFIC_LEVELS[level].label} ×${TRAFFIC_LEVELS[level].multiplier} (${level})`}
          >
            <span className="swatch" style={{ background: TRAFFIC_LEVELS[level].color }} />
            {level}
          </button>
        ))}
      </div>

      <div className="tool-group">
        <button className={`tool-btn${showLabels ? ' active' : ''}`} onClick={toggleLabels} title="Show road distance · cost (L)" aria-pressed={showLabels}>
          Labels<kbd>L</kbd>
        </button>
        <button className="tool-btn" onClick={requestFit} title="Fit map to view (F)">
          Fit<kbd>F</kbd>
        </button>
        <button className="tool-btn" onClick={loadDemo}>Demo map</button>
        <button className="tool-btn danger" onClick={confirmClear}>Clear</button>
      </div>

      <div className="toolbar-stats">
        {nodeCount.toLocaleString()} intersections · {roadCount.toLocaleString()} roads
      </div>
    </header>
  );
}
