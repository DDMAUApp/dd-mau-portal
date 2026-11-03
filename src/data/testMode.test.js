// Test mode switch: enter / exit / cold-launch restore (2026-11-03).
import { describe, it, expect, beforeEach, vi } from 'vitest';

const FLAG = 'ddmau:testMode';
const BACKUP = 'ddmau:testMode:lsBackup';

async function load() {
    vi.resetModules();
    return import('./testMode');
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
});

describe('TEST_MODE switch', () => {
    it('is off with no flag', async () => {
        const m = await load();
        expect(m.TEST_MODE).toBe(null);
    });

    it('is on for the page when the flag is set and this tab entered it', async () => {
        localStorage.setItem(FLAG, JSON.stringify({ name: 'Bryan Test', id: 77, at: 1, tab: 't1' }));
        sessionStorage.setItem('ddmau:sessionAlive', '1');
        sessionStorage.setItem('ddmau:testModeTab', 't1');
        const m = await load();
        expect(m.TEST_MODE).toMatchObject({ name: 'Bryan Test', id: 77 });
        expect(Object.isFrozen(m.TEST_MODE)).toBe(true);
    });

    it('another open tab (desktop web shares localStorage) never runs in someone else\'s test mode', async () => {
        localStorage.setItem(FLAG, JSON.stringify({ name: 'Bryan Test', id: 77, at: 1, tab: 't1', beat: Date.now() }));
        localStorage.setItem('ddmau:language', 'es');
        sessionStorage.setItem('ddmau:sessionAlive', '1');
        sessionStorage.setItem('ddmau:testModeTab', 'other-tab');
        const m = await load();
        expect(m.TEST_MODE).toBe(null);
        expect(m.TEST_MODE_IN_OTHER_TAB).toBe(true);
        // ...and it leaves the test tab's flag + this tab's storage alone.
        expect(localStorage.getItem(FLAG)).not.toBe(null);
        expect(localStorage.getItem('ddmau:language')).toBe('es');
    });

    it('a cold launch (app closed) never resumes test mode and restores the device', async () => {
        localStorage.setItem(BACKUP, JSON.stringify({ 'ddmau:language': 'es', 'ddmau:printerSlot': 'kitchen' }));
        localStorage.setItem(FLAG, JSON.stringify({ name: 'Bryan Test', id: 77 }));
        localStorage.setItem('ddmau:staffName', 'Bryan Test');
        localStorage.setItem('ddmau:chatDraft:x', 'test-mode junk');
        const m = await load();
        expect(m.TEST_MODE).toBe(null);
        expect(localStorage.getItem(FLAG)).toBe(null);
        expect(localStorage.getItem('ddmau:staffName')).toBe(null);
        expect(localStorage.getItem('ddmau:chatDraft:x')).toBe(null);
        expect(localStorage.getItem('ddmau:language')).toBe('es');
    });
});

describe('flags left by other tabs / older builds', () => {
    it('adopts a v1.0.499 flag (no tab id) in the same tab instead of booting the real app as the tester', async () => {
        localStorage.setItem(FLAG, JSON.stringify({ name: 'Bryan Test', id: 77, at: 1 }));
        localStorage.setItem('ddmau:staffName', 'Bryan Test');
        sessionStorage.setItem('ddmau:sessionAlive', '1');
        const m = await load();
        expect(m.TEST_MODE?.name).toBe('Bryan Test');
        const flag = JSON.parse(localStorage.getItem(FLAG));
        expect(flag.tab).toBeTruthy();
        expect(sessionStorage.getItem('ddmau:testModeTab')).toBe(flag.tab);
    });

    it('a brand-new tab while a LIVE test tab is running shows the blocker and leaves the session alone', async () => {
        localStorage.setItem(FLAG, JSON.stringify({ name: 'Bryan Test', id: 77, tab: 't1', beat: Date.now() }));
        localStorage.setItem(BACKUP, JSON.stringify({ 'ddmau:language': 'es' }));
        const m = await load();   // no sessionAlive: a cold launch of another tab
        expect(m.TEST_MODE).toBe(null);
        expect(m.TEST_MODE_IN_OTHER_TAB).toBe(true);
        expect(localStorage.getItem(FLAG)).not.toBe(null);
        expect(localStorage.getItem(BACKUP)).not.toBe(null);
    });

    it('a stale flag (no heartbeat for 90s+) is cleaned up and the device restored', async () => {
        localStorage.setItem(FLAG, JSON.stringify({ name: 'Bryan Test', id: 77, tab: 't1', beat: Date.now() - 5 * 60000 }));
        localStorage.setItem(BACKUP, JSON.stringify({ 'ddmau:language': 'es' }));
        sessionStorage.setItem('ddmau:sessionAlive', '1');
        sessionStorage.setItem('ddmau:testModeTab', 'other-tab');
        const m = await load();
        expect(m.TEST_MODE).toBe(null);
        expect(m.TEST_MODE_IN_OTHER_TAB).toBe(false);
        expect(localStorage.getItem(FLAG)).toBe(null);
        expect(localStorage.getItem('ddmau:language')).toBe('es');
    });

    it('re-entering while an unfinished session\'s backup exists keeps the CLEAN backup', async () => {
        localStorage.setItem(BACKUP, JSON.stringify({ 'ddmau:language': 'es' }));
        localStorage.setItem(FLAG, JSON.stringify({ name: 'Bryan Test', id: 77, tab: 't1', beat: Date.now() }));
        localStorage.setItem('ddmau:language', 'en-from-test-session');
        sessionStorage.setItem('ddmau:sessionAlive', '1');
        sessionStorage.setItem('ddmau:testModeTab', 't1');
        const m = await load();
        m.__setTestModeReloadForTests(() => {});
        m.enterTestMode({ name: 'Bryan Test', id: 77 });
        expect(JSON.parse(localStorage.getItem(BACKUP))).toEqual({ 'ddmau:language': 'es' });
    });

    it('the test tab leaves test mode as soon as another tab ends it', async () => {
        localStorage.setItem(FLAG, JSON.stringify({ name: 'Bryan Test', id: 77, tab: 't1', beat: Date.now() }));
        sessionStorage.setItem('ddmau:sessionAlive', '1');
        sessionStorage.setItem('ddmau:testModeTab', 't1');
        const m = await load();
        const reload = vi.fn();
        m.__setTestModeReloadForTests(reload);
        const stop = m.startTestModeHeartbeat();
        expect(JSON.parse(localStorage.getItem(FLAG)).beat).toBeGreaterThan(0);
        localStorage.removeItem(FLAG);   // another tab's "End test mode"
        window.dispatchEvent(new StorageEvent('storage', { key: FLAG }));
        expect(reload).toHaveBeenCalledTimes(1);
        stop();
    });
});

