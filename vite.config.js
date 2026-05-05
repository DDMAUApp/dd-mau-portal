import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const buildId = Date.now().toString(36)

export default defineConfig({
  plugins: [react()],
  base: '/dd-mau-portal/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-${buildId}-[hash].js`,
      }
    }
  },
})
