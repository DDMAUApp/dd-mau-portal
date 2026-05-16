// Vitest configuration — kept separate from vite.config.js so the
// SPA fallback plugin + manual chunks don't fire during tests. We
// reuse the existing React plugin so JSX + Fast Refresh just work.
//
// 2026-05-16 — added as part of Phase 1 (multi-tenant foundations).
// Without test infrastructure we can't safely refactor the
// single-tenant codebase into the multi-tenant shape, so this is
// the first wired-up piece even though no tests are required to
// ship today.
//
// Environment is jsdom so component tests can render. The setup
// file wires @testing-library/jest-dom's matchers globally.

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['./src/test/setup.js'],
        // Co-locate test files with the source they test. The pattern
        // matches both `foo.test.js` next to `foo.js` AND `__tests__/`
        // dirs if we adopt that convention later.
        include: ['src/**/*.{test,spec}.{js,jsx}'],
        // Coverage isn't wired yet — first goal is to get green tests
        // running in CI, then add coverage tracking once we have a
        // baseline.
    },
});
