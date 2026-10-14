/**
 * "Find intersection" box on the map: type an id or a label, pick a result
 * (click or Enter) and the map centres on it, selects it and pulses it.
 * Each result also offers one-click "set as start / end / stop".
 *
 * Keyboard: / focuses the box, ↑ ↓ move through results, Enter picks, Esc closes.
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { mapStore, useMapStore } from '../state/mapStore';
import { findIntersections } from '../utils/findIntersections';

export function FindIntersection({ inputRef }: { inputRef: RefObject<HTMLInputElement> }) {
  const nodes = useMapStore((s) => s.nodes);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** Pending "close the list" after blur; cancelled if focus comes back first. */
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  useEffect(() => cancelClose, []);

  const results = useMemo(() => findIntersections(nodes.values(), query), [nodes, query]);
  const showList = open && query.trim() !== '';

  const pick = (id: string) => {
    const s = mapStore.getState();
    s.select({ kind: 'node', id });
    s.requestFocus({ type: 'node', id });
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      setActive((i) => Math.min(i + 1, results.length - 1));
      setOpen(true);
    } else if (e.key === 'ArrowUp') {
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      const hit = results[active];
      if (hit) pick(hit.node.id);
    } else if (e.key === 'Escape') {
      if (open && query) setOpen(false);
      else {
        setQuery('');
        e.currentTarget.blur();
      }
    } else {
      return;
    }
    e.preventDefault();
  };

  const s = mapStore.getState();
  const listId = 'find-results';

  return (
    <div className="map-find">
      <input
        ref={inputRef}
        type="search"
        value={query}
        placeholder="Find intersection…  /"
        aria-label="Find an intersection by id or label"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && results[active] ? `find-${results[active].node.id}` : undefined}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => {
          cancelClose();
          setOpen(true);
        }}
        onBlur={() => {
          cancelClose();
          // Delay so a click on a result lands before the list disappears.
          closeTimer.current = window.setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <ul id={listId} className="find-results" role="listbox">
          {results.length === 0 && <li className="find-empty muted">No intersection matches “{query.trim()}”.</li>}
          {results.map(({ node }, i) => (
            <li
              key={node.id}
              id={`find-${node.id}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              // mousedown, not click: fires before the input's blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(node.id);
              }}
            >
              <span className="find-name">
                <code>{node.id}</code>
                {node.label && <span className="muted"> {node.label}</span>}
                {node.blocked && <span className="find-flag"> blocked</span>}
              </span>
              <span className="find-actions">
                <button
                  className="pin start"
                  title="Set as start (A)"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    s.setStart(node.id);
                    pick(node.id);
                  }}
                >
                  A
                </button>
                <button
                  className="pin end"
                  title="Set as destination (B)"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    s.setEnd(node.id);
                    pick(node.id);
                  }}
                >
                  B
                </button>
                <button
                  className="pin waypoint"
                  title="Add or remove as a stop"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    s.toggleWaypoint(node.id);
                    pick(node.id);
                  }}
                >
                  +
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
