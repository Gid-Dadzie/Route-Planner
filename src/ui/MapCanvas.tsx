/**
 * Interactive map canvas: drawing, zoom/pan, hit testing and tool handling.
 *
 * Rendering is decoupled from React. The component subscribes to the store
 * directly and marks the canvas dirty; a requestAnimationFrame loop redraws
 * at most once per frame and only when something changed. Viewport and hover
 * live in refs, so panning and hovering never trigger React renders.
 *
 * Pointer model: a press that moves less than DRAG_THRESHOLD_PX is a click and
 * is handled by the active tool; a larger move pans the view, or drags the node
 * under the pointer when the Select or Move tool is active. Right/middle drag
 * always pans. The wheel zooms around the cursor.
 *
 * Other ways to navigate, so the map works without a mouse wheel:
 * - touch: one finger pans (or drags a node), two fingers pinch-zoom and pan;
 * - on-screen controls: zoom in, zoom out, fit the map, zoom to the route;
 * - keyboard: arrows pan (Shift for bigger steps), + / - zoom, Z zooms to the
 *   route, F fits the map, / focuses the Find box;
 * - Find: jump to an intersection by id or label (it is selected and pulses).
 */

import { useEffect, useRef, useState } from 'react';
import { mapStore, useMapStore, type MapState, type Selection } from '../state/mapStore';
import { routeStore, useRouteStore } from '../state/routeStore';
import { SpatialIndex } from '../utils/spatialIndex';
import { alternativeLayers } from './alternatives';
import { FindIntersection } from './FindIntersection';
import { MapControls } from './MapControls';
import { loadMapFile } from './mapFiles';
import { nodeRadiusPx, renderMap, type MapView, type RenderOverlay, type RouteLayer } from './renderMap';
import { animationFrameAt, finalFrame } from './routeAnimation';
import { boundsOf, centerOn, fitBounds, panBy, pinchStep, screenToWorld, zoomAt, zoomCentered, type ScreenPoint, type Viewport } from './viewport';

const DRAG_THRESHOLD_PX = 4;
/** Extra pick tolerance around nodes, in screen pixels. */
const NODE_PICK_PX = 5;
const EDGE_PICK_PX = 6;
/**
 * While dragging, the node is drawn at the pointer every frame but written to
 * the store at most this often. Each store write copies the node and road maps
 * (copy-on-write); doing that 60 times a second on a 10,000-node map causes
 * garbage-collection stalls that halve the frame rate.
 */
const DRAG_COMMIT_MS = 100;
/** Zoom factor of one button press or + / - key press. */
const ZOOM_STEP = 1.4;
/** Arrow-key pan step in screen pixels (Shift: three times as far). */
const PAN_STEP_PX = 80;
/** Zooming to a route or an intersection never goes closer than this. */
const FOCUS_MAX_SCALE = 3;
/** Focusing an intersection zooms in to at least this scale. */
const FOCUS_MIN_SCALE = 1.4;
const PULSE_MS = 1400;

type Interaction =
  | { mode: 'idle' }
  /** Button down, not yet moved far enough to count as a drag. */
  | { mode: 'pressed'; button: number; startX: number; startY: number; lastX: number; lastY: number; hit: Selection | null }
  | { mode: 'pan'; lastX: number; lastY: number }
  /** Dragging a node: drawn at (x, y) every frame, committed to the store every DRAG_COMMIT_MS and on release. */
  | { mode: 'dragNode'; id: string; grabDx: number; grabDy: number; startX: number; startY: number; moved: boolean; x: number; y: number; lastCommit: number }
  /** Two fingers down: pinch-zoom and pan. Ends without a click when either lifts. */
  | { mode: 'pinch' };

/**
 * The map as the renderer should see it: the store's state, except that a
 * node being dragged appears at its pointer position. Road endpoints follow
 * automatically because the renderer looks nodes up through this view.
 */
