import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Builds the Android web layer (overlay.html and dashboard.html) into the app's assets.
// The output is generated and git-ignored: native/mobile/android/app/src/main/assets/web/
const repo = fileURLToPath(new URL('.', import.meta.url))
const web = resolve(repo, 'native/mobile/web')

export default defineConfig({
  root: web,
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    // Read-only access to the desktop rig and its types in src/.
    alias: { '@desktop': resolve(repo, 'src') },
  },
  server: { fs: { allow: [repo] } },
  build: {
    outDir: resolve(repo, 'native/mobile/android/app/src/main/assets/web'),
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        overlay: resolve(web, 'overlay.html'),
        dashboard: resolve(web, 'dashboard.html'),
      },
    },
  },
})