// glassService.ts - The "Transparent Glass" appearance setting.
//
// 'frosted' (default): floating surfaces are translucent with a backdrop blur.
// 'clear': no blur anywhere - the same surfaces become see-through panes (see
// the data-glass rules at the end of index.css).
//
// Kept in localStorage so index.html can apply it before first paint.
export type GlassStyle = 'frosted' | 'clear';

const KEY = 'anistream_glass';

export function getGlassStyle(): GlassStyle {
  try {
    return window.localStorage.getItem(KEY) === 'clear' ? 'clear' : 'frosted';
  } catch {
    return 'frosted';
  }
}

export function applyGlassStyle(style: GlassStyle): void {
  if (style === 'clear') document.documentElement.setAttribute('data-glass', 'clear');
  else document.documentElement.removeAttribute('data-glass');
}

export function setGlassStyle(style: GlassStyle): void {
  try { window.localStorage.setItem(KEY, style); } catch { /* storage unavailable: applies this session only */ }
  applyGlassStyle(style);
}