function withDraggedNode(s: MapState, drag: RenderOverlay['drag']): MapView {
  const base = drag ? s.nodes.get(drag.id) : undefined;
  if (!drag || !base) return s;
  const moved = { ...base, x: drag.x, y: drag.y };
  const nodes = s.nodes;
  return {
    edges: s.edges,
    start: s.start,
    end: s.end,
    waypoints: s.waypoints,
    turnRestrictions: s.turnRestrictions,
    selection: s.selection,
    pendingRoadFrom: s.pendingRoadFrom,
    showLabels: s.showLabels,
    nodes: {
      get: (id) => (id === drag.id ? moved : nodes.get(id)),
      *values() {
        for (const n of nodes.values()) yield n.id === drag.id ? moved : n;
      },
    },
  };
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

const TOOL_HINTS: Record<MapState['tool'], string> = {
  select: 'Click to inspect a road or intersection. Drag to pan, drag a node to move it.',
  addNode: 'Click empty space to add an intersection.',
  addRoad: 'Click an intersection, then another to connect them. Esc or right-click to stop.',
  oneWay: 'Click a road to cycle: two-way → one-way → reversed → two-way.',
  traffic: 'Click a road to apply the selected traffic level.',
  obstacle: 'Click an intersection to block or unblock it.',
  closeRoad: 'Click a road to close or reopen it.',
  move: 'Drag an intersection to move it. Connected roads follow.',
  delete: 'Click a road or intersection to delete it.',
  setStart: 'Click an intersection to place the start pin (A).',
  setEnd: 'Click an intersection to place the destination pin (B).',
  waypoint: 'Click an intersection to add it as the next stop, or click a stop to remove it.',
};

export function MapCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<Viewport>({ scale: 1, ox: 0, oy: 0, width: 0, height: 0 });
  const overlayRef = useRef<RenderOverlay>({ hover: null, cursor: null, route: null, drag: null, isolated: [], alternatives: [], pulse: null });
  /** Active pointers (for pinch), by pointer id, in canvas coordinates. */
  const pointersRef = useRef(new Map<number, ScreenPoint>());
  /** Intersection pulsing after Find / focus, with the time it started. */
  const pulseRef = useRef<{ id: string; start: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const interactionRef = useRef<Interaction>({ mode: 'idle' });
  const dirtyRef = useRef(true);
  const indexRef = useRef<{ nodes: MapState['nodes']; edges: MapState['edges']; index: SpatialIndex } | null>(null);

  const tool = useMapStore((s) => s.tool);
  const pendingRoadFrom = useMapStore((s) => s.pendingRoadFrom);
  const isEmpty = useMapStore((s) => s.nodes.size === 0);
  const slow = useRouteStore((s) => s.slow);
  const hasRoute = useRouteStore((s) => s.result?.found === true);
  const [dropActive, setDropActive] = useState(false);
  const [dropMessage, setDropMessage] = useState<string | null>(null);

  // ---- Helpers (read state lazily so handlers never go stale) --------------

  const markDirty = () => {
    dirtyRef.current = true;
  };

  const getIndex = (): SpatialIndex => {
    const s = mapStore.getState();
    const cached = indexRef.current;
    if (cached && cached.nodes === s.nodes && cached.edges === s.edges) return cached.index;
    const index = new SpatialIndex(s.nodes, s.edges);
    indexRef.current = { nodes: s.nodes, edges: s.edges, index };
    return index;
  };

  /** What is under screen point (sx, sy): nodes take priority over roads. */
  const hitTest = (sx: number, sy: number): Selection | null => {
    const v = viewRef.current;
    const p = screenToWorld(v, sx, sy);
    const index = getIndex();
    const node = index.nearestNode(p.x, p.y, (nodeRadiusPx(v.scale) + NODE_PICK_PX) / v.scale);
    if (node) return { kind: 'node', id: node.id };
    const edge = index.nearestEdge(p.x, p.y, EDGE_PICK_PX / v.scale);
    return edge ? { kind: 'edge', id: edge.id } : null;
  };

  const fitToMap = () => {
    const { nodes } = mapStore.getState();
    const v = viewRef.current;
    if (nodes.size === 0) {
      v.scale = 1;
      v.ox = v.width / 2;
      v.oy = v.height / 2;
    } else {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of nodes.values()) {
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x);
        maxY = Math.max(maxY, n.y);
      }
      // 56px padding leaves room for the pins above the top-most nodes.
      fitBounds(v, { minX, minY, maxX, maxY }, 56);
    }
    markDirty();
  };

  // ---- View commands (controls, keyboard, focus requests) ---------------------

  const zoomBy = (factor: number) => {
    zoomCentered(viewRef.current, factor);
    markDirty();
  };

  /** Frames the route with its pins and stops (or just the pins if there is no route). */
  const zoomToRoute = () => {
    const s = mapStore.getState();
    const r = routeStore.getState();
    const ids = [...(r.result?.found ? r.result.path : []), s.start ?? '', s.end ?? '', ...s.waypoints];
    const points = ids.map((id) => s.nodes.get(id)).filter((n): n is NonNullable<typeof n> => n !== undefined);
    const b = boundsOf(points);
    if (!b) return;
    const v = viewRef.current;
    // 70px padding keeps the pins (drawn above their intersection) on screen.
    fitBounds(v, b, 70);
    if (v.scale > FOCUS_MAX_SCALE) centerOn(v, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, FOCUS_MAX_SCALE);
    markDirty();
  };

  /** Centres an intersection, zooming in if the view is far out, and pulses it. */
  const focusNode = (id: string) => {
    const n = mapStore.getState().nodes.get(id);
    if (!n) return;
    const v = viewRef.current;
    centerOn(v, n.x, n.y, Math.min(FOCUS_MAX_SCALE, Math.max(v.scale, FOCUS_MIN_SCALE)));
    pulseRef.current = { id, start: performance.now() };
    markDirty();
  };

  /** Applies the active tool to a click at screen point (sx, sy). */
  const handleClick = (hit: Selection | null, sx: number, sy: number) => {
    const s = mapStore.getState();
    const world = screenToWorld(viewRef.current, sx, sy);

    switch (s.tool) {
      case 'select':
      case 'move':
        s.select(hit);
        break;
      case 'addNode':
        if (hit?.kind === 'node') s.select(hit);
        else s.select({ kind: 'node', id: s.addNode(Math.round(world.x), Math.round(world.y)) });
        break;
      case 'addRoad':
        if (hit?.kind !== 'node') {
          s.setPendingRoadFrom(null);
        } else if (s.pendingRoadFrom === null) {
          s.setPendingRoadFrom(hit.id);
        } else if (s.pendingRoadFrom === hit.id) {
          s.setPendingRoadFrom(null);
        } else {
          const roadId = s.addRoad(s.pendingRoadFrom, hit.id);
          if (roadId) s.select({ kind: 'edge', id: roadId });
          // Chain: the next road starts where this one ended.
          s.setPendingRoadFrom(hit.id);
        }
        break;
      case 'oneWay':
        if (hit?.kind === 'edge') {
          s.cycleDirection(hit.id);
          s.select(hit);
        }
        break;
      case 'traffic':
        if (hit?.kind === 'edge') {
          s.setTraffic(hit.id, s.trafficBrush);
          s.select(hit);
        }
        break;
      case 'obstacle':
        if (hit?.kind === 'node') {
          s.toggleBlocked(hit.id);
          s.select(hit);
        }
        break;
      case 'closeRoad':
        if (hit?.kind === 'edge') {
          s.toggleClosed(hit.id);
          s.select(hit);
        }
        break;
      case 'delete':
        if (hit?.kind === 'node') s.deleteNode(hit.id);
        else if (hit?.kind === 'edge') s.deleteEdge(hit.id);
        break;
      case 'setStart':
        if (hit?.kind === 'node') s.setStart(hit.id);
        break;
      case 'setEnd':
        if (hit?.kind === 'node') s.setEnd(hit.id);
        break;
      case 'waypoint':
        if (hit?.kind === 'node') s.toggleWaypoint(hit.id);
        break;
    }
  };

  const updateCursor = (hit: Selection | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const mode = interactionRef.current.mode;
    const t = mapStore.getState().tool;
    canvas.style.cursor =
      mode === 'pan' || mode === 'dragNode' || mode === 'pinch'
        ? 'grabbing'
        : hit
          ? 'pointer'
          : t === 'addNode'
            ? 'crosshair'
            : 'default';
  };

  // ---- Setup: render loop, resize, store subscription, wheel ---------------

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let firstLayout = true;
    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const v = viewRef.current;
      v.width = rect.width;
      v.height = rect.height;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      if (firstLayout && rect.width > 0) {
        firstLayout = false;
        fitToMap();
      }
      markDirty();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    // Route animation. `animatedToken` starts at -1 so a route that already
    // exists on mount (the initial demo route) plays its wave once.
    let animatedToken = -1;
    let animStart: number | null = null;

    const syncAnimation = () => {
      const r = routeStore.getState();
      if (r.animationToken !== animatedToken) {
        animatedToken = r.animationToken;
        animStart = r.animate && r.result ? performance.now() : null;
      }
    };
    syncAnimation();

    /** The route layer for time `now`: an animation frame while playing, else the final state. */
    const routeLayer = (now: number): RouteLayer | null => {
      const r = routeStore.getState();
      if (!r.result) return null;
      const count = r.result.exploredInOrder.length;
      let f = finalFrame(count);
      if (animStart !== null) {
        f = animationFrameAt(count, now - animStart);
        if (f.done) animStart = null;
      }
      return {
        path: r.result.path,
        explored: r.result.exploredInOrder,
        ...(r.result.exploredSides ? { exploredSides: r.result.exploredSides } : {}),
        revealed: f.revealed,
        frontier: f.frontier,
        routeProgress: f.routeProgress,
        showExplored: r.showExplored,
        faded: r.slow,
        // Shown once the wave has finished, so the flood fill reads first.
        cutOff: r.noRoute && f.done ? r.noRoute : null,
      };
    };

    let raf = 0;
    const frame = (now: number) => {
      const pulse = pulseRef.current;
      const pulsing = pulse !== null && now - pulse.start < PULSE_MS;
      if (pulse && !pulsing) {
        pulseRef.current = null;
        overlayRef.current.pulse = null;
        dirtyRef.current = true;
      }
      // Keep redrawing every frame while the animation or the pulse is playing.
      if (dirtyRef.current || animStart !== null || pulsing) {
        dirtyRef.current = false;
        overlayRef.current.pulse = pulse && pulsing ? { id: pulse.id, t: (now - pulse.start) / PULSE_MS } : null;
        overlayRef.current.route = routeLayer(now);
        overlayRef.current.isolated = routeStore.getState().network?.isolated ?? [];
        overlayRef.current.alternatives = alternativeLayers(mapStore.getState(), routeStore.getState());
        renderMap(ctx, viewRef.current, window.devicePixelRatio || 1, withDraggedNode(mapStore.getState(), overlayRef.current.drag), overlayRef.current);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const unsubscribeRoute = routeStore.subscribe(() => {
      syncAnimation();
      markDirty();
    });

    let lastFit = mapStore.getState().fitRequest;
    let lastFocus = mapStore.getState().focusRequest?.seq ?? 0;
    const unsubscribe = mapStore.subscribe((s) => {
      if (s.fitRequest !== lastFit) {
        lastFit = s.fitRequest;
        fitToMap();
      }
      if (s.focusRequest && s.focusRequest.seq !== lastFocus) {
        lastFocus = s.focusRequest.seq;
        const target = s.focusRequest.target;
        if (target.type === 'route') zoomToRoute();
        else focusNode(target.id);
      }
      // Drop hover if the hovered item was deleted.
      const hover = overlayRef.current.hover;
      if (hover && !(hover.kind === 'node' ? s.nodes.has(hover.id) : s.edges.has(hover.id))) {
        overlayRef.current.hover = null;
      }
      markDirty();
    });

    // Native listener: React's onWheel is passive, so it cannot preventDefault.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      zoomAt(viewRef.current, e.clientX - rect.left, e.clientY - rect.top, factor);
      markDirty();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    // Keyboard navigation. Tool shortcuts live in the toolbar; these move the view.
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const step = PAN_STEP_PX * (e.shiftKey ? 3 : 1);
      const v = viewRef.current;
      switch (e.key) {
        case 'ArrowLeft':
          panBy(v, step, 0);
          break;
        case 'ArrowRight':
          panBy(v, -step, 0);
          break;
        case 'ArrowUp':
          panBy(v, 0, step);
          break;
        case 'ArrowDown':
          panBy(v, 0, -step);
          break;
        case '+':
        case '=':
          zoomCentered(v, ZOOM_STEP);
          break;
        case '-':
        case '_':
          zoomCentered(v, 1 / ZOOM_STEP);
          break;
        case 'z':
        case 'Z':
          zoomToRoute();
          break;
        case '/':
          searchRef.current?.focus();
          break;
        default:
          return;
      }
      e.preventDefault();
      markDirty();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      unsubscribe();
      unsubscribeRoute();
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // ---- Pointer handlers -----------------------------------------------------

  const localPoint = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /** The first two active pointers (for pinch). */
  const twoPointers = (): [ScreenPoint, ScreenPoint] | null => {
    const it = pointersRef.current.values();
    const a = it.next().value;
    const b = it.next().value;
    return a && b ? [a, b] : null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = localPoint(e);
    pointersRef.current.set(e.pointerId, p);
    if (pointersRef.current.size >= 2) {
      // A second finger: whatever the first one started becomes a pinch.
      finishDrag();
      interactionRef.current = { mode: 'pinch' };
      updateCursor(null);
      return;
    }
    const hit = hitTest(p.x, p.y);
    const s = mapStore.getState();

    if (e.button === 0 && hit?.kind === 'node' && (s.tool === 'move' || s.tool === 'select')) {
      const node = s.nodes.get(hit.id);
      if (node) {
        const w = screenToWorld(viewRef.current, p.x, p.y);
        interactionRef.current = {
          mode: 'dragNode',
          id: hit.id,
          grabDx: node.x - w.x,
          grabDy: node.y - w.y,
          startX: p.x,
          startY: p.y,
          moved: false,
          x: node.x,
          y: node.y,
          lastCommit: 0,
        };
        return;
      }
    }
    interactionRef.current = { mode: 'pressed', button: e.button, startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, hit };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = localPoint(e);
    const v = viewRef.current;
    const it = interactionRef.current;
    overlayRef.current.cursor = screenToWorld(v, p.x, p.y);

    if (it.mode === 'pinch') {
      const before = twoPointers();
      if (pointersRef.current.has(e.pointerId)) pointersRef.current.set(e.pointerId, p);
      const after = twoPointers();
      if (before && after) {
        pinchStep(v, before[0], before[1], after[0], after[1]);
        markDirty();
      }
      return;
    }
    if (pointersRef.current.has(e.pointerId)) pointersRef.current.set(e.pointerId, p);

    if (it.mode === 'dragNode') {
      if (!it.moved && Math.hypot(p.x - it.startX, p.y - it.startY) < DRAG_THRESHOLD_PX) return;
      it.moved = true;
      const w = screenToWorld(v, p.x, p.y);
      it.x = Math.round(w.x + it.grabDx);
      it.y = Math.round(w.y + it.grabDy);
      overlayRef.current.drag = { id: it.id, x: it.x, y: it.y };
      markDirty();
      const now = performance.now();
      if (now - it.lastCommit >= DRAG_COMMIT_MS) {
        it.lastCommit = now;
        mapStore.getState().moveNode(it.id, it.x, it.y);
      }
      updateCursor(null);
      return;
    }

    if (it.mode === 'pressed' && Math.hypot(p.x - it.startX, p.y - it.startY) >= DRAG_THRESHOLD_PX) {
      interactionRef.current = { mode: 'pan', lastX: it.lastX, lastY: it.lastY };
    }
    const cur = interactionRef.current;
    if (cur.mode === 'pan') {
      v.ox += p.x - cur.lastX;
      v.oy += p.y - cur.lastY;
      cur.lastX = p.x;
      cur.lastY = p.y;
      updateCursor(null);
      markDirty();
      return;
    }

    // Hover.
    const hit = hitTest(p.x, p.y);
    const prev = overlayRef.current.hover;
    if (hit?.kind !== prev?.kind || hit?.id !== prev?.id) {
      overlayRef.current.hover = hit;
      markDirty();
    }
    if (mapStore.getState().pendingRoadFrom) markDirty(); // rubber band follows the cursor
    updateCursor(hit);
  };

  /** Ends a node drag, committing its final position. */
  const finishDrag = () => {
    const it = interactionRef.current;
    if (it.mode !== 'dragNode') return;
    if (it.moved) mapStore.getState().moveNode(it.id, it.x, it.y);
    overlayRef.current.drag = null;
    markDirty();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(e.pointerId);
    if (interactionRef.current.mode === 'pinch') {
      // Lifting a finger ends the pinch; the other finger does nothing until it lifts too.
      if (pointersRef.current.size < 2) interactionRef.current = { mode: 'idle' };
      return;
    }
    finishDrag();
    const it = interactionRef.current;
    interactionRef.current = { mode: 'idle' };
    const p = localPoint(e);

    if (it.mode === 'pressed') {
      if (it.button === 0) handleClick(it.hit, p.x, p.y);
      else if (it.button === 2) mapStore.getState().setPendingRoadFrom(null);
    } else if (it.mode === 'dragNode' && !it.moved) {
      handleClick({ kind: 'node', id: it.id }, p.x, p.y);
    }
    updateCursor(hitTest(p.x, p.y));
  };

  const onPointerLeave = () => {
    overlayRef.current.cursor = null;
    if (overlayRef.current.hover) {
      overlayRef.current.hover = null;
      markDirty();
    }
  };

  // ---- Drag and drop a saved map ---------------------------------------------

  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropActive(true);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const outcome = await loadMapFile(file);
    setDropMessage(outcome.message);
    window.setTimeout(() => setDropMessage((m) => (m === outcome.message ? null : m)), outcome.ok ? 4000 : 10000);
  };

  return (
    <div
      ref={containerRef}
      className={`map-canvas${dropActive ? ' drop-active' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={() => setDropActive(false)}
      onDrop={(e) => void onDrop(e)}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={(e) => {
          pointersRef.current.delete(e.pointerId);
          finishDrag();
          interactionRef.current = { mode: 'idle' };
        }}
        onPointerLeave={onPointerLeave}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="Road network map"
      />
      <FindIntersection inputRef={searchRef} />
      <MapControls
        onZoomIn={() => zoomBy(ZOOM_STEP)}
        onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
        onFit={fitToMap}
        onRoute={zoomToRoute}
        hasRoute={hasRoute}
      />
      {slow && (
        <div className="map-busy" role="status">
          <span className="spinner" aria-hidden="true" /> Recalculating…
        </div>
      )}
      <div className="map-hint">
        {pendingRoadFrom ? `Drawing from ${pendingRoadFrom}: click another intersection.` : TOOL_HINTS[tool]}
      </div>
      {dropActive && <div className="map-drop">Drop a saved map (.json) to load it</div>}
      {dropMessage && (
        <div className="map-toast" role="status" onClick={() => setDropMessage(null)}>
          {dropMessage}
        </div>
      )}
      {isEmpty && (
        <div className="map-empty">
          <p>The map is empty.</p>
          <p>Pick <b>Add intersection</b> (N) and click to place intersections, then connect them with <b>Draw road</b> (R).</p>
        </div>
      )}
    </div>
  );
}
