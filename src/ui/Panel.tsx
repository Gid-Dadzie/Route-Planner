/**
 * A collapsible sidebar section. The heading is a button; the open/closed
 * state is remembered (uiStore).
 */

import type { ReactNode } from 'react';
import { uiStore, useUiStore } from '../state/uiStore';

interface PanelProps {
  /** Stable id used to remember the collapsed state. */
  id: string;
  title: string;
  /** Shown next to the title, also while collapsed (e.g. "Recalculating…"). */
  badge?: ReactNode;
  children: ReactNode;
}

export function Panel({ id, title, badge, children }: PanelProps) {
  const open = !useUiStore((s) => s.collapsed[id]);
  const bodyId = `panel-${id}`;
  return (
    <section className={`panel${open ? '' : ' collapsed'}`}>
      <h2>
        <button className="panel-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => uiStore.getState().togglePanel(id)}>
          <span className="chevron" aria-hidden="true">
            ▸
          </span>
          {title}
        </button>
        {badge}
      </h2>
      {open && <div id={bodyId}>{children}</div>}
    </section>
  );
}
