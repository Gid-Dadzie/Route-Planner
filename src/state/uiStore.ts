/**
 * Layout preferences: which panels are open. Remembered per browser in
 * localStorage (best effort: private windows or blocked storage simply start
 * with everything open).
 */

import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

const STORAGE_KEY = 'route-planner-ui';
const DEFAULT_SIDEBAR_WIDTH = 320;

export interface UiState {
  /** Right-hand sidebar (route, traffic, map, network panels). */
  sidebarOpen: boolean;
  /** Bottom algorithm comparison table. */
  comparisonOpen: boolean;
  /** Sidebar sections the user collapsed, by panel id. */
  collapsed: Readonly<Record<string, boolean>>;
  /** Side panel width in pixels (kept while the panel is hidden, to restore it). */
  sidebarWidth: number;
  /** Comparison table height in pixels, or null to fit its content. */
  comparisonHeight: number | null;
  toggleSidebar(): void;
  toggleComparison(): void;
  togglePanel(id: string): void;
  setSidebar(open: boolean, width: number): void;
  setComparison(open: boolean, height: number | null): void;
  /** Back to the default sizes, both panels shown. */
  resetLayout(): void;
}

type Persisted = Pick<UiState, 'sidebarOpen' | 'comparisonOpen' | 'collapsed' | 'sidebarWidth' | 'comparisonHeight'>;

const isSize = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 10000;

function load(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const data: unknown = raw ? JSON.parse(raw) : null;
    if (typeof data !== 'object' || data === null) return {};
    const d = data as Record<string, unknown>;
    return {
      ...(typeof d.sidebarOpen === 'boolean' ? { sidebarOpen: d.sidebarOpen } : {}),
      ...(typeof d.comparisonOpen === 'boolean' ? { comparisonOpen: d.comparisonOpen } : {}),
      ...(typeof d.collapsed === 'object' && d.collapsed !== null ? { collapsed: d.collapsed as Record<string, boolean> } : {}),
      ...(isSize(d.sidebarWidth) ? { sidebarWidth: d.sidebarWidth } : {}),
      ...(isSize(d.comparisonHeight) || d.comparisonHeight === null ? { comparisonHeight: d.comparisonHeight as number | null } : {}),
    };
  } catch {
    return {};
  }
}

export const uiStore = createStore<UiState>()((set, get) => ({
  sidebarOpen: true,
  comparisonOpen: true,
  collapsed: {},
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  comparisonHeight: null,
  ...load(),
  toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
  toggleComparison: () => set({ comparisonOpen: !get().comparisonOpen }),
  togglePanel: (id) => set({ collapsed: { ...get().collapsed, [id]: !get().collapsed[id] } }),
  setSidebar: (sidebarOpen, sidebarWidth) => set({ sidebarOpen, sidebarWidth }),
  setComparison: (comparisonOpen, comparisonHeight) => set({ comparisonOpen, comparisonHeight }),
  resetLayout: () => set({ sidebarOpen: true, sidebarWidth: DEFAULT_SIDEBAR_WIDTH, comparisonOpen: true, comparisonHeight: null }),
}));

uiStore.subscribe((s) => {
  try {
    const data: Persisted = {
      sidebarOpen: s.sidebarOpen,
      comparisonOpen: s.comparisonOpen,
      collapsed: s.collapsed,
      sidebarWidth: s.sidebarWidth,
      comparisonHeight: s.comparisonHeight,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage unavailable: preferences last for this session only.
  }
});

export function useUiStore<T>(selector: (s: UiState) => T): T {
  return useStore(uiStore, selector);
}
