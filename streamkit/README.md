# streamkit

Shared app shell for **AniStream** and **CineStream**. Everything that is not a
content provider lives here, so both apps stay on one architecture and only
their `providers/` layer (scraping, catalogs, stream resolution) differs.

| Area | Contents |
|---|---|
| `ui/` | `FadeImage`, `ErrorState`, `ErrorBoundary`, `ConfirmModal`, `Dock` |
| `player/` | Speed / audio / episode panels, `useWakeLock`, `useFullscreenState`, HLS config, `formatTime` |
| `core/` | `http` (retry, dedupe, timeouts, cache), `errors`, `backStack`, `theme` |
| `providers/` | `resolveHedged` (first success wins, staggered), `ProviderHealth` (cooldown), `LastGoodStore` |
| `styles/` | `fonts.css` (Outfit, woff2 only), `dock.css` (liquid-glass dock) |

Consume with explicit extensions, e.g. `import { Dock } from 'streamkit/ui/Dock.tsx'`.
Source is TypeScript and is compiled by the app's own Vite build.

```bash
npm test        # unit tests
npm run typecheck
```

## Using it from an app

Local development: `"streamkit": "file:../streamkit"` plus `install-links=true` in `.npmrc`
(installs a copy, so React resolves from the app). For CI, publish this repo and depend on
`github:<owner>/streamkit#<tag>`.
