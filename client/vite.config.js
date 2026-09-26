import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// `--mode desktop` builds the UI for the Tauri app: IPC instead of HTTP, no
// service worker, and a separate output directory. Everything else is shared.
export default defineConfig(({ mode }) => {
  const desktop = mode === 'desktop'
  const transport = desktop ? './src/transport/tauri.js' : './src/transport/http.js'

  return {
    resolve: {
      alias: { '#transport': fileURLToPath(new URL(transport, import.meta.url)) },
    },
    server: {
      proxy: desktop ? undefined : { '/api': 'http://localhost:3001' },
    },
    build: {
      outDir: desktop ? 'dist-desktop' : 'dist',
      emptyOutDir: true,
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test-setup.js'],
    },
    plugins: [
      react(),
      tailwindcss(),
      !desktop && VitePWA({
        registerType: 'autoUpdate',
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//],
        },
        manifest: {
          name: 'Inbox Max',
          short_name: 'Inbox Max',
          description: 'The email client for people who read subject lines.',
          theme_color: '#6366f1',
          background_color: '#ffffff',
          display: 'standalone',
          scope: '/',
          start_url: '/',
          icons: [
            {
              src: '/icons/favicon.svg',
              sizes: 'any',
              type: 'image/svg+xml',
              purpose: 'any',
            },
          ],
        },
      }),
    ],
  }
})
