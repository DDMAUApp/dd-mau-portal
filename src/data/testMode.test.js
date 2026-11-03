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

    it('is on for the page when the flag is set and the session is alive', async () => {
        localStorage.setItem(FLAG, JSON.stringify({ name: 'Bryan Test', id: 77, at: 1 }));
        sessionStorage.setItem('ddmau:sessionAlive', '1');
        const m = await load();
        expect(m.TEST_MODE).toMatchObject({ name: 'Bryan Test', id: 77 });
        expect(Object.isFrozen(m.TEST_MODE)).toBe(true);
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

describe('enter / exit', () => {
    it('enter backs up the device, sets the flag + session, and reloads', async () => {
        localStorage.setItem('ddmau:language', 'es');
        localStorage.setItem('ddmau:stickerLists:v1', '{"real":true}');
        const m = await load();
        const reload = vi.fn();
        m.__setTestModeReloadForTests(reload);
        expect(m.enterTestMode({ name: 'Bryan Test', id: 77 })).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(JSON.parse(localStorage.getItem(FLAG))).toMatchObject({ name: 'Bryan Test', id: 77 });
        expect(localStorage.getItem('ddmau:staffName')).toBe('Bryan Test');
        expect(sessionStorage.getItem('ddmau:sessionAlive')).toBe('1');
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

    it('without a backup, exit still sweeps state that could be re-saved for real', async () => {
        localStorage.setItem(FLAG, JSON.stringify({ name: 'Bryan Test', id: 77 }));
        sessionStorage.setItem('ddmau:sessionAlive', '1');
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
