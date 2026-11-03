// Dock.tsx - The floating liquid-glass bottom bar. Touching it magnifies the
// bar and the selection lens follows the finger across the tabs; lifting
// selects the tab under it. Keyboard / screen-reader activation (a click with
// no pointer, detail 0) is handled separately.
import React, { useRef, useState } from 'react';

export interface DockTab<T extends string = string> {
  id: T;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}

interface DockProps<T extends string> {
  tabs: DockTab<T>[];
  currentTab: T;
  // Slides away while a title page or the player is open.
  hidden: boolean;
  // A title/genre page is open: re-selecting the current tab should close it.
  hasOverlay: boolean;
  onSelect: (tab: T) => void;
  // Extra distance from the bottom edge (CSS length); defaults to the stylesheet value.
  bottom?: string;
}

export function Dock<T extends string>({ tabs: TABS, currentTab, hidden, hasOverlay, onSelect, bottom }: DockProps<T>) {
  const dockRef = useRef<HTMLElement | null>(null);
  const [pressIdx, setPressIdx] = useState<number | null>(null);

  const tabIndexAt = (clientX: number) => {
    const rect = dockRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const ratio = (clientX - rect.left - 6) / Math.max(1, rect.width - 12);
    return Math.max(0, Math.min(TABS.length - 1, Math.floor(ratio * TABS.length)));
  };

  const currentIdx = TABS.findIndex(t => t.id === currentTab);
  const shouldSwitch = (tab: T) => tab !== currentTab || hasOverlay;

  return (
    <div className={hidden ? 'dock-wrap hidden' : 'dock-wrap'} style={bottom ? { bottom } : undefined} aria-hidden={hidden}>
      <nav
        ref={dockRef}
        className="glass-dock"
        aria-label="Main"
        data-pressed={pressIdx !== null}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setPressIdx(tabIndexAt(e.clientX));
        }}
        onPointerMove={(e) => {
          if (pressIdx !== null) setPressIdx(tabIndexAt(e.clientX));
        }}
        onPointerUp={() => {
          if (pressIdx === null) return;
          const tab = TABS[pressIdx];
          setPressIdx(null);
          if (shouldSwitch(tab.id)) onSelect(tab.id);
        }}
        onPointerCancel={() => setPressIdx(null)}
      >
        <div
          className="dock-indicator"
          style={{
            width: `calc((100% - 12px) / ${TABS.length})`,
            transform: `translateX(${(pressIdx ?? currentIdx) * 100}%)`
          }}
        />
        {TABS.map((tab, i) => {
          const Icon = tab.icon;
          const active = (pressIdx ?? currentIdx) === i;
          return (
            <button
              key={tab.id}
              onClick={(e) => {
                // Touch and mouse are handled on pointer up; a click with no
                // pointer (detail 0) is keyboard or screen-reader activation.
                if (e.detail === 0 && shouldSwitch(tab.id)) onSelect(tab.id);
              }}
              className={`dock-item ${active ? 'active' : ''}`}
              aria-label={tab.label}
              aria-current={currentTab === tab.id ? 'page' : undefined}
            >
              <Icon size={20} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
