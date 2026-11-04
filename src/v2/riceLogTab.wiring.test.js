// The Rice Log tab (2026-11-03) is all-staff, wired the same way as Health
// Dept: a lazy route, a phone tile, a sidebar item, none behind an access gate.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p) => readFileSync(resolve(__dirname, p), 'utf8');

describe('Rice Log tab wiring', () => {
    it('App lazy-loads it and routes every signed-in staff member to it', () => {
        const app = read('../App.jsx');
        expect(app).toMatch(/const RiceLogTab = lazy\(\(\) => import\('\.\/components\/RiceLogTab'\)/);
        expect(app).toMatch(/if \(activeTab === 'ricelog'\) return <PageErrorBoundary tabName="Rice Log"[^\n]*<RiceLogTab [^\n]*location=\{effectiveLocation\}/);
    });

    it('the phone home screen has a tile with no access gate', () => {
        expect(read('./MobileHome.jsx')).toMatch(/^\s*\{ tab: 'ricelog', Icon: Soup, en: 'Rice Log', es: 'Registro de Arroz' \},$/m);
    });

    it('the sidebar has an item with no requires', () => {
        expect(read('./Sidebar.jsx')).toMatch(/^\s*\{ tab: 'ricelog', Icon: Soup,\s+en: 'Rice Log', es: 'Registro de Arroz' \},$/m);
    });

    it('the sticker page opens the rice screen by kind, and the log from its button', () => {
        const page = read('../components/DateStickerPrinter.jsx');
        expect(page).toContain("if (component.kind === 'rice_batch') { setRiceView('start'); return; }");
        expect(page).toContain("onClick={() => setRiceView('log')}");
    });
});
