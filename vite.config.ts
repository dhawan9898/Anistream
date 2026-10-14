import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import { aniCliBridgePlugin } from './aniCliBridgePlugin.ts'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), aniCliBridgePlugin()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { chunkSizeWarningLimit: 700 },
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api-hianime': {
        target: 'https://hianime.at',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-hianime/, ''),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': 'https://hianime.at/'
        }
      }
    }
  }
})


