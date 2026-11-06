// SharedElementTransitionOverlay.tsx - Flies the tapped poster from its card to
// its place on the title page.
//
// Why it is built this way (the earlier version looked glitchy):
//  - The proxy is laid out ONCE at the destination and moved there with a
//    compositor-only transform (translate + scale), never by animating
//    top/left/width/height, which re-lays-out every frame.
//  - The destination is measured only once the title page has mounted (it is
//    lazy-loaded) and its position has stopped changing. While this runs the
//    page only fades in (see `data-shared-transition` in index.css) instead of
//    sliding and scaling, so the target is not moving underneath the proxy.
//  - The proxy is removed with no fade at the end, exactly on top of the page's
//    own poster, so there is no cross-fade "pop".
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  subscribeSharedTransition,
  finishSharedTransition,
  type SharedTransitionState,
  type CardRect
} from '../services/sharedTransitionService';

const FLIGHT_MS = 380;
const FLIGHT_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
// Give up waiting for the (lazy) title page after this long.
const TARGET_TIMEOUT_MS = 900;

// Stacked title pages each have a poster target; the newest is the last.
function findTarget(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>('#detail-poster-target');
  return all.length ? all[all.length - 1] : null;
}

const toRect = (r: DOMRect): CardRect => ({ top: r.top, left: r.left, width: r.width, height: r.height });

export const SharedElementTransitionOverlay: React.FC = () => {
  const [transition, setTransition] = useState<SharedTransitionState | null>(null);
  const proxyRef = useRef<HTMLDivElement | null>(null);
  // Bumped per transition so a stale one never finishes a newer one.
  const runRef = useRef(0);

  useEffect(() => subscribeSharedTransition(next => {
    if (next.active && next.phase === 'expanding' && next.originRect && next.anime) {
      runRef.current += 1;
      setTransition(next);
    } else if (!next.active) {
      setTransition(null);
    }
  }), []);

  useLayoutEffect(() => {
    if (!transition || !transition.originRect) return;
    const run = runRef.current;
    const origin = transition.originRect;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let animation: Animation | null = null;
    let cancelled = false;
    const started = performance.now();
    let lastKey = '';
    let stableFrames = 0;

    const end = () => {
      if (cancelled || run !== runRef.current) return;
      setTransition(null);
      finishSharedTransition();
    };

    const fly = (target: HTMLElement) => {
      const proxy = proxyRef.current;
      if (!proxy) return end();
      const t = toRect(target.getBoundingClientRect());
      if (t.width < 1 || t.height < 1 || reduceMotion) return end();

      // Lay the proxy out at the destination, then play origin -> destination.
      Object.assign(proxy.style, {
        top: `${t.top}px`, left: `${t.left}px`, width: `${t.width}px`, height: `${t.height}px`
      });
      const dx = origin.left - t.left;
      const dy = origin.top - t.top;
      const sx = origin.width / t.width;
      const sy = origin.height / t.height;
      animation = proxy.animate(
        [
          { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})` },
          { transform: 'translate3d(0, 0, 0) scale(1, 1)' }
        ],
        { duration: FLIGHT_MS, easing: FLIGHT_EASING, fill: 'both' }
      );
      animation.onfinish = () => {
        // Hand over only once the page's own poster has painted, so the
        // proxy never uncovers an empty slot.
        const img = target.querySelector('img');
        if (!img || img.complete) return end();
        const done = () => end();
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
        window.setTimeout(done, 500);
      };
    };

    // Until the title page is mounted and has stopped moving, the proxy simply
    // sits on the card (it reads as the card lifting).
    const waitForTarget = () => {
      if (cancelled) return;
      const target = findTarget();
      if (target) {
        const r = target.getBoundingClientRect();
        const key = `${Math.round(r.top)}|${Math.round(r.left)}|${Math.round(r.width)}|${Math.round(r.height)}`;
        stableFrames = key === lastKey ? stableFrames + 1 : 0;
        lastKey = key;
        if (stableFrames >= 2) return fly(target);
      }
      if (performance.now() - started > TARGET_TIMEOUT_MS) return end();
      raf = requestAnimationFrame(waitForTarget);
    };
    raf = requestAnimationFrame(waitForTarget);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      animation?.cancel();
    };
  }, [transition]);

  if (!transition || !transition.anime || !transition.originRect) return null;

  const { anime, originRect } = transition;
  const imageSrc = anime.poster || anime.banner;

  return (
    <div
      ref={proxyRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        top: originRect.top,
        left: originRect.left,
        width: originRect.width,
        height: originRect.height,
        transformOrigin: '0 0',
        willChange: 'transform',
        borderRadius: 'var(--radius-md, 16px)',
        boxShadow: 'var(--card-shadow-hover)',
        zIndex: 9999,
        pointerEvents: 'none',
        overflow: 'hidden',
        backfaceVisibility: 'hidden'
      }}
    >
      {imageSrc && (
        <img
          src={imageSrc}
          alt=""
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      )}
    </div>
  );
};
