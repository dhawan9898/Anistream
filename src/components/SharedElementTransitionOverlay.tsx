// SharedElementTransitionOverlay.tsx - Fluid Apple-style shared element proxy
// that animates seamlessly between the clicked poster card and the anime detail view.
import React, { useEffect, useState, useRef } from 'react';
import {
  subscribeSharedTransition,
  finishSharedTransition,
  type SharedTransitionState,
  type CardRect
} from '../services/sharedTransitionService';

export const SharedElementTransitionOverlay: React.FC = () => {
  const [transition, setTransition] = useState<SharedTransitionState>({
    active: false,
    anime: null,
    originRect: null,
    phase: 'idle'
  });

  const [currentStyle, setCurrentStyle] = useState<React.CSSProperties | null>(null);
  const [visible, setVisible] = useState(false);
  const animTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return subscribeSharedTransition(next => {
      setTransition(next);
      if (next.active && next.phase === 'expanding' && next.originRect && next.anime) {
        const { originRect } = next;
        setVisible(true);

        // Frame 0: Exact geometry of the source poster card
        setCurrentStyle({
          position: 'fixed',
          top: `${originRect.top}px`,
          left: `${originRect.left}px`,
          width: `${originRect.width}px`,
          height: `${originRect.height}px`,
          borderRadius: 'var(--radius-md, 16px)',
          boxShadow: '0 12px 30px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.15)',
          transform: 'translate3d(0, 0, 0) scale(1)',
          transition: 'none',
          zIndex: 9999,
          pointerEvents: 'none',
          overflow: 'hidden',
          opacity: 1
        });

        // Frame 1: Morph to destination poster in AnimeDetailScreen
        const frame = requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            // Check if destination element is already in DOM
            const targetEl = document.getElementById('detail-poster-target');
            let targetRect: CardRect;

            if (targetEl) {
              const rect = targetEl.getBoundingClientRect();
              targetRect = {
                top: rect.top,
                left: rect.left,
                width: rect.width || 108,
                height: rect.height || 154
              };
            } else {
              // Standard Apple detail header target coordinate
              const safeTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0;
              targetRect = {
                top: safeTop + 136,
                left: 20,
                width: 108,
                height: 154
              };
            }

            setCurrentStyle({
              position: 'fixed',
              top: `${targetRect.top}px`,
              left: `${targetRect.left}px`,
              width: `${targetRect.width}px`,
              height: `${targetRect.height}px`,
              borderRadius: 'var(--radius-md, 16px)',
              boxShadow: 'var(--card-shadow-hover), 0 20px 48px rgba(0, 0, 0, 0.75)',
              border: '1px solid rgba(255, 255, 255, 0.22)',
              transform: 'translate3d(0, 0, 0) scale(1)',
              transition: 'all 0.36s cubic-bezier(0.32, 0.72, 0, 1)',
              zIndex: 9999,
              pointerEvents: 'none',
              overflow: 'hidden',
              opacity: 1
            });
          });
        });

        // Clean up and hand off to real detail screen poster
        if (animTimerRef.current) window.clearTimeout(animTimerRef.current);
        animTimerRef.current = window.setTimeout(() => {
          // Subtle fade out as real poster takes over
          setCurrentStyle(prev => prev ? { ...prev, opacity: 0, transition: 'opacity 0.12s ease' } : null);
          window.setTimeout(() => {
            setVisible(false);
            finishSharedTransition();
          }, 120);
        }, 360);

        return () => cancelAnimationFrame(frame);
      } else if (!next.active) {
        setVisible(false);
      }
    });
  }, []);

  if (!visible || !transition.anime || !currentStyle) {
    return null;
  }

  const { anime } = transition;
  const imageSrc = anime.poster || anime.banner;

  return (
    <div style={currentStyle} aria-hidden="true">
      {imageSrc && (
        <img
          src={imageSrc}
          alt=""
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block'
          }}
        />
      )}
      {/* Specular sheen during flight */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(180deg, rgba(255,255,255,0.18) 0%, transparent 40%, rgba(0,0,0,0.4) 100%)',
          pointerEvents: 'none'
        }}
      />
    </div>
  );
};
