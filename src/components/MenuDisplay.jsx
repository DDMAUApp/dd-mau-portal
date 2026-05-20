// MenuDisplay — read-only TV/kiosk menu board for the restaurant.
//
// Andrew 2026-05-20: "i have menu tvs at the restaurant and i want
// to have a usb drive that i can connect to the wifi and have
// automatic menu updates". Hardware = Fire TV Stick 4K + Fully
// Kiosk Browser pointed at ?tv=<tvId>. This component IS what
// that browser renders.
//
// ─── Routing ───────────────────────────────────────────────────
// Mounted by App.jsx when ?tv=<tvId> is in the URL. Bypasses the
// PIN entirely (public-facing display, not staff data). Same trick
// the onboarding portal uses.
//
// ─── Data sources ─────────────────────────────────────────────
//   • Static base:  MENU_DATA from src/data/menu.js (canonical menu).
//   • Live overlay: /menu_items/{slug} — admin price/desc/photo edits
//                   AND custom items not in MENU_DATA.
//   • Live 86:      /ops/86_{location} — sold-out items.
//   • Live config:  /tv_configs/{tvId} — layout, categories, photos.
//
// All three Firestore sources are onSnapshot — changes in admin
// reflect on the TV within seconds, no refresh.
//
// ─── Layout modes ─────────────────────────────────────────────
//   • dense     — 3-column single-page (default; everything visible)
//   • rotate    — auto-cycles through categories every N seconds
//                 (good for narrow/portrait TVs)
//   • spotlight — one big featured category + others compact
//                 (good for "today's specials" feel)

import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { MENU_DATA } from '../data/menu';
import { subscribeMenuOverrides, applyMenuOverrides } from '../data/menuOverrides';
import { subscribeTvConfig, DEFAULT_ROTATE_SECONDS } from '../data/tvConfigs';

const LOC_LABEL = {
    webster: 'Webster',
    maryland: 'MD Heights',
};

