import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { copyFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
// Sentry source map upload plugin — Andrew 2026-05-26. Runs on every
// `npm run build`. Reads three env vars from the local shell or CI:
//   • SENTRY_AUTH_TOKEN  — created at sentry.io → User Settings → Auth Tokens
//                          (scopes: project:write, project:releases). SECRET.
//   • SENTRY_ORG         — your Sentry org slug (visible in URLs).
//   • SENTRY_PROJECT     — the project slug; we use 'dd-mau-portal'.
//
// If any of these are missing the plugin is omitted entirely — local
// dev builds work without Sentry credentials. Source maps still get
// generated (sourcemap: 'hidden' below) so the plugin can ingest them
// when the env is configured; the `filesToDeleteAfterUpload` setting
// then strips them from /dist before deploy so production never ships
// the maps.
import { sentryVitePlugin } from '@sentry/vite-plugin'

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

// Self-heal version manifest. Writes dist/version.json with the
// current build's __APP_VERSION__ string. The running app fetches
// /version.json with cache:'no-store' on every boot and compares
// to its baked-in __APP_VERSION__ — if they differ, the bundle
// nukes its caches + unregisters the SW + reloads. This is the
// last-resort safety net for "Safari is showing the old bundle"
// problems: even if the SW update channel fails to fire, the next
// app boot self-heals as long as the user has network.
const writeVersionManifest = () => ({
  name: 'write-version-manifest',
  closeBundle() {
    try {
      const payload = JSON.stringify({ v: APP_VERSION, ts: APP_BUILT_AT });
      writeFileSync(resolve('dist/version.json'), payload + '\n');
    } catch (e) {
      console.warn('[write-version-manifest] failed (non-fatal):', e.message);
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
  plugins: [
    react(),
    spa404Fallback(),
    writeVersionManifest(),
    // Sentry source-map upload — only attached when the three env vars
    // are present. Local dev/build without Sentry creds = no plugin,
    // no upload, no warning. CI/owner laptop with creds = source maps
    // are uploaded to Sentry on every build so stack traces in the
    // Sentry dashboard show source code instead of minified output.
    // The release tag matches __APP_VERSION__ so Sentry's "this deploy
    // introduced N errors" UI lines up with our app version label.
    ...(process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
      ? [sentryVitePlugin({
          authToken: process.env.SENTRY_AUTH_TOKEN,
          org: process.env.SENTRY_ORG,
          project: process.env.SENTRY_PROJECT,
          release: { name: APP_VERSION, finalize: true },
          sourcemaps: {
            assets: ['./dist/**/*.js', './dist/**/*.js.map'],
            // After upload, delete the .map files so production
            // doesn't serve them. Sentry has them; the browser
            // doesn't need them.
            filesToDeleteAfterUpload: ['./dist/**/*.map'],
          },
          // Suppress the "no auth token" / "no org" warnings if any
          // env var is empty — we already gate above so this is a
          // safety net for partial configs.
          silent: false,
        })]
      : []),
  ],
  // Strip noisy console calls from production builds.
  // `pure` marks these as side-effect-free so esbuild removes them
  // when minifying (production only — dev keeps everything so we can
  // debug). Keeps console.warn + console.error so real problems still
  // surface in prod consoles.
  //
  // Why this matters in this app: Schedule.jsx has 52 console.* calls
  // and Operations.jsx has 44. Many are inside hot loops or per-shift
  // iterators. Each one allocates strings + formatting work on mobile,
  // contributing to scroll judder even when DevTools isn't open.
  esbuild: {
    pure: ['console.log', 'console.info', 'console.debug', 'console.trace'],
  },
  // Custom domain (app.ddmaustl.com) serves from the apex, so assets
  // resolve at '/' not '/dd-mau-portal/'. A CNAME file in public/ tells
  // GitHub Pages which domain to serve from. The legacy
  // ddmauapp.github.io/dd-mau-portal/ URL auto-redirects to the custom
  // domain once GitHub Pages has the custom domain set in repo settings.
  base: '/',
  build: {
    outDir: 'dist',
    // 2026-06-03 — Target ES2015 to dodge Temporal Dead Zone issues
    // in WKWebView. The wrapped iOS app crashes on launch with
    // "Cannot access 'X' before initialization" in vendor-firebase.
    // The same bundle works fine in Safari and Chrome. WKWebView's
    // JavaScriptCore is stricter about let/const evaluation order
    // than V8 or the standalone Safari engine. Lowering target to
    // es2015 makes esbuild/Rollup emit `var` declarations which
    // are hoisted (no TDZ) - eliminates the entire bug class.
    //
    // Trade: bundle size grows ~3-5% from var hoisting (vendor-
    // firebase 567 KB -> ~590 KB). Worth it for "always loads".
    target: 'es2015',
    // 2026-05-26 — sourcemap generation is gated on Sentry being
    // configured. The Sentry vite plugin needs maps to upload to its
    // backend; if Sentry isn't configured we DON'T want to generate
    // them because they'd ship to GitHub Pages unprotected and any
    // visitor could URL-guess /assets/*.js.map to recover near-source
    // code. Conditional:
    //   • Sentry creds set → sourcemap: 'hidden' (generated, no
    //     //# sourceMappingURL= comment, plugin uploads + deletes from
    //     dist via filesToDeleteAfterUpload).
    //   • Sentry creds NOT set → sourcemap: false (no .map files
    //     generated at all → nothing leaks).
    sourcemap: (process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT)
      ? 'hidden'
      : false,
    chunkSizeWarningLimit: 800,
    // Keep the lazy Sentry chunk OUT of the entry's modulepreload list. Vite
    // walks one level of dynamic imports and would otherwise <link rel=
    // "modulepreload"> vendor-sentry — which re-introduces the eager fetch +
    // compile we're avoiding. It's dynamic-imported at idle (data/sentryClient),
    // so it doesn't need to preload.
    modulePreload: {
      resolveDependencies: (_filename, deps) => deps.filter((d) => !/vendor-sentry/.test(d)),
    },
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
          // TranslatableText is used by ChatThread + ChatPinsDrawer +
          // ChatAckDashboard (the first static, the others lazy from
          // ChatThread). Without this rule Vite inlines it into
          // ChatThread's chunk and emits a dual-export (`C as <default>`
          // and `T as TranslatableText`) namespace-wrapper pair.
          // Safari then hit a TDZ on `t.C` when ChatCenter tried to
          // render the lazy ChatThread ("Cannot access 'C' before
          // initialization", Andrew 2026-05-22 outage). Forcing
          // TranslatableText into its own chunk gives ChatThread a
          // clean single default export and breaks the failure mode.
          // The translation data layer goes with it so the chunk is
          // self-contained (no extra round-trip for the cache helpers).
          if (id.includes('/TranslatableText.jsx') || id.includes('/data/translation.js')) {
            return 'translatable-text';
          }
          if (!id.includes('node_modules')) return;
          // React + scheduler + lucide-react — app-wide, stable.
          // 2026-05-27 OUTAGE — lucide-react ended up in vendor-misc
          // because the previous regex check was `/react/` which doesn't
          // match `lucide-react/` (the slash is wrong — it's
          // `-react/`, not `/react/`). vendor-misc then tried to call
          // React.createContext at the top of the lucide module before
          // vendor-react had bound React in scope, producing:
          //   TypeError: Cannot read properties of undefined
          //   (reading 'createContext')
          // and the app refused to mount. Pinning lucide-react to the
          // SAME chunk as React removes the cross-chunk dependency
          // entirely. Cost: vendor-react gets a few KB bigger; benefit:
          // app loads at all.
          if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/scheduler/') ||
              id.includes('/lucide-react/')
          ) {
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
            // pdf-lib's SCOPED deps (@pdf-lib/standard-fonts ≈ 70KB of zlib
            // base64 font data, @pdf-lib/upng). The '/pdf-lib/' check above does
            // NOT match '/@pdf-lib/', so these were being force-bundled into the
            // EAGER vendor-misc chunk and downloaded on every cold boot — even
            // though pdf-lib is only dynamic-imported. Andrew 2026-06-17 audit.
            id.includes('/@pdf-lib/') ||
            id.includes('/pdfjs-dist/') ||
            id.includes('/jszip/') ||
            id.includes('/qrcode/') ||
            // exceljs (+ its private zip/csv deps) is ONLY dynamic-imported by the
            // payroll engine. Returning undefined keeps it OUT of the eager
            // vendor-misc chunk so it co-locates with the lazy payroll chunk and
            // costs first-paint nothing. (2026-06-17, payroll feature.)
            id.includes('/exceljs/') ||
            id.includes('/archiver') ||
            id.includes('/zip-stream/') ||
            id.includes('/compress-commons/') ||
            id.includes('/crc32-stream/') ||
            id.includes('/crc-32/') ||
            id.includes('/lazystream/') ||
            id.includes('/fast-csv/') ||
            id.includes('/@fast-csv/') ||
            id.includes('/saxes/') ||
            id.includes('/unzipper/')
          ) {
            return;
          }
          // Capacitor plugins + the Capgo OTA updater are DYNAMIC-imported
          // (capacitor-bridge / messaging / downloadFile all `await import()`
          // them, gated behind isCapacitorNative()). The catch-all below would
          // otherwise force them into the eager vendor-misc chunk — so they were
          // being downloaded + parsed on every cold boot, on WEB (where the
          // plugins no-op and are never imported) and on native's cold-start
          // eager path. Returning undefined lets Rollup co-locate them with the
          // lazy code that imports them → zero web first-paint cost, off native's
          // critical path. @capacitor/core stays eager (statically imported to
          // detect the native platform on boot). Andrew 2026-06-17 speed audit.
          if (id.includes('/@capgo/')) return;
          if (id.includes('/@capacitor/') && !id.includes('/@capacitor/core/')) return;
          // Sentry SDK is imported LAZILY (dynamic import in data/sentryClient)
          // so it stays out of the eager entry. Give it its own async chunk;
          // because nothing imports it statically, this chunk is NOT preloaded
          // → zero first-paint cost (was ~150KB of eager vendor-misc).
          if (id.includes('@sentry/') || id.includes('@sentry-internal/')) {
            return 'vendor-sentry';
          }
          // Everything else from node_modules → generic vendor chunk.
          return 'vendor-misc';
        },
      }
    }
  },
})
