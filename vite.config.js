import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const buildId = Date.now().toString(36)

export default defineConfig({
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
