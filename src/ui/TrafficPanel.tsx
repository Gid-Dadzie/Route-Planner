/**
 * Right-hand editing panel: traffic legend/brush plus an inspector for the
 * selected road or intersection.
 */

import { useEffect, useState } from 'react';
import { edgeCost, minAllowedDistance, TRAFFIC_LEVELS, type GraphEdge, type GraphNode, type TrafficLevel } from '../core/graph';
import { mapStore, useMapStore } from '../state/mapStore';
import { TurnEditor } from './TurnEditor';

const LEVELS: readonly TrafficLevel[] = [1, 2, 3, 4];

export function TrafficPanel() {
  const brush = useMapStore((s) => s.trafficBrush);
  const selection = useMapStore((s) => s.selection);
  const edge = useMapStore((s) => (s.selection?.kind === 'edge' ? s.edges.get(s.selection.id) : undefined));
  const node = useMapStore((s) => (s.selection?.kind === 'node' ? s.nodes.get(s.selection.id) : undefined));

  return (
    <section className="panel">
      <h2>Traffic</h2>
      <ul className="legend">
        {LEVELS.map((level) => (
          <li key={level}>
            <button
              className={`legend-row${brush === level ? ' active' : ''}`}
              onClick={() => {
                mapStore.getState().setTrafficBrush(level);
                mapStore.getState().setTool('traffic');
              }}
            >
              <span className="swatch" style={{ background: TRAFFIC_LEVELS[level].color }} />
              <span>{TRAFFIC_LEVELS[level].label}</span>
              <span className="muted">×{TRAFFIC_LEVELS[level].multiplier.toFixed(1)}</span>
            </button>
          </li>
        ))}
        <li className="legend-row static">
          <span className="swatch closed" />
          <span>Closed</span>
          <span className="muted">skipped</span>
        </li>
      </ul>

      <h2>Selection</h2>
      {edge ? <RoadInspector edge={edge} /> : node ? <NodeInspector node={node} /> : <p className="muted">{selection ? 'Selected item no longer exists.' : 'Nothing selected. Click a road or intersection with the Select tool.'}</p>}
    </section>
  );
}

function RoadInspector({ edge }: { edge: GraphEdge }) {
  const from = useMapStore((s) => s.nodes.get(edge.from));
  const to = useMapStore((s) => s.nodes.get(edge.to));
  const minDistance = from && to ? minAllowedDistance(from, to) : 0;
  const [draft, setDraft] = useState(edge.distance.toFixed(1));
  const [note, setNote] = useState<string | null>(null);
  const s = mapStore.getState();

  // Resync the input when the road changes (e.g. an endpoint was dragged).
  useEffect(() => {
    setDraft(edge.distance.toFixed(1));
  }, [edge.id, edge.distance]);
  useEffect(() => setNote(null), [edge.id]);

  const commitDistance = () => {
    const requested = Number(draft);
    const applied = s.setEdgeDistance(edge.id, requested);
    if (applied === null) {
      setNote('Distance must be a positive number.');
      setDraft(edge.distance.toFixed(1));
    } else if (applied > requested) {
      setNote(`Raised to the straight-line length (${applied.toFixed(1)}) so the A* heuristic stays admissible.`);
      setDraft(applied.toFixed(1));
    } else {
      setNote(null);
    }
  };

  return (
    <div className="inspector">
      <div className="inspector-title">
        <span>
          Road <code>{edge.id}</code>
        </span>
        <span className="muted">
          {edge.from} {edge.oneWay ? '→' : '↔'} {edge.to}
        </span>
      </div>

      <label className="field">
        <span>Distance</span>
        <input
          type="number"
          min={minDistance.toFixed(1)}
          step="any"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDistance}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </label>
      <p className="muted small">Straight line: {minDistance.toFixed(1)} · Cost: {edgeCost(edge).toFixed(1)}</p>
      {note && <p className="note small">{note}</p>}

      <div className="field">
        <span>Traffic</span>
        <div className="segmented">
          {LEVELS.map((level) => (
            <button
              key={level}
              className={edge.trafficLevel === level ? 'active' : ''}
              onClick={() => s.setTraffic(edge.id, level)}
              title={TRAFFIC_LEVELS[level].label}
            >
              <span className="swatch" style={{ background: TRAFFIC_LEVELS[level].color }} />
              {level}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span>Direction</span>
        <div className="segmented">
          <button className={!edge.oneWay ? 'active' : ''} onClick={() => s.setOneWay(edge.id, false)}>
            Two-way
          </button>
          <button className={edge.oneWay ? 'active' : ''} onClick={() => s.setOneWay(edge.id, true)}>
            One-way
          </button>
          <button onClick={() => s.reverseEdge(edge.id)} disabled={!edge.oneWay} title="Reverse direction">
            ⇄
          </button>
        </div>
      </div>

      <div className="actions">
        <button className={edge.closed ? 'btn danger active' : 'btn'} onClick={() => s.toggleClosed(edge.id)}>
          {edge.closed ? 'Reopen road' : 'Close road'}
        </button>
        <button className="btn danger" onClick={() => s.deleteEdge(edge.id)}>
          Delete
        </button>
      </div>
    </div>
  );
}

function NodeInspector({ node }: { node: GraphNode }) {
  const isStart = useMapStore((s) => s.start === node.id);
  const isEnd = useMapStore((s) => s.end === node.id);
  const stopIndex = useMapStore((s) => s.waypoints.indexOf(node.id));
  const degree = useMapStore((s) => {
    let d = 0;
    for (const e of s.edges.values()) if (e.from === node.id || e.to === node.id) d++;
    return d;
  });
  const [label, setLabel] = useState(node.label ?? '');
  const s = mapStore.getState();

  useEffect(() => setLabel(node.label ?? ''), [node.id, node.label]);

  return (
    <div className="inspector">
      <div className="inspector-title">
        <span>
          Intersection <code>{node.id}</code>
        </span>
        <span className="muted">
          ({node.x}, {node.y}) · {degree} road{degree === 1 ? '' : 's'}
        </span>
      </div>

      <label className="field">
        <span>Label</span>
        <input
          type="text"
          value={label}
          placeholder="Optional name"
          maxLength={40}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => s.setNodeLabel(node.id, label)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </label>

      <div className="actions">
        <button className={isStart ? 'btn start active' : 'btn start'} onClick={() => s.setStart(isStart ? null : node.id)}>
          {isStart ? 'Unset start' : 'Set as start'}
        </button>
        <button className={isEnd ? 'btn end active' : 'btn end'} onClick={() => s.setEnd(isEnd ? null : node.id)}>
          {isEnd ? 'Unset end' : 'Set as end'}
        </button>
      </div>
      <div className="actions">
        <button className={node.blocked ? 'btn danger active' : 'btn'} onClick={() => s.toggleBlocked(node.id)}>
          {node.blocked ? 'Remove obstacle' : 'Place obstacle'}
        </button>
        <button className="btn danger" onClick={() => s.deleteNode(node.id)}>
          Delete
        </button>
      </div>
      <div className="actions">
        <button className={stopIndex >= 0 ? 'btn waypoint active' : 'btn waypoint'} onClick={() => s.toggleWaypoint(node.id)}>
          {stopIndex >= 0 ? `Remove stop ${stopIndex + 1}` : 'Add as stop'}
        </button>
      </div>
      <TurnEditor node={node} />
    </div>
  );
}
