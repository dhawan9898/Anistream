// CategoryPicker.tsx - Netflix-style "Categories" overlay: a dimmed full-screen
// list, centered, optionally grouped into titled sections, with an optional
// header (e.g. a Movies/TV filter) and a round close button pinned at the
// bottom. Data-agnostic: each app supplies its own sections.
// Colors come from --picker-* CSS variables (dark defaults), so a light theme
// can re-skin the overlay instead of rendering dark text on a dark scrim.
//
// presentation="card" shows the same options as a rounded card, about 70% of the
// screen high, over a blurred and dimmed page (used for season / range pickers,
// where the page behind should stay recognisable); tapping outside closes it.
import React from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';
import { useBackHandler } from '../core/backStack.ts';

export interface CategoryItem {
  key: string;
  name: string;
}

export interface CategorySection {
  /** Omit for a single untitled list. */
  title?: string;
  items: CategoryItem[];
}

interface CategoryPickerProps {
  open: boolean;
  sections: CategorySection[];
  selectedKey?: string;
  onSelect: (key: string) => void;
  onClose: () => void;
  header?: React.ReactNode;
  /** 'fullscreen' (default): centred list over the whole screen. 'card': a ~70%-high card. */
  presentation?: 'fullscreen' | 'card';
  /** Heading of the card presentation, e.g. "Seasons". */
  title?: string;
}

export const CategoryPicker: React.FC<CategoryPickerProps> = ({ open, sections, selectedKey, onSelect, onClose, header, presentation = 'fullscreen', title }) => {
  useBackHandler(open, onClose);
  if (!open) return null;

  if (presentation === 'card') {
    return createPortal(
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Choose'}
        data-modal-root="true"
        onClick={onClose}
        className="animate-fade-in"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9500,
          backgroundColor: 'var(--picker-card-scrim, rgba(8, 8, 12, 0.7))',
          WebkitBackdropFilter: 'blur(18px) saturate(150%)',
          backdropFilter: 'blur(18px) saturate(150%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'calc(var(--safe-top) + 16px) 16px calc(var(--safe-bottom) + 16px) 16px'
        }}
      >
        <div
          onClick={e => e.stopPropagation()}
          className="animate-pop-in"
          style={{
            width: 'min(100%, 440px)',
            // About 70% of the screen, the same size every time.
            height: '70vh',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: 'rgba(var(--bg-main-rgb), 0.88)',
            WebkitBackdropFilter: 'blur(24px) saturate(160%)',
            backdropFilter: 'blur(24px) saturate(160%)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-xl, 24px)',
            boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
            overflow: 'hidden'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 16px 10px 20px', flexShrink: 0 }}>
            <h2 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.2px' }}>{title ?? 'Choose'}</h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="interactive glass-pill"
              style={{ width: '34px', height: '34px', borderRadius: '50%', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-primary)' }}
            >
              <X size={18} />
            </button>
          </div>
          <div style={{ overflowY: 'auto', padding: '0 10px 14px 10px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {header}
            {sections.map((section, sIdx) => (
              <section key={section.title ?? sIdx} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {section.title && (
                  <h3 style={{ margin: '10px 10px 4px', fontSize: '11px', fontWeight: 800, letterSpacing: '1.2px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{section.title}</h3>
                )}
                {section.items.map(item => {
                  const active = item.key === selectedKey;
                  return (
                    <button
                      key={`${section.title ?? sIdx}-${item.key}`}
                      onClick={() => onSelect(item.key)}
                      aria-current={active ? 'true' : undefined}
                      className="interactive"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '12px',
                        width: '100%',
                        textAlign: 'left',
                        padding: '14px 12px',
                        border: 'none',
                        borderRadius: 'var(--radius-md)',
                        cursor: 'pointer',
                        fontSize: '16px',
                        fontWeight: active ? 800 : 600,
                        color: active ? 'var(--accent-primary)' : 'var(--text-primary)',
                        backgroundColor: active ? 'var(--picker-active-bg, rgba(255,255,255,0.08))' : 'transparent'
                      }}
                    >
                      <span style={{ minWidth: 0 }}>{item.name}</span>
                      {active && <Check size={18} style={{ flexShrink: 0 }} />}
                    </button>
                  );
                })}
              </section>
            ))}
          </div>
        </div>
      </div>,
      document.body
    );
  }

  // Portaled to <body>: the screens sit inside their own stacking contexts,
  // which would otherwise keep this overlay underneath the dock.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Categories"
      data-modal-root="true"
      className="animate-fade-in"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9500,
        backgroundColor: 'var(--picker-scrim, rgba(8, 8, 12, 0.82))',
        WebkitBackdropFilter: 'blur(28px) saturate(190%)',
        backdropFilter: 'blur(28px) saturate(190%)',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <div style={{ flex: 1, overflowY: 'auto', padding: 'calc(var(--safe-top) + 24px) 20px 120px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
        {header}
        {sections.map((section, s) => (
          <section key={section.title ?? s} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', width: '100%' }}>
            {section.title && (
              <h3 style={{ marginTop: '12px', fontSize: '11px', fontWeight: 800, letterSpacing: '1.4px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{section.title}</h3>
            )}
            {section.items.map(item => {
              const active = item.key === selectedKey;
              return (
                <button
                  key={`${section.title ?? s}-${item.key}`}
                  onClick={() => onSelect(item.key)}
                  aria-current={active ? 'true' : undefined}
                  className="interactive"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: active ? 'var(--accent-primary)' : 'var(--text-primary)',
                    fontSize: active ? '22px' : '18px',
                    fontWeight: active ? 800 : 500,
                    cursor: 'pointer',
                    padding: '6px 16px',
                    borderRadius: 'var(--radius-pill)',
                    backgroundColor: active ? 'var(--picker-active-bg, rgba(255,255,255,0.08))' : 'transparent',
                    transition: 'all 0.25s ease'
                  }}
                >
                  {item.name}
                </button>
              );
            })}
          </section>
        ))}
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '24px 0 calc(var(--safe-bottom) + 28px) 0', display: 'flex', justifyContent: 'center', background: 'var(--picker-fade, linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.92) 50%))' }}>
        <button
          onClick={onClose}
          aria-label="Close categories"
          className="interactive"
          style={{
            width: '56px',
            height: '56px',
            borderRadius: '50%',
            border: 'none',
            backgroundColor: 'var(--picker-close-bg, #fff)',
            color: 'var(--picker-close-fg, #000)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)'
          }}
        >
          <X size={26} />
        </button>
      </div>
    </div>,
    document.body
  );
};
