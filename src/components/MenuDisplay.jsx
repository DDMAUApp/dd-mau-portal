// MenuDisplay — read-only TV/kiosk menu board for the restaurant.
//
// Andrew 2026-05-20: "i have menu tvs at the restaurant and i want
// to have a usb drive that i can connect to the wifi and have
// automatic menu updates is that posible and what hardware do i
// need to buy". Hardware answer: Fire TV Stick 4K (~$50/TV) +
// Fully Kiosk Browser pointed at `?tv=<location>`. This component
// IS what that browser renders.
//
// ─── Routing ───────────────────────────────────────────────────
// Mounted by App.jsx when ?tv=<webster|maryland> is in the URL.
// Bypasses the PIN entirely (it's a public-facing display, not
// staff data). Same trick the onboarding portal uses to skip auth.
//
// ─── Data sources ─────────────────────────────────────────────
//   • Static:  MENU_DATA from src/data/menu.js — the canonical menu
//              definition (category → items[] with name + price).
//              Sourced from Andrew's PDFs; updated by editing the
//              file directly. No Firestore overlay for items yet —
//              that's a follow-up if/when admin wants live edits.
//   • Live:    /ops/86_{location} — items currently 86'd. Subscribed
//              with onSnapshot so striking a sold-out item in the
//              app shows on the TV within seconds, no refresh.
//
// ─── Layout decisions ─────────────────────────────────────────
// Andrew picked: food only, "Sold Out Today" badge on 86'd items,
// static single-screen (no animation, no scroll). With 9-ish
// categories × 5-15 items each, CSS columns are the cleanest fit
// — each category block stays together (break-inside-avoid) and
// flows across 3 columns so the whole menu reads in one glance
// across the room. Typography is sized for ~10 ft viewing on a
// 1080p TV; bump the base if testing shows it small.
//
// Allergen icons, descriptions, drinks, and rotating specials were
// explicitly turned OFF in the initial scope. Re-add later if Andrew
// changes his mind — the MENU_DATA already carries all that info.

import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { MENU_DATA } from '../data/menu';

const LOC_LABEL = {
    webster: 'Webster',
    maryland: 'MD Heights',
};

// Normalize a name for fuzzy 86-list matching. The 86 doc stores
// items by free-text name ("Pork Bowl", "shrimp banh mi", etc.) so
// we strip case + punctuation + diacritics for matching. The menu
// names have accents (Bánh Mì, Phở) that won't survive a strict
// equality check otherwise.
function normalizeName(s) {
    return String(s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')   // strip accents
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')        // strip punctuation
        .replace(/\s+/g, ' ')
        .trim();
}

export default function MenuDisplay({ location = 'webster' }) {
    const [sixed, setSixed] = useState(() => new Set());
    const [sixedUpdatedAt, setSixedUpdatedAt] = useState(null);
    const [now, setNow] = useState(() => new Date());

    // Live subscription to the location's 86 list. The doc schema
    // (see Eighty6Dashboard.jsx) is { items: [{ name, status, ... }] }
    // where status === 'OUT_OF_STOCK' means 86'd today.
    useEffect(() => {
        const loc = location === 'maryland' ? 'maryland' : 'webster';
        const ref = doc(db, 'ops', `86_${loc}`);
        const unsub = onSnapshot(ref, (snap) => {
            const data = snap.exists() ? snap.data() : null;
            const items = Array.isArray(data?.items) ? data.items : [];
            const outOfStock = items.filter(i => i?.status === 'OUT_OF_STOCK' && i?.name);
            setSixed(new Set(outOfStock.map(i => normalizeName(i.name))));
            setSixedUpdatedAt(new Date());
        }, (err) => {
            console.warn('86 listener failed:', err);
        });
        return unsub;
    }, [location]);

    // Tick the clock every 30s. Visible cue to staff that the feed
    // is alive (frozen clock = TV needs a reboot).
    useEffect(() => {
        const t = setInterval(() => setNow(new Date()), 30_000);
        return () => clearInterval(t);
    }, []);

    // Match a menu item against the 86 list. The 86 doc might list
    // an item under different naming conventions ("steak" vs "Steak
    // Bánh Mì" vs "banh mi steak"). Try a few variants to maximize
    // the chance of catching it.
    const is86d = useMemo(() => {
        return (item, cat) => {
            if (!item?.nameEn) return false;
            const candidates = [
                item.nameEn,
                `${item.nameEn} ${cat.category}`,
                `${cat.category} ${item.nameEn}`,
            ].map(normalizeName);
            return candidates.some(n => n && sixed.has(n));
        };
    }, [sixed]);

    return (
        <div className="fixed inset-0 bg-white text-dd-text flex flex-col overflow-hidden font-sans">
            {/* ── Header band ──────────────────────────────────────── */}
            <header className="bg-dd-green text-white px-8 py-4 flex items-baseline justify-between flex-shrink-0 shadow-md">
                <div className="flex items-baseline gap-5">
                    <div className="text-5xl font-black tracking-tight leading-none">
                        DD MAU
                    </div>
                    <div className="text-xl font-bold opacity-90 tracking-wide">
                        {LOC_LABEL[location] || location}
                    </div>
                </div>
                <div className="text-lg font-bold opacity-90 tabular-nums">
                    {now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}
                    <span className="mx-2 opacity-50">•</span>
                    {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </div>
            </header>

            {/* ── Menu grid ────────────────────────────────────────── */}
            <main className="flex-1 px-8 py-6 overflow-hidden">
                <div className="columns-3 gap-8 h-full">
                    {MENU_DATA.map(cat => (
                        <section key={cat.category}
                            className="break-inside-avoid mb-7">
                            <h2 className="text-2xl font-black text-dd-green-700 border-b-2 border-dd-green/40 pb-1 mb-2.5 uppercase tracking-wider">
                                {cat.category}
                            </h2>
                            <ul className="space-y-0.5">
                                {cat.items.map(item => {
                                    const out = is86d(item, cat);
                                    return (
                                        <li key={item.nameEn}
                                            className={`flex items-baseline gap-3 py-0.5 ${out ? 'opacity-60' : ''}`}>
                                            <span className={`flex-1 font-bold text-[19px] leading-tight ${out ? 'line-through decoration-[1.5px]' : ''}`}>
                                                {item.nameEn}
                                            </span>
                                            {out ? (
                                                <span className="px-2 py-0.5 rounded-md bg-red-600 text-white text-[10px] font-black uppercase tracking-wider whitespace-nowrap leading-tight">
                                                    Sold&nbsp;Out
                                                </span>
                                            ) : (
                                                <span className="font-black text-dd-green-700 tabular-nums text-[19px] whitespace-nowrap">
                                                    {item.price}
                                                </span>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    ))}
                </div>
            </main>

            {/* ── Footer band ──────────────────────────────────────── */}
            <footer className="bg-dd-bg border-t border-dd-line px-8 py-2 flex items-center justify-between flex-shrink-0 text-dd-text-2">
                <div className="text-[13px] font-bold tracking-wide">
                    Vietnamese Fast Casual
                </div>
                <div className="flex items-center gap-2 text-[12px]">
                    <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    <span className="font-bold">Live menu</span>
                    {sixedUpdatedAt && (
                        <span className="opacity-60 ml-1">
                            · {sixed.size} sold out today
                        </span>
                    )}
                </div>
                <div className="text-[12px] opacity-60">
                    ddmau.com
                </div>
            </footer>
        </div>
    );
}
