// The Food Safety tab shows to admins until the owner has read the rules. Opening
// it is one flag, so these check that every route to it goes through that flag.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canSeeFoodSafety, FOOD_SAFETY_OPEN_TO_ALL } from '../data/foodSafetyVisibility';

const read = (p) => readFileSync(resolve(__dirname, p), 'utf8');

describe('Food Safety tab wiring', () => {
    it('the route, phone tile and sidebar all use the flag', () => {
        expect(read('../App.jsx')).toMatch(/activeTab === 'foodsafety' && canSeeFoodSafety\(staffIsAdmin\)/);
        expect(read('./MobileHome.jsx')).toMatch(/canSeeFoodSafety\(isAdmin\) \? \[\{ tab: 'foodsafety'/);
        expect(read('./Sidebar.jsx')).toMatch(/tab: 'foodsafety'.*requires: FOOD_SAFETY_OPEN_TO_ALL \? undefined : 'admin'/);
    });
    it('while closed, only admins can see it', () => {
        if (FOOD_SAFETY_OPEN_TO_ALL) return;
        expect(canSeeFoodSafety(true)).toBe(true);
        expect(canSeeFoodSafety(false)).toBe(false);
    });
});
