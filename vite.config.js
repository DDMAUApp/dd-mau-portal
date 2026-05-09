import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

const buildId = Date.now().toString(36)

// Build a human-readable version string at config time. Format:
//   "2026.05.10 · 3705ba1"  (date + git short hash)
// Falls back to date-only if git isn't available (shouldn't happen in CI
// or local dev, but keeps the build alive if it ever does).
let gitHash = ''
try { gitHash = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch {}
const today = new Date()
const APP_VERSION = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}${gitHash ? ' · ' + gitHash : ''}`
const APP_BUILT_AT = today.toISOString()

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __APP_BUILT_AT__: JSON.stringify(APP_BUILT_AT),
    __APP_OPERATOR__: JSON.stringify('Shih Technology'),
  },
  plugins: [react()],
  base: '/dd-mau-portal/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-${buildId}-[hash].js`,
        // Vendor chunk splitting — drops the main bundle from ~600KB
        // to ~50KB and lets browsers cache the big rarely-changing libs
        // (react + firebase) across deploys.
        //
        // History note: the May 2026 outage was NOT caused by this split,
        // it was a TDZ bug in App.jsx (const referenced in useEffect
        // deps before declaration). Re-enabled here with one important
        // safety lesson: keep ALL of @firebase/* together. Splitting
        // firestore from storage/messaging causes "Cannot access X
        // before initialization" because @firebase/util and
        // @firebase/component are shared by every firebase package and
        // must initialize before any individual firebase package uses
        // them. One firebase chunk = guaranteed-correct load order.
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return;
          // React + scheduler — app-wide, stable.
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
            return 'vendor-react';
          }
          // ALL of firebase in one chunk. Do NOT split into sub-chunks.
          if (id.includes('@firebase/') || id.includes('firebase/')) {
            return 'vendor-firebase';
          }
          // Everything else from node_modules → generic vendor chunk.
          return 'vendor-misc';
        },
      }
    }
  },
})