describe('multi-tab edge cases (final review)', () => {
    it('ending test mode from another tab keeps the real drafts the restore put back', async () => {
        localStorage.setItem(BACKUP, JSON.stringify({ 'ddmau:moneydraft:webster': '{"real":1}', 'ddmau:chatDraft:abc': 'hi' }));
        localStorage.setItem(FLAG, JSON.stringify({ name: 'Bryan Test', id: 77, tab: 't1', beat: Date.now() }));
        sessionStorage.setItem('ddmau:sessionAlive', '1');
        sessionStorage.setItem('ddmau:testModeTab', 't1');
        const m = await load();
        const reload = vi.fn();
        m.__setTestModeReloadForTests(reload);
        const stop = m.startTestModeHeartbeat();
        m.endTestModeElsewhere();                               // tab B's button
        window.dispatchEvent(new StorageEvent('storage', { key: null }));   // tab A hears it
        expect(localStorage.getItem('ddmau:moneydraft:webster')).toBe('{"real":1}');
        expect(localStorage.getItem('ddmau:chatDraft:abc')).toBe('hi');
        expect(localStorage.getItem(FLAG)).toBe(null);
        expect(sessionStorage.getItem('ddmau:testModeTab')).toBe(null);   // A dropped its own leftovers
        stop();
    });

    it('exitTestMode after someone else already restored the device does not sweep again', async () => {
        localStorage.setItem('ddmau:recipeEditDraft:7', 'real draft');
        sessionStorage.setItem('ddmau:sessionAlive', '1');
        const m = await load();
        m.__setTestModeReloadForTests(() => {});
        m.exitTestMode();   // no flag present
        expect(localStorage.getItem('ddmau:recipeEditDraft:7')).toBe('real draft');
    });

    it('storage events only check ownership and never write (no ping-pong between duplicated tabs)', async () => {
        localStorage.setItem(FLAG, JSON.stringify({ name: 'Bryan Test', id: 77, tab: 't1', beat: 1 }));
        sessionStorage.setItem('ddmau:sessionAlive', '1');
        sessionStorage.setItem('ddmau:testModeTab', 't1');
        const m = await load();
        m.__setTestModeReloadForTests(() => {});
        const stop = m.startTestModeHeartbeat();
        const spy = vi.spyOn(Storage.prototype, 'setItem');
        window.dispatchEvent(new StorageEvent('storage', { key: FLAG }));
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
        stop();
    });

    it('a former test tab whose flag is gone boots the real app without its test-session leftovers', async () => {
        sessionStorage.setItem('ddmau:sessionAlive', '1');
        sessionStorage.setItem('ddmau:testModeTab', 't1');
        sessionStorage.setItem('ddmau:payrollUnlocked', '1');   // set against the test copy
        const m = await load();
        expect(m.TEST_MODE).toBe(null);
        expect(sessionStorage.getItem('ddmau:payrollUnlocked')).toBe(null);
        expect(sessionStorage.getItem('ddmau:sessionAlive')).toBe('1');
    });

    it('an iPhone home-screen app reopened within 90s is never blocked (it has no other tab)', async () => {
        Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true });
        try {
            localStorage.setItem(FLAG, JSON.stringify({ name: 'Bryan Test', id: 77, tab: 't1', beat: Date.now() }));
            const m = await load();   // cold launch
            expect(m.TEST_MODE_IN_OTHER_TAB).toBe(false);
            expect(localStorage.getItem(FLAG)).toBe(null);
        } finally {
            delete window.navigator.standalone;
        }
    });
});

