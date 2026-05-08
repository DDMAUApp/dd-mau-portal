import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const buildId = Date.now().toString(36)

export default defineConfig({
  plugins: [react()],
  base: '/dd-mau-portal/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Bumped from the default 500KB. After the manualChunks split below,
    // the main bundle drops to ~150-200KB; the bigger chunks left are the
    // firebase SDK (~250KB) and per-tab feature chunks (Operations, etc.).
    // Those rarely change relative to app code, so they cache long on
    // staff devices and don't re-download on every deploy.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-${buildId}-[hash].js`,
        // Manual chunk splitting. The win is twofold:
        //   1. Smaller initial JS payload — the main bundle no longer ships
        //      Firebase SDK + React inline, so first paint is faster on LTE.
        //   2. Independent caching — a deploy that only touches a component
        //      doesn't bust the firebase / react chunks. Staff phones keep
        //      ~400KB cached across releases.
        manualChunks: (id) => {
          if (id.includes('node_modules')) {
            // React core — app-wide, stable, ~140KB. Safe to split because
            // react packages don't share internals with anything else we use.
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
              return 'vendor-react';
            }
            // Firebase — keep ALL of it in one chunk. Splitting firestore
            // from storage/messaging into separate chunks (the previous
            // attempt) caused circular-import "Cannot access 'X' before
            // initialization" runtime errors because @firebase/util and
            // @firebase/component (shared by every firebase package) ended
            // up in a third chunk that loaded AFTER firestore tried to use
            // it. One firebase chunk = guaranteed-correct load order.
            if (id.includes('@firebase/') || id.includes('firebase/')) {
              return 'vendor-firebase';
            }
            // Everything else from node_modules → generic vendor chunk.
            return 'vendor-misc';
          }
        },
      }
    }
  },
})