// Normalize for 86 fuzzy matching (strip diacritics + punctuation).
function normalizeName(s) {
    return String(s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export default function MenuDisplay({ tvId = 'webster' }) {
    const [tvConfig, setTvConfig] = useState(null);
    const [overrides, setOverrides] = useState(() => new Map());
    const [sixed, setSixed] = useState(() => new Set());
    const [sixedUpdatedAt, setSixedUpdatedAt] = useState(null);
    const [now, setNow] = useState(() => new Date());

    // Subscribe to the TV's config doc. Falls back to defaults for
    // the reserved 'webster'/'maryland' ids when no doc exists.
    useEffect(() => {
        const unsub = subscribeTvConfig(tvId, (cfg) => setTvConfig(cfg));
        return unsub;
    }, [tvId]);

    const location = tvConfig?.location || (tvId === 'maryland' ? 'maryland' : 'webster');
    const layout = tvConfig?.layout || 'dense';
    const showPhotos = tvConfig?.showPhotos === true;
    const rotateSeconds = Math.max(3, Math.min(60, Number(tvConfig?.rotateSeconds) || DEFAULT_ROTATE_SECONDS));
    const includeCategories = Array.isArray(tvConfig?.includeCategories) && tvConfig.includeCategories.length > 0
        ? new Set(tvConfig.includeCategories) : null;
    const spotlightCategory = tvConfig?.spotlightCategory || null;

    // Subscribe to admin menu overrides (price/desc/photo edits +
    // custom items). Pure overlay, no Firestore reads in render.
    useEffect(() => {
        const unsub = subscribeMenuOverrides(setOverrides);
        return unsub;
    }, []);

    // Subscribe to the location's 86 list.
    useEffect(() => {
        const ref = doc(db, 'ops', `86_${location}`);
        const unsub = onSnapshot(ref, (snap) => {
            const data = snap.exists() ? snap.data() : null;
            const items = Array.isArray(data?.items) ? data.items : [];
            const outOfStock = items.filter(i => i?.status === 'OUT_OF_STOCK' && i?.name);
            setSixed(new Set(outOfStock.map(i => normalizeName(i.name))));
            setSixedUpdatedAt(new Date());
        }, (err) => console.warn('86 listener failed:', err));
        return unsub;
    }, [location]);

    // Live clock — also a "feed alive" cue. Frozen clock = reboot.
    useEffect(() => {
        const t = setInterval(() => setNow(new Date()), 30_000);
        return () => clearInterval(t);
    }, []);

    // Merge MENU_DATA + overrides + apply category filter.
    const menu = useMemo(() => {
        const merged = applyMenuOverrides(MENU_DATA, overrides);
        if (!includeCategories) return merged;
        return merged.filter(c => includeCategories.has(c.category));
    }, [overrides, includeCategories]);

    // Check 86 status. Try several name variants since the 86 doc
    // might list under different conventions.
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

    const headerNode = (
        <header className="bg-dd-green text-white px-8 py-4 flex items-baseline justify-between flex-shrink-0 shadow-md">
            <div className="flex items-baseline gap-5">
                <div className="text-5xl font-black tracking-tight leading-none">
                    DD MAU
                </div>
                <div className="text-xl font-bold opacity-90 tracking-wide">
                    {tvConfig?.label || LOC_LABEL[location] || location}
                </div>
            </div>
            <div className="text-lg font-bold opacity-90 tabular-nums">
                {now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}
                <span className="mx-2 opacity-50">•</span>
                {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </div>
        </header>
    );

    const footerNode = (
        <footer className="bg-dd-bg border-t border-dd-line px-8 py-2 flex items-center justify-between flex-shrink-0 text-dd-text-2">
            <div className="text-[13px] font-bold tracking-wide">
                Vietnamese Fast Casual
            </div>
            <div className="flex items-center gap-2 text-[12px]">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                <span className="font-bold">Live menu</span>
                {sixedUpdatedAt && sixed.size > 0 && (
                    <span className="opacity-60 ml-1">
                        · {sixed.size} sold out today
                    </span>
                )}
            </div>
            <div className="text-[12px] opacity-60">
                ddmau.com
            </div>
        </footer>
    );

    return (
        <div className="fixed inset-0 bg-white text-dd-text flex flex-col overflow-hidden font-sans">
            {headerNode}
            {layout === 'rotate' ? (
                <RotateLayout menu={menu} is86d={is86d} showPhotos={showPhotos} rotateSeconds={rotateSeconds} />
            ) : layout === 'spotlight' ? (
                <SpotlightLayout menu={menu} is86d={is86d} showPhotos={showPhotos} spotlightCategory={spotlightCategory} />
            ) : (
                <DenseLayout menu={menu} is86d={is86d} showPhotos={showPhotos} />
            )}
            {footerNode}
        </div>
    );
}

// ── Item row — shared across layouts ─────────────────────────
// `size` controls type scale: 'normal', 'large' (spotlight hero),
// 'xl' (rotate-fullscreen hero).
function ItemRow({ item, sixed, showPhotos, size = 'normal' }) {
    const nameSize = size === 'xl' ? 'text-3xl' : size === 'large' ? 'text-2xl' : 'text-[19px]';
    const priceSize = size === 'xl' ? 'text-3xl' : size === 'large' ? 'text-2xl' : 'text-[19px]';
    return (
        <li className={`flex items-center gap-3 py-1 ${sixed ? 'opacity-60' : ''}`}>
            {showPhotos && item.photoUrl && (
                <img src={item.photoUrl} alt=""
                    className="flex-shrink-0 rounded-md object-cover bg-dd-bg"
                    style={{ width: size === 'normal' ? 36 : size === 'large' ? 56 : 80,
                             height: size === 'normal' ? 36 : size === 'large' ? 56 : 80 }} />
            )}
            <span className={`flex-1 font-bold leading-tight ${nameSize} ${sixed ? 'line-through decoration-[1.5px]' : ''}`}>
                {item.nameEn}
            </span>
            {sixed ? (
                <span className="px-2 py-0.5 rounded-md bg-red-600 text-white text-[10px] font-black uppercase tracking-wider whitespace-nowrap leading-tight">
                    Sold&nbsp;Out
                </span>
            ) : (
                <span className={`font-black text-dd-green-700 tabular-nums whitespace-nowrap ${priceSize}`}>
                    {item.price}
                </span>
            )}
        </li>
    );
}

// ── Layout A: dense 3-column ─────────────────────────────────
// Everything on one page. CSS-columns flow lets each category
// stay together (break-inside-avoid) while distributing the
// total content evenly across columns.
function DenseLayout({ menu, is86d, showPhotos }) {
    return (
        <main className="flex-1 px-8 py-6 overflow-hidden">
            <div className="columns-3 gap-8 h-full">
                {menu.map(cat => (
                    <section key={cat.category} className="break-inside-avoid mb-7">
                        <h2 className="text-2xl font-black text-dd-green-700 border-b-2 border-dd-green/40 pb-1 mb-2.5 uppercase tracking-wider">
                            {cat.category}
                        </h2>
                        <ul className="space-y-0.5">
                            {cat.items.map(item => (
                                <ItemRow key={item._slug || item.nameEn}
                                    item={item}
                                    sixed={is86d(item, cat)}
                                    showPhotos={showPhotos}
                                    size="normal" />
                            ))}
                        </ul>
                    </section>
                ))}
            </div>
        </main>
    );
}

// ── Layout B: auto-rotate full-screen categories ────────────
// Cycles through one category per page. Items get xl typography
// so people across the room can read them. Page indicator dots
// at the bottom + smooth fade transition.
function RotateLayout({ menu, is86d, showPhotos, rotateSeconds }) {
    const [idx, setIdx] = useState(0);
    useEffect(() => {
        if (!menu.length) return;
        const t = setInterval(() => {
            setIdx(prev => (prev + 1) % menu.length);
        }, rotateSeconds * 1000);
        return () => clearInterval(t);
    }, [menu.length, rotateSeconds]);

    const cat = menu[idx] || menu[0];
    if (!cat) return <main className="flex-1" />;

    return (
        <main className="flex-1 px-12 py-8 overflow-hidden flex flex-col">
            <div className="flex items-baseline justify-between mb-6">
                <h2 className="text-5xl font-black text-dd-green-700 uppercase tracking-wider">
                    {cat.category}
                </h2>
                <div className="flex items-center gap-2">
                    {menu.map((_, i) => (
                        <span key={i}
                            className={`block rounded-full transition-all ${
                                i === idx ? 'bg-dd-green-700 w-6 h-2' : 'bg-dd-line w-2 h-2'
                            }`} />
                    ))}
                </div>
            </div>
            <ul className="flex-1 grid grid-cols-2 gap-x-12 gap-y-2 content-start overflow-hidden">
                {cat.items.map(item => (
                    <ItemRow key={item._slug || item.nameEn}
                        item={item}
                        sixed={is86d(item, cat)}
                        showPhotos={showPhotos}
                        size="xl" />
                ))}
            </ul>
        </main>
    );
}

// ── Layout C: spotlight (one big + others compact) ──────────
// Hero category on the left at large scale; remaining categories
// stacked in a narrow column on the right. Good for "feature a
// section" feel (e.g. spotlight today's Bowls).
function SpotlightLayout({ menu, is86d, showPhotos, spotlightCategory }) {
    if (!menu.length) return <main className="flex-1" />;
    const hero = menu.find(c => c.category === spotlightCategory) || menu[0];
    const rest = menu.filter(c => c.category !== hero.category);
    return (
        <main className="flex-1 px-8 py-6 overflow-hidden grid grid-cols-3 gap-8">
            {/* Hero (2 cols) */}
            <section className="col-span-2 flex flex-col overflow-hidden">
                <h2 className="text-4xl font-black text-dd-green-700 border-b-4 border-dd-green/40 pb-2 mb-4 uppercase tracking-wider">
                    {hero.category}
                </h2>
                <ul className="flex-1 grid grid-cols-2 gap-x-8 gap-y-1 content-start overflow-hidden">
                    {hero.items.map(item => (
                        <ItemRow key={item._slug || item.nameEn}
                            item={item}
                            sixed={is86d(item, hero)}
                            showPhotos={showPhotos}
                            size="large" />
                    ))}
                </ul>
            </section>
            {/* Rest (1 col, flowing) */}
            <aside className="overflow-hidden">
                <div className="columns-1 gap-4 h-full">
                    {rest.map(cat => (
                        <section key={cat.category} className="break-inside-avoid mb-4">
                            <h3 className="text-base font-black text-dd-green-700 border-b border-dd-green/30 pb-0.5 mb-1 uppercase tracking-wider">
                                {cat.category}
                            </h3>
                            <ul className="space-y-0">
                                {cat.items.map(item => (
                                    <li key={item._slug || item.nameEn}
                                        className={`flex items-baseline gap-2 py-0.5 text-[13px] ${is86d(item, cat) ? 'opacity-60' : ''}`}>
                                        <span className={`flex-1 font-bold leading-tight ${is86d(item, cat) ? 'line-through' : ''}`}>
                                            {item.nameEn}
                                        </span>
                                        {is86d(item, cat) ? (
                                            <span className="px-1 py-0 rounded bg-red-600 text-white text-[8px] font-black uppercase tracking-wide">
                                                Out
                                            </span>
                                        ) : (
                                            <span className="font-black text-dd-green-700 tabular-nums whitespace-nowrap">
                                                {item.price}
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            </aside>
        </main>
    );
}