describe('enter / exit', () => {
    it('enter backs up the device, sets the flag + session, and reloads', async () => {
        localStorage.setItem('ddmau:language', 'es');
        localStorage.setItem('ddmau:stickerLists:v1', '{"real":true}');
        const m = await load();
        const reload = vi.fn();
        m.__setTestModeReloadForTests(reload);
        sessionStorage.setItem('ddmau:payrollUnlocked', '1');   // a real owner unlocked payroll in this tab
        expect(m.enterTestMode({ name: 'Bryan Test', id: 77 })).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
        const flag = JSON.parse(localStorage.getItem(FLAG));
        expect(flag).toMatchObject({ name: 'Bryan Test', id: 77 });
        expect(sessionStorage.getItem('ddmau:testModeTab')).toBe(flag.tab);
        // The test identity is never written to the device-wide saved login.
        expect(localStorage.getItem('ddmau:staffName')).toBe(null);
        expect(sessionStorage.getItem('ddmau:sessionAlive')).toBe('1');
        expect(sessionStorage.getItem('ddmau:payrollUnlocked')).toBe(null);
        expect(JSON.parse(localStorage.getItem(BACKUP))).toEqual({ 'ddmau:language': 'es', 'ddmau:stickerLists:v1': '{"real":true}' });
    });

    it('exit puts every localStorage key back exactly and lands on the lock screen', async () => {
        localStorage.setItem('ddmau:language', 'es');
        localStorage.setItem('ddmau:stickerLists:v1', '{"real":true}');
        let m = await load();
        m.__setTestModeReloadForTests(() => {});
        m.enterTestMode({ name: 'Bryan Test', id: 77 });
        // Test session dirties the device.
        localStorage.setItem('ddmau:stickerLists:v1', '{"fake":true}');
        localStorage.setItem('ddmau:inventoryReloadStash', '[1,2,3]');
        localStorage.setItem('ddmau:language', 'en');
        m = await load();
        expect(m.TEST_MODE?.name).toBe('Bryan Test');
        const reload = vi.fn();
        m.__setTestModeReloadForTests(reload);
        m.exitTestMode();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem('ddmau:stickerLists:v1')).toBe('{"real":true}');
        expect(localStorage.getItem('ddmau:language')).toBe('es');
        expect(localStorage.getItem('ddmau:inventoryReloadStash')).toBe(null);
        expect(localStorage.getItem('ddmau:staffName')).toBe(null);
        expect(localStorage.getItem(FLAG)).toBe(null);
        expect(localStorage.getItem(BACKUP)).toBe(null);
    });

    it('exit drops everything the test session kept for this tab (e.g. a payroll unlock) but stays "open"', async () => {
        let m = await load();
        m.__setTestModeReloadForTests(() => {});
        m.enterTestMode({ name: 'Bryan Test', id: 77 });
        m = await load();
        expect(m.TEST_MODE?.name).toBe('Bryan Test');
        sessionStorage.setItem('ddmau:payrollUnlocked', '1');   // set against the test copy
        sessionStorage.setItem('ddmau:reloadStash:inventory', '[1]');
        m.__setTestModeReloadForTests(() => {});
        m.exitTestMode();
        expect(sessionStorage.getItem('ddmau:payrollUnlocked')).toBe(null);
        expect(sessionStorage.getItem('ddmau:reloadStash:inventory')).toBe(null);
        expect(sessionStorage.getItem('ddmau:testModeTab')).toBe(null);
        expect(sessionStorage.getItem('ddmau:sessionAlive')).toBe('1');
    });

    it('without a backup, exit still sweeps state that could be re-saved for real', async () => {
        localStorage.setItem(FLAG, JSON.stringify({ name: 'Bryan Test', id: 77, tab: 't1' }));
        sessionStorage.setItem('ddmau:sessionAlive', '1');
        sessionStorage.setItem('ddmau:testModeTab', 't1');
        localStorage.setItem('ddmau:inventoryReloadStash', '[1]');
        localStorage.setItem('ddmau:chatListCache:Bryan', '[]');
        localStorage.setItem('ddmau:language', 'es');
        const m = await load();
        m.__setTestModeReloadForTests(() => {});
        m.exitTestMode();
        expect(localStorage.getItem('ddmau:inventoryReloadStash')).toBe(null);
        expect(localStorage.getItem('ddmau:chatListCache:Bryan')).toBe(null);
        expect(localStorage.getItem('ddmau:language')).toBe('es');
        expect(localStorage.getItem(FLAG)).toBe(null);
    });

    it('isTestModeStaff only trusts an explicit true', async () => {
        const m = await load();
        expect(m.isTestModeStaff({ testMode: true })).toBe(true);
        expect(m.isTestModeStaff({ testMode: 'yes' })).toBe(false);
        expect(m.isTestModeStaff(null)).toBe(false);
    });
});
