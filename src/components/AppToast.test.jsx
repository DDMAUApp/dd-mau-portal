// Toasts have to read over every modal. The rice screen's backdrop (z-[80])
// once covered them, which hid "did not save" and "toss it" messages.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { render, screen, act } from '@testing-library/react';
import AppToast from './AppToast';
import { toast } from '../toast';

const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(jsx?|css)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
});
const zOf = (text) => [...text.matchAll(/\bz-\[(\d+)\]/g)].map((m) => Number(m[1]));

describe('AppToast', () => {
    it('sits above every other z-index in the app', () => {
        const src = resolve(__dirname, '..');
        const toastFile = resolve(__dirname, 'AppToast.jsx');
        const toastZ = Math.max(...zOf(readFileSync(toastFile, 'utf8')));
        const others = walk(src).filter((p) => p !== toastFile).flatMap((p) => zOf(readFileSync(p, 'utf8')));
        expect(others.length).toBeGreaterThan(0);
        expect(toastZ).toBeGreaterThan(Math.max(...others));
    });

    it('renders a toast at that layer', async () => {
        render(<AppToast />);
        await act(async () => { toast('Batch #3 did not save. Try again.', { kind: 'error' }); });
        const region = screen.getByRole('region', { name: 'Notifications' });
        expect(region.className).toContain('z-[100]');
        expect(region).toHaveTextContent('Batch #3 did not save. Try again.');
    });
});
