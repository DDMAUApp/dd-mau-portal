// The real editor modal, from opening a TV to the payload it saves.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ configs: [], saveTvConfig: vi.fn(async () => ({ keptFromServer: [] })), saveTvConfigDraft: vi.fn(async () => {}) }));
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('../data/menuConfig', () => ({ useMenuConfigLegacy: () => [] }));
vi.mock('../toast', () => ({ toast: vi.fn() }));
vi.mock('../data/tvConfigs', async (orig) => ({
    ...(await orig()),
    subscribeTvConfigs: (cb) => { cb(h.configs); return () => {}; },
    subscribeTvHeartbeats: () => () => {},
    saveTvConfig: h.saveTvConfig,
    saveTvConfigDraft: h.saveTvConfigDraft,
}));

import TvConfigsEditor from './TvConfigsEditor';

const TV = { tvId: 'webster-photos', label: 'Photos', location: 'webster', mode: 'image', imageUrls: ['a.jpg'], imageLayers: [], publishedVersion: 3 };
const open = (over = {}, language = 'en') => {
    h.configs = [{ ...TV, ...over }];
    render(<TvConfigsEditor language={language} byName="Andrew" />);
    fireEvent.click(screen.getByRole('button', { name: language === 'es' ? 'Editar' : 'Edit' }));
};
const savedPayload = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save & Publish' }));
    await waitFor(() => expect(h.saveTvConfig).toHaveBeenCalledTimes(1));
    return h.saveTvConfig.mock.calls[0][0].payload;
};

beforeEach(() => { h.saveTvConfig.mockClear(); h.saveTvConfigDraft.mockClear(); });

describe('TV editor background picker', () => {
    it('untouched on a TV with no background: the payload does not carry the field', async () => {
        open();
        expect(screen.getByRole('button', { name: 'Black' })).toHaveAttribute('aria-pressed', 'true');
        expect('imageBackground' in await savedPayload()).toBe(false);
    });
    it('picking snow saves it, static unless motion is checked', async () => {
        open();
        fireEvent.click(screen.getByRole('button', { name: 'Snow' }));
        expect(screen.getByRole('button', { name: 'Still' })).toHaveAttribute('aria-pressed', 'true');
        expect((await savedPayload()).imageBackground).toEqual({ kind: 'snow', motion: false });
    });
    it('Slow saves motion:true', async () => {
        open();
        fireEvent.click(screen.getByRole('button', { name: 'Fall leaves' }));
        fireEvent.click(screen.getByRole('button', { name: 'Slow' }));
        expect((await savedPayload()).imageBackground).toEqual({ kind: 'fall', motion: true });
    });
    it.each(['Medium', 'Fast'])('%s saves its speed', async (label) => {
        open({});
        fireEvent.click(screen.getByRole('button', { name: 'Fall leaves' }));
        fireEvent.click(screen.getByRole('button', { name: label }));
        expect((await savedPayload()).imageBackground).toEqual({ kind: 'fall', motion: true, speed: label.toLowerCase() });
    });
    it('color kind shows the input and saves the color; art kinds without motion hide the checkbox', async () => {
        open();
        fireEvent.click(screen.getByRole('button', { name: 'Blue sky' }));
        expect(screen.queryByRole('button', { name: 'Slow' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Color' }));
        fireEvent.change(screen.getByLabelText('Pick a color'), { target: { value: '#336699' } });
        expect((await savedPayload()).imageBackground).toEqual({ kind: 'color', color: '#336699' });
    });
    it('opens on the saved background and an unchanged save sends the same value', async () => {
        open({ imageBackground: { kind: 'fall', motion: true } });
        expect(screen.getByRole('button', { name: 'Fall leaves' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'Slow' })).toHaveAttribute('aria-pressed', 'true');
        expect((await savedPayload()).imageBackground).toEqual({ kind: 'fall', motion: true });
    });
    it('going back to Black clears the field', async () => {
        open({ imageBackground: { kind: 'sky' } });
        fireEvent.click(screen.getByRole('button', { name: 'Black' }));
        expect((await savedPayload()).imageBackground).toBeNull();
    });
    it('Save as Draft carries it too', async () => {
        open();
        fireEvent.click(screen.getByRole('button', { name: 'Snow' }));
        fireEvent.click(screen.getByRole('button', { name: /draft/i }));
        await waitFor(() => expect(h.saveTvConfigDraft).toHaveBeenCalledTimes(1));
        expect(h.saveTvConfigDraft.mock.calls[0][0].payload.imageBackground).toEqual({ kind: 'snow', motion: false });
    });
    it('shows Spanish labels', () => {
        open({}, 'es');
        expect(screen.getByRole('button', { name: 'Nieve' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Cielo azul' })).toBeInTheDocument();
    });
});
