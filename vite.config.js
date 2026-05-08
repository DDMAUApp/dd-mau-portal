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
            // React core — app-wide, stable, ~140KB.
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
              return 'vendor-react';
            }
            // Firebase — large, modular. Split into core (firestore+auth+app,
            // needed everywhere) vs aux (storage + messaging, used only on
            // some flows). Lets staff who never use FCM/photos avoid those
            // bytes entirely if Vite doesn't pre-fetch them.
            if (id.includes('@firebase/firestore') || id.includes('@firebase/auth') || id.includes('@firebase/app')) {
              return 'vendor-firebase-core';
            }
            if (id.includes('@firebase/storage') || id.includes('@firebase/messaging')) {
              return 'vendor-firebase-aux';
            }
            // Everything else from node_modules → generic vendor chunk.
            return 'vendor-misc';
          }
        },
      }
    }
  },
})
