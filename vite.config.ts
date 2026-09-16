import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { aniCliBridgePlugin } from './aniCliBridgePlugin.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), aniCliBridgePlugin()],
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


