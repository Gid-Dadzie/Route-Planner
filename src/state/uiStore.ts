/**
 * Layout preferences: which panels are open. Remembered per browser in
 * localStorage (best effort: private windows or blocked storage simply start
 * with everything open).
 */

import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

const STORAGE_KEY = 'route-planner-ui';

export interface UiState {
  /** Right-hand sidebar (route, traffic, map, network panels). */
  sidebarOpen: boolean;
  /** Bottom algorithm comparison table. */
  comparisonOpen: boolean;
  /** Sidebar sections the user collapsed, by panel id. */
  collapsed: Readonly<Record<string, boolean>>;
  toggleSidebar(): void;
  toggleComparison(): void;
  togglePanel(id: string): void;
}

type Persisted = Pick<UiState, 'sidebarOpen' | 'comparisonOpen' | 'collapsed'>;

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
    };
  } catch {
    return {};
  }
}

export const uiStore = createStore<UiState>()((set, get) => ({
  sidebarOpen: true,
  comparisonOpen: true,
  collapsed: {},
  ...load(),
  toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
  toggleComparison: () => set({ comparisonOpen: !get().comparisonOpen }),
  togglePanel: (id) => set({ collapsed: { ...get().collapsed, [id]: !get().collapsed[id] } }),
}));

uiStore.subscribe((s) => {
  try {
    const data: Persisted = { sidebarOpen: s.sidebarOpen, comparisonOpen: s.comparisonOpen, collapsed: s.collapsed };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage unavailable: preferences last for this session only.
  }
});

export function useUiStore<T>(selector: (s: UiState) => T): T {
  return useStore(uiStore, selector);
}
