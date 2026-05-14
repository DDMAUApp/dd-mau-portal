import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'

// GitHub Pages SPA fallback: serve index.html for any unknown path.
// Pages doesn't natively rewrite to index.html, but it DOES serve
// /404.html for any 404'd path with a 200 status from the SPA's point
// of view (the SPA bootstraps + reads window.location and routes).
// Without this, /apply works on first load (via the Squarespace 302
// or a typed URL) but pull-to-refresh on iOS reloads /apply, hits a
// genuine 404, and the user sees GitHub's "file not found" page.
//
// The 404.html MUST be byte-identical to index.html for the same
// hashed asset bundle, so we generate it from index.html post-build
// rather than checking in a stale static copy that would drift.
const spa404Fallback = () => ({
  name: 'spa-404-fallback',
  closeBundle() {
    try {
      copyFileSync(resolve('dist/index.html'), resolve('dist/404.html'));
    } catch (e) {
      console.warn('[spa-404-fallback] copy failed (non-fatal):', e.message);
    }
  },
})

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
  plugins: [react(), spa404Fallback()],
  // Custom domain (app.ddmaustl.com) serves from the apex, so assets
  // resolve at '/' not '/dd-mau-portal/'. A CNAME file in public/ tells
  // GitHub Pages which domain to serve from. The legacy
  // ddmauapp.github.io/dd-mau-portal/ URL auto-redirects to the custom
  // domain once GitHub Pages has the custom domain set in repo settings.
  base: '/',
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
        //
        // 2026-05-11 bundle-trim pass: pdf-lib, pdfjs-dist, jszip, qrcode
        // were all being swept into vendor-misc (~934 KB), which loaded
        // on FIRST PAINT for every user even though none of them are
        // imported eagerly. Verified import sites:
        //   - pdf-lib       → OnboardingFillablePdf / OfferLetter /
        //                     EmployerFill / TemplateEditor (all lazy)
        //   - pdfjs-dist    → await import() inside lazy onboarding (double-lazy)
        //   - jszip, qrcode → await import() inside lazy Onboarding.jsx
        // Returning undefined for these lets Rollup co-locate them with
        // the lazy route chunks that actually need them, so first-paint
        // no longer ships ~900 KB of PDF infrastructure that 99% of
        // sessions never touch.
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
          // Lazy-only deps — let Rollup attach them to the lazy route
          // chunks instead of force-grouping them into vendor-misc.
          // Note: pdf-lib has no slash in the path on every platform
          // (npm hoists it as /pdf-lib/), match by the package name.
          if (
            id.includes('/pdf-lib/') ||
            id.includes('/pdfjs-dist/') ||
            id.includes('/jszip/') ||
            id.includes('/qrcode/')
          ) {
            return;
          }
          // Everything else from node_modules → generic vendor chunk.
          return 'vendor-misc';
        },
      }
    }
  },
})
