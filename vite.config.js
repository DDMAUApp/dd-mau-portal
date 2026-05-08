import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const buildId = Date.now().toString(36)

export default defineConfig({
  plugins: [react()],
  base: '/dd-mau-portal/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Bumped to silence the size warning while we let Rollup do its own
    // automatic chunking. We previously had a hand-rolled manualChunks
    // splitter (vendor-react / vendor-firebase / vendor-misc) — it broke
    // production with "Cannot access 'X' before initialization" runtime
    // errors. The crash class is well-documented for manualChunks: when
    // a lazy-imported chunk references vendor code, Rollup's chunking
    // assumes a certain init order that the runtime then violates because
    // ESM hoisting + circular imports interact poorly with hand splits.
    //
    // Default chunking (no manualChunks) lets Rollup analyze the entire
    // dep graph and emit chunks with provably-correct load order. We pay
    // a slightly larger main bundle (~600KB) for guaranteed correctness.
    // If we want vendor-cache wins later, the SAFE path is dynamic
    // import() inside specific code, not vite manualChunks.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-${buildId}-[hash].js`,
      }
    }
  },
})
