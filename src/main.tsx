import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Bundled fonts: the app starts (and looks right) offline, with no
// render-blocking request to a font CDN.
import 'streamkit/styles/fonts.css'
import 'streamkit/styles/dock.css'
import 'streamkit/styles/shared.css'
import './index.css'
import App from './App.tsx'
import { applyGlassStyle, getGlassStyle } from './services/glassService.ts'
import { ErrorBoundary } from 'streamkit/ui/ErrorBoundary.tsx'
import { loadSiteConfig } from './providers/siteConfig.ts'

// Transparent-glass setting (index.html applies it pre-paint too).
applyGlassStyle(getGlassStyle())

// The site's address: the saved copy applies at once, a fresh one downloads in the background.
void loadSiteConfig()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary appName="AniStream">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
