import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Bundled fonts: the app starts (and looks right) offline, with no
// render-blocking request to a font CDN.
import 'streamkit/styles/fonts.css'
import 'streamkit/styles/dock.css'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from 'streamkit/ui/ErrorBoundary.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary appName="AniStream">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
