/**
 * Resize handles on the map's right and bottom edges, so the workspace can be
 * shared between the map, the side panel and the comparison table.
 *
 * Each edge can be:
 * - dragged;
 * - stepped with its two arrow buttons (◀ ▶ on the right edge, ▲ ▼ on the bottom);
 * - focused (Tab) and moved with the arrow keys;
 * - double-clicked to reset the layout.
 * Pushing a panel past its minimum hides it; the opposite arrow brings it back.
 * Sizes are remembered (uiStore).
 */

import { useRef } from 'react';
import { uiStore, useUiStore } from '../state/uiStore';
import { clampComparison, clampSidebar, stepComparison, stepSidebar } from './workspace';

/** Current on-screen sizes, read when needed (layout can change at any time). */
function measure() {
  const app = document.querySelector('.app')?.getBoundingClientRect();
  const map = document.querySelector('.map-area')?.getBoundingClientRect();
  const comparison = document.querySelector('.comparison')?.getBoundingClientRect();
  return {
    app,
    appWidth: app?.width ?? window.innerWidth,
    comparisonHeight: comparison?.height ?? 0,
    /** Height shared by the map and the comparison table. */
    available: (map?.height ?? 0) + (comparison?.height ?? 0),
  };
}

function resizeSidebar(dir: 'grow' | 'shrink') {
  const ui = uiStore.getState();
  const next = stepSidebar({ open: ui.sidebarOpen, width: ui.sidebarWidth }, dir, measure().appWidth);
  ui.setSidebar(next.open, next.width);
}

function resizeComparison(dir: 'grow' | 'shrink') {
  const ui = uiStore.getState();
  const m = measure();
  const next = stepComparison({ open: ui.comparisonOpen, height: ui.comparisonHeight }, dir, m.comparisonHeight, m.available);
  ui.setComparison(next.open, next.height);
}

export function WorkspaceResizers() {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const comparisonOpen = useUiStore((s) => s.comparisonOpen);
  const comparisonHeight = useUiStore((s) => s.comparisonHeight);
  /** Space shared by map + comparison when a bottom drag starts. */
  const dragAvailable = useRef(0);

  // ---- Dragging ---------------------------------------------------------------

  const startDrag = (e: React.PointerEvent<HTMLDivElement>, edge: 'right' | 'bottom') => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    if (edge === 'right' ? !sidebarOpen : !comparisonOpen) return; // hidden: use the arrow to bring it back
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragAvailable.current = measure().available;
    document.body.classList.add(edge === 'right' ? 'resizing-x' : 'resizing-y');
  };

  const onDrag = (e: React.PointerEvent<HTMLDivElement>, edge: 'right' | 'bottom') => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const app = measure().app;
    if (!app) return;
    const ui = uiStore.getState();
    if (edge === 'right') ui.setSidebar(true, clampSidebar(app.right - e.clientX, app.width));
    else ui.setComparison(true, clampComparison(app.bottom - e.clientY, dragAvailable.current));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove('resizing-x', 'resizing-y');
  };

  // ---- Keyboard on a focused handle ----------------------------------------------

  const onKey = (e: React.KeyboardEvent, edge: 'right' | 'bottom') => {
    const keys: Record<string, 'grow' | 'shrink' | undefined> =
      edge === 'right' ? { ArrowLeft: 'grow', ArrowRight: 'shrink' } : { ArrowUp: 'grow', ArrowDown: 'shrink' };
    const dir = keys[e.key];
    if (dir) (edge === 'right' ? resizeSidebar : resizeComparison)(dir);
    else if (e.key === 'Home') uiStore.getState().resetLayout();
    else return;
    // Keep the arrow keys from also panning the map.
    e.preventDefault();
    e.stopPropagation();
  };

  const arrow = (label: string, glyph: string, onClick: () => void, disabled = false) => (
    <button className="resize-arrow" onClick={onClick} disabled={disabled} title={label} aria-label={label}>
      {glyph}
    </button>
  );

  return (
    <>
      <div
        className={`resizer resizer-x${sidebarOpen ? '' : ' closed'}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the side panel"
        aria-valuenow={sidebarOpen ? sidebarWidth : 0}
        tabIndex={0}
        title="Drag to resize · double-click to reset · ← → when focused"
        onPointerDown={(e) => startDrag(e, 'right')}
        onPointerMove={(e) => onDrag(e, 'right')}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => uiStore.getState().resetLayout()}
        onKeyDown={(e) => onKey(e, 'right')}
      >
        <div className="resize-handle vertical">
          {arrow(sidebarOpen ? 'Widen the side panel (shrink the map)' : 'Show the side panel', '◀', () => resizeSidebar('grow'))}
          {arrow('Narrow the side panel (widen the map); hides it at its minimum', '▶', () => resizeSidebar('shrink'), !sidebarOpen)}
        </div>
      </div>

      <div
        className={`resizer resizer-y${comparisonOpen ? '' : ' closed'}`}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the comparison table"
        aria-valuenow={comparisonOpen ? (comparisonHeight ?? undefined) : 0}
        tabIndex={0}
        title="Drag to resize · double-click to reset · ↑ ↓ when focused"
        onPointerDown={(e) => startDrag(e, 'bottom')}
        onPointerMove={(e) => onDrag(e, 'bottom')}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => uiStore.getState().resetLayout()}
        onKeyDown={(e) => onKey(e, 'bottom')}
      >
        <div className="resize-handle horizontal">
          {arrow(comparisonOpen ? 'Enlarge the comparison table (shrink the map)' : 'Show the comparison table', '▲', () => resizeComparison('grow'))}
          {arrow('Shrink the comparison table (enlarge the map); folds it at its minimum', '▼', () => resizeComparison('shrink'), !comparisonOpen)}
        </div>
      </div>
    </>
  );
}
