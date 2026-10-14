/**
 * Sizing rules for the resizable workspace: how far the side panel and the
 * comparison table can grow into the map, and what each arrow press does.
 * Pure functions, so the rules are unit-tested without a browser.
 *
 * Arrows point the way the map's edge moves:
 *   ◀ / ▶ on the right edge: grow / shrink the side panel (shrink / grow the map);
 *   ▲ / ▼ on the bottom edge: grow / shrink the comparison table.
 * Shrinking a panel that is already at its minimum hides it; the opposite
 * arrow brings it back at its previous size.
 */

export const SIDEBAR_DEFAULT = 320;
export const SIDEBAR_MIN = 280;
export const COMPARISON_MIN = 110;
/** Pixels per arrow press (button or keyboard). */
export const RESIZE_STEP = 80;
/** The map always keeps at least this much room. */
export const MAP_MIN_WIDTH = 280;
export const MAP_MIN_HEIGHT = 160;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Sidebar width allowed in an app `appWidth` pixels wide. */
export function clampSidebar(width: number, appWidth: number): number {
  return Math.round(clamp(width, SIDEBAR_MIN, appWidth - MAP_MIN_WIDTH));
}

/** Comparison height allowed when map + comparison share `available` pixels of height. */
export function clampComparison(height: number, available: number): number {
  return Math.round(clamp(height, COMPARISON_MIN, available - MAP_MIN_HEIGHT));
}

export interface SidebarSize {
  open: boolean;
  width: number;
}

/** One arrow press on the right edge: 'grow' = ◀ (panel wider), 'shrink' = ▶ (map wider). */
export function stepSidebar(s: SidebarSize, dir: 'grow' | 'shrink', appWidth: number): SidebarSize {
  if (!s.open) return dir === 'grow' ? { open: true, width: clampSidebar(s.width, appWidth) } : s;
  if (dir === 'grow') return { open: true, width: clampSidebar(s.width + RESIZE_STEP, appWidth) };
  if (s.width <= SIDEBAR_MIN) return { open: false, width: s.width };
  return { open: true, width: clampSidebar(s.width - RESIZE_STEP, appWidth) };
}

export interface ComparisonSize {
  open: boolean;
  /** Fixed height, or null for "fit the content". */
  height: number | null;
}

/**
 * One arrow press on the bottom edge: 'grow' = ▲ (table taller), 'shrink' = ▼ (map taller).
 * `measured` is the table's current on-screen height (used when it is sized to its content).
 */
export function stepComparison(s: ComparisonSize, dir: 'grow' | 'shrink', measured: number, available: number): ComparisonSize {
  if (!s.open) return dir === 'grow' ? { open: true, height: s.height } : s;
  const current = s.height ?? measured;
  if (dir === 'grow') return { open: true, height: clampComparison(current + RESIZE_STEP, available) };
  if (current <= COMPARISON_MIN) return { open: false, height: s.height };
  return { open: true, height: clampComparison(current - RESIZE_STEP, available) };
}
