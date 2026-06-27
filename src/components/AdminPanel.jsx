import { useState, useEffect, useRef } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { db } from '../firebase';
import { doc, collection, onSnapshot, setDoc, getDoc, getDocs, updateDoc, deleteDoc, writeBatch, query, orderBy, limit, where, serverTimestamp } from 'firebase/firestore';
import { t } from '../data/translations';
import { isAdmin, ADMIN_IDS, LOCATION_LABELS, HIDEABLE_PAGES } from '../data/staff';
import { getPositionTemplate, hasPositionTemplate } from '../data/positionTemplates';
// Static (not dynamic) import on purpose: AdminPanel is already lazy-loaded,
// so renameStaff rides in the admin chunk. A dynamic import() spun it into a
// separate chunk that failed to load on a stale-cached PWA — the rename then
// silently no-op'd while the staff record had already saved (orphaned data).
import { renameStaffEverywhere, removeStaffFromChats } from '../data/renameStaff';
import { auditAvailabilityChange } from '../data/audit';
import {
    normalizeToE164,
    formatE164ForDisplay,
    smsStatusPill,
    writeClientOptInEvent,
} from '../data/sms';
import ChecklistHistory from './ChecklistHistory';
import InventoryHistory from './InventoryHistory';
import LaborHistoryPanel from './LaborHistoryPanel';
import { downloadFile, openExternalUrl } from '../capacitor-bridge';
import ImportStaffModal from './ImportStaffModal';
import ModalPortal from './ModalPortal';
import OffsiteClockSection from './OffsiteClockSection';
import StaffTodosAdmin from './StaffTodosAdmin';
// 2026-05-27 — Andrew: "i also want to add another audit to the admin
// page. i want to know which staff has used the app?" Self-contained
// read-only card; reads staffList in-place, no new Firestore writes.
import StaffUsageAudit from './StaffUsageAudit';
import ScheduleAuditLog from './ScheduleAuditLog';
import AttendanceLog from './AttendanceLog';
import { toast } from '../toast';
import { enableFcmPush } from '../messaging';
import { lazy as reactLazy, Suspense as ReactSuspense } from 'react';
const RequiredTaskAdmin = reactLazy(() => import('./RequiredTaskAdmin'));
const InventoryListsAdmin = reactLazy(() => import('./InventoryListsAdmin'));
// Payroll wizard — owner-only, password-gated. Lazy so its engine + exceljs
// only download when the section is expanded.
const PayrollPanel = reactLazy(() => import('./payroll/PayrollPanel'));
// 2026-05-24 — MenuEditor (the public menu / TV menu data editor)
// removed from AdminPanel per Andrew: "in the admin page i want to get
// rid of public menu board. we dont need it." The component file
// MenuEditor.jsx is left in src/components/ in case admin wants to
// reinstate later; just re-add the import + section block at line
// ~4251 and you're back.
// TvConfigsEditor moved to MenuScreensPage (top-level tab 'menuscreens')
// 2026-05-23. The breadcrumb card below renders an "→ Menu Screens" link
// in place of the old embed; the editor chunk only loads when the
// dedicated page mounts it.
// 2026-05-23. ToastSyncSection deleted: the Cloud Function it configured
// (syncToastMenuStatus) was a redundant duplicate of the Railway scraper
// that already writes /ops/86_<location>. We tried to debug 401s for an
// hour before realizing the Railway pipeline was already doing the job.
// The admin UI was misleading — staff who tried to "set it up" were
// configuring a sync that had no effect. See git log for context.
const LabelFormatEditor = reactLazy(() => import('./LabelFormatEditor'));
const ChatHistoryAdmin = reactLazy(() => import('./ChatHistoryAdmin'));
// 2026-05-30 — SaaS-ready menu/brand/buildsheet editor. Replaces the
// legacy MenuEditor (overlay-only) that was removed 2026-05-24. New
// editor is full CRUD: items + categories + brand + build sheet,
// all backed by /config/menu_v2, /config/brand, /config/build_sheet.
// See src/data/menuConfig.js for the schema + hooks.
const MenuConfigEditor = reactLazy(() => import('./MenuConfigEditor'));

// Wrapper enforces admin-only access BEFORE the inner component's hooks run.
// Early-returning inside AdminPanelInner would violate React's rules-of-hooks
// (hooks must run in the same order every render). This wrapper-pattern is the
// idiomatic fix.

// ── PrintersConfigSection ─────────────────────────────────────────
// Per-location Epson TM-L100 label printer config. Andrew 2026-05-20.
// Each location has one printer doc at /config/printers_{location}.
// Admin enters the printer's local IP + can fire a test print to
// verify connectivity before staff start hitting "Print prep label".
//
// Why per-location: each restaurant has its own LAN + its own
// printer with its own IP. Shared config would force both stores
// onto the same printer.
function PrintersConfigSection({ language, byName }) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;
    const LOCATIONS = ['webster', 'maryland'];
    const LOC_LABEL = {
        webster: tx('Webster', 'Webster'),
        maryland: tx('MD Heights', 'MD Heights'),
    };
    return (
        <div className="mt-6 mb-4 bg-white border-2 border-purple-200 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1">
                <span className="text-2xl">🏷</span>
                <h3 className="text-base font-bold text-purple-900">
                    {tx('Label printers', 'Impresoras de etiquetas')}
                </h3>
            </div>
            <p className="text-[11px] text-purple-700 mb-3">
                {tx(
                    'One kitchen label printer per location. Epson TM-L100 (linerless 80mm, prints directly via Wi-Fi — no driver, no dialog) or Brother QL-820NWB (DK adhesive rolls, prints through the OS print dialog via AirPrint — for freezer/walk-in surfaces).',
                    'Una impresora de cocina por ubicación. Epson TM-L100 (sin liner 80mm, directo por Wi-Fi) o Brother QL-820NWB (rollos DK con adhesivo, vía AirPrint — para congelador/walk-in).',
                )}
            </p>
            <div className="space-y-3">
                {/* Andrew 2026-05-20: "the label printers in the admin
                    page i only need the kitchen section for each
                    location". Office slot dropped from admin UI; data
                    layer + modals also defaulted to kitchen-only. */}
                {LOCATIONS.map(loc => (
                    <PrinterConfigRow key={loc}
                        location={loc}
                        slot="kitchen"
                        locationLabel={LOC_LABEL[loc]}
                        tx={tx}
                        byName={byName}
                    />
                ))}
            </div>
            {/* ── TM-L100 drivers & downloads ──────────────────────
                Andrew 2026-06-10 (printer arriving): official Epson
                resources, every URL verified live. NOTE deliberately
                absent: a CORS setting — the TM-L100 has none (verified
                against the Technical Reference + ePOS manuals); the
                thing that blocks browser printing is HTTPS→HTTP mixed
                content, which the native app bypasses via the OS
                network stack. There is NO macOS driver for this model
                — Mac/web print through the app's direct path. */}
            <details className="mt-3 text-[11px] bg-purple-50/50 border border-purple-200 rounded-md">
                <summary className="cursor-pointer px-2.5 py-2 font-bold text-purple-800 select-none hover:bg-purple-100/60 rounded-md">
                    📥 {tx('Epson TM-L100 — drivers, apps & manuals', 'Epson TM-L100 — drivers, apps y manuales')}
                </summary>
                <div className="px-3 pb-3 pt-1 space-y-1.5">
                    <p className="text-[10.5px] text-purple-700/90 italic">
                        {tx(
                            'The app prints to the TM-L100 with NO driver. These are only for setup, Windows printing, and reference. There is no Mac driver for this model.',
                            'La app imprime al TM-L100 SIN driver. Esto es solo para configuración, impresión desde Windows y referencia. No existe driver para Mac.',
                        )}
                    </p>
                    {[
                        { icon: '📱', en: 'Epson TM Utility — iPhone/iPad (Wi-Fi setup, settings, firmware)', es: 'Epson TM Utility — iPhone/iPad', url: 'https://apps.apple.com/us/app/epson-tm-utility/id726122574' },
                        { icon: '🤖', en: 'Epson TM Utility — Android', es: 'Epson TM Utility — Android', url: 'https://play.google.com/store/apps/details?id=com.epson.tmutility' },
                        { icon: '🪟', en: 'Windows printer driver (Advanced Printer Driver 6.12)', es: 'Driver de Windows (APD 6.12)', url: 'https://ftp.epson.com/drivers/APD_612_L100_WM.exe' },
                        { icon: '🛠', en: 'TM-L100 Utility for Windows (deep settings: 40 mm paper, logos, paper saving)', es: 'TM-L100 Utility para Windows (configuración avanzada)', url: 'https://ftp.epson.com/drivers/pos/TM-L100Utility120.exe' },
                        { icon: '📄', en: 'Technical Reference Guide (PDF — every setting explained)', es: 'Guía técnica de referencia (PDF)', url: 'https://files.support.epson.com/pdf/pos/bulk/tm-l100_trg_en_revb.pdf' },
                        { icon: '🌐', en: 'Epson US support page (all downloads & warranty)', es: 'Página de soporte de Epson US', url: 'https://epson.com/Support/Point-of-Sale/Label-Printers/Epson-OmniLink-TM-L100-Liner-free-Compatible/s/SPT_C31CJ52001' },
                    ].map((l) => (
                        <button key={l.url} type="button"
                            onClick={() => openExternalUrl(l.url)}
                            className="w-full text-left px-2.5 py-1.5 rounded-lg bg-white border border-purple-200 text-purple-900 font-bold hover:bg-purple-50 active:scale-[0.99] transition flex items-center gap-2">
                            <span>{l.icon}</span>
                            <span className="flex-1 min-w-0 leading-tight">{tx(l.en, l.es)}</span>
                            <span className="text-purple-400">↗</span>
                        </button>
                    ))}
                    <p className="text-[10px] text-purple-700/70 mt-1">
                        {tx(
                            'Firmware updates: easiest from the TM Utility phone app (Settings → Firmware Update).',
                            'Actualizaciones de firmware: lo más fácil es desde la app TM Utility.',
                        )}
                    </p>
                </div>
            </details>

            <p className="text-[10px] text-purple-700/70 italic mt-2">
                {tx(
                    'Epson troubleshooting: if a test print times out, confirm the printer is powered on, on the restaurant network, and the IP above matches its status sheet (Status button on the back prints it). Printing only works from the phone/iPad APP, not a web browser — browsers block the HTTPS→HTTP hop to the printer. Brother troubleshooting: if the Brother doesn\'t show up in the AirPrint list, confirm the printer is on the same Wi-Fi as the iPad and Bonjour/mDNS is allowed on the network.',
                    'Epson: si la prueba falla, confirma que la impresora esté encendida, en la red del restaurante, y que la IP coincida con su hoja de estado (botón Status atrás). Solo se imprime desde la APP del teléfono/iPad, no desde el navegador. Brother: si no aparece en AirPrint, confirma que esté en la misma Wi-Fi que el iPad y que Bonjour/mDNS esté permitido.',
                )}
            </p>

            <PrintHistorySection tx={tx} />
        </div>
    );
}

// ── PrintHistorySection ───────────────────────────────────────────
// Recent label-print history pulled from /audit. Helps admin verify
// that the feature is actually being used and which staff/location
// is printing the most. Inspector-friendly trail — every print
// (success OR failure) is logged.
function PrintHistorySection({ tx }) {
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(false);
    const [expanded, setExpanded] = useState(false);
    // Source filter — Andrew 2026-05-20 Phase 2b. Lets admin slice
    // the print history by where the print came from (recipe page,
    // date-stickers tab, free-text print center, test prints).
    const [sourceFilter, setSourceFilter] = useState('all');

    const load = async () => {
        setLoading(true);
        try {
            // Action prefix filter: print.label + print.test. Firestore
            // doesn't support startsWith natively — we use a range
            // query on `action` (>= 'print.' < 'print/') which works
            // because '/' sorts after any letter in ASCII.
            const q = query(
                collection(db, 'audit'),
                where('action', '>=', 'print.'),
                where('action', '<', 'print/'),
                orderBy('action'),
                orderBy('createdAt', 'desc'),
                limit(25),
            );
            const snap = await getDocs(q);
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            // Re-sort client-side by createdAt desc (the query already
            // does this within an action, but across actions we want
            // pure recency).
            list.sort((a, b) => {
                const ta = a.createdAt?.toMillis?.() ?? 0;
                const tb = b.createdAt?.toMillis?.() ?? 0;
                return tb - ta;
            });
            setRows(list);
        } catch (e) {
            console.warn('print history load failed:', e);
            setRows([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (expanded && rows.length === 0) load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [expanded]);

    return (
        <div className="mt-3 pt-3 border-t border-purple-200">
            <button onClick={() => setExpanded(v => !v)}
                className="w-full flex items-center justify-between text-purple-800 text-xs font-bold hover:bg-purple-50 rounded-md px-2 py-1.5 transition">
                <span>📜 {tx('Recent label prints', 'Impresiones recientes')}</span>
                <span className="text-purple-500">{expanded ? '▼' : '▶'}</span>
            </button>
            {expanded && (
                <div className="mt-2">
                    <div className="flex items-center gap-1 flex-wrap mb-2">
                        {[
                            { k: 'all',          en: 'All',          es: 'Todo' },
                            { k: 'recipe',       en: '📖 Recipes',    es: '📖 Recetas' },
                            { k: 'datestickers', en: '🏷 Stickers',   es: '🏷 Etiquetas' },
                            { k: 'freetext',     en: '🖨 Free-text',  es: '🖨 Libre' },
                            { k: 'test',         en: '🧪 Test',       es: '🧪 Prueba' },
                        ].map(f => (
                            <button key={f.k}
                                onClick={() => setSourceFilter(f.k)}
                                className={`px-2 py-1 rounded-full text-[10px] font-bold border ${sourceFilter === f.k
                                    ? 'bg-purple-600 text-white border-purple-700'
                                    : 'bg-white text-purple-700 border-purple-200 hover:bg-purple-50'}`}>
                                {tx(f.en, f.es)}
                            </button>
                        ))}
                        <button onClick={load}
                            className="ml-auto text-[10px] text-purple-700 underline hover:no-underline">
                            {loading ? tx('Loading…', 'Cargando…') : tx('Refresh', 'Actualizar')}
                        </button>
                    </div>
                    {loading && rows.length === 0 ? (
                        <p className="text-[11px] text-purple-700/70 italic px-2">
                            {tx('Loading…', 'Cargando…')}
                        </p>
                    ) : rows.length === 0 ? (
                        <p className="text-[11px] text-purple-700/70 italic px-2 py-3">
                            {tx(
                                'No prints yet. Once staff start using the 🏷 buttons, every print lands here.',
                                'Aún no hay impresiones. Cuando el personal use los botones 🏷, aparecerán aquí.',
                            )}
                        </p>
                    ) : (
                        <div className="space-y-1 max-h-72 overflow-y-auto">
                            {rows.filter(r => {
                                if (sourceFilter === 'all') return true;
                                if (sourceFilter === 'test') return r.action === 'print.test';
                                if (sourceFilter === 'freetext') return r.action === 'print.freetext';
                                if (sourceFilter === 'datestickers') return r.details?.source === 'datestickers';
                                if (sourceFilter === 'recipe') return r.action === 'print.label' && r.details?.source !== 'datestickers';
                                return true;
                            }).map(r => {
                                const ts = r.createdAt?.toDate?.() || null;
                                const ok = r.action === 'print.test'
                                    ? r.details?.printerOk === true
                                    : r.details?.printerOk !== false;
                                return (
                                    <div key={r.id}
                                        className={`px-2 py-1.5 rounded-md text-[11px] border ${ok ? 'border-emerald-200 bg-emerald-50/40' : 'border-red-200 bg-red-50/40'}`}>
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className={ok ? 'text-emerald-700' : 'text-red-700'}>
                                                {ok ? '✓' : '✕'}
                                            </span>
                                            <span className="font-bold text-dd-text">
                                                {r.action === 'print.test' ? tx('Test', 'Prueba') : (r.details?.itemName || tx('Label', 'Etiqueta'))}
                                            </span>
                                            <span className="text-dd-text-2 truncate">
                                                · {r.actorName || '—'}
                                                {r.details?.location && <> · {r.details.location}</>}
                                                {r.details?.shelfLifeDays && <> · {r.details.shelfLifeDays}d</>}
                                            </span>
                                            {ts && (
                                                <span className="text-dd-text-2/70 ml-auto whitespace-nowrap">
                                                    {ts.toLocaleString()}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// Single printer row — loads its config doc, lets admin edit type
// (Epson vs Brother) / IP / DK label size / enabled, fires a test
// print. Stamps lastTestedAt / lastTestOk so the next admin to
// land here sees the state.
function PrinterConfigRow({ location, slot = 'kitchen', locationLabel, tx, byName }) {
    const [cfg, setCfg] = useState(null);
    const [loading, setLoading] = useState(true);
    const [typeDraft, setTypeDraft] = useState('epson_linerless');
    const [ipDraft, setIpDraft] = useState('');
    const [nameDraft, setNameDraft] = useState('');
    const [labelWMm, setLabelWMm] = useState(62);
    const [labelHMm, setLabelHMm] = useState(90);
    const [enabled, setEnabled] = useState(true);
    // Epson connection details — exposed for "adding new printers"
    // (Andrew 2026-06-10, TM-L100 arriving). Defaults match the
    // printer's factory values, so most admins never touch them.
    const [portDraft, setPortDraft] = useState('80');
    const [deviceIdDraft, setDeviceIdDraft] = useState('local_printer');
    // Paper width loaded in the printer. The TM-L100 auto-detects
    // 58 vs 80 mm from the roll guides; 40 mm additionally needs the
    // TM-L100 Utility. Stored so labels + admin agree on the roll.
    const [paperWidthMm, setPaperWidthMm] = useState(80);
    // Left-margin nudge (mm) — shifts the whole label right for a printer
    // that prints too far to the left. Epson only; 0 = no shift.
    const [leftOffsetMm, setLeftOffsetMm] = useState(0);
    const [showEpsonGuide, setShowEpsonGuide] = useState(false);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    // Brother-only — expandable "first-time setup" guide. Collapsed by
    // default; admin pops it open the day the Brother arrives, then
    // forgets about it. Andrew (2026-05-20): "yes" to "Want me to put
    // this as a help blurb inside the Admin panel's Brother section".
    const [showSetupGuide, setShowSetupGuide] = useState(false);
    // Andrew 2026-05-21 — "the proxy is off on the printer, can we
    // just use the ip and bridge straight into the printer?". Probe
    // tests 3 things against the Brother's IP from the browser:
    // basic reach, CORS-mode GET, IPP POST. The output tells us
    // whether direct-IP browser printing is feasible (Brother
    // accepts CORS) or not (Same-Origin Policy blocks).
    const [probing, setProbing] = useState(false);
    const [probeResult, setProbeResult] = useState(null);
    // The Brother section doesn't normally need an IP (it goes
    // through AirPrint). For the probe we need one, so we expose
    // a small input below.
    const [probeIp, setProbeIp] = useState('');

    const isBrother = typeDraft === 'brother_ql';

    // Normalize whatever the admin typed into a clean host + port.
    // Accepts "192.168.1.42", "192.168.1.42:8080", "http://192.168.1.42/".
    // The print URL builder appends :port itself, so a colon left in the
    // IP would produce http://ip:8080:80/... and break every print.
    const parseEpsonAddress = () => {
        let host = ipDraft.trim().replace(/^https?:\/\//i, '').replace(/[/\s].*$/, '');
        let port = Math.trunc(Number(portDraft));
        const m = host.match(/^(.+):(\d{1,5})$/);
        if (m) { host = m[1]; port = Math.trunc(Number(m[2])); }
        if (!(Number.isInteger(port) && port >= 1 && port <= 65535)) port = 80;
        return { host, port };
    };

    useEffect(() => {
        let mounted = true;
        (async () => {
            try {
                const mod = await import('../data/labelPrinting');
                const got = await mod.getPrinterConfig(location, slot);
                if (!mounted) return;
                setCfg(got);
                setTypeDraft(got?.type || 'epson_linerless');
                setIpDraft(got?.ip || '');
                setNameDraft(got?.name || `${locationLabel}`);
                setLabelWMm(Number(got?.labelWidthMm) || 62);
                setLabelHMm(Number(got?.labelHeightMm) || 90);
                setEnabled(got?.enabled !== false);
                setPortDraft(String(got?.port || 80));
                setDeviceIdDraft(got?.deviceId || 'local_printer');
                setPaperWidthMm(Number(got?.paperWidthMm) || 80);
                setLeftOffsetMm(Number(got?.leftOffsetMm) || 0);
            } catch (e) {
                console.warn('printer config load failed:', e);
            } finally {
                if (mounted) setLoading(false);
            }
        })();
        return () => { mounted = false; };
    }, [location, slot, locationLabel]);

    const save = async () => {
        if (saving) return;
        setSaving(true);
        try {
            const mod = await import('../data/labelPrinting');
            const { host, port } = parseEpsonAddress();
            await mod.savePrinterConfig({
                location, slot,
                type: typeDraft,
                name: nameDraft,
                ip: host,
                port,
                deviceId: deviceIdDraft.trim() || 'local_printer',
                paperWidthMm,
                leftOffsetMm,
                labelWidthMm: labelWMm,
                labelHeightMm: labelHMm,
                enabled,
                byName,
            });
            const fresh = await mod.getPrinterConfig(location, slot);
            setCfg(fresh);
            // Re-sync drafts so the form shows what was actually SAVED
            // (port '' → 80, "ip:8080" split into the two fields, etc.).
            setIpDraft(fresh?.ip || '');
            setPortDraft(String(fresh?.port || 80));
            setDeviceIdDraft(fresh?.deviceId || 'local_printer');
            setPaperWidthMm(Number(fresh?.paperWidthMm) || 80);
            setLeftOffsetMm(Number(fresh?.leftOffsetMm) || 0);
            toast(tx('✓ Saved', '✓ Guardado'), { kind: 'success' });
        } catch (e) {
            console.warn('save printer config failed:', e);
            toast(tx('Save failed', 'Error al guardar') + ': ' + (e?.message || ''), { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    const runTest = async () => {
        if (testing) return;
        setTesting(true);
        try {
            const mod = await import('../data/labelPrinting');
            const res = await mod.testPrint({ location, slot, byName });
            if (res.ok) {
                toast(tx('✓ Test label sent', '✓ Etiqueta de prueba enviada'), { kind: 'success' });
            } else {
                toast(tx('Test failed: ', 'Prueba falló: ') + res.error, { kind: 'error' });
            }
            const fresh = await mod.getPrinterConfig(location, slot);
            setCfg(fresh);
        } finally {
            setTesting(false);
        }
    };

    // Brother direct-IP probe — see if we can talk to the Brother
    // from the browser without going through AirPrint. Tests three
    // things and reports back, all read-only / no print attempts.
    // If ALL three succeed the path is "we can build direct-IP".
    // If any fail with a CORS error, the browser is blocking — we
    // can't direct-IP and have to stick with AirPrint or Brother's
    // own SDK app.
    const runProbe = async () => {
        if (probing) return;
        const ip = (probeIp || ipDraft || cfg?.ip || '').trim();
        if (!ip) {
            setProbeResult('No IP set. Type the Brother\'s IP in the field below first.');
            return;
        }
        setProbing(true);
        setProbeResult('Running…');
        const lines = [`Probing http://${ip}/ from ${window.location.origin}`, ''];

        // Test 1 — basic reachability. no-cors mode tells the
        // browser "don't enforce CORS, just see if the request
        // round-trips". The response is opaque (we can't read
        // status or body) but a non-network error means the
        // Brother answered.
        try {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 6000);
            await fetch(`http://${ip}/`, { method: 'GET', mode: 'no-cors', signal: ctrl.signal });
            clearTimeout(to);
            lines.push('✓ TEST 1 — basic reach (no-cors): printer answered');
            lines.push('   (response is opaque to JS — that\'s normal)');
        } catch (e) {
            lines.push(`✗ TEST 1 — basic reach failed: ${e.name} ${e.message}`);
            lines.push('   → Possible causes: wrong IP, printer offline, iPad on different Wi-Fi.');
        }

        // Test 2 — CORS-mode GET. The browser will refuse to give
        // us the response unless the printer returns proper CORS
        // headers (Access-Control-Allow-Origin etc.). If this
        // succeeds, the printer is willing to talk to a browser
        // app — which is what we'd need for direct-IP print.
        try {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 6000);
            const r = await fetch(`http://${ip}/`, { method: 'GET', mode: 'cors', signal: ctrl.signal });
            clearTimeout(to);
            const acao = r.headers.get('Access-Control-Allow-Origin') || '(none)';
            lines.push(`✓ TEST 2 — CORS GET succeeded: status ${r.status}`);
            lines.push(`   Access-Control-Allow-Origin = ${acao}`);
            lines.push('   → Printer accepts browser requests.');
        } catch (e) {
            lines.push(`✗ TEST 2 — CORS GET blocked: ${e.message || e.name}`);
            lines.push('   → Browser refused the response (no CORS headers).');
        }

        // Test 3 — try POSTing to the IPP endpoint (path used by
        // AirPrint under the hood). Empty body just to see if the
        // route responds at all. If this succeeds with CORS, we can
        // build a real IPP client in the browser.
        try {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 6000);
            const r = await fetch(`http://${ip}/ipp/printer`, {
                method: 'POST',
                mode: 'cors',
                headers: { 'Content-Type': 'application/ipp' },
                body: new Uint8Array([]),
                signal: ctrl.signal,
            });
            clearTimeout(to);
            lines.push(`✓ TEST 3 — IPP POST succeeded: status ${r.status}`);
            lines.push('   → Direct-IP print to the Brother is feasible.');
        } catch (e) {
            lines.push(`✗ TEST 3 — IPP POST blocked: ${e.message || e.name}`);
            lines.push('   → No CORS-permissive IPP. Browser-direct path is not available.');
        }

        lines.push('');
        lines.push('— Summary —');
        const allOk = lines.filter(l => l.startsWith('✓')).length === 3;
        if (allOk) {
            lines.push('All three tests passed. I can build a direct-IP path');
            lines.push('similar to the Epson (no AirPrint, no OS dialog).');
        } else {
            lines.push('Some tests failed. Browser-direct to Brother is not');
            lines.push('viable on this firmware. Options: install Brother');
            lines.push('iPrint&Scan and use the Web Share API path, or fix');
            lines.push('the AirPrint paper-size issue at the printer level.');
        }
        setProbeResult(lines.join('\n'));
        setProbing(false);
    };

    if (loading) {
        return <div className="text-[11px] text-purple-700/70 px-2 py-1.5">{tx('Loading…', 'Cargando…')}</div>;
    }

    // Test enabled when: enabled toggle on, AND either Brother (no IP
    // required) OR Epson with an IP filled in. Save uses the same
    // gate so we never write a config that can't actually print.
    const canTest = enabled && (isBrother || !!ipDraft.trim());
    const canSave = isBrother || !!ipDraft.trim();

    return (
        <div className="border border-purple-200 rounded-lg p-3 bg-purple-50/40">
            <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-black text-purple-900">{locationLabel}</span>
                <label className="flex items-center gap-1.5 text-[11px] text-purple-800 font-bold cursor-pointer">
                    <input type="checkbox" checked={enabled}
                        onChange={(e) => setEnabled(e.target.checked)}
                        className="w-4 h-4 accent-purple-600" />
                    {tx('Enabled', 'Activada')}
                </label>
            </div>
            <div className="space-y-2">
                {/* ── Type selector ─────────────────────────────── */}
                <div>
                    <span className="block text-[10px] font-bold uppercase tracking-wide text-purple-800 mb-1">
                        {tx('Printer type', 'Tipo de impresora')}
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                        {[
                            { val: 'epson_linerless', en: '🧾 Epson Linerless',  es: '🧾 Epson sin liner', sub: 'TM-L100 / direct Wi-Fi' },
                            { val: 'brother_ql',      en: '🏷 Brother QL (DK)',  es: '🏷 Brother QL (DK)', sub: 'QL-820NWB / AirPrint dialog' },
                        ].map(t => (
                            <button key={t.val}
                                onClick={() => setTypeDraft(t.val)}
                                type="button"
                                className={`text-left px-2.5 py-1.5 rounded-lg border-2 text-[11px] font-bold transition ${
                                    typeDraft === t.val
                                        ? 'border-purple-600 bg-purple-600 text-white'
                                        : 'border-purple-200 bg-white text-purple-800 hover:bg-purple-50'
                                }`}>
                                <div className="leading-tight">{tx(t.en, t.es)}</div>
                                <div className={`text-[9px] font-normal mt-0.5 ${typeDraft === t.val ? 'text-purple-100' : 'text-purple-500'}`}>
                                    {t.sub}
                                </div>
                            </button>
                        ))}
                    </div>
                </div>

                <label className="block">
                    <span className="block text-[10px] font-bold uppercase tracking-wide text-purple-800 mb-0.5">
                        {tx('Name (any label)', 'Nombre (cualquier etiqueta)')}
                    </span>
                    <input type="text" value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        placeholder={`${locationLabel} ${isBrother ? 'Brother' : 'Epson'}`}
                        className="w-full px-2 py-1.5 rounded border border-purple-200 text-sm bg-white" />
                </label>

                {/* ── Epson-specific: connection + paper + settings ── */}
                {!isBrother && (
                    <>
                        <label className="block">
                            <span className="block text-[10px] font-bold uppercase tracking-wide text-purple-800 mb-0.5">
                                {tx('Printer IP on local Wi-Fi', 'IP de impresora en Wi-Fi')}
                            </span>
                            <input type="text" value={ipDraft}
                                onChange={(e) => setIpDraft(e.target.value)}
                                placeholder="192.168.1.42"
                                inputMode="decimal"
                                className="w-full px-2 py-1.5 rounded border border-purple-200 text-sm bg-white font-mono" />
                        </label>

                        <div className="grid grid-cols-3 gap-2">
                            <label className="block">
                                <span className="block text-[10px] font-bold uppercase tracking-wide text-purple-800 mb-0.5">
                                    {tx('Port', 'Puerto')}
                                </span>
                                <input type="number" value={portDraft}
                                    onChange={(e) => setPortDraft(e.target.value)}
                                    placeholder="80" min={1} max={65535} step={1}
                                    className="w-full px-2 py-1.5 rounded border border-purple-200 text-sm bg-white font-mono" />
                            </label>
                            <label className="block">
                                <span className="block text-[10px] font-bold uppercase tracking-wide text-purple-800 mb-0.5">
                                    {tx('Device ID', 'ID de dispositivo')}
                                </span>
                                <input type="text" value={deviceIdDraft}
                                    onChange={(e) => setDeviceIdDraft(e.target.value)}
                                    placeholder="local_printer"
                                    className="w-full px-2 py-1.5 rounded border border-purple-200 text-sm bg-white font-mono" />
                            </label>
                            <label className="block">
                                <span className="block text-[10px] font-bold uppercase tracking-wide text-purple-800 mb-0.5">
                                    {tx('Paper width', 'Ancho de papel')}
                                </span>
                                <select value={paperWidthMm}
                                    onChange={(e) => setPaperWidthMm(Number(e.target.value))}
                                    className="w-full px-2 py-1.5 rounded border border-purple-200 text-sm bg-white">
                                    <option value={80}>80 mm (3")</option>
                                    <option value={58}>58 mm</option>
                                    <option value={40}>40 mm</option>
                                </select>
                            </label>
                            <label className="block">
                                <span className="block text-[10px] font-bold uppercase tracking-wide text-purple-800 mb-0.5">
                                    {tx('Left offset (mm)', 'Margen izq. (mm)')}
                                </span>
                                <input type="number" min="0" max="20" step="0.5" value={leftOffsetMm}
                                    onChange={(e) => setLeftOffsetMm(Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
                                    className="w-full px-2 py-1.5 rounded border border-purple-200 text-sm bg-white" />
                                <span className="block text-[9px] text-purple-700/70 mt-0.5">
                                    {tx('Increase if it prints too far left', 'Súbelo si imprime muy a la izquierda')}
                                </span>
                            </label>
                        </div>
                        <p className="text-[10px] text-purple-700/80 leading-snug -mt-1">
                            {tx(
                                'Port 80 + device ID "local_printer" are the TM-L100 factory defaults — only change them if you changed them on the printer. Set this to match the roll you loaded: the labels resize to fit it (set it wrong and prints come out cut off or tiny). 58 vs 80 mm is set with the roll guides; 40 mm also needs a one-time switch in the TM-L100 Utility. Never go back to a wider roll after running a narrow one (wears the head and cutter).',
                                'Puerto 80 + ID "local_printer" son los valores de fábrica del TM-L100. Ajústalo al rollo que cargaste: las etiquetas se redimensionan para caber (si lo pones mal, salen cortadas o diminutas). 58 vs 80 mm se fija con las guías del rollo; 40 mm requiere un cambio único en el TM-L100 Utility. Nunca vuelvas a un rollo más ancho después de usar uno angosto (desgasta el cabezal y la cuchilla).',
                            )}
                        </p>

                        {/* Density, speed, paper-saving, margins etc. are
                            settings stored ON the printer, not in the app —
                            one tap opens its built-in settings page. */}
                        <div className="flex items-center gap-2">
                            <button type="button"
                                disabled={!ipDraft.trim()}
                                onClick={() => {
                                    const { host, port } = parseEpsonAddress();
                                    if (!host) return;
                                    openExternalUrl(`http://${host}${port !== 80 ? `:${port}` : ''}/`);
                                }}
                                className="px-3 py-2 rounded-lg bg-purple-600 text-white text-[11px] font-bold hover:bg-purple-700 active:scale-95 transition disabled:opacity-40">
                                🔧 {tx('Open printer settings page', 'Abrir configuración de la impresora')}
                            </button>
                            <span className="text-[10px] text-purple-700/80 leading-snug flex-1">
                                {tx('Login: user "epson" · password = the printer\'s serial number (bottom sticker; very old firmware uses "epson"). Density, speed, paper saving and network live here. Same settings are also in the free "Epson TM Utility" phone app.',
                                    'Usuario "epson" · contraseña = número de serie (etiqueta inferior; firmware muy viejo usa "epson"). Densidad, velocidad, ahorro de papel y red están ahí. También en la app "Epson TM Utility".')}
                            </span>
                        </div>

                        {/* First-time setup guide — mirrors the Brother one.
                            Opens the day the TM-L100 arrives, then never again. */}
                        <details
                            open={showEpsonGuide}
                            onToggle={(e) => setShowEpsonGuide(e.currentTarget.open)}
                            className="text-[11px] bg-white/80 border-2 border-purple-200 rounded-md">
                            <summary className="cursor-pointer px-2.5 py-2 font-bold text-purple-800 select-none hover:bg-purple-50 rounded-md">
                                📖 {tx('First-time setup guide (day the TM-L100 arrives)', 'Guía de configuración inicial')}
                            </summary>
                            <div className="px-3 pb-3 pt-1 space-y-3 text-purple-900/90 leading-snug">
                                <div>
                                    <div className="font-black text-purple-900 mb-1">1. {tx('Load paper + power on', 'Carga papel y enciende')}</div>
                                    <ul className="space-y-1 pl-4 list-disc marker:text-purple-400">
                                        <li>{tx('Drop in the 80 mm liner-free roll (certified roll: ICONEX 9023 series), close the cover, power on.', 'Coloca el rollo sin liner de 80 mm, cierra la tapa y enciende.')}</li>
                                    </ul>
                                </div>
                                <div>
                                    <div className="font-black text-purple-900 mb-1">2. {tx('Get it on the restaurant network', 'Conéctala a la red del restaurante')}</div>
                                    <ul className="space-y-1 pl-4 list-disc marker:text-purple-400">
                                        <li><span className="font-bold">{tx('Ethernet (easiest)', 'Ethernet (lo más fácil)')}:</span> {tx('plug a cable into the router — the printer grabs an address by itself (DHCP).', 'conecta un cable al router — la impresora toma una dirección sola (DHCP).')}</li>
                                        <li><span className="font-bold">Wi-Fi:</span> {tx('install the "Epson TM Utility" app (links below), tap Wi-Fi Setup Wizard, follow it.', 'instala la app "Epson TM Utility" (enlaces abajo), toca el asistente Wi-Fi y síguelo.')}</li>
                                        <li>{tx('Press the Status button on the back — it prints a sheet with the printer\'s IP.', 'Presiona el botón Status atrás — imprime una hoja con la IP.')}</li>
                                        <li>{tx('In the router, RESERVE that IP for the printer so it never changes (same as the TVs).', 'En el router, RESERVA esa IP para que nunca cambie (igual que las TVs).')}</li>
                                    </ul>
                                </div>
                                <div>
                                    <div className="font-black text-purple-900 mb-1">3. {tx('Save it here + test', 'Guárdala aquí y prueba')}</div>
                                    <ul className="space-y-1 pl-4 list-disc marker:text-purple-400">
                                        <li>{tx('Type the IP above, leave Port/Device ID at defaults, Enabled ON, Save.', 'Escribe la IP arriba, deja Puerto/ID por defecto, Activada, Guardar.')}</li>
                                        <li>{tx('Hit Test print FROM THE PHONE/IPAD APP — a label pops out in seconds. (Printing from a web browser is blocked by browser security; the app talks to the printer directly.)', 'Toca Probar DESDE LA APP del teléfono/iPad — sale una etiqueta en segundos. (Desde el navegador web está bloqueado; la app habla directo con la impresora.)')}</li>
                                        <li>{tx('No drivers needed for the app — drivers below are only for printing from a Windows PC.', 'La app no necesita drivers — los de abajo son solo para imprimir desde una PC con Windows.')}</li>
                                    </ul>
                                </div>
                            </div>
                        </details>
                    </>
                )}

                {/* ── Brother-specific: DK label dimensions ──────── */}
                {isBrother && (
                    <>
                        <div className="grid grid-cols-2 gap-2">
                            <label className="block">
                                <span className="block text-[10px] font-bold uppercase tracking-wide text-purple-800 mb-0.5">
                                    {tx('Label width (mm)', 'Ancho (mm)')}
                                </span>
                                <input type="number" value={labelWMm}
                                    min={20} max={200} step={1}
                                    onChange={(e) => setLabelWMm(Number(e.target.value) || 62)}
                                    className="w-full px-2 py-1.5 rounded border border-purple-200 text-sm bg-white font-mono" />
                            </label>
                            <label className="block">
                                <span className="block text-[10px] font-bold uppercase tracking-wide text-purple-800 mb-0.5">
                                    {tx('Label height (mm)', 'Alto (mm)')}
                                </span>
                                <input type="number" value={labelHMm}
                                    min={20} max={300} step={1}
                                    onChange={(e) => setLabelHMm(Number(e.target.value) || 90)}
                                    className="w-full px-2 py-1.5 rounded border border-purple-200 text-sm bg-white font-mono" />
                            </label>
                        </div>
                        <div className="text-[10px] text-purple-700/80 leading-snug bg-white/60 border border-purple-200 rounded-md px-2 py-1.5">
                            <div className="font-bold text-purple-800 mb-0.5">
                                {tx('Common DK rolls', 'Rollos DK comunes')}:
                            </div>
                            <div>DK-2205 (62 × cut length) · DK-1201 (29 × 90) · DK-1247 (103 × 164) · DK-4205 (62 continuous, removable)</div>
                            <div className="mt-1 italic text-purple-600">
                                {tx(
                                    'Brother goes through the OS print dialog. Tap "Test print" → pick the Brother in AirPrint → confirm.',
                                    'Brother imprime por el diálogo del sistema. Toca "Probar" → elige Brother en AirPrint → confirma.',
                                )}
                            </div>
                        </div>

                        {/* First-time setup guide — collapsible. The
                            day the Brother arrives, the admin opens
                            this once, runs through the 3 steps, never
                            opens it again. Lives here (next to the
                            Type selector) so it's where you'd look
                            after picking "Brother QL". */}
                        <details
                            open={showSetupGuide}
                            onToggle={(e) => setShowSetupGuide(e.currentTarget.open)}
                            className="text-[11px] bg-white/80 border-2 border-purple-200 rounded-md">
                            <summary className="cursor-pointer px-2.5 py-2 font-bold text-purple-800 select-none hover:bg-purple-50 rounded-md">
                                📖 {tx('First-time setup guide', 'Guía de configuración inicial')}
                            </summary>
                            <div className="px-3 pb-3 pt-1 space-y-3 text-purple-900/90 leading-snug">
                                <p className="text-[10.5px] italic text-purple-700">
                                    {tx(
                                        'Brother goes through the OS print dialog (AirPrint), so it doesn\'t need an IP like the Epson does. Three steps the day it arrives:',
                                        'Brother imprime por AirPrint del sistema operativo, no necesita IP como la Epson. Tres pasos el día que llegue:',
                                    )}
                                </p>

                                {/* Step 1 — Wi-Fi */}
                                <div>
                                    <div className="font-black text-purple-900 mb-1">
                                        1. {tx('Get the Brother on restaurant Wi-Fi', 'Conecta la Brother al Wi-Fi del restaurante')}
                                    </div>
                                    <ul className="space-y-1 pl-4 list-disc marker:text-purple-400">
                                        <li>
                                            <span className="font-bold">{tx('WPS (fastest)', 'WPS (lo más rápido)')}:</span>{' '}
                                            {tx(
                                                'press WPS on the router, then hold the Wi-Fi button on the Brother for ~3 sec. Wi-Fi LED goes solid = connected.',
                                                'presiona WPS en el router, luego mantén el botón Wi-Fi de la Brother ~3 seg. LED Wi-Fi fijo = conectado.',
                                            )}
                                        </li>
                                        <li>
                                            <span className="font-bold">{tx('Brother iPrint&Scan app', 'App Brother iPrint&Scan')}:</span>{' '}
                                            {tx(
                                                'install on the iPad, tap Add Printer, follow the wizard to push Wi-Fi creds.',
                                                'instálala en el iPad, toca Agregar impresora, sigue el asistente para pasarle las credenciales Wi-Fi.',
                                            )}
                                        </li>
                                        <li>
                                            <span className="font-bold">{tx('USB to laptop', 'USB a la laptop')}:</span>{' '}
                                            {tx(
                                                'plug into a Mac/PC, install drivers from support.brother.com, then use Printer Setting Tool → Communication Settings to switch USB → Wi-Fi.',
                                                'conéctala a la Mac/PC, instala los drivers de support.brother.com, luego usa Printer Setting Tool → Communication Settings para pasar de USB a Wi-Fi.',
                                            )}
                                        </li>
                                    </ul>
                                </div>

                                {/* Step 2 — AirPrint */}
                                <div>
                                    <div className="font-black text-purple-900 mb-1">
                                        2. {tx('Confirm AirPrint sees it', 'Confirma que AirPrint la detecta')}
                                    </div>
                                    <ul className="space-y-1 pl-4 list-disc marker:text-purple-400">
                                        <li>{tx(
                                            'On the iPad, open any app, hit Print — the Brother should be in the printer list.',
                                            'En el iPad, abre cualquier app y toca Imprimir — la Brother debe aparecer en la lista.',
                                        )}</li>
                                        <li>{tx(
                                            'If not visible: wait 30-60 sec (Bonjour discovery is slow at first), confirm the iPad is on the same Wi-Fi (NOT a guest network), turn off "client/AP isolation" on the router if enabled.',
                                            'Si no aparece: espera 30-60 seg, confirma que el iPad esté en la misma Wi-Fi (no de invitados), apaga "aislamiento de cliente/AP" en el router si está activado.',
                                        )}</li>
                                    </ul>
                                </div>

                                {/* Step 3 — App config */}
                                <div>
                                    <div className="font-black text-purple-900 mb-1">
                                        3. {tx('Save the printer here', 'Guarda la impresora aquí')}
                                    </div>
                                    <ul className="space-y-1 pl-4 list-disc marker:text-purple-400">
                                        <li>{tx(
                                            'Type = Brother QL (already picked above).',
                                            'Tipo = Brother QL (ya seleccionado arriba).',
                                        )}</li>
                                        <li>{tx(
                                            'Name = anything ("Webster Brother" is fine).',
                                            'Nombre = lo que quieras ("Webster Brother" está bien).',
                                        )}</li>
                                        <li>{tx(
                                            'Label width = 62 mm (DK-4205 paper width). Height = doesn\'t really matter — the Small/Medium/Large tabs override it at print time.',
                                            'Ancho = 62 mm (ancho del papel DK-4205). Alto = casi no importa — las pestañas Small/Medium/Large lo sobrescriben al imprimir.',
                                        )}</li>
                                        <li>{tx(
                                            'Toggle Enabled ON, hit Save, then hit Test print → OS print dialog opens → pick the Brother in AirPrint → confirm.',
                                            'Activa Enabled, toca Guardar, luego Probar → se abre el diálogo del sistema → elige la Brother en AirPrint → confirma.',
                                        )}</li>
                                    </ul>
                                </div>

                                {/* Troubleshooting */}
                                <div>
                                    <div className="font-black text-purple-900 mb-1">
                                        🔧 {tx('Troubleshooting', 'Problemas comunes')}
                                    </div>
                                    <ul className="space-y-1 pl-4 list-disc marker:text-purple-400">
                                        <li>
                                            <span className="font-bold">{tx('Not in AirPrint list', 'No aparece en AirPrint')}:</span>{' '}
                                            {tx(
                                                'iPad on wrong Wi-Fi, or router has client isolation on.',
                                                'iPad en Wi-Fi equivocada, o el router tiene aislamiento de cliente activado.',
                                            )}
                                        </li>
                                        <li>
                                            <span className="font-bold">{tx('Job hangs', 'El trabajo se cuelga')}:</span>{' '}
                                            {tx(
                                                'open Brother iPrint&Scan to check status — usually paper jam or empty roll.',
                                                'abre Brother iPrint&Scan para ver el estado — normalmente atasco de papel o rollo vacío.',
                                            )}
                                        </li>
                                        <li>
                                            <span className="font-bold">{tx('Label prints sideways', 'La etiqueta sale de lado')}:</span>{' '}
                                            {tx(
                                                'Printer Setting Tool → Layout → set to Portrait.',
                                                'Printer Setting Tool → Layout → ponlo en Vertical.',
                                            )}
                                        </li>
                                        <li>
                                            <span className="font-bold">{tx('Wrong cut length', 'Largo de corte incorrecto')}:</span>{' '}
                                            {tx(
                                                'DK-4205 is continuous; the Small/Medium/Large tab in the print modal sets the cut. Small = 25mm, Medium = 38mm, Large = 62mm.',
                                                'DK-4205 es continuo; la pestaña Small/Medium/Large fija el corte. Small = 25mm, Medium = 38mm, Large = 62mm.',
                                            )}
                                        </li>
                                    </ul>
                                </div>

                                <p className="text-[10px] italic text-purple-600 border-t border-purple-200 pt-2">
                                    {tx(
                                        'Why no IP? The Epson talks straight to its IP over Wi-Fi (HTTP/SOAP). The Brother uses AirPrint via Bonjour — the OS does discovery and routing, the app just hands off the print job.',
                                        '¿Por qué sin IP? La Epson habla directo a su IP por Wi-Fi (HTTP/SOAP). La Brother usa AirPrint vía Bonjour — el sistema operativo hace el descubrimiento y el ruteo, la app solo entrega el trabajo de impresión.',
                                    )}
                                </p>
                            </div>
                        </details>

                        {/* Direct-IP probe — Andrew 2026-05-21: "can
                            we just use the ip and bridge straight
                            into the printer?". Tests if the Brother
                            accepts CORS-permissive HTTP from a
                            browser. If all 3 tests pass, direct-IP
                            print is feasible like the Epson. If any
                            fail, AirPrint or iPrint&Scan is the
                            only browser-side option. Read-only — no
                            print attempts. */}
                        <details className="text-[11px] bg-white/80 border-2 border-purple-200 rounded-md">
                            <summary className="cursor-pointer px-2.5 py-2 font-bold text-purple-800 select-none hover:bg-purple-50 rounded-md">
                                🔬 {tx('Try direct IP (skip AirPrint)', 'Probar IP directa (saltar AirPrint)')}
                            </summary>
                            <div className="px-3 pb-3 pt-1 space-y-2 text-purple-900/90 leading-snug">
                                <p className="text-[10.5px] italic text-purple-700">
                                    {tx(
                                        'Tests whether the Brother accepts direct HTTP from the browser (3 read-only requests, no print attempts). If yes, I can build a direct-IP print path like the Epson. If no, browser is blocking us — AirPrint is the only browser-side route.',
                                        'Prueba si la Brother acepta HTTP directo del navegador (3 peticiones de solo-lectura, sin impresión). Si sí, puedo construir una ruta IP directa como la Epson.',
                                    )}
                                </p>
                                <label className="block">
                                    <span className="block text-[10px] font-bold uppercase tracking-wide text-purple-800 mb-0.5">
                                        {tx('Brother IP', 'IP de Brother')}
                                    </span>
                                    <input
                                        type="text"
                                        value={probeIp}
                                        onChange={(e) => setProbeIp(e.target.value)}
                                        placeholder="192.168.1.42"
                                        inputMode="decimal"
                                        className="w-full px-2 py-1.5 rounded border border-purple-200 text-sm bg-white font-mono"
                                    />
                                </label>
                                <button
                                    onClick={runProbe}
                                    disabled={probing || !(probeIp || ipDraft || cfg?.ip)}
                                    className="w-full py-1.5 rounded-lg bg-purple-600 text-white text-xs font-bold hover:bg-purple-700 disabled:opacity-40">
                                    {probing ? tx('Probing…', 'Probando…') : '🔬 ' + tx('Run direct-IP probe', 'Ejecutar prueba')}
                                </button>
                                {probeResult && (
                                    <pre className="text-[10px] text-purple-900 bg-white border border-purple-200 p-2 rounded mt-1 overflow-x-auto whitespace-pre-wrap font-mono leading-tight">
                                        {probeResult}
                                    </pre>
                                )}
                                <p className="text-[10px] italic text-purple-600 border-t border-purple-200 pt-2">
                                    {tx(
                                        'Make sure the Brother\'s IP is filled in above before probing. Find the IP on the Brother\'s LCD: Menu → WLAN → TCP/IP → IP Address.',
                                        'Llena la IP de la Brother arriba antes de probar. Encuéntrala en la LCD de la Brother: Menu → WLAN → TCP/IP → IP Address.',
                                    )}
                                </p>
                            </div>
                        </details>
                    </>
                )}

                {cfg?.lastTestedAt && (
                    <div className={`text-[10px] font-bold ${cfg.lastTestOk ? 'text-emerald-700' : 'text-red-700'}`}>
                        {cfg.lastTestOk ? '✓ ' : '✕ '}
                        {tx('Last test', 'Última prueba')}: {formatPrinterTestTime(cfg.lastTestedAt)}
                        {cfg.lastTestBy && <span className="opacity-70"> · {cfg.lastTestBy}</span>}
                    </div>
                )}
                <div className="flex gap-2 pt-1">
                    <button onClick={save} disabled={saving || !canSave}
                        className="flex-1 py-1.5 rounded-lg bg-purple-600 text-white text-xs font-bold hover:bg-purple-700 disabled:opacity-40">
                        {saving ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
                    </button>
                    <button onClick={runTest} disabled={testing || !canTest}
                        className="flex-1 py-1.5 rounded-lg bg-white border-2 border-purple-600 text-purple-700 text-xs font-bold hover:bg-purple-50 disabled:opacity-40">
                        {testing ? tx('Testing…', 'Probando…') : '🏷 ' + tx('Test print', 'Probar')}
                    </button>
                </div>
            </div>
        </div>
    );
}

function formatPrinterTestTime(ts) {
    try {
        const d = ts.toDate ? ts.toDate() : new Date(ts);
        return d.toLocaleString();
    } catch {
        return String(ts || '');
    }
}

// AccessToggle — bulk-edit per-staff "what can this person SEE" pill.
// Designed for the redesigned bulk edit cards: shows a clear icon + label,
// big enough to be tappable on a phone, with on/off state read at a glance
// (mint pill = ON, ghost-grey strikethrough = OFF). Replaces the old 8x8
// icon-only buttons that had no labels.
function AccessToggle({ on, label, icon, onClick }) {
    return (
        <button onClick={onClick}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition active:scale-95 ${
                on
                    ? 'bg-dd-green-50 text-dd-green-700 border-dd-green/30 hover:bg-dd-sage-50'
                    : 'bg-white text-dd-text-2 border-dd-line line-through opacity-70 hover:opacity-100'
            }`}>
            <span className="text-sm">{icon}</span>
            <span>{label}</span>
        </button>
    );
}

// Lists the last 10 notification docs targeted at this staff member.
// Lets admin diagnose where a missing-push problem actually is:
//   - Row present, recent → doc was created. If you didn't see a toast,
//     the issue is FCM delivery (Cloud Function not deployed, dead
//     token, browser permission, etc.).
//   - Row missing → upstream (notify() never fired). Check the event
//     handler that should have written it.
//
// Reads /notifications WHERE forStaff == currentStaff ORDER BY createdAt
// DESC LIMIT 10. No realtime subscription; refresh button re-reads.
function RecentNotificationsFeed({ staffName, language }) {
    const [items, setItems] = useState(null);
    const [refresh, setRefresh] = useState(0);
    const tx = (en, es) => (language === 'es' ? es : en);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const { collection, query: q, where, orderBy, limit, getDocs } = await import('firebase/firestore');
                const ref = collection(db, 'notifications');
                const qq = q(ref, where('forStaff', '==', staffName), orderBy('createdAt', 'desc'), limit(10));
                const snap = await getDocs(qq);
                if (!alive) return;
                setItems(snap.docs.map(d => ({ id: d.id, ...d.data() })));
            } catch (e) {
                console.warn('recent notifications query failed:', e);
                if (alive) setItems([]);
            }
        })();
        return () => { alive = false; };
    }, [staffName, refresh]);

    const fmtTime = (ts) => {
        if (!ts) return '—';
        try {
            const d = ts.toDate ? ts.toDate() : new Date(ts);
            const now = Date.now();
            const diff = (now - d.getTime()) / 1000;
            if (diff < 60) return `${Math.round(diff)}s ago`;
            if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
            if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
            return d.toLocaleString();
        } catch { return '—'; }
    };

    return (
        <div className="mt-3 mb-2 bg-white border border-blue-200 rounded-lg p-2">
            <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10px] font-bold uppercase tracking-wider text-blue-800">
                    {tx('Recent notification docs sent to you', 'Notificaciones recientes para ti')}
                </div>
                <button onClick={() => setRefresh(r => r + 1)}
                    className="text-[10px] font-bold text-blue-700 hover:underline">
                    ↻ {tx('Refresh', 'Actualizar')}
                </button>
            </div>
            {items === null ? (
                <p className="text-[11px] text-blue-700 italic">{tx('Loading…', 'Cargando…')}</p>
            ) : items.length === 0 ? (
                <p className="text-[11px] text-blue-700 italic">
                    {tx('No notification docs found for you. If you triggered an event that should notify you, check whether notify() actually fired (or whether forStaff was you and got skipped by the self-notify guard).',
                        'Sin notificaciones para ti. Si activaste un evento que debería notificarte, revisa si notify() corrió.')}
                </p>
            ) : (
                <div className="divide-y divide-gray-100">
                    {items.map(n => (
                        <div key={n.id} className="py-1.5 first:pt-0 last:pb-0">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] font-bold text-dd-text truncate">{n.title || n.type || '(no title)'}</span>
                                <span className="text-[10px] text-gray-500 flex-shrink-0">{fmtTime(n.createdAt)}</span>
                            </div>
                            {n.body && <div className="text-[10px] text-gray-600 truncate">{n.body}</div>}
                            <div className="text-[9px] text-gray-400 mt-0.5">
                                {n.type || '?'} · tag: {n.tag || '(none)'} · by: {n.createdBy || '?'}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default function AdminPanel(props) {
    if (!isAdmin(props.staffName, props.staffList)) {
        return (
            <div className="p-6 text-center text-gray-500">
                {props.language === "es" ? "Acceso denegado." : "Access denied."}
            </div>
        );
    }
    return <AdminPanelInner {...props} />;
}

function AdminPanelInner({ language, staffName, staffList, setStaffList, storeLocation, onNavigate, hasOnboardingAccess, onSelfRenamed }) {
            const [editingId, setEditingId] = useState(null);
            const [editPin, setEditPin] = useState("");
            const [editRole, setEditRole] = useState("");
            // 2026-06-16 — staff NAME is now editable. Because the app has no
            // per-user auth (identity IS the name string), changing it has to
            // fan out across every name-joined collection — see
            // src/data/renameStaff.js. The Save button defers a name change to
            // a confirm step (pendingRename) so the admin sees the blast
            // radius before we rewrite the schedule / PTO / chat membership.
            const [editName, setEditName] = useState("");
            const [pendingRename, setPendingRename] = useState(null); // { id, oldName, newName }
            const [renameBusy, setRenameBusy] = useState(false);
            const [editOpsAccess, setEditOpsAccess] = useState(false);
            const [editRecipesAccess, setEditRecipesAccess] = useState(false);
            const [editViewLabor, setEditViewLabor] = useState(false);
            const [editCanCountMoney, setEditCanCountMoney] = useState(false);
            const [editShiftLead, setEditShiftLead] = useState(false);
            const [editIsMinor, setEditIsMinor] = useState(false);
            // 2026-05-16 — owners / silent admins who exist in the staff
            // list (for PIN + permissions + admin access) but should NOT
            // appear as a row on the schedule grid by default. When true,
            // the staff record is hidden from sideStaff in Schedule.jsx
            // UNLESS they actually have a shift this week (safety net so
            // a real assignment can't be invisible).
            const [editHideFromSchedule, setEditHideFromSchedule] = useState(false);
            const [editScheduleSide, setEditScheduleSide] = useState("foh");
            const [editTargetHours, setEditTargetHours] = useState(0);
            // 2026-05-16 — staff birthday MM-DD. Drives the auto-derived
            // birthday chips on the Schedule grid's events strip. Empty
            // string = not set. Stored without year (recurring annual).
            const [editBirthday, setEditBirthday] = useState("");
            // Preferred language for outbound notifications (push, in-app
            // banners). Defaults to English for legacy records that don't
            // carry the field. New staff form picks this up from the device's
            // current UI language.
            const [editPreferredLanguage, setEditPreferredLanguage] = useState("en");
            // Per-staff Home view override. When set to a tab id (e.g. 'schedule'),
            // tapping the Home tab — or signing in for the first time — shows
            // that tab's content instead of the default dashboard. Useful for:
            // FOH staff landing on Schedule, kitchen on Recipes, trainees on
            // Training, etc. Empty/'auto' = the default unified Home page.
            const [editHomeView, setEditHomeView] = useState("auto");
            // Per-staff tab visibility — array of HIDEABLE_PAGES ids that are
            // FORCE-HIDDEN. Empty array = sees everything. Mirrors the
            // staff.hiddenPages field. Edit form drives this; bulk-tag panel
            // also writes to it from a different surface.
            const [editHiddenPages, setEditHiddenPages] = useState([]);
            // Designated-scheduler toggles. Per-side so the FOH scheduler
            // can't accidentally publish over BOH shifts and vice versa.
            const [editCanEditScheduleFOH, setEditCanEditScheduleFOH] = useState(false);
            const [editCanEditScheduleBOH, setEditCanEditScheduleBOH] = useState(false);
            // SMS — per-staff phone draft. Map of staffId → raw input
            // string. The input field commits its value via
            // setPhoneForStaff on blur or Enter; while editing, the
            // raw typed string lives here so we don't snap to the
            // normalized form mid-typing.
            const [phoneDrafts, setPhoneDrafts] = useState({});
            // 2026-06-02 — Mask PINs on the staff-list cards by default
            // (●●●● placeholder). Per-row Eye toggle reveals the real
            // PIN for 10 seconds, then auto-hides. The audit flagged
            // PINs as plain-text-visible to anyone with admin access
            // (e.g. over-the-shoulder during a shift). State is per-row
            // (Set of staff ids) so toggling one row never affects
            // another. Timers are tracked in pinHideTimersRef so we can
            // cancel them on unmount or when the same row is toggled
            // off early. The edit form still shows the PIN editable —
            // that surface is intentional and password-style would
            // make it impossible to verify what was just typed.
            const [visiblePinIds, setVisiblePinIds] = useState(() => new Set());
            const pinHideTimersRef = useRef({});
            useEffect(() => {
                // Cancel any pending auto-hide timers on unmount so we
                // don't fire setState on a torn-down component.
                return () => {
                    const timers = pinHideTimersRef.current;
                    Object.keys(timers).forEach(id => {
                        try { clearTimeout(timers[id]); } catch {}
                    });
                    pinHideTimersRef.current = {};
                };
            }, []);
            const togglePinVisibility = (personId) => {
                setVisiblePinIds(prev => {
                    const next = new Set(prev);
                    const timers = pinHideTimersRef.current;
                    if (next.has(personId)) {
                        // Hiding manually — cancel the auto-hide timer
                        // so a stale fire later can't toggle other state.
                        next.delete(personId);
                        if (timers[personId]) {
                            clearTimeout(timers[personId]);
                            delete timers[personId];
                        }
                    } else {
                        next.add(personId);
                        // Reset any previous timer (shouldn't happen, but
                        // belt-and-suspenders: a double-tap is harmless).
                        if (timers[personId]) clearTimeout(timers[personId]);
                        timers[personId] = setTimeout(() => {
                            setVisiblePinIds(curr => {
                                const after = new Set(curr);
                                after.delete(personId);
                                return after;
                            });
                            delete timers[personId];
                        }, 10000);
                    }
                    return next;
                });
            };
            const [showBulkTag, setShowBulkTag] = useState(false);
            const [showRequiredTaskAdmin, setShowRequiredTaskAdmin] = useState(false);
            const [showInventoryLists, setShowInventoryLists] = useState(false);
            // Staff Import flow — paste names or upload CSV, diff against
            // current staff list, configure new records (role / location /
            // PIN / flags), commit as a batch. Lives in ImportStaffModal.
            const [showImportStaff, setShowImportStaff] = useState(false);
            const [bulkSearch, setBulkSearch] = useState("");
            const [bulkFilter, setBulkFilter] = useState("all"); // all | untagged | foh | boh
            // Bulk toggles panel is collapsed by default so the staff list gets
            // the most room. Expand on demand for mass on/off operations.
            const [bulkTogglesOpen, setBulkTogglesOpen] = useState(false);
            // Live counts for the Onboarding launcher card. Only subscribe when
            // the current admin actually has PII access — defaults to off for
            // everyone except owners (Julie + Andrew).
            //
            // 2026-05-28 Audit #9 — bounded queries. Previously this
            // subscribed to the entire onboarding_applications and
            // onboarding_hires collections with no orderBy/limit. Both
            // hold PII docs that include uploaded photos/scans, so per-
            // device payloads grow indefinitely as the restaurant hires
            // more people. Capped at limit(500) ordered by createdAt
            // desc — we get the 500 most recent rows, which is more
            // than enough for an active counter (the restaurant
            // averages <50 hires/year). If we ever genuinely exceed
            // 500 active, the counter shows ≥500 but the per-row
            // detail screens (which do their own paginated queries)
            // still work — this is just the launcher badge.
            const [onboardingPendingApps, setOnboardingPendingApps] = useState(0);
            const [onboardingActiveHires, setOnboardingActiveHires] = useState(0);
            useEffect(() => {
                if (!hasOnboardingAccess) return;
                const appsQ = query(
                    collection(db, 'onboarding_applications'),
                    orderBy('createdAt', 'desc'),
                    limit(500),
                );
                const unsubA = onSnapshot(appsQ,
                    (snap) => setOnboardingPendingApps(snap.size),
                    // 2026-06-20 (QA audit L3) — DON'T reset the badge to 0 on a
                    // load error. A transient blip used to silently hide real
                    // pending applications from managers ("0" reads as "nothing to
                    // do"). Keep the last known count — the badge is a launcher
                    // hint and the detail screen re-queries — and just log.
                    (err) => console.warn('onboarding apps count load error:', err?.code || err));
                const hiresQ = query(
                    collection(db, 'onboarding_hires'),
                    orderBy('createdAt', 'desc'),
                    limit(500),
                );
                const unsubH = onSnapshot(hiresQ,
                    (snap) => {
                        let active = 0;
                        snap.forEach(d => {
                            const s = (d.data() || {}).status;
                            if (s !== 'archived' && s !== 'complete') active++;
                        });
                        setOnboardingActiveHires(active);
                    },
                    // 2026-06-20 (QA audit L3) — keep the last known count on a
                    // load error rather than zeroing it (see the apps listener).
                    (err) => console.warn('onboarding hires count load error:', err?.code || err));
                return () => { unsubA(); unsubH(); };
            }, [hasOnboardingAccess]);
            // Two-step confirmation for the System Refresh broadcast.
            // First tap arms the button; second tap (within 10s) fires it.
            const [confirmingRefresh, setConfirmingRefresh] = useState(false);
            // Recipe view audit log — most recent N opens. Used in the
            // "Recipe Audit" panel below; collected by Recipes.jsx on every
            // accordion expand.
            const [recipeViews, setRecipeViews] = useState([]);
            const [showAllViews, setShowAllViews] = useState(false);

            // ── Inventory audit panel state ─────────────────────────────
            // Mirrors the recipe-view audit shape so the same UX
            // (collapsed by default, on-demand subscribe, show-25 then
            // expand) applies. Audit rows are already written by
            // Operations.jsx on every count change to
            // /inventory_audits_{location} with { itemId, itemName,
            // previous, next, delta, byStaff, at, atLocal, dateKey }.
            const [inventoryAudits, setInventoryAudits] = useState([]);
            const [inventoryAuditExpanded, setInventoryAuditExpanded] = useState(false);
            const [showAllInvAudits, setShowAllInvAudits] = useState(false);
            // Filters — keep client-side; the query just pulls the most
            // recent 500 rows for the selected location and we trim from
            // there. At restaurant scale this is plenty fast.
            const [invAuditDir, setInvAuditDir] = useState('all');         // 'all' | 'adds' | 'subs'
            const [invAuditDateK, setInvAuditDateK] = useState('week');    // 'all' | 'today' | 'yest' | 'week'
            const [invAuditStaff, setInvAuditStaff] = useState('');        // staffName filter, empty = all
            const [invAuditSearch, setInvAuditSearch] = useState('');      // item-name substring

            // ── Order log panel state ───────────────────────────────────
            // Same on-demand subscription pattern as the inventory audit
            // panel. /order_logs accumulates one row per submitted Order
            // Mode session — captures who placed the order, when, vendor
            // breakdown, and every item with its final status + note.
            const [orderLogs, setOrderLogs] = useState([]);
            const [orderLogExpanded, setOrderLogExpanded] = useState(false);
            const [orderLogDateK, setOrderLogDateK] = useState('month');  // 'all' | 'today' | 'week' | 'month'
            const [orderLogVendor, setOrderLogVendor] = useState('');     // exact vendor name, empty=all
            const [expandedOrderId, setExpandedOrderId] = useState(null);
            // FIX (review 2026-05-14, perf): subscription gated by an
            // expand toggle. Recipe-views grow as a 200-doc-cap descending
            // query — every recipe open re-fires the snapshot. With the
            // audit panel collapsed by default, the subscription doesn't
            // start until admin actually wants to see the data.
            const [recipeAuditExpanded, setRecipeAuditExpanded] = useState(false);
            // Heavy history panels are collapsed by default — they were
            // dominating the admin page and forcing people to scroll past
            // hundreds of rows to reach the more important controls.
            const [checklistHistoryExpanded, setChecklistHistoryExpanded] = useState(false);
            const [inventoryHistoryExpanded, setInventoryHistoryExpanded] = useState(false);
            // Chat history (admin-only audit view of every chat + message).
            // Lazy-loaded — Firestore reads only fire when expanded.
            const [chatHistoryExpanded, setChatHistoryExpanded] = useState(false);
            // Payroll (owner-only, gated behind its own password). Lazy-loaded —
            // the engine + exceljs only load when this section is expanded.
            const [payrollExpanded, setPayrollExpanded] = useState(false);
            useEffect(() => {
                if (!confirmingRefresh) return;
                const t = setTimeout(() => setConfirmingRefresh(false), 10000);
                return () => clearTimeout(t);
            }, [confirmingRefresh]);
            const handleSystemRefresh = async () => {
                try {
                    await setDoc(doc(db, "config", "forceRefresh"), {
                        triggeredAt: serverTimestamp(),
                        triggeredBy: staffName,
                    });
                    setConfirmingRefresh(false);
                    toast(language === "es"
                        ? "✓ Refresco enviado. Cada dispositivo activo se actualizará en segundos."
                        : "✓ Broadcast sent. Every active device will refresh within seconds.");
                } catch (e) {
                    console.error("System refresh broadcast failed:", e);
                    toast((language === "es" ? "Error: " : "Error: ") + e.message);
                }
            };

            // Centralized BOH role inference — same vocabulary as Schedule.jsx,
            // duplicated here so AdminPanel doesn't take a Schedule import.
            const BULK_BOH_ROLES = ["BOH", "Pho", "Pho Station", "Grill", "Fryer", "Fried Rice", "Dish", "Bao/Tacos/Banh Mi", "Spring Rolls/Prep", "Prep", "Kitchen Manager", "Asst Kitchen Manager"];
            const inferSide = (role) => BULK_BOH_ROLES.includes(role) ? "boh" : "foh";

            // One-shot auto-tag — fills in scheduleSide for every staff that
            // currently has no explicit value. Saves a single Firestore write
            // (whole-list setDoc) instead of N separate ones, so 60+ staff
            // get tagged in a fraction of a second.
            const autoTagUntagged = async () => {
                let touched = 0;
                let latest = null;
                setStaffList(prev => {
                    const next = prev.map(s => {
                        if (s.scheduleSide === "foh" || s.scheduleSide === "boh") return s;
                        touched += 1;
                        return { ...s, scheduleSide: inferSide(s.role) };
                    });
                    latest = next;
                    return next;
                });
                if (touched > 0 && latest) {
                    await saveStaffToFirestore(latest);
                    showSaved();
                }
                toast(language === "es"
                    ? `✓ Etiquetados automáticamente: ${touched}.`
                    : `✓ Auto-tagged ${touched} staff from role.`);
            };

            // Migration helper: flip every staff record's recipesAccess to
            // true. The recipes policy moved from opt-IN to opt-OUT, so any
            // existing record that's false (or unset) needs an explicit true
            // to participate cleanly. Idempotent — safe to click again.
            // After this runs, the manager only has to TOGGLE OFF anyone they
            // don't want to have access (rare).
            const grantRecipesToAll = async () => {
                if (!confirm(language === "es"
                    ? "¿Dar acceso a Recetas a TODO el personal? (Puedes quitárselo a alguien después.)"
                    : "Grant Recipes access to ALL staff? (You can revoke individuals later.)")) return;
                let touched = 0;
                let latest = null;
                setStaffList(prev => {
                    const next = prev.map(s => {
                        if (s.recipesAccess === true) return s;
                        touched += 1;
                        return { ...s, recipesAccess: true };
                    });
                    latest = next;
                    return next;
                });
                if (touched > 0 && latest) {
                    await saveStaffToFirestore(latest);
                    showSaved();
                }
                toast(language === "es"
                    ? `✓ Acceso a Recetas otorgado: ${touched}.`
                    : `✓ Recipes access granted to ${touched} staff.`);
            };

            // Generic bulk-update helper — sweep a subset of staff records
            // to the same value for the same field. Used by every "Sweep N
            // visible to ON/OFF" button in the bulk-toggle section.
            // ── SMS opt-in helpers ────────────────────────────────────
            //
            // Every flip of `smsOptIn` writes a row to `sms_opt_in_events`
            // capturing WHEN, by WHO, from WHAT source, and the verbatim
            // consent text snapshot + version. That collection is the
            // legal evidence trail — exported as CSV via the "Export SMS
            // opt-in log" button. Without this audit, a carrier or
            // attorney asking "prove she agreed" leaves us empty-handed.
            //
            // Skips no-ops (current value == new value) so we don't
            // pollute the event log with phantom rows.
            //
            // applyOptInToList — pure transform: returns a new list with
            // the staff's SMS fields updated. Pulled out so the bulk
            // path can stack many updates in one setStaffList call.
            const applyOptInToList = (list, staffName, value) => {
                const nowIso = new Date().toISOString();
                return list.map(s => {
                    if (s.name !== staffName) return s;
                    if (s.smsOptIn === value) return s;
                    return value
                        ? {
                            ...s,
                            smsOptIn: true,
                            smsOptInAt: nowIso,
                            smsOptInBy: staffName || 'admin',          // current admin doing the toggle
                            smsOptInSource: 'admin_panel',
                        }
                        : {
                            ...s,
                            smsOptIn: false,
                            // We do NOT clear smsStopped here — that flag is
                            // server-only (set by inbound STOP reply) and
                            // only an inbound START reply can clear it.
                            // Admin opt-out is a separate concept from a
                            // STOP-reply opt-out.
                        };
                });
            };

            // setSmsOptInForStaff — flip a single staff's smsOptIn and
            // write the matching audit row. Used by the per-staff toggle
            // in the Settings row. Returns true if a change happened.
            const setSmsOptInForStaff = async (staff, value) => {
                if (!staff || !staff.name) return false;
                if (staff.smsOptIn === value) return false;
                let latest = null;
                setStaffList(prev => {
                    latest = applyOptInToList(prev, staff.name, value);
                    return latest;
                });
                if (latest) await saveStaffToFirestore(latest);
                // Log the consent change. The byName is the current admin
                // — staffName is hoisted from the AdminPanelInner props.
                await writeClientOptInEvent({
                    staffId: staff.id ?? null,
                    staffName: staff.name,
                    phoneE164: staff.phoneE164 || null,
                    action: value ? 'opt_in' : 'opt_out',
                    source: 'admin_panel',
                    byName: staffName || 'admin',
                    byId: null,
                });
                showSaved();
                return true;
            };

            // bulkSmsOptIn — set smsOptIn for many staff in one go.
            // Each individual change still produces its own audit row
            // (one row per staff, not one row per batch) so the export
            // remains useful for per-person compliance review.
            const bulkSmsOptIn = async (ids, value) => {
                if (!ids || ids.length === 0) return;
                const idSet = new Set(ids);
                // Snapshot the targets BEFORE the state update so we can
                // write per-staff audit rows after persistence.
                const targets = staffList.filter(s => idSet.has(s.id) && s.smsOptIn !== value);
                if (targets.length === 0) return;
                let latest = null;
                setStaffList(prev => {
                    let next = prev;
                    for (const t of targets) {
                        next = applyOptInToList(next, t.name, value);
                    }
                    latest = next;
                    return next;
                });
                if (latest) await saveStaffToFirestore(latest);
                // Write one audit row per staff. Done in parallel —
                // writeClientOptInEvent is best-effort + handles its
                // own error logging.
                await Promise.all(targets.map(s => writeClientOptInEvent({
                    staffId: s.id ?? null,
                    staffName: s.name,
                    phoneE164: s.phoneE164 || null,
                    action: value ? 'opt_in' : 'opt_out',
                    source: 'admin_panel',
                    byName: staffName || 'admin',
                    byId: null,
                    note: `bulk: ${targets.length} staff`,
                })));
                showSaved();
            };

            // Update a single staff's phoneE164. Validates + normalizes.
            // Returns the new value (or null on invalid). When the new
            // number differs from the prior one and the staff is currently
            // opted in, we re-stamp smsOptInAt with the new phone — the
            // consent attaches to the number, so a number change should
            // be visible in the audit trail.
            const setPhoneForStaff = async (staff, rawInput) => {
                if (!staff || !staff.name) return null;
                const normalized = rawInput ? normalizeToE164(rawInput) : '';
                if (rawInput && !normalized) {
                    toast(language === 'es'
                        ? 'Número inválido. Usa 10 dígitos o formato +1...'
                        : 'Invalid number. Use 10 digits or +1... format',
                        { kind: 'error' });
                    return null;
                }
                if (staff.phoneE164 === normalized) return normalized;
                let latest = null;
                setStaffList(prev => {
                    latest = prev.map(s => s.name === staff.name
                        ? { ...s, phoneE164: normalized || null }
                        : s);
                    return latest;
                });
                if (latest) await saveStaffToFirestore(latest);
                // Number-change audit. We log this as a 'phone_change'
                // event with the same shape as opt-in events — it's
                // information the compliance reviewer needs in case the
                // current opt-in row references the OLD number.
                if (staff.smsOptIn === true) {
                    await writeClientOptInEvent({
                        staffId: staff.id ?? null,
                        staffName: staff.name,
                        phoneE164: normalized || null,
                        action: 'opt_in',                       // still opted in, but on a new number
                        source: 'admin_panel',
                        byName: staffName || 'admin',
                        byId: null,
                        note: `phone updated from ${staff.phoneE164 || '(none)'} to ${normalized || '(none)'}`,
                    });
                }
                showSaved();
                return normalized;
            };

            // exportSmsOptInLog — pulls every row from /sms_opt_in_events
            // (timestamps + staff + phone + action + source + verbatim
            // consent text snapshot + version), formats as CSV, triggers
            // a download. This is the compliance evidence file —
            // carriers/attorneys asking for proof of consent get this CSV.
            //
            // We DON'T paginate or summarize — the full event history is
            // the point. Restaurant-scale rows are in the hundreds, not
            // millions; a single page download is fine.
            const exportSmsOptInLog = async () => {
                try {
                    const snap = await getDocs(query(
                        collection(db, 'sms_opt_in_events'),
                        orderBy('at', 'desc'),
                    ));
                    if (snap.empty) {
                        toast(language === 'es' ? 'No hay eventos de SMS aún' : 'No SMS opt-in events yet');
                        return;
                    }
                    const rows = [];
                    // Header row. Keep column names stable — downstream
                    // tools (Excel, Google Sheets, legal review) expect
                    // these names.
                    rows.push([
                        'at',
                        'staffId',
                        'staffName',
                        'phoneE164',
                        'action',
                        'source',
                        'byName',
                        'byId',
                        'consentTextVersion',
                        'consentTextEn',
                        'consentTextEs',
                        'ipAddress',
                        'userAgent',
                        'twilioMessageSid',
                        'note',
                    ]);
                    for (const d of snap.docs) {
                        const r = d.data() || {};
                        const at = r.at && r.at.toDate ? r.at.toDate().toISOString() : (r.at || '');
                        rows.push([
                            at,
                            r.staffId ?? '',
                            r.staffName || '',
                            r.phoneE164 || '',
                            r.action || '',
                            r.source || '',
                            r.byName || '',
                            r.byId ?? '',
                            r.consentTextVersion || '',
                            r.consentTextEn || '',
                            r.consentTextEs || '',
                            r.ipAddress || '',
                            r.userAgent || '',
                            r.twilioMessageSid || '',
                            r.note || '',
                        ]);
                    }
                    // CSV escape: wrap any cell containing comma, quote,
                    // or newline in double quotes; double up inner quotes.
                    const csvEscape = (val) => {
                        const s = String(val == null ? '' : val);
                        if (/[",\r\n]/.test(s)) {
                            return '"' + s.replace(/"/g, '""') + '"';
                        }
                        return s;
                    };
                    const csv = rows.map(row => row.map(csvEscape).join(',')).join('\n');
                    // Trigger download via blob URL — works on all
                    // mobile browsers, no extra deps.
                    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                    const today = new Date().toISOString().slice(0, 10);
                    await downloadFile({ data: blob, fileName: `dd-mau-sms-optin-log-${today}.csv`, mimeType: 'text/csv' });
                    toast(language === 'es'
                        ? `✓ Exportado: ${snap.docs.length} eventos`
                        : `✓ Exported ${snap.docs.length} events`);
                } catch (e) {
                    console.error('exportSmsOptInLog failed:', e);
                    toast(language === 'es' ? 'Error al exportar' : 'Export failed', { kind: 'error' });
                }
            };

            const bulkSetField = async (ids, field, value) => {
                if (!ids || ids.length === 0) return;
                const idSet = new Set(ids);
                let touched = 0;
                let latest = null;
                setStaffList(prev => {
                    latest = prev.map(s => {
                        if (!idSet.has(s.id)) return s;
                        if (s[field] === value) return s; // skip no-ops
                        touched += 1;
                        return { ...s, [field]: value };
                    });
                    return latest;
                });
                if (touched > 0 && latest) {
                    await saveStaffToFirestore(latest);
                    showSaved();
                }
            };

            // Sweep a filtered subset to one side. Used by the "Tag all
            // visible as FOH/BOH" action — one batched write instead of
            // dozens of taps.
            const bulkSetSide = async (ids, side) => {
                if (ids.length === 0) return;
                const idSet = new Set(ids);
                let latest = null;
                setStaffList(prev => {
                    latest = prev.map(s => idSet.has(s.id) ? { ...s, scheduleSide: side } : s);
                    return latest;
                });
                if (latest) await saveStaffToFirestore(latest);
                showSaved();
            };
            const [availabilityForId, setAvailabilityForId] = useState(null); // staff id whose availability we're editing
            const [showAdd, setShowAdd] = useState(false);
            const [newName, setNewName] = useState("");
            const [newRole, setNewRole] = useState("FOH");
            const [newPin, setNewPin] = useState("");
            const [newLocation, setNewLocation] = useState(storeLocation || "webster");
            const [newOpsAccess, setNewOpsAccess] = useState(false);
            // Recipes is opt-OUT — every new hire gets access by default.
            // Manager can flip the toggle off if they don't want a specific
            // person to see recipes (rare). Operations stays opt-in (default
            // false) because access is genuinely restricted there.
            const [newRecipesAccess, setNewRecipesAccess] = useState(true);
            const [newShiftLead, setNewShiftLead] = useState(false);
            const [newIsMinor, setNewIsMinor] = useState(false);
            const [newScheduleSide, setNewScheduleSide] = useState("foh");
            const [editLocation, setEditLocation] = useState("");
            // scheduleHome — only meaningful when editLocation === 'both'.
            // For single-location staff the schedule grid follows their
            // location directly (see getScheduleHome in data/staff.js).
            // For 'both' staff this picks WHICH store's grid they live on
            // by default; they remain eligible to fill in at the other.
            const [editScheduleHome, setEditScheduleHome] = useState("both");
            const [savedMsg, setSavedMsg] = useState(null);
            const [confirmRemoveId, setConfirmRemoveId] = useState(null);
            const [staffExpanded, setStaffExpanded] = useState(false);
            // Ref to the staff list section so the top-of-page search bar
            // can scroll it into view + auto-expand when the admin types.
            const staffSectionRef = useRef(null);
            const [maintenanceRequests, setMaintenanceRequests] = useState([]);
            const [maintenanceExpanded, setMaintenanceExpanded] = useState(true);
            const [selectedRequest, setSelectedRequest] = useState(null);
            const [adminNote, setAdminNote] = useState("");
            const [maintFilter, setMaintFilter] = useState("all");

            const showSaved = () => { setSavedMsg(true); setTimeout(() => setSavedMsg(null), 1500); };

            // Filter maintenance requests by selected filter (all / webster / maryland)
            const filteredMaintenance = maintFilter === "all" ? maintenanceRequests : maintenanceRequests.filter(r => !r.storeBranch || r.storeBranch === maintFilter);

            // Filter staff by active location
            const [staffFilter, setStaffFilter] = useState("all");
            // Side filter inside a location tab. Only meaningful when a
            // specific location is selected (Webster or Maryland) — when "All
            // Locations" is showing, the side filter is hidden but kept in
            // state so toggling locations preserves the user's choice.
            const [staffSideFilter, setStaffSideFilter] = useState("all"); // 'all' | 'foh' | 'boh'
            // 2026-05-20 — Andrew: "lets add a search bar in the staff
            // page". Free-text filter that runs across name / role /
            // email / phone, accent-insensitive. Composes WITH the
            // location + side filters above (intersection).
            const [staffSearch, setStaffSearch] = useState("");
            // Resolve a person's effective side: explicit scheduleSide if set,
            // else infer from BOH-tagged role list. Same logic the schedule
            // uses, kept consistent so the count chips match.
            const personSide = (s) => s.scheduleSide || (BULK_BOH_ROLES.includes(s.role) ? 'boh' : 'foh');
            // Tiny inline normalize — drops diacritics + lowercases. Mirrors
            // chatSearch.normalize() but kept inline so we don't drag the
            // module in. Stable across staff names like "José" / "Jose".
            const normalizeStr = (s) => String(s || '')
                .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
            const filteredStaff = (() => {
                let out = staffList;
                if (staffFilter !== "all") out = out.filter(s => s.location === staffFilter || s.location === "both");
                if (staffSideFilter !== "all" && staffFilter !== "all") {
                    out = out.filter(s => personSide(s) === staffSideFilter);
                }
                const q = normalizeStr(staffSearch).trim();
                if (q) {
                    const tokens = q.split(/\s+/).filter(Boolean);
                    out = out.filter(s => {
                        const hay = normalizeStr([
                            s.name, s.role, s.email, s.phone, s.phoneE164,
                            s.location, s.scheduleSide,
                        ].filter(Boolean).join(' '));
                        return tokens.every(t => hay.includes(t));
                    });
                }
                return out;
            })();

            // Load maintenance requests
            useEffect(() => {
                const unsub = onSnapshot(query(collection(db, "maintenanceRequests"), orderBy("createdAt", "desc"), limit(50)), (snap) => {
                    const reqs = [];
                    snap.forEach(docSnapshot => reqs.push({ id: docSnapshot.id, ...docSnapshot.data() }));
                    setMaintenanceRequests(reqs);
                }, (err) => { console.error("Error loading maintenance requests:", err); });
                return () => unsub();
            }, []);

            // Recipe view audit — last 200. Sorted client-side because
            // serverTimestamp() can be momentarily null on the writer's
            // own snapshot before round-trip; we sort by it once it lands.
            // FIX (review 2026-05-14, perf): only subscribe when admin
            // expands the audit panel. The 200-doc query was always-on
            // before — a meaningful Firestore read every time the
            // AdminPanel mounted, even though most admin sessions never
            // look at the audit.
            useEffect(() => {
                if (!recipeAuditExpanded) return;
                const unsub = onSnapshot(
                    query(collection(db, "recipe_views"), orderBy("viewedAt", "desc"), limit(200)),
                    (snap) => {
                        const arr = [];
                        snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
                        setRecipeViews(arr);
                    },
                    (err) => { console.warn("Error loading recipe views:", err); }
                );
                return () => unsub();
            }, [recipeAuditExpanded]);

            // Order log subscription — on-demand. /order_logs is flat
            // (not per-location-suffixed); we filter by storeLocation
            // client-side. When admin is on 'both', we show everything;
            // when pinned to webster or maryland, only that location's
            // orders.
            useEffect(() => {
                if (!orderLogExpanded) return;
                const q = query(
                    collection(db, 'order_logs'),
                    orderBy('submittedAt', 'desc'),
                    limit(200),
                );
                return onSnapshot(q, (snap) => {
                    const arr = [];
                    snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
                    setOrderLogs(arr);
                }, (err) => { console.warn('order_logs subscribe failed:', err); });
            }, [orderLogExpanded]);

            // Inventory audit subscription — only fires when the panel
            // is expanded. Pulls the most recent 500 rows for the
            // currently-selected location. When storeLocation === 'both'
            // we query BOTH suffixed collections and merge — admin on
            // 'both' wants to see activity across the company.
            useEffect(() => {
                if (!inventoryAuditExpanded) return;
                const locs = storeLocation === 'both'
                    ? ['webster', 'maryland']
                    : [storeLocation || 'webster'];
                const buffers = new Map();  // loc → array
                const unsubs = locs.map(loc => onSnapshot(
                    query(collection(db, `inventory_audits_${loc}`), orderBy('at', 'desc'), limit(500)),
                    (snap) => {
                        const arr = [];
                        snap.forEach(d => arr.push({ id: d.id, _loc: loc, ...d.data() }));
                        buffers.set(loc, arr);
                        // Merge + sort across all watched locations.
                        const merged = [];
                        for (const a of buffers.values()) merged.push(...a);
                        merged.sort((a, b) => {
                            const at = a.at?.toMillis?.() ?? 0;
                            const bt = b.at?.toMillis?.() ?? 0;
                            return bt - at;
                        });
                        setInventoryAudits(merged);
                    },
                    (err) => { console.warn(`Error loading inventory_audits_${loc}:`, err); },
                ));
                return () => unsubs.forEach(u => u && u());
            }, [inventoryAuditExpanded, storeLocation]);

            const updateRequestStatus = async (reqId, newStatus) => {
                try {
                    const updates = { status: newStatus, updatedAt: new Date().toISOString() };
                    if (adminNote.trim()) updates.adminNote = adminNote.trim();
                    await updateDoc(doc(db, "maintenanceRequests", reqId), updates);
                    setAdminNote("");
                    showSaved();
                } catch (err) { console.error("Error updating request:", err); }
            };

            const addAdminNoteToRequest = async (reqId) => {
                if (!adminNote.trim()) return;
                try {
                    await updateDoc(doc(db, "maintenanceRequests", reqId), {
                        adminNote: adminNote.trim(), updatedAt: new Date().toISOString()
                    });
                    setAdminNote("");
                    showSaved();
                } catch (err) { console.error("Error adding note:", err); }
            };

            // Delete a single maintenance request. Hard delete — no archive.
            // Confirm prompt because this is permanent.
            const deleteMaintenanceRequest = async (reqId) => {
                if (!confirm(language === "es"
                    ? "¿Eliminar esta solicitud permanentemente?"
                    : "Delete this request permanently?")) return;
                try {
                    await deleteDoc(doc(db, "maintenanceRequests", reqId));
                    showSaved();
                } catch (err) {
                    console.error("Error deleting request:", err);
                    toast((language === "es" ? "Error al eliminar: " : "Delete failed: ") + (err.message || err));
                }
            };

            // Bulk-clear: delete every "completed" or "declined" request
            // (optionally restricted to the active maintenance filter). Two-step
            // confirm — staff lose audit trail. Uses a Firestore batch (max 500
            // ops) so cleanup is atomic.
            const clearOldMaintenanceRequests = async () => {
                const targets = filteredMaintenance.filter(r => r.status === "completed" || r.status === "declined");
                if (targets.length === 0) {
                    toast(language === "es"
                        ? "No hay solicitudes completadas o rechazadas para eliminar."
                        : "No completed/declined requests to delete.");
                    return;
                }
                const msg = language === "es"
                    ? `Eliminar permanentemente ${targets.length} solicitud(es) completadas/rechazadas? No se puede deshacer.`
                    : `Permanently delete ${targets.length} completed/declined request(s)? Cannot be undone.`;
                if (!confirm(msg)) return;
                try {
                    // Chunk into batches of 450 to stay safely under Firestore's 500-op cap.
                    for (let i = 0; i < targets.length; i += 450) {
                        const chunk = targets.slice(i, i + 450);
                        const batch = writeBatch(db);
                        chunk.forEach(r => batch.delete(doc(db, "maintenanceRequests", r.id)));
                        await batch.commit();
                    }
                    toast((language === "es" ? "Eliminadas: " : "Deleted: ") + targets.length);
                    showSaved();
                } catch (err) {
                    console.error("Error clearing requests:", err);
                    toast((language === "es" ? "Error: " : "Error: ") + (err.message || err));
                }
            };

            // Refuse-to-write-empty-pin guard + PIN audit log.
            // After the 2026-05-09 PIN-corruption incident (the legacy migration
            // block was silently re-writing PINs to placeholder defaults), every
            // staff write goes through this helper. Two protections:
            //
            // 1. PIN INTEGRITY GATE: any record whose pin would land as empty,
            //    null, or non-4-digit is REJECTED — the entire save is aborted
            //    and the admin sees a toast. This kills the class of bug where
            //    a stale React state writes pin: "" or pin: undefined.
            //
            // 2. AUDIT LOG: we read the current Firestore record, diff against
            //    the new list, and write a doc to /pin_audits for every PIN
            //    that actually changed. Each entry: {id, name, oldPin, newPin,
            //    changedBy, changedAt}. So if a PIN ever changes again, we
            //    have a full forensic trail naming the actor.
            const saveStaffToFirestore = async (updatedList) => {
                // GATE: bail if any PIN is missing/blank/wrong-length.
                const bad = updatedList.find(s => {
                    const p = String(s.pin ?? '').trim();
                    return !p || !/^\d{4}$/.test(p);
                });
                if (bad) {
                    // Do NOT log bad.pin — even console.error breadcrumbs can
                    // leak into Sentry / aiDebugReport exports. Name alone is
                    // enough to triage. Cap-readiness audit 2026-05-31.
                    console.error('Refusing staff save — invalid PIN on:', bad.name);
                    toast(language === 'es'
                        ? `Guardado bloqueado: PIN inválido en ${bad.name}. No se hicieron cambios.`
                        : `Save blocked: invalid PIN on ${bad.name}. No changes made.`,
                        { kind: 'error', duration: 8000 });
                    return false;
                }
                // AUDIT: read current Firestore + compute diff before write.
                let oldByName = new Map();
                let preReadSize = -1;
                try {
                    const cur = await getDoc(doc(db, 'config', 'staff'));
                    if (cur.exists()) {
                        const list = (cur.data() || {}).list || [];
                        preReadSize = list.length;
                        for (const s of list) oldByName.set(`${s.id}|${s.name}`, s.pin);
                    }
                } catch (e) {
                    console.warn('audit: pre-read failed (proceeding anyway):', e);
                }
                // HF-7, 2026-05-30: concurrent-edit guard. Two admins
                // editing the staff list at the same time used to silently
                // clobber each other — last writer wins, the loser's
                // changes vanish. Wrap the write in a transaction that
                // re-reads inside the txn and aborts if the list SIZE
                // changed since our pre-read (another admin added or
                // removed a record). Doesn't catch same-size concurrent
                // in-place edits, but catches the most common Andrew+Julie
                // race. Anything tighter requires schema work (versioned
                // staff doc).
                try {
                    const { runTransaction } = await import('firebase/firestore');
                    await runTransaction(db, async (tx) => {
                        const snap = await tx.get(doc(db, "config", "staff"));
                        if (snap.exists() && preReadSize >= 0) {
                            const currentSize = ((snap.data() || {}).list || []).length;
                            if (currentSize !== preReadSize) {
                                const err = new Error('CONCURRENT_STAFF_EDIT');
                                err.code = 'CONCURRENT_STAFF_EDIT';
                                throw err;
                            }
                        }
                        tx.set(doc(db, "config", "staff"), { list: updatedList });
                    });
                } catch (err) {
                    if (err && err.code === 'CONCURRENT_STAFF_EDIT') {
                        console.warn('saveStaff: concurrent edit detected, asking user to reload');
                        toast(language === 'es'
                            ? 'Otro administrador editó al personal — recargue la página'
                            : 'Another admin edited the staff list — please reload',
                            { kind: 'error' });
                        return false;
                    }
                    console.error("Error saving staff:", err);
                    toast(language === 'es' ? 'Error al guardar personal' : 'Staff save failed', { kind: 'error' });
                    return false;
                }
                // Post-write: log every PIN change to /pin_audits.
                // Fire-and-forget so a logging failure never blocks the save.
                for (const s of updatedList) {
                    const key = `${s.id}|${s.name}`;
                    const oldPin = oldByName.get(key);
                    if (oldPin != null && oldPin !== s.pin) {
                        // 2026-06-20 (QA audit AD1) — log only THAT a PIN changed,
                        // never the PIN values. pin_audits is world-readable
                        // (rule: allow read: if true) and the 4-digit PIN is the
                        // entire auth mechanism, so persisting old/new PINs here
                        // was a credential-history leak — and it contradicted this
                        // function's own "never log a PIN" policy above. Who/when
                        // is enough to triage a change.
                        addDoc(collection(db, 'pin_audits'), {
                            staffId: s.id,
                            staffName: s.name,
                            changedBy: staffName,
                            changedAt: serverTimestamp(),
                            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
                        }).catch(e => console.warn('pin audit write failed:', e));
                    }
                }
                return true;
            };

            // Tap-to-flip bulk tag handler — used by the Bulk Tag modal.
            // BUG FIX: rapid taps were clobbering each other because the closed-over
            // `staffList` could be stale between renders. Use the functional setter
            // form so we always merge into the latest list, then persist outside the
            // setter (idempotent — last save wins, matches the displayed state).
            const handleBulkUpdate = async (id, patch) => {
                let latest = null;
                setStaffList(prev => {
                    latest = prev.map(s => s.id === id ? { ...s, ...patch } : s);
                    return latest;
                });
                if (latest) await saveStaffToFirestore(latest);
            };

            // Reset every edit-form field back to idle. Centralized so the
            // Save / Cancel / rename-confirm paths can't drift apart (the old
            // hand-rolled resets had already diverged — some fields were reset
            // on Cancel but not on Save).
            const resetEditForm = () => {
                setEditingId(null);
                setEditPin("");
                setEditRole("");
                setEditName("");
                setEditLocation("");
                setEditScheduleHome("both");
                setEditOpsAccess(false);
                setEditRecipesAccess(false);
                setEditViewLabor(false);
                setEditCanCountMoney(false);
                setEditShiftLead(false);
                setEditIsMinor(false);
                setEditHideFromSchedule(false);
                setEditScheduleSide("foh");
                setEditTargetHours(0);
                setEditBirthday("");
                setEditCanEditScheduleFOH(false);
                setEditCanEditScheduleBOH(false);
                setEditPreferredLanguage("en");
                setEditHomeView("auto");
                setEditHiddenPages([]);
            };

            // Persist the open edit form for staff `id`, writing `finalName`
            // as the (possibly unchanged) name. When the name actually
            // changed, `rename` carries the OLD name so we fan the change out
            // across every name-joined collection — but only AFTER the staff
            // record itself saves, so we never rewrite the schedule to a name
            // the record never took.
            const commitStaffEdit = async (id, finalName, rename = null) => {
                // Functional setState avoids stale-closure clobber when a
                // concurrent admin edit is in flight (same fix as bulk-tag).
                let latest = null;
                setStaffList(prev => {
                    // 2026-05-24 audit fix: the finalLocation/finalBirthday
                    // computation used to live OUT here referencing a bare
                    // `s` that didn't exist in this scope — a guaranteed
                    // ReferenceError if editLocation was ever empty (or
                    // editBirthday was non-empty but malformed). Moving the
                    // computation INSIDE the map() callback so `s` is the
                    // matched record and the fallback works as intended.
                    latest = prev.map(s => {
                        if (s.id !== id) return s;
                        const finalLocation = editLocation || s.location || "webster";
                        const finalScheduleHome = finalLocation === 'both'
                            ? (editScheduleHome || 'both')
                            : finalLocation;
                        const finalBirthday = /^\d{2}-\d{2}$/.test(editBirthday)
                            ? editBirthday
                            : (editBirthday === '' ? '' : (s.birthday || ''));
                        return { ...s, name: finalName, pin: editPin, role: editRole, location: finalLocation, scheduleHome: finalScheduleHome, opsAccess: editOpsAccess, recipesAccess: editRecipesAccess, viewLabor: editViewLabor, canCountMoney: editCanCountMoney, shiftLead: editShiftLead, isMinor: editIsMinor, hideFromSchedule: editHideFromSchedule, scheduleSide: editScheduleSide, targetHours: Number(editTargetHours) || 0, birthday: finalBirthday, canEditScheduleFOH: editCanEditScheduleFOH, canEditScheduleBOH: editCanEditScheduleBOH, preferredLanguage: editPreferredLanguage, homeView: editHomeView, hiddenPages: editHiddenPages };
                    });
                    return latest;
                });
                const saved = latest ? await saveStaffToFirestore(latest) : false;
                // saveStaffToFirestore returns false (and already toasted) on
                // a bad PIN / concurrent-edit / write error. Bail before
                // fanning out a rename in that case.
                if (saved === false) return;

                resetEditForm();
                showSaved();

                if (rename && rename.oldName && rename.oldName !== finalName) {
                    setRenameBusy(true);
                    try {
                        const report = await renameStaffEverywhere({
                            oldName: rename.oldName,
                            newName: finalName,
                            staffId: id,
                        });
                        // If the signed-in admin renamed THEMSELVES, push the
                        // new name up so App's session validation doesn't kick
                        // them to the lock screen on the next render.
                        if (rename.oldName === staffName && typeof onSelfRenamed === 'function') {
                            onSelfRenamed(finalName);
                        }
                        if (report.ok) {
                            toast(language === 'es'
                                ? `Renombrado a ${finalName} — ${report.total} registro(s) actualizado(s).`
                                : `Renamed to ${finalName} — updated ${report.total} linked record(s).`,
                                { kind: 'success', duration: 6000 });
                        } else {
                            const failed = report.errors.map(e => e.collection).join(', ');
                            const detail = report.errors[0]?.message ? ` — ${report.errors[0].message}` : '';
                            toast(language === 'es'
                                ? `Renombrado, pero algunos registros fallaron (${failed})${detail}. Reintente.`
                                : `Renamed, but some records didn't update (${failed})${detail}. Try again.`,
                                { kind: 'error', duration: 12000 });
                        }
                    } catch (err) {
                        console.error('renameStaffEverywhere threw:', err);
                        const msg = err?.message || String(err);
                        toast(language === 'es'
                            ? `El nombre se guardó pero la actualización de registros falló: ${msg}`
                            : `Name saved but updating linked records failed: ${msg}`,
                            { kind: 'error', duration: 12000 });
                    } finally {
                        setRenameBusy(false);
                    }
                }
            };

            const handleSavePin = async (id) => {
                if (editPin.length !== 4 || !/^\d{4}$/.test(editPin)) return;
                const person = (staffList || []).find(s => s.id === id);
                const currentName = person ? person.name : '';
                const trimmed = editName.trim();
                // Name is required and must stay unique — two staffers sharing
                // a name would collapse into one identity (PIN login, chat,
                // schedule all key on the string).
                if (!trimmed) {
                    toast(language === 'es' ? 'El nombre no puede estar vacío.' : 'Name cannot be empty.', { kind: 'error' });
                    return;
                }
                const nameChanged = trimmed !== currentName;
                if (nameChanged) {
                    const dup = (staffList || []).some(s => s.id !== id && (s.name || '').trim().toLowerCase() === trimmed.toLowerCase());
                    if (dup) {
                        toast(language === 'es' ? 'Ya existe un miembro con ese nombre.' : 'A staff member with that name already exists.', { kind: 'error' });
                        return;
                    }
                    // Defer to the confirm modal so the admin sees the blast
                    // radius before linked records get rewritten. The edit
                    // form stays open + populated underneath.
                    setPendingRename({ id, oldName: currentName, newName: trimmed });
                    return;
                }
                await commitStaffEdit(id, currentName);
            };

            // Confirm-modal "Yes, rename" handler.
            const confirmRename = async () => {
                const pending = pendingRename;
                if (!pending) return;
                setPendingRename(null);
                await commitStaffEdit(pending.id, pending.newName, { oldName: pending.oldName });
            };

            const handleAddStaff = async () => {
                if (!newName.trim() || newPin.length !== 4 || !/^\d{4}$/.test(newPin)) return;
                // 2026-06-16 (#5): block duplicate names on ADD (the edit path
                // already guards this). NAME is the app-wide join key, so two
                // records sharing a name silently resolve to whichever is first
                // in the list — wrong access flags, wrong shifts, and a later
                // rename rewrites data for both. Mirror the edit-path check.
                const dupName = (staffList || []).some(s => (s.name || '').trim().toLowerCase() === newName.trim().toLowerCase());
                if (dupName) {
                    toast(language === 'es' ? 'Ya existe un miembro con ese nombre.' : 'A staff member with that name already exists.', { kind: 'error' });
                    return;
                }
                // Functional setState — read latest list from React state
                // instead of closing over a stale snapshot. Otherwise two
                // admins adding back-to-back can silently lose one entry
                // (and the new id is computed off the stale max).
                let latest = null;
                setStaffList(prev => {
                    const maxId = Math.max(...prev.map(s => s.id), 0);
                    // Auto-apply the position template for this role so new
                    // hires land with reasonable access defaults (homeView,
                    // hiddenPages, viewLabor, scheduler flags). The visible
                    // form toggles below intentionally take precedence so an
                    // admin who flipped, say, opsAccess OFF gets that intent.
                    const template = getPositionTemplate(newRole) || {};
                    const newStaff = {
                        id: maxId + 1,
                        ...template,
                        name: newName.trim(),
                        role: newRole,
                        pin: newPin,
                        location: newLocation,
                        opsAccess: newOpsAccess,
                        recipesAccess: newRecipesAccess,
                        shiftLead: newShiftLead,
                        isMinor: newIsMinor,
                        scheduleSide: newScheduleSide,
                    };
                    latest = [...prev, newStaff];
                    return latest;
                });
                if (latest) await saveStaffToFirestore(latest);
                setShowAdd(false);
                setNewName("");
                setNewRole("FOH");
                setNewPin("");
                setNewLocation(storeLocation || "webster");
                setNewOpsAccess(false);
                setNewRecipesAccess(true);
                setNewShiftLead(false);
                setNewIsMinor(false);
                setNewScheduleSide("foh");
                showSaved();
            };

            const handleRemoveStaff = async (id) => {
                // Block removal by ADMIN_ID (not name) so renaming an admin
                // doesn't bypass this guard.
                if (ADMIN_IDS.includes(id)) return;
                // Capture the name BEFORE we drop them from the list — needed
                // to clean up future-dated shifts so the schedule stops
                // showing them as a ghost row (bug 2026-05-09).
                const removedPerson = (staffList || []).find(s => s.id === id);
                const removedName = removedPerson?.name;
                // Functional setState avoids stale-closure clobber.
                let latest = null;
                setStaffList(prev => {
                    latest = prev.filter(s => s.id !== id);
                    return latest;
                });
                if (latest) await saveStaffToFirestore(latest);
                // Put the removed staffer's FUTURE shifts UP FOR GRABS (open
                // offer) instead of deleting them — coverage isn't silently
                // lost, and another staffer can claim them (a manager approves
                // the claim, which reassigns the shift). Past shifts are kept
                // (hours history / audit). Skip any shift with a claim already
                // in flight (offerStatus 'pending') so we don't stomp it.
                // Andrew 2026-06-23.
                if (removedName) {
                    try {
                        const today = new Date();
                        const todayKey = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
                        const futureShifts = await getDocs(query(
                            collection(db, 'shifts'),
                            where('staffName', '==', removedName),
                            where('date', '>=', todayKey)
                        ));
                        if (!futureShifts.empty) {
                            const batch = writeBatch(db);
                            futureShifts.forEach(d => {
                                if ((d.data() || {}).offerStatus === 'pending') return; // claim mid-flight — leave it
                                batch.update(d.ref, {
                                    offerStatus: 'open',
                                    offeredBy: removedName,
                                    offeredAt: serverTimestamp(),
                                    offerNote: 'Staff removed — shift open for pickup',
                                    offerUrgent: false,
                                    coverNeeded: false,
                                    coverNeededAt: null,
                                    pendingClaimBy: null,
                                    claimedAt: null,
                                    updatedAt: serverTimestamp(),
                                });
                            });
                            await batch.commit();
                        }
                    } catch (e) {
                        console.warn('cascade shift offer failed:', e);
                    }
                    // 2026-06-16 (#24): strip the removed name from chat
                    // membership/admins so a future same-name hire can't inherit
                    // their chat + DM access. Message history is left intact.
                    try { await removeStaffFromChats(removedName); }
                    catch (e) { console.warn('chat membership cleanup failed:', e); }
                }
                setConfirmRemoveId(null);
                showSaved();
            };

            const roleOptions = ["FOH", "BOH", "Shift Lead", "Kitchen Manager", "Asst Kitchen Manager", "Manager", "Owner", "Prep", "Grill", "Fryer", "Fried Rice", "Dish", "Bao/Tacos/Banh Mi", "Spring Rolls/Prep", "Pho Station"];

            return (
                <div className="p-4 pb-bottom-nav">
                    <h2 className="text-2xl font-bold text-mint-700 mb-2">⚙️ {t("adminPanel", language)}</h2>
                    <p className="text-xs text-gray-500 mb-3 bg-mint-50 border border-mint-200 rounded-lg p-2">
                        🔐 {language === "es"
                            ? "Solo Andrew Shih y Julie Shih pueden acceder a este panel."
                            : "Only Andrew Shih and Julie Shih can access this panel."}
                    </p>

                    {/* 2026-05-20 — Andrew: "put a search in the first
                        staff page too". Quick-find pinned at the very
                        top of the admin panel so typing a name jumps
                        straight to the staff list (auto-expanded +
                        scrolled into view), without having to scroll
                        past Onboarding / Maintenance / Todos first.
                        Same state as the inner staff-list search; typing
                        in either keeps both in sync. */}
                    <div className="relative mb-4">
                        <input
                            type="search"
                            inputMode="search"
                            enterKeyHint="search"
                            value={staffSearch}
                            onChange={(e) => {
                                setStaffSearch(e.target.value);
                                if (e.target.value.trim()) {
                                    // Open the staff list so results show
                                    // immediately, and bring it onscreen.
                                    setStaffExpanded(true);
                                    requestAnimationFrame(() => {
                                        try {
                                            staffSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                        } catch {}
                                    });
                                }
                            }}
                            placeholder={language === "es"
                                ? "🔍 Buscar personal (nombre, puesto, email, teléfono)…"
                                : "🔍 Find staff (name, role, email, phone)…"}
                            className="w-full pl-3 pr-10 py-3 border-2 border-blue-300 rounded-xl text-sm font-bold bg-white focus:outline-none focus:border-blue-500 placeholder:font-normal placeholder:text-blue-400 shadow-sm"
                        />
                        {staffSearch && (
                            <button onClick={() => setStaffSearch("")}
                                className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-blue-100 text-blue-700 text-sm font-bold flex items-center justify-center hover:bg-blue-200">
                                ✕
                            </button>
                        )}
                        {staffSearch.trim() && (
                            <p className="mt-1.5 text-[11px] text-blue-700 font-bold pl-1">
                                {filteredStaff.length}{' '}
                                {language === "es"
                                    ? `coincidencia${filteredStaff.length === 1 ? '' : 's'}`
                                    : `match${filteredStaff.length === 1 ? '' : 'es'}`}
                                {' '}
                                {language === "es" ? '— ver abajo ↓' : '— see below ↓'}
                            </p>
                        )}
                    </div>

                    {savedMsg && (
                        <div className="mb-3 p-2 bg-green-100 border border-green-300 rounded-lg text-center text-green-700 font-bold text-sm">
                            ✅ {t("saved", language)}
                        </div>
                    )}

                    {/* ── STAFF USAGE AUDIT ──
                        Read-only rollup: which staff have notifications
                        enabled, have installed the PWA, and when they
                        were last seen. Helps admins confirm "everyone is
                        actually receiving my chat messages." All signals
                        come from existing /config/staff fields
                        (fcmTokens, pwaInstalled, fcmTokens[].lastSeen)
                        — no new Firestore writes were added to surface
                        this audit. Collapsed by default. */}
                    <StaffUsageAudit
                        staffList={staffList}
                        language={language}
                        currentManagerName={staffName}
                        currentManagerId={(staffList || []).find(s => s.name === staffName)?.id ?? null}
                        onSetPhone={setPhoneForStaff}
                    />

                    {/* ── SCHEDULE AUDIT LOG ── Andrew 2026-06-25: "every shift
                        move, every time-off request, everything in the schedule
                        page so we can see what's happening." Reads the
                        append-only /audit collection (schedule features). */}
                    <div className="mt-4 p-4 rounded-2xl bg-white border border-dd-line shadow-card">
                        <ScheduleAuditLog language={language} />
                    </div>

                    {/* ── ATTENDANCE LOG ── Andrew 2026-06-25: who's clocked in —
                        on-time/late/no-show + shifts worked per staff (4 weeks),
                        click for a month/week drill-down. Reads /attendance. */}
                    <div className="mt-4 p-4 rounded-2xl bg-white border border-dd-line shadow-card">
                        <AttendanceLog language={language} staffList={staffList} />
                    </div>

                    {/* ── ONBOARDING LAUNCHER ──
                        Onboarding lives behind the admin page (not in the main
                        nav) because it handles PII and is owner-only. Tapping
                        the card switches the active tab to the full-screen
                        Onboarding view. Badge count surfaces new applications
                        + active hires so admins notice attention-worthy state. */}
                    {hasOnboardingAccess && onNavigate && (
                        <button
                            onClick={() => onNavigate('onboarding')}
                            className="w-full mb-4 flex items-center justify-between bg-gradient-to-r from-rose-50 to-amber-50 border-2 border-rose-200 rounded-xl p-4 hover:from-rose-100 hover:to-amber-100 active:scale-[0.99] transition shadow-sm group">
                            <div className="flex items-center gap-3 min-w-0">
                                <span className="text-3xl flex-shrink-0">🪪</span>
                                <div className="text-left min-w-0">
                                    <h3 className="font-black text-rose-800 text-base flex items-center gap-2 flex-wrap">
                                        {language === "es" ? "Onboarding" : "Onboarding"}
                                        {onboardingPendingApps > 0 && (
                                            <span className="text-[10px] font-bold bg-amber-200 text-amber-900 border border-amber-300 px-1.5 py-0.5 rounded-full">
                                                {onboardingPendingApps} {language === "es" ? "nueva" : "new"}{onboardingPendingApps !== 1 ? 's' : ''}
                                            </span>
                                        )}
                                    </h3>
                                    <p className="text-[11px] text-rose-700/80 truncate">
                                        {language === "es"
                                            ? `${onboardingActiveHires} contrataciones activas · papeleo W-4/I-9/DL · PII solo dueños`
                                            : `${onboardingActiveHires} active hires · W-4/I-9/DL paperwork · owners-only PII`}
                                    </p>
                                </div>
                            </div>
                            <span className="text-rose-600 text-2xl flex-shrink-0 group-hover:translate-x-0.5 transition-transform">→</span>
                        </button>
                    )}

                    {/* ── MAINTENANCE REQUESTS ── */}
                    <div className="mb-6">
                        <button onClick={() => setMaintenanceExpanded(!maintenanceExpanded)}
                            className="w-full flex items-center justify-between bg-red-50 border-2 border-red-200 rounded-xl p-4 hover:bg-red-100 transition">
                            <div className="flex items-center gap-2">
                                <span className="text-2xl">🔧</span>
                                <div className="text-left">
                                    <h3 className="font-bold text-red-700">{language === "es" ? "Solicitudes de Mantenimiento" : "Maintenance Requests"}</h3>
                                    <p className="text-xs text-red-500">
                                        {filteredMaintenance.filter(r => r.status === "open").length} {language === "es" ? "abiertos" : "open"}
                                        {filteredMaintenance.filter(r => r.status === "in-progress").length > 0 && (
                                            ` • ${filteredMaintenance.filter(r => r.status === "in-progress").length} ${language === "es" ? "en progreso" : "in progress"}`
                                        )}
                                    </p>
                                </div>
                            </div>
                            <span className="text-gray-400 text-xl">{maintenanceExpanded ? "▼" : "▶"}</span>
                        </button>

                        {maintenanceExpanded && (
                            <div className="mt-2 space-y-2">
                                <div className="flex gap-1 justify-center flex-wrap">
                                    {[{k:"all",en:"All Locations",es:"Todas"},{k:"webster",en:"Webster",es:"Webster"},{k:"maryland",en:"MD Heights",es:"MD Heights"}].map(f => (
                                        <button key={f.k} onClick={() => setMaintFilter(f.k)}
                                            className={`px-3 py-1 rounded-full text-xs font-bold border transition ${maintFilter === f.k ? "bg-red-600 text-white border-red-600" : "bg-white text-red-600 border-red-300 hover:bg-red-50"}`}>
                                            {language === "es" ? f.es : f.en}
                                            {f.k !== "all" && <span className="ml-1 opacity-70">({maintenanceRequests.filter(r => r.storeBranch === f.k).length})</span>}
                                        </button>
                                    ))}
                                </div>
                                {/* Bulk-clear: deletes every completed/declined request in the
                                    current filter. Shown only when there's something to delete. */}
                                {filteredMaintenance.some(r => r.status === "completed" || r.status === "declined") && (
                                    <div className="flex justify-center">
                                        <button onClick={clearOldMaintenanceRequests}
                                            className="text-xs font-bold px-3 py-1 rounded-full border border-red-300 text-red-600 bg-white hover:bg-red-50">
                                            🗑️ {language === "es"
                                                ? `Limpiar completadas/rechazadas (${filteredMaintenance.filter(r => r.status === "completed" || r.status === "declined").length})`
                                                : `Clear completed/declined (${filteredMaintenance.filter(r => r.status === "completed" || r.status === "declined").length})`}
                                        </button>
                                    </div>
                                )}
                                {filteredMaintenance.length === 0 ? (
                                    <p className="text-center text-gray-400 text-sm py-4">{language === "es" ? "No hay solicitudes" : "No requests yet"}</p>
                                ) : <div className="md:grid md:grid-cols-2 md:gap-2 space-y-2 md:space-y-0">{filteredMaintenance.map(req => {
                                    const isExpanded = selectedRequest === req.id;
                                    const statusColors = { open: "bg-yellow-100 text-yellow-700 border-yellow-300", "in-progress": "bg-blue-100 text-blue-700 border-blue-300", completed: "bg-green-100 text-green-700 border-green-300", declined: "bg-red-100 text-red-700 border-red-300" };
                                    const urgencyDot = { low: "🟢", normal: "🟡", high: "🟠", urgent: "🔴" };
                                    return (
                                        <div key={req.id} className={`bg-white rounded-lg border-2 overflow-hidden ${req.status === "open" ? "border-yellow-200" : "border-gray-200"}`}>
                                            <button onClick={() => setSelectedRequest(isExpanded ? null : req.id)}
                                                className="w-full p-3 text-left">
                                                <div className="flex items-start justify-between">
                                                    <div className="flex-1">
                                                        <div className="flex items-center gap-1.5 mb-0.5">
                                                            <span className="text-sm">{urgencyDot[req.urgency] || "🟡"}</span>
                                                            <p className="text-sm font-bold text-gray-800">{req.description}</p>
                                                        </div>
                                                        <p className="text-xs text-gray-500">📍 {req.location} {req.storeBranch ? <span className={`inline-block ml-1 px-1.5 py-0.5 rounded text-xs font-bold ${req.storeBranch === "webster" ? "bg-emerald-100 text-emerald-700" : "bg-purple-100 text-purple-700"}`}>{LOCATION_LABELS[req.storeBranch] || req.storeBranch}</span> : null} • 👤 {req.submittedBy} • {new Date(req.createdAt).toLocaleDateString()}</p>
                                                    </div>
                                                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ml-2 whitespace-nowrap ${statusColors[req.status] || "bg-gray-100 text-gray-600 border-gray-300"}`}>
                                                        {req.status === "in-progress" ? (language === "es" ? "En Progreso" : "In Progress") : req.status === "open" ? (language === "es" ? "Abierto" : "Open") : req.status === "completed" ? (language === "es" ? "Completado" : "Done") : (language === "es" ? "Rechazado" : "Declined")}
                                                    </span>
                                                </div>
                                            </button>

                                            {isExpanded && (
                                                <div className="px-3 pb-3 border-t border-gray-100 pt-2 space-y-2">
                                                    {req.reason && <p className="text-xs text-gray-600"><span className="font-bold">{language === "es" ? "Razón:" : "Why:"}</span> {req.reason}</p>}
                                                    <p className="text-xs text-gray-500">{language === "es" ? "Enviado:" : "Submitted:"} {new Date(req.createdAt).toLocaleString()}</p>
                                                    {req.photoUrl && (
                                                        <img src={req.photoUrl} alt="Maintenance" loading="lazy" decoding="async" className="rounded-lg border border-gray-200 max-w-full cursor-pointer" style={{maxHeight: "200px"}}
                                                            onClick={() => openExternalUrl(req.photoUrl)} />
                                                    )}
                                                    {req.adminNote && <p className="text-xs bg-blue-50 border border-blue-200 rounded p-2 text-blue-700">💬 {req.adminNote}</p>}

                                                    {/* Admin note input */}
                                                    <div className="flex gap-1">
                                                        <input type="text" value={adminNote} onChange={e => setAdminNote(e.target.value)}
                                                            placeholder={language === "es" ? "Agregar nota..." : "Add note..."}
                                                            className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-xs" />
                                                        <button onClick={() => addAdminNoteToRequest(req.id)}
                                                            className="bg-blue-500 text-white text-xs font-bold px-2 py-1.5 rounded">💬</button>
                                                    </div>

                                                    {/* Status buttons */}
                                                    <div className="flex gap-1.5">
                                                        {req.status !== "in-progress" && (
                                                            <button onClick={() => updateRequestStatus(req.id, "in-progress")}
                                                                className="flex-1 py-1.5 bg-blue-500 text-white rounded text-xs font-bold">
                                                                {language === "es" ? "En Progreso" : "In Progress"}
                                                            </button>
                                                        )}
                                                        {req.status !== "completed" && (
                                                            <button onClick={() => updateRequestStatus(req.id, "completed")}
                                                                className="flex-1 py-1.5 bg-green-600 text-white rounded text-xs font-bold">
                                                                {language === "es" ? "Completado" : "Done"}
                                                            </button>
                                                        )}
                                                        {req.status !== "declined" && req.status !== "completed" && (
                                                            <button onClick={() => updateRequestStatus(req.id, "declined")}
                                                                className="flex-1 py-1.5 bg-red-500 text-white rounded text-xs font-bold">
                                                                {language === "es" ? "Rechazar" : "Decline"}
                                                            </button>
                                                        )}
                                                        {(req.status === "completed" || req.status === "declined") && (
                                                            <button onClick={() => updateRequestStatus(req.id, "open")}
                                                                className="flex-1 py-1.5 bg-yellow-500 text-white rounded text-xs font-bold">
                                                                {language === "es" ? "Reabrir" : "Reopen"}
                                                            </button>
                                                        )}
                                                    </div>
                                                    {/* Permanent delete — separate row so it's not adjacent to "Done"
                                                        (avoids accidental misclick). Confirms via deleteMaintenanceRequest. */}
                                                    <button onClick={() => deleteMaintenanceRequest(req.id)}
                                                        className="w-full py-1.5 bg-white border border-red-300 text-red-600 rounded text-xs font-bold hover:bg-red-50">
                                                        🗑️ {language === "es" ? "Eliminar permanentemente" : "Delete permanently"}
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}</div>}
                            </div>
                        )}
                    </div>

                    {/* ── OFF-SITE CLOCK-IN ──
                        Rare-occurrence labor tracking for staff working
                        away from a DD Mau store (catering, supply runs,
                        etc.). Admin schedules an assignment here; the
                        staff app prompts the staff member to clock in /
                        out on next login. See src/data/offsiteClock.js
                        for the state machine + schema. */}
                    <OffsiteClockSection
                        language={language}
                        staffName={staffName}
                        staffList={staffList}
                        viewer={(staffList || []).find(s => s.name === staffName)}
                    />

                    {/* ── STAFF TODOS ──
                        Admin section for managing the custom todos that
                        appear on every targeted staff member's Home page.
                        Auto-detected todos (missing birthday / availability)
                        are computed client-side from each staff record and
                        not managed here — they disappear when the field
                        is filled. */}
                    <StaffTodosAdmin
                        language={language}
                        staffName={staffName}
                        staffList={staffList}
                    />

                    {/* ── STAFF LIST (collapsible) ── */}
                    <div className="mb-6" ref={staffSectionRef}>
                        <button onClick={() => setStaffExpanded(!staffExpanded)}
                            className="w-full flex items-center justify-between bg-blue-50 border-2 border-blue-200 rounded-xl p-4 hover:bg-blue-100 transition">
                            <div className="flex items-center gap-2">
                                <span className="text-2xl">👥</span>
                                <div className="text-left">
                                    <h3 className="font-bold text-blue-700">{language === "es" ? "Personal" : "Staff"}</h3>
                                    <p className="text-xs text-blue-500">{filteredStaff.length} {language === "es" ? "empleados" : "members"}</p>
                                </div>
                            </div>
                            <span className="text-gray-400 text-xl">{staffExpanded ? "▼" : "▶"}</span>
                        </button>

                        {staffExpanded && (
                            <div className="mt-2">
                                {/* Empty-list nudge — surfaces the Import button
                                    as a big tile when the staff list is brand
                                    new or near-empty. The "where do I click to
                                    add my whole team?" moment for a new owner
                                    onboarding the app. Threshold of 5 catches
                                    the just-installed and the "I'm just trying
                                    it out with a couple test names" cases. */}
                                {staffList.length < 5 && (
                                    <div className="mb-3 bg-gradient-to-r from-blue-50 to-emerald-50 border-2 border-blue-300 rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center gap-3">
                                        <div className="flex-1">
                                            <p className="text-sm font-bold text-blue-900 flex items-center gap-1.5">
                                                <span className="text-lg">👋</span>
                                                {language === "es" ? "¿Recién instalado?" : "Just getting started?"}
                                            </p>
                                            <p className="text-xs text-blue-700 mt-1">
                                                {language === "es"
                                                    ? "Importa toda tu lista de personal de una vez — pega los nombres, sube un CSV de Toast/Sling, o jala directo del scraper de Toast."
                                                    : "Import your whole staff list at once — paste names, upload a Toast/Sling CSV, or pull straight from the Toast scraper."}
                                            </p>
                                        </div>
                                        <button onClick={() => setShowImportStaff(true)}
                                            className="flex-shrink-0 px-4 py-2 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 transition text-sm">
                                            📥 {language === "es" ? "Importar Personal" : "Import Staff"}
                                        </button>
                                    </div>
                                )}
                                {/* Search bar — composes with the location +
                                    side chips below. Andrew 2026-05-20. */}
                                <div className="relative mb-2">
                                    <input
                                        type="search"
                                        inputMode="search"
                                        enterKeyHint="search"
                                        value={staffSearch}
                                        onChange={(e) => setStaffSearch(e.target.value)}
                                        placeholder={language === "es"
                                            ? "Buscar por nombre, puesto, email, teléfono…"
                                            : "Search by name, role, email, phone…"}
                                        className="w-full pl-9 pr-9 py-2 border border-blue-200 rounded-lg text-sm bg-white focus:outline-none focus:border-blue-400"
                                    />
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-blue-400 text-sm pointer-events-none">🔍</span>
                                    {staffSearch && (
                                        <button onClick={() => setStaffSearch("")}
                                            className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-blue-100 text-blue-600 text-xs font-bold flex items-center justify-center hover:bg-blue-200">
                                            ✕
                                        </button>
                                    )}
                                </div>
                                <div className="flex gap-1 justify-center mb-2 flex-wrap">
                                    {[{k:"all",en:"All",es:"Todos"},{k:"webster",en:"Webster",es:"Webster"},{k:"maryland",en:"MD Heights",es:"MD Heights"}].map(f => (
                                        <button key={f.k} onClick={() => setStaffFilter(f.k)}
                                            className={`px-3 py-1 rounded-full text-xs font-bold border transition ${staffFilter === f.k ? "bg-blue-600 text-white border-blue-600" : "bg-white text-blue-600 border-blue-300 hover:bg-blue-50"}`}>
                                            {language === "es" ? f.es : f.en}
                                            {f.k !== "all" && <span className="ml-1 opacity-70">({staffList.filter(s => s.location === f.k || s.location === "both").length})</span>}
                                        </button>
                                    ))}
                                    <button onClick={() => setShowBulkTag(true)}
                                        className="px-3 py-1 rounded-full text-xs font-bold border bg-purple-600 text-white border-purple-600 hover:bg-purple-700 transition ml-2">
                                        🏷 {language === "es" ? "Etiquetar en lote" : "Bulk Tag"}
                                    </button>
                                    {/* Import flow — paste names / upload CSV and pull
                                        in everyone not already on the staff list. */}
                                    <button onClick={() => setShowImportStaff(true)}
                                        className="px-3 py-1 rounded-full text-xs font-bold border bg-blue-600 text-white border-blue-600 hover:bg-blue-700 transition">
                                        📥 {language === "es" ? "Importar Personal" : "Import Staff"}
                                    </button>
                                    {/* Export the full SMS opt-in/opt-out audit log as CSV.
                                        Pulls every row from /sms_opt_in_events with timestamp,
                                        staff, phone, action, source, who triggered it, and the
                                        verbatim consent text version. This is the compliance
                                        evidence file for any carrier review or legal hold. */}
                                    <button onClick={exportSmsOptInLog}
                                        title={language === "es"
                                            ? "Exportar registro de aceptaciones de SMS (CSV)"
                                            : "Export SMS opt-in audit log (CSV)"}
                                        className="px-3 py-1 rounded-full text-xs font-bold border bg-green-600 text-white border-green-600 hover:bg-green-700 transition">
                                        📋 {language === "es" ? "Exportar SMS" : "Export SMS log"}
                                    </button>
                                    {/* Required-task admin — push a task type (SMS opt-in,
                                        availability, etc.) to selected staff. They see the
                                        gate on next login. Mounts as a modal. */}
                                    <button onClick={() => setShowRequiredTaskAdmin(true)}
                                        title={language === "es"
                                            ? "Pedir a personal que complete una acción (SMS opt-in, disponibilidad…)"
                                            : "Ask staff to complete an action (SMS opt-in, availability…)"}
                                        className="px-3 py-1 rounded-full text-xs font-bold border bg-amber-600 text-white border-amber-600 hover:bg-amber-700 transition">
                                        📌 {language === "es" ? "Tareas requeridas" : "Required tasks"}
                                    </button>
                                </div>
                                {/* Side sub-tabs — only meaningful when a specific
                                    location is selected. Hidden under "All Locations"
                                    because filtering by side across both stores rarely
                                    matches what an admin actually wants to see. */}
                                {staffFilter !== "all" && (
                                    <div className="flex gap-1 justify-center mb-3 flex-wrap">
                                        {[
                                            { k: "all", en: "All", es: "Todos", tone: "blue" },
                                            { k: "foh", en: "🪑 FOH", es: "🪑 FOH", tone: "blue" },
                                            { k: "boh", en: "🍳 BOH", es: "🍳 BOH", tone: "orange" },
                                        ].map(f => {
                                            const active = staffSideFilter === f.k;
                                            const count = staffList.filter(s =>
                                                (s.location === staffFilter || s.location === "both") &&
                                                (f.k === "all" || personSide(s) === f.k)
                                            ).length;
                                            const activeCls = f.tone === 'orange'
                                                ? 'bg-orange-600 text-white border-orange-600'
                                                : 'bg-blue-500 text-white border-blue-500';
                                            return (
                                                <button key={f.k} onClick={() => setStaffSideFilter(f.k)}
                                                    className={`px-3 py-1 rounded-full text-[11px] font-bold border transition ${active ? activeCls : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}>
                                                    {language === "es" ? f.es : f.en}
                                                    <span className="ml-1 opacity-70">({count})</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                                <div className="space-y-2 mb-4 md:space-y-0 md:grid md:grid-cols-2 md:gap-2">
                                    {filteredStaff.map(person => (
                                        <div key={person.id} className="bg-white rounded-lg border-2 border-gray-200 overflow-hidden">
                                            {editingId === person.id ? (
                                                <div className="p-3 bg-blue-50 space-y-2">
                                                    <div>
                                                        <label className="text-xs text-gray-600 font-semibold">{t("staffName", language)}</label>
                                                        {/* text-base (not text-sm) so iOS Safari doesn't
                                                            zoom the viewport on focus — matches the Cap-A
                                                            input-zoom fix applied app-wide. */}
                                                        <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)}
                                                            placeholder={person.name}
                                                            className="w-full px-3 py-2 border-2 border-gray-300 rounded-lg focus:border-mint-700 focus:outline-none text-base" />
                                                    </div>
                                                    <div>
                                                        <label className="text-xs text-gray-600 font-semibold">{t("staffRole", language)}</label>
                                                        <select value={editRole} onChange={(e) => setEditRole(e.target.value)}
                                                            className="w-full px-2 py-2 border-2 border-gray-300 rounded-lg focus:border-mint-700 focus:outline-none text-sm">
                                                            {roleOptions.map(r => <option key={r} value={r}>{r}</option>)}
                                                        </select>
                                                        {/* Position template — one-tap fill of every access toggle below
                                                            based on the current role. NOT auto-applied on role change,
                                                            so a manual customization isn't silently clobbered. */}
                                                        {hasPositionTemplate(editRole) ? (
                                                            <button type="button"
                                                                onClick={() => {
                                                                    const t = getPositionTemplate(editRole);
                                                                    if (!t) return;
                                                                    const has = Object.keys(t).some(k => {
                                                                        if (k === 'scheduleSide') return editScheduleSide !== t[k];
                                                                        if (k === 'opsAccess') return editOpsAccess !== t[k];
                                                                        if (k === 'recipesAccess') return editRecipesAccess !== t[k];
                                                                        if (k === 'viewLabor') return editViewLabor !== t[k];
                                                                        if (k === 'shiftLead') return editShiftLead !== t[k];
                                                                        if (k === 'canEditScheduleFOH') return editCanEditScheduleFOH !== t[k];
                                                                        if (k === 'canEditScheduleBOH') return editCanEditScheduleBOH !== t[k];
                                                                        if (k === 'homeView') return editHomeView !== t[k];
                                                                        if (k === 'hiddenPages') return JSON.stringify(editHiddenPages.slice().sort()) !== JSON.stringify((t[k] || []).slice().sort());
                                                                        return false;
                                                                    });
                                                                    if (has && !confirm(language === "es"
                                                                        ? `Aplicar plantilla "${editRole}"? Sobrescribirá los toggles actuales.`
                                                                        : `Apply "${editRole}" template? This will overwrite your current toggles.`)) return;
                                                                    if (typeof t.scheduleSide === 'string') setEditScheduleSide(t.scheduleSide);
                                                                    if (typeof t.opsAccess === 'boolean') setEditOpsAccess(t.opsAccess);
                                                                    if (typeof t.recipesAccess === 'boolean') setEditRecipesAccess(t.recipesAccess);
                                                                    if (typeof t.viewLabor === 'boolean') setEditViewLabor(t.viewLabor);
                                                                    if (typeof t.shiftLead === 'boolean') setEditShiftLead(t.shiftLead);
                                                                    if (typeof t.canEditScheduleFOH === 'boolean') setEditCanEditScheduleFOH(t.canEditScheduleFOH);
                                                                    if (typeof t.canEditScheduleBOH === 'boolean') setEditCanEditScheduleBOH(t.canEditScheduleBOH);
                                                                    if (typeof t.homeView === 'string') setEditHomeView(t.homeView);
                                                                    if (Array.isArray(t.hiddenPages)) setEditHiddenPages([...t.hiddenPages]);
                                                                }}
                                                                className="mt-1.5 w-full py-1.5 rounded-lg text-[11px] font-bold bg-indigo-600 text-white hover:bg-indigo-700 active:scale-95 transition">
                                                                ⚡ {language === "es"
                                                                    ? `Aplicar plantilla "${editRole}"`
                                                                    : `Apply "${editRole}" template`}
                                                            </button>
                                                        ) : (
                                                            <p className="mt-1.5 text-[10px] text-gray-400 italic">
                                                                {language === "es"
                                                                    ? "Sin plantilla para este rol — ajusta los toggles manualmente."
                                                                    : "No template for this role — toggle access manually."}
                                                            </p>
                                                        )}
                                                    </div>
                                                    <div>
                                                        <label className="text-xs text-gray-600 font-semibold">{language === "es" ? "Ubicación" : "Location"}</label>
                                                        <select value={editLocation} onChange={(e) => setEditLocation(e.target.value)}
                                                            className="w-full px-2 py-2 border-2 border-gray-300 rounded-lg focus:border-mint-700 focus:outline-none text-sm">
                                                            <option value="webster">Webster</option>
                                                            <option value="maryland">Maryland Heights</option>
                                                            <option value="both">Both Locations</option>
                                                        </select>
                                                        <p className="text-[10px] text-gray-500 mt-1 leading-snug">
                                                            {language === "es"
                                                                ? "Dónde puede trabajar esta persona (elegible para turnos)"
                                                                : "Where this person can work (eligible for shifts)"}
                                                        </p>
                                                    </div>
                                                    {/* scheduleHome — only meaningful when location === 'both'.
                                                        Lets a 'both'-location floater LIVE on one store's schedule
                                                        grid without losing eligibility to fill in at the other. */}
                                                    {editLocation === 'both' && (
                                                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                                                            <p className="text-sm font-bold text-amber-900 mb-1">
                                                                {language === "es" ? "Horario principal" : "Home schedule"}
                                                            </p>
                                                            <p className="text-[11px] text-amber-700 mb-2 leading-snug">
                                                                {language === "es"
                                                                    ? "En cuál tienda aparece esta persona en la cuadrícula del horario por defecto. La otra tienda aún puede asignarle turnos como suplente."
                                                                    : "Which store's schedule grid this person appears on by default. The other store can still pull them in as a fill-in."}
                                                            </p>
                                                            <div className="grid grid-cols-3 gap-2">
                                                                <button onClick={() => setEditScheduleHome("webster")}
                                                                    className={`py-2 rounded-md text-xs font-bold ${editScheduleHome === "webster" ? "bg-emerald-600 text-white" : "bg-white border border-gray-300 text-gray-600"}`}>
                                                                    Webster
                                                                </button>
                                                                <button onClick={() => setEditScheduleHome("maryland")}
                                                                    className={`py-2 rounded-md text-xs font-bold ${editScheduleHome === "maryland" ? "bg-purple-600 text-white" : "bg-white border border-gray-300 text-gray-600"}`}>
                                                                    Maryland
                                                                </button>
                                                                <button onClick={() => setEditScheduleHome("both")}
                                                                    className={`py-2 rounded-md text-xs font-bold ${editScheduleHome === "both" ? "bg-blue-600 text-white" : "bg-white border border-gray-300 text-gray-600"}`}>
                                                                    {language === "es" ? "Ambos" : "Both"}
                                                                </button>
                                                            </div>
                                                        </div>
                                                    )}
                                                    <div>
                                                        <label className="text-xs text-gray-600 font-semibold">{t("newPIN", language)}</label>
                                                        <input type="text" inputMode="numeric" maxLength={4} value={editPin}
                                                            onChange={(e) => setEditPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                                                            placeholder="0000"
                                                            className="w-full px-3 py-2 border-2 border-gray-300 rounded-lg text-center text-2xl tracking-widest font-mono focus:border-mint-700 focus:outline-none" />
                                                    </div>
                                                    <div className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                                                        <div>
                                                            <p className="text-sm font-bold text-gray-700">{language === "es" ? "Acceso a Operaciones" : "Daily Ops Access"}</p>
                                                            <p className="text-xs text-gray-500">{language === "es" ? "Desbloquear sin contrase\u00F1a" : "Unlock without password"}</p>
                                                        </div>
                                                        <button onClick={() => setEditOpsAccess(!editOpsAccess)}
                                                            className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${editOpsAccess ? "bg-green-600" : "bg-gray-300"}`}>
                                                            <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${editOpsAccess ? "translate-x-7" : "translate-x-1"}`} />
                                                        </button>
                                                    </div>
                                                    <div className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                                                        <div>
                                                            <p className="text-sm font-bold text-gray-700">{language === "es" ? "Acceso a Recetas" : "Recipes Access"}</p>
                                                            <p className="text-xs text-gray-500">{language === "es" ? "Ver y gestionar recetas" : "View and manage recipes"}</p>
                                                        </div>
                                                        <button onClick={() => setEditRecipesAccess(!editRecipesAccess)}
                                                            className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${editRecipesAccess ? "bg-green-600" : "bg-gray-300"}`}>
                                                            <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${editRecipesAccess ? "translate-x-7" : "translate-x-1"}`} />
                                                        </button>
                                                    </div>
                                                    {/* Labor % visibility — gated dashboard data. Default ON for
                                                        managers/owners, OFF for staff. Admin can override per-person. */}
                                                    <div className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                                                        <div>
                                                            <p className="text-sm font-bold text-gray-700">{language === "es" ? "Ver % de Mano de Obra" : "View Labor %"}</p>
                                                            <p className="text-xs text-gray-500">{language === "es" ? "Ver KPI de costo laboral en Inicio + Operaciones" : "See labor-cost KPI on Home + Operations"}</p>
                                                        </div>
                                                        <button onClick={() => setEditViewLabor(!editViewLabor)}
                                                            className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${editViewLabor ? "bg-green-600" : "bg-gray-300"}`}>
                                                            <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${editViewLabor ? "translate-x-7" : "translate-x-1"}`} />
                                                        </button>
                                                    </div>
                                                    {/* Money Count — manager cash-drawer counter. Default ON for
                                                        managers/shift-leads/owners; admin can grant/revoke per person. */}
                                                    <div className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                                                        <div>
                                                            <p className="text-sm font-bold text-gray-700">{language === "es" ? "Conteo de Dinero" : "Money Count"}</p>
                                                            <p className="text-xs text-gray-500">{language === "es" ? "Usar el contador de caja en Inicio" : "Use the cash-drawer counter on Home"}</p>
                                                        </div>
                                                        <button onClick={() => setEditCanCountMoney(!editCanCountMoney)}
                                                            className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${editCanCountMoney ? "bg-green-600" : "bg-gray-300"}`}>
                                                            <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${editCanCountMoney ? "translate-x-7" : "translate-x-1"}`} />
                                                        </button>
                                                    </div>
                                                    <div className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                                                        <div>
                                                            <p className="text-sm font-bold text-gray-700">{language === "es" ? "Líder de Turno" : "Shift Lead"}</p>
                                                            <p className="text-xs text-gray-500">{language === "es" ? "Acceso a entrenamientos y SOPs de líder" : "Access to Lead-tier training & SOPs"}</p>
                                                        </div>
                                                        <button onClick={() => setEditShiftLead(!editShiftLead)}
                                                            className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${editShiftLead ? "bg-green-600" : "bg-gray-300"}`}>
                                                            <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${editShiftLead ? "translate-x-7" : "translate-x-1"}`} />
                                                        </button>
                                                    </div>
                                                    <div className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                                                        <div>
                                                            <p className="text-sm font-bold text-gray-700">{language === "es" ? "Menor de edad (<18)" : "Minor (under 18)"}</p>
                                                            <p className="text-xs text-gray-500">{language === "es" ? "El programador advierte sobre límites de horas/horario" : "Scheduler warns on hour/time limits"}</p>
                                                        </div>
                                                        <button onClick={() => setEditIsMinor(!editIsMinor)}
                                                            className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${editIsMinor ? "bg-amber-600" : "bg-gray-300"}`}>
                                                            <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${editIsMinor ? "translate-x-7" : "translate-x-1"}`} />
                                                        </button>
                                                    </div>
                                                    {/* 2026-05-16 — Andrew: owners (he + Julie) don't need
                                                        a row on the schedule grid. Hides them from sideStaff
                                                        in Schedule.jsx. Safety net: if a hidden person
                                                        actually has a shift this week, the row still
                                                        appears so it can't silently disappear. */}
                                                    <div className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                                                        <div>
                                                            <p className="text-sm font-bold text-gray-700">{language === "es" ? "Ocultar del horario" : "Hide from schedule"}</p>
                                                            <p className="text-xs text-gray-500">{language === "es" ? "Para dueños / admins que no necesitan una fila en la cuadrícula" : "For owners / admins who don't need a row on the grid"}</p>
                                                        </div>
                                                        <button onClick={() => setEditHideFromSchedule(!editHideFromSchedule)}
                                                            className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${editHideFromSchedule ? "bg-gray-700" : "bg-gray-300"}`}>
                                                            <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${editHideFromSchedule ? "translate-x-7" : "translate-x-1"}`} />
                                                        </button>
                                                    </div>
                                                    <div className="bg-gray-50 rounded-lg p-3">
                                                        <p className="text-sm font-bold text-gray-700 mb-1">{language === "es" ? "Horario" : "Schedule Side"}</p>
                                                        <p className="text-xs text-gray-500 mb-2">{language === "es" ? "En cuál horario aparece esta persona" : "Which schedule this person appears on"}</p>
                                                        <div className="grid grid-cols-2 gap-2">
                                                            <button onClick={() => setEditScheduleSide("foh")}
                                                                className={`py-2 rounded-md text-xs font-bold ${editScheduleSide === "foh" ? "bg-teal-600 text-white" : "bg-white border border-gray-300 text-gray-600"}`}>
                                                                FOH
                                                            </button>
                                                            <button onClick={() => setEditScheduleSide("boh")}
                                                                className={`py-2 rounded-md text-xs font-bold ${editScheduleSide === "boh" ? "bg-orange-600 text-white" : "bg-white border border-gray-300 text-gray-600"}`}>
                                                                BOH
                                                            </button>
                                                        </div>
                                                    </div>
                                                    {/* Per-staff Home view picker. Determines what THIS person sees
                                                        when they tap the Home tab (and what tab they land on after
                                                        signing in for the first time on a device). 'Auto' = the
                                                        default unified Home; any other value redirects to that tab. */}
                                                    <div className="bg-gray-50 rounded-lg p-3">
                                                        <p className="text-sm font-bold text-gray-700 mb-1">🏠 {language === "es" ? "Vista de inicio" : "Home view"}</p>
                                                        <p className="text-xs text-gray-500 mb-2">{language === "es"
                                                            ? "Qué ve esta persona al abrir la app."
                                                            : "What this person sees when they open the app."}</p>
                                                        <select value={editHomeView}
                                                            onChange={(e) => setEditHomeView(e.target.value)}
                                                            className="w-full px-2 py-2 border-2 border-gray-300 rounded-lg focus:border-mint-700 focus:outline-none text-sm bg-white">
                                                            <option value="auto">{language === "es" ? "🏠 Inicio (predeterminado)" : "🏠 Default Home"}</option>
                                                            <option value="schedule">{language === "es" ? "📅 Horario" : "📅 Schedule"}</option>
                                                            <option value="recipes">{language === "es" ? "🧑‍🍳 Recetas" : "🧑‍🍳 Recipes"}</option>
                                                            <option value="operations">{language === "es" ? "📋 Operaciones (tareas)" : "📋 Operations (tasks)"}</option>
                                                            <option value="training">{language === "es" ? "📚 Capacitación" : "📚 Training"}</option>
                                                            <option value="menu">{language === "es" ? "🍜 Menú" : "🍜 Menu"}</option>
                                                            <option value="eighty6">{language === "es" ? "🚫 Tablero 86" : "🚫 86 Board"}</option>
                                                            <option value="handoff">{language === "es" ? "🤝 Entrega de turno" : "🤝 Shift Handoff"}</option>
                                                            <option value="tardies">{language === "es" ? "⏰ Tardanzas" : "⏰ Tardies"}</option>
                                                            <option value="labor">{language === "es" ? "📊 Mano de obra" : "📊 Labor Dashboard"}</option>
                                                        </select>
                                                    </div>

                                                    {/* Per-staff tab access — toggle which optional tabs this
                                                        person sees in the sidebar / mobile launcher. Default
                                                        (empty array) = sees everything. Toggling OFF adds the
                                                        tab id to hiddenPages, hiding it from this person's view.
                                                        Schedule/Home are never hideable (they're core). Recipes,
                                                        Operations have their own access flags above. */}
                                                    {(() => {
                                                        const visibleCount = HIDEABLE_PAGES.length - editHiddenPages.length;
                                                        const allVisible = editHiddenPages.length === 0;
                                                        const allHidden = editHiddenPages.length === HIDEABLE_PAGES.length;
                                                        const toggle = (id) => {
                                                            setEditHiddenPages(prev => prev.includes(id)
                                                                ? prev.filter(x => x !== id)
                                                                : [...prev, id]);
                                                        };
                                                        return (
                                                            <div className="bg-gray-50 rounded-lg p-3">
                                                                <div className="flex items-center justify-between mb-1 flex-wrap gap-1">
                                                                    <p className="text-sm font-bold text-gray-700">
                                                                        👁 {language === "es" ? "Acceso a pestañas" : "Tab access"}
                                                                    </p>
                                                                    <span className="text-[10px] font-bold text-gray-500">
                                                                        {visibleCount}/{HIDEABLE_PAGES.length} {language === "es" ? "visibles" : "visible"}
                                                                    </span>
                                                                </div>
                                                                <p className="text-xs text-gray-500 mb-2">
                                                                    {language === "es"
                                                                        ? "Activa/desactiva qué pestañas opcionales ve esta persona. Horario/Inicio siempre visibles. Recetas y Operaciones tienen sus propios accesos arriba."
                                                                        : "Toggle which optional tabs this person sees. Home/Schedule always visible. Recipes & Operations have their own access above."}
                                                                </p>
                                                                <div className="flex gap-1 mb-2">
                                                                    <button type="button" onClick={() => setEditHiddenPages([])}
                                                                        className={`flex-1 py-1 rounded text-[10px] font-bold border ${allVisible ? 'bg-green-600 text-white border-green-600' : 'bg-white text-green-700 border-green-300 hover:bg-green-50'}`}>
                                                                        ✓ {language === "es" ? "Todas visibles" : "All on"}
                                                                    </button>
                                                                    <button type="button" onClick={() => setEditHiddenPages(HIDEABLE_PAGES.map(p => p.id))}
                                                                        className={`flex-1 py-1 rounded text-[10px] font-bold border ${allHidden ? 'bg-red-600 text-white border-red-600' : 'bg-white text-red-700 border-red-300 hover:bg-red-50'}`}>
                                                                        ✕ {language === "es" ? "Todas ocultas" : "All off"}
                                                                    </button>
                                                                </div>
                                                                <div className="grid grid-cols-2 gap-1.5">
                                                                    {HIDEABLE_PAGES.map(pg => {
                                                                        const isVisible = !editHiddenPages.includes(pg.id);
                                                                        return (
                                                                            <button key={pg.id} type="button" onClick={() => toggle(pg.id)}
                                                                                className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-bold border-2 transition active:scale-95 ${
                                                                                    isVisible
                                                                                        ? 'bg-white text-dd-text border-dd-line hover:border-dd-green/50'
                                                                                        : 'bg-gray-100 text-gray-400 border-gray-200 line-through'
                                                                                }`}>
                                                                                <span className="text-sm">{pg.emoji}</span>
                                                                                <span className="flex-1 text-left truncate">{language === "es" ? pg.labelEs : pg.labelEn}</span>
                                                                                <span className={`w-3.5 h-3.5 rounded-full flex-shrink-0 ${isVisible ? 'bg-green-500' : 'bg-gray-300'}`} />
                                                                            </button>
                                                                        );
                                                                    })}
                                                                </div>
                                                            </div>
                                                        );
                                                    })()}

                                                    {/* Preferred language for this person's notifications. */}
                                                    <div className="bg-gray-50 rounded-lg p-3">
                                                        <p className="text-sm font-bold text-gray-700 mb-1">🗣 {language === "es" ? "Idioma de notificaciones" : "Notification language"}</p>
                                                        <p className="text-xs text-gray-500 mb-2">{language === "es"
                                                            ? "Pushes y mensajes de tareas se enviarán en este idioma."
                                                            : "Pushes and task messages will be sent in this language."}</p>
                                                        <div className="grid grid-cols-2 gap-2">
                                                            <button onClick={() => setEditPreferredLanguage("en")}
                                                                className={`py-2 rounded-md text-xs font-bold ${editPreferredLanguage === "en" ? "bg-blue-600 text-white" : "bg-white border border-gray-300 text-gray-600"}`}>
                                                                English
                                                            </button>
                                                            <button onClick={() => setEditPreferredLanguage("es")}
                                                                className={`py-2 rounded-md text-xs font-bold ${editPreferredLanguage === "es" ? "bg-blue-600 text-white" : "bg-white border border-gray-300 text-gray-600"}`}>
                                                                Español
                                                            </button>
                                                        </div>
                                                    </div>
                                                    <div className="bg-gray-50 rounded-lg p-3">
                                                        <p className="text-sm font-bold text-gray-700 mb-1">{language === "es" ? "Horas semanales objetivo" : "Target Hours / Week"}</p>
                                                        <p className="text-xs text-gray-500 mb-2">{language === "es" ? "Usado por el auto-populador. 0 = sin objetivo." : "Used by auto-fill. 0 = no target."}</p>
                                                        <input type="number" inputMode="numeric" pattern="[0-9]*" min="0" max="80" step="1"
                                                            value={editTargetHours} onChange={e => setEditTargetHours(e.target.value)}
                                                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                                                    </div>
                                                    <div className="bg-gray-50 rounded-lg p-3">
                                                        <p className="text-sm font-bold text-gray-700 mb-1">🎂 {language === "es" ? "Cumpleaños" : "Birthday"}</p>
                                                        <p className="text-xs text-gray-500 mb-2">{language === "es"
                                                            ? "Aparece como una etiqueta sobre el día en la cuadrícula del horario. Solo mes y día — el año no se guarda."
                                                            : "Shows as a chip above the day on the schedule grid. Month and day only — year is not stored."}</p>
                                                        <input type="text" inputMode="numeric" placeholder="MM-DD"
                                                            value={editBirthday}
                                                            onChange={e => {
                                                                // Accept the canonical MM-DD form; reject other characters.
                                                                const v = e.target.value.replace(/[^\d-]/g, '').slice(0, 5);
                                                                setEditBirthday(v);
                                                            }}
                                                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono" />
                                                    </div>
                                                    {/* Designated-scheduler toggles. ONLY the people you turn on here can
                                                        edit / publish the schedule for that side. Everyone else can still
                                                        view, offer up shifts, take shifts, and request PTO. */}
                                                    <div className="bg-gray-50 rounded-lg p-3">
                                                        <p className="text-sm font-bold text-gray-700 mb-1">📅 {language === "es" ? "Editor de horario" : "Schedule Editor"}</p>
                                                        <p className="text-xs text-gray-500 mb-2">
                                                            {language === "es"
                                                                ? "Solo los activados aquí pueden crear/editar/publicar turnos. Admin (Andrew/Julie) siempre puede."
                                                                : "Only people toggled on here can create/edit/publish shifts. Admin (Andrew/Julie) always can."}
                                                        </p>
                                                        <div className="flex items-center justify-between mb-2">
                                                            <span className="text-xs font-bold text-teal-700">FOH {language === "es" ? "editor" : "editor"}</span>
                                                            <button onClick={() => setEditCanEditScheduleFOH(!editCanEditScheduleFOH)}
                                                                className={`w-12 h-6 rounded-full relative transition ${editCanEditScheduleFOH ? "bg-teal-600" : "bg-gray-300"}`}>
                                                                <div className={`w-5 h-5 bg-white rounded-full shadow absolute top-0.5 transition ${editCanEditScheduleFOH ? "translate-x-6" : "translate-x-0.5"}`} />
                                                            </button>
                                                        </div>
                                                        <div className="flex items-center justify-between">
                                                            <span className="text-xs font-bold text-orange-700">BOH {language === "es" ? "editor" : "editor"}</span>
                                                            <button onClick={() => setEditCanEditScheduleBOH(!editCanEditScheduleBOH)}
                                                                className={`w-12 h-6 rounded-full relative transition ${editCanEditScheduleBOH ? "bg-orange-600" : "bg-gray-300"}`}>
                                                                <div className={`w-5 h-5 bg-white rounded-full shadow absolute top-0.5 transition ${editCanEditScheduleBOH ? "translate-x-6" : "translate-x-0.5"}`} />
                                                            </button>
                                                        </div>
                                                    </div>
                                                    <button onClick={() => setAvailabilityForId(person.id)}
                                                        className="w-full py-2 rounded-lg bg-purple-100 text-purple-700 text-xs font-bold hover:bg-purple-200">
                                                        🗓 {language === "es" ? "Editar disponibilidad" : "Edit Availability"}
                                                    </button>
                                                    <div className="flex gap-2">
                                                        <button onClick={() => handleSavePin(person.id)}
                                                            disabled={editPin.length !== 4}
                                                            className={`flex-1 py-2 rounded-lg font-bold text-white transition ${editPin.length === 4 ? "bg-green-700 hover:bg-green-800" : "bg-gray-300 cursor-not-allowed"}`}>
                                                            {t("save", language)}
                                                        </button>
                                                        <button onClick={resetEditForm}
                                                            className="flex-1 py-2 rounded-lg font-bold bg-gray-500 text-white hover:bg-gray-600 transition">
                                                            {t("cancel", language)}
                                                        </button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="p-3 flex items-center justify-between">
                                                    <div>
                                                        <p className="font-bold text-gray-800">{person.name}</p>
                                                        {/* 2026-06-02 — PIN masked on cards. Inline span +
                                                            Eye toggle replaces the old `PIN: 1234` plain
                                                            text. See visiblePinIds state + togglePinVisibility
                                                            above for the 10s auto-hide. The rest of the meta
                                                            line (role / location / flags) stays in the same
                                                            <p> so wrapping behavior matches the previous
                                                            layout. */}
                                                        <p className="text-xs text-gray-500">
                                                            {person.role} • {LOCATION_LABELS[person.location] || "Webster"}{person.location === 'both' && person.scheduleHome && person.scheduleHome !== 'both' ? ` (${language === "es" ? "horario" : "schedule"}: ${LOCATION_LABELS[person.scheduleHome] || person.scheduleHome})` : ''}
                                                            {" • PIN: "}
                                                            <span className="font-mono tracking-wider align-middle">
                                                                {visiblePinIds.has(person.id) ? (person.pin || "") : "●●●●"}
                                                            </span>
                                                            <button
                                                                type="button"
                                                                onClick={(e) => { e.stopPropagation(); togglePinVisibility(person.id); }}
                                                                title={visiblePinIds.has(person.id)
                                                                    ? (language === "es" ? "Ocultar PIN" : "Hide PIN")
                                                                    : (language === "es" ? "Mostrar PIN (se ocultará en 10s)" : "Show PIN (auto-hides in 10s)")}
                                                                aria-label={visiblePinIds.has(person.id)
                                                                    ? (language === "es" ? "Ocultar PIN" : "Hide PIN")
                                                                    : (language === "es" ? "Mostrar PIN (se ocultará en 10s)" : "Show PIN (auto-hides in 10s)")}
                                                                className="ml-1 inline-flex items-center justify-center align-middle text-gray-400 hover:text-gray-700 transition">
                                                                {visiblePinIds.has(person.id)
                                                                    ? <EyeOff size={14} />
                                                                    : <Eye size={14} />}
                                                            </button>
                                                            {person.opsAccess ? " • \u{1F4CB} Ops" : ""}{person.recipesAccess ? " • \u{1F9D1}\u{200D}\u{1F373} Recipes" : ""}{person.shiftLead ? " • \u{1F6E1}\u{FE0F} Lead" : ""}{person.isMinor ? " • \u{1F511} Minor" : ""}
                                                            {" • "}{(person.scheduleSide || "foh").toUpperCase()}{person.targetHours ? ` • ${person.targetHours}h` : ""}
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <button onClick={() => { setEditingId(person.id); setEditName(person.name); setEditPin(person.pin); setEditRole(person.role); setEditLocation(person.location || "webster"); setEditScheduleHome(person.scheduleHome || person.location || "both"); setEditOpsAccess(!!person.opsAccess); setEditRecipesAccess(person.recipesAccess !== false); setEditViewLabor(person.viewLabor === true || (person.viewLabor !== false && /manager|owner/i.test(person.role || ''))); setEditCanCountMoney(person.canCountMoney === true || (person.canCountMoney !== false && (/manager|owner/i.test(person.role || '') || person.shiftLead === true || person.id === 40 || person.id === 41))); setEditShiftLead(!!person.shiftLead); setEditIsMinor(!!person.isMinor); setEditHideFromSchedule(!!person.hideFromSchedule); setEditScheduleSide(person.scheduleSide || "foh"); setEditTargetHours(person.targetHours || 0); setEditBirthday(typeof person.birthday === 'string' ? person.birthday : ''); setEditCanEditScheduleFOH(!!person.canEditScheduleFOH); setEditCanEditScheduleBOH(!!person.canEditScheduleBOH); setEditPreferredLanguage(person.preferredLanguage || "en"); setEditHomeView(person.homeView || "auto"); setEditHiddenPages(Array.isArray(person.hiddenPages) ? [...person.hiddenPages] : []); }}
                                                            className="px-3 py-1.5 bg-blue-100 text-blue-700 rounded-lg text-xs font-bold hover:bg-blue-200 transition">
                                                            ✏️ {t("changePIN", language)}
                                                        </button>
                                                        {!ADMIN_IDS.includes(person.id) && (
                                                            confirmRemoveId === person.id ? (
                                                                <div className="flex gap-1">
                                                                    <button onClick={() => handleRemoveStaff(person.id)}
                                                                        className="px-2 py-1.5 bg-red-600 text-white rounded-lg text-xs font-bold hover:bg-red-700">✓</button>
                                                                    <button onClick={() => setConfirmRemoveId(null)}
                                                                        className="px-2 py-1.5 bg-gray-400 text-white rounded-lg text-xs font-bold hover:bg-gray-500">✕</button>
                                                                </div>
                                                            ) : (
                                                                <button onClick={() => setConfirmRemoveId(person.id)}
                                                                    className="px-2 py-1.5 bg-mint-100 text-mint-700 rounded-lg text-xs font-bold hover:bg-mint-200 transition">
                                                                    🗑️
                                                                </button>
                                                            )
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>

                                {showAdd ? (
                                    <div className="bg-green-50 border-2 border-green-300 rounded-lg p-4 space-y-3">
                                        <h3 className="font-bold text-green-800">{t("addStaff", language)}</h3>
                                        <div>
                                            <label className="text-xs text-gray-600 font-semibold">{t("staffName", language)}</label>
                                            <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                                                placeholder={language === "es" ? "Nombre completo" : "Full name"}
                                                className="w-full px-3 py-2 border-2 border-gray-300 rounded-lg focus:border-green-700 focus:outline-none" />
                                        </div>
                                        <div>
                                            <label className="text-xs text-gray-600 font-semibold">{t("staffRole", language)}</label>
                                            <select value={newRole} onChange={(e) => setNewRole(e.target.value)}
                                                className="w-full px-2 py-2 border-2 border-gray-300 rounded-lg focus:border-green-700 focus:outline-none text-sm">
                                                {roleOptions.map(r => <option key={r} value={r}>{r}</option>)}
                                            </select>
                                            {hasPositionTemplate(newRole) ? (
                                                <p className="mt-1 text-[10px] text-indigo-700 font-bold">
                                                    ⚡ {language === "es"
                                                        ? `Se aplicarán los accesos predeterminados de "${newRole}" al guardar.`
                                                        : `"${newRole}" template will apply default access on save.`}
                                                </p>
                                            ) : (
                                                <p className="mt-1 text-[10px] text-gray-400 italic">
                                                    {language === "es"
                                                        ? "Sin plantilla — ajusta el acceso luego en Editar."
                                                        : "No template — tweak access later via Edit."}
                                                </p>
                                            )}
                                        </div>
                                        <div>
                                            <label className="text-xs text-gray-600 font-semibold">{language === "es" ? "Ubicación" : "Location"}</label>
                                            <select value={newLocation} onChange={(e) => setNewLocation(e.target.value)}
                                                className="w-full px-2 py-2 border-2 border-gray-300 rounded-lg focus:border-green-700 focus:outline-none text-sm">
                                                <option value="webster">Webster</option>
                                                <option value="maryland">Maryland Heights</option>
                                                <option value="both">Both Locations</option>
                                            </select>
                                        </div>
                                        <div>
                                            <label className="text-xs text-gray-600 font-semibold">{t("staffPIN", language)} (4 {language === "es" ? "dígitos" : "digits"})</label>
                                            <input type="text" inputMode="numeric" maxLength={4} value={newPin}
                                                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                                                placeholder="0000"
                                                className="w-full px-3 py-2 border-2 border-gray-300 rounded-lg text-center text-2xl tracking-widest font-mono focus:border-green-700 focus:outline-none" />
                                        </div>
                                        <div className="flex items-center justify-between bg-white rounded-lg p-3 border border-gray-200">
                                            <div>
                                                <p className="text-sm font-bold text-gray-700">{language === "es" ? "Acceso a Operaciones" : "Daily Ops Access"}</p>
                                                <p className="text-xs text-gray-500">{language === "es" ? "Desbloquear sin contrase\u00F1a" : "Unlock without password"}</p>
                                            </div>
                                            <button onClick={() => setNewOpsAccess(!newOpsAccess)}
                                                className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${newOpsAccess ? "bg-green-600" : "bg-gray-300"}`}>
                                                <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${newOpsAccess ? "translate-x-7" : "translate-x-1"}`} />
                                            </button>
                                        </div>
                                        <div className="flex items-center justify-between bg-white rounded-lg p-3 border border-gray-200">
                                            <div>
                                                <p className="text-sm font-bold text-gray-700">{language === "es" ? "Acceso a Recetas" : "Recipes Access"}</p>
                                                <p className="text-xs text-gray-500">{language === "es" ? "Ver y gestionar recetas" : "View and manage recipes"}</p>
                                            </div>
                                            <button onClick={() => setNewRecipesAccess(!newRecipesAccess)}
                                                className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${newRecipesAccess ? "bg-green-600" : "bg-gray-300"}`}>
                                                <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${newRecipesAccess ? "translate-x-7" : "translate-x-1"}`} />
                                            </button>
                                        </div>
                                        <div className="flex items-center justify-between bg-white rounded-lg p-3 border border-gray-200">
                                            <div>
                                                <p className="text-sm font-bold text-gray-700">{language === "es" ? "Líder de Turno" : "Shift Lead"}</p>
                                                <p className="text-xs text-gray-500">{language === "es" ? "Acceso a entrenamientos y SOPs de líder" : "Access to Lead-tier training & SOPs"}</p>
                                            </div>
                                            <button onClick={() => setNewShiftLead(!newShiftLead)}
                                                className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${newShiftLead ? "bg-green-600" : "bg-gray-300"}`}>
                                                <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${newShiftLead ? "translate-x-7" : "translate-x-1"}`} />
                                            </button>
                                        </div>
                                        <div className="flex items-center justify-between bg-white rounded-lg p-3 border border-gray-200">
                                            <div>
                                                <p className="text-sm font-bold text-gray-700">{language === "es" ? "Menor de edad (<18)" : "Minor (under 18)"}</p>
                                                <p className="text-xs text-gray-500">{language === "es" ? "El programador advierte sobre límites de horas/horario" : "Scheduler warns on hour/time limits"}</p>
                                            </div>
                                            <button onClick={() => setNewIsMinor(!newIsMinor)}
                                                className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${newIsMinor ? "bg-amber-600" : "bg-gray-300"}`}>
                                                <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${newIsMinor ? "translate-x-7" : "translate-x-1"}`} />
                                            </button>
                                        </div>
                                        <div className="bg-white rounded-lg p-3 border border-gray-200">
                                            <p className="text-sm font-bold text-gray-700 mb-1">{language === "es" ? "Horario" : "Schedule Side"}</p>
                                            <div className="grid grid-cols-2 gap-2">
                                                <button onClick={() => setNewScheduleSide("foh")}
                                                    className={`py-2 rounded-md text-xs font-bold ${newScheduleSide === "foh" ? "bg-teal-600 text-white" : "bg-white border border-gray-300 text-gray-600"}`}>
                                                    FOH
                                                </button>
                                                <button onClick={() => setNewScheduleSide("boh")}
                                                    className={`py-2 rounded-md text-xs font-bold ${newScheduleSide === "boh" ? "bg-orange-600 text-white" : "bg-white border border-gray-300 text-gray-600"}`}>
                                                    BOH
                                                </button>
                                            </div>
                                        </div>
                                        <div className="flex gap-2">
                                            <button onClick={handleAddStaff}
                                                disabled={!newName.trim() || newPin.length !== 4}
                                                className={`flex-1 py-2 rounded-lg font-bold text-white transition ${newName.trim() && newPin.length === 4 ? "bg-green-700 hover:bg-green-800" : "bg-gray-300 cursor-not-allowed"}`}>
                                                {t("addStaff", language)}
                                            </button>
                                            <button onClick={() => { setShowAdd(false); setNewName(""); setNewRole("FOH"); setNewPin(""); setNewOpsAccess(false); setNewRecipesAccess(true); setNewShiftLead(false); setNewIsMinor(false); setNewScheduleSide("foh"); }}
                                                className="flex-1 py-2 rounded-lg font-bold bg-gray-500 text-white hover:bg-gray-600 transition">
                                                {t("cancel", language)}
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <button onClick={() => setShowAdd(true)}
                                        className="w-full py-3 bg-green-700 text-white font-bold rounded-lg hover:bg-green-800 transition text-lg">
                                        + {t("addStaff", language)}
                                    </button>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Checklist History Section — collapsed by default. The
                        rendered list is hundreds of rows long; mounting it on
                        every Admin visit pushed the more important controls way
                        below the fold. Now: header bar opens / closes; the
                        component itself is unmounted while collapsed so its
                        Firestore subscription doesn't run when nobody's looking. */}
                    <div className="mt-8 pt-6 border-t-2 border-gray-200">
                        <button onClick={() => setChecklistHistoryExpanded(v => !v)}
                            className="w-full flex items-center justify-between text-left">
                            <div>
                                <h3 className="text-xl font-bold text-mint-700 mb-1">📋 {language === "es" ? "Historial de Listas" : "Checklist History"}</h3>
                                <p className="text-xs text-gray-500">{language === "es"
                                    ? "Revisa las listas de apertura y cierre de días anteriores"
                                    : "Review opening and closing checklists from previous days"}</p>
                            </div>
                            <span className="text-gray-400 text-xl ml-2">{checklistHistoryExpanded ? "▼" : "▶"}</span>
                        </button>
                        {checklistHistoryExpanded && (
                            <div className="mt-3"><ChecklistHistory language={language} storeLocation={storeLocation} /></div>
                        )}
                    </div>

                    {/* Inventory History Section — collapsed by default for the
                        same reason as Checklist History. */}
                    <div className="mt-8 pt-6 border-t-2 border-gray-200">
                        <button onClick={() => setInventoryHistoryExpanded(v => !v)}
                            className="w-full flex items-center justify-between text-left">
                            <div>
                                <h3 className="text-xl font-bold text-mint-700 mb-1">📦 {language === "es" ? "Historial de Inventario" : "Inventory History"}</h3>
                                <p className="text-xs text-gray-500">{language === "es"
                                    ? "Revisa los conteos de inventario de días anteriores. Los cambios vs el día anterior se muestran en verde/rojo."
                                    : "Review inventory counts from previous days. Changes vs the prior day are shown in green/red."}</p>
                            </div>
                            <span className="text-gray-400 text-xl ml-2">{inventoryHistoryExpanded ? "▼" : "▶"}</span>
                        </button>
                        {inventoryHistoryExpanded && (
                            <div className="mt-3"><InventoryHistory language={language} customInventory={null} storeLocation={storeLocation} /></div>
                        )}
                    </div>

                    {/* Inventory list variations — admin can create/name/
                        activate alternate inventory lists ("Produce day",
                        "Quick prep", etc.) that swap what staff sees in
                        the Inventory tab. */}
                    <div className="mt-4 pt-4 border-t border-gray-200">
                        <button onClick={() => setShowInventoryLists(true)}
                            className="w-full flex items-center justify-between text-left p-3 rounded-xl bg-gradient-to-r from-amber-50 to-yellow-50 border-2 border-amber-200 hover:from-amber-100 hover:to-yellow-100 transition">
                            <div>
                                <h3 className="text-base font-bold text-amber-800 mb-0.5">
                                    📋 {language === "es" ? "Listas de inventario" : "Inventory lists"}
                                </h3>
                                <p className="text-xs text-amber-700">{language === "es"
                                    ? "Crea variaciones (\"Día de verduras\", \"Prep rápida\") · activa la que el inventario muestra"
                                    : 'Build named variations ("Produce day", "Quick prep") · activate the one shown in the inventory tab'}</p>
                            </div>
                            <span className="text-amber-600 text-2xl">→</span>
                        </button>
                    </div>

                    {showInventoryLists && (
                        <ReactSuspense fallback={<div className="fixed inset-0 bg-black/40 z-50" />}>
                            <InventoryListsAdmin
                                language={language}
                                staffName={staffName}
                                viewer={staffList.find(s => s.name === staffName)}
                                onClose={() => setShowInventoryLists(false)}
                            />
                        </ReactSuspense>
                    )}

                    {/* ── Availability Editor Modal ── */}
                    {availabilityForId !== null && (() => {
                        const person = staffList.find(p => p.id === availabilityForId);
                        if (!person) return null;
                        const DAYS = [
                            { k: "sun", en: "Sunday",    es: "Domingo" },
                            { k: "mon", en: "Monday",    es: "Lunes" },
                            { k: "tue", en: "Tuesday",   es: "Martes" },
                            { k: "wed", en: "Wednesday", es: "Miércoles" },
                            { k: "thu", en: "Thursday",  es: "Jueves" },
                            { k: "fri", en: "Friday",    es: "Viernes" },
                            { k: "sat", en: "Saturday",  es: "Sábado" },
                        ];
                        // availability stored as: { mon: { available: true, from: "09:00", to: "17:00" } | { available: false }, ... }
                        const avail = person.availability || {};
                        const updateDay = async (dayKey, patch) => {
                            // Functional setState — avoids clobbering a sibling
                            // edit that might land between snapshot and save.
                            // Read fresh availability from `prev` rather than
                            // closing over `avail` from the parent scope.
                            let latest = null;
                            let auditDiff = null;
                            setStaffList(prev => {
                                const me = prev.find(s => s.id === person.id);
                                const curAvail = (me && me.availability) || {};
                                const cur = curAvail[dayKey] || { available: true, from: "09:00", to: "21:00" };
                                const nextDay = { ...cur, ...patch };
                                const nextAvail = { ...curAvail, [dayKey]: nextDay };
                                auditDiff = { before: { [dayKey]: cur }, after: { [dayKey]: nextDay } };
                                latest = prev.map(s => s.id === person.id ? { ...s, availability: nextAvail } : s);
                                return latest;
                            });
                            if (latest) {
                                await saveStaffToFirestore(latest);
                                // Audit 2026-06-24: manager-edited availability →
                                // Debug/QA change-history (who/old/new/where). Best-effort.
                                if (auditDiff) auditAvailabilityChange({
                                    staffId: person.id, staffName: person.name,
                                    before: auditDiff.before, after: auditDiff.after,
                                    surface: 'admin-dashboard',
                                });
                            }
                        };
                        return (
                            <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
                                <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                                    <div className="border-b border-gray-200 p-4 flex items-center justify-between">
                                        <div>
                                            <h3 className="text-lg font-bold text-purple-700">🗓 {language === "es" ? "Disponibilidad" : "Availability"}</h3>
                                            <p className="text-xs text-gray-500">{person.name}</p>
                                        </div>
                                        <button onClick={() => setAvailabilityForId(null)}
                                            className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 text-lg">×</button>
                                    </div>
                                    <div className="flex-1 overflow-y-auto p-3 space-y-2">
                                        <p className="text-xs text-gray-500 mb-1">{language === "es" ? "Auto-popular usa esto para asignar turnos." : "Auto-fill uses this to assign shifts."}</p>
                                        {DAYS.map(d => {
                                            const dayData = avail[d.k] || { available: true, from: "09:00", to: "21:00" };
                                            const available = dayData.available !== false;
                                            return (
                                                <div key={d.k} className="bg-gray-50 rounded-lg p-2">
                                                    <div className="flex items-center justify-between mb-1">
                                                        <span className="font-bold text-sm text-gray-800">{language === "es" ? d.es : d.en}</span>
                                                        <button onClick={() => updateDay(d.k, { available: !available })}
                                                            className={`px-3 py-1 rounded-full text-xs font-bold ${available ? "bg-green-600 text-white" : "bg-gray-300 text-gray-600"}`}>
                                                            {available ? (language === "es" ? "Disponible" : "Available") : (language === "es" ? "No disponible" : "Off")}
                                                        </button>
                                                    </div>
                                                    {available && (
                                                        <div className="grid grid-cols-2 gap-2">
                                                            <div>
                                                                <label className="text-[10px] text-gray-500 block">{language === "es" ? "Desde" : "From"}</label>
                                                                <input type="time" value={dayData.from || "09:00"}
                                                                    onChange={e => updateDay(d.k, { from: e.target.value })}
                                                                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                                                            </div>
                                                            <div>
                                                                <label className="text-[10px] text-gray-500 block">{language === "es" ? "Hasta" : "To"}</label>
                                                                <input type="time" value={dayData.to || "21:00"}
                                                                    onChange={e => updateDay(d.k, { to: e.target.value })}
                                                                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                    <div className="border-t border-gray-200 p-3">
                                        <button onClick={() => setAvailabilityForId(null)}
                                            className="w-full py-2 rounded-lg bg-purple-700 text-white font-bold">{language === "es" ? "Listo" : "Done"}</button>
                                    </div>
                                </div>
                            </div>
                        );
                    })()}

                    {/* ── Rename confirm — name is a join key across the app, so
                          renaming fans out to linked collections. Show the blast
                          radius before committing. ── */}
                    {pendingRename && (
                        <ModalPortal onBackPress={() => setPendingRename(null)}>
                        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
                            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                                <div className="border-b border-gray-200 p-4">
                                    <h3 className="text-lg font-bold text-gray-800">
                                        {language === "es" ? "¿Renombrar al personal?" : "Rename staff member?"}
                                    </h3>
                                </div>
                                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                                    <div className="flex items-center justify-center gap-2 text-center">
                                        <span className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 font-bold text-sm line-through decoration-gray-400">{pendingRename.oldName}</span>
                                        <span className="text-gray-400 font-black">→</span>
                                        <span className="px-3 py-1.5 rounded-lg bg-green-100 text-green-800 font-bold text-sm">{pendingRename.newName}</span>
                                    </div>
                                    <p className="text-sm text-gray-600">
                                        {language === "es"
                                            ? "Esto también actualizará sus registros vinculados:"
                                            : "This will also update their linked records:"}
                                    </p>
                                    <ul className="text-sm text-gray-700 list-disc pl-5 space-y-0.5">
                                        <li>{language === "es" ? "Turnos del horario (incl. recurrentes)" : "Schedule shifts (incl. recurring)"}</li>
                                        <li>{language === "es" ? "Tiempo libre / PTO" : "Time-off / PTO"}</li>
                                        <li>{language === "es" ? "Notificaciones" : "Notifications"}</li>
                                        <li>{language === "es" ? "Turnos fuera del sitio" : "Off-site shifts"}</li>
                                        <li>{language === "es" ? "Tardanzas y tareas asignadas" : "Tardiness & task assignments"}</li>
                                        <li>{language === "es" ? "Membresía de chats" : "Chat membership"}</li>
                                    </ul>
                                    <p className="text-xs text-gray-500">
                                        {language === "es"
                                            ? "Los mensajes de chat antiguos y el historial de auditoría conservan el nombre anterior. Es posible que deban volver a ingresar su PIN la próxima vez que abran la app."
                                            : "Old chat messages and audit history keep the old name. They may need to re-enter their PIN the next time they open the app."}
                                    </p>
                                </div>
                                <div className="border-t border-gray-200 p-3 flex gap-2">
                                    <button onClick={() => setPendingRename(null)}
                                        className="flex-1 py-2.5 rounded-lg font-bold bg-gray-200 text-gray-700 hover:bg-gray-300 transition">
                                        {t("cancel", language)}
                                    </button>
                                    <button onClick={confirmRename}
                                        className="flex-1 py-2.5 rounded-lg font-bold bg-green-700 text-white hover:bg-green-800 transition">
                                        {language === "es" ? "Renombrar" : "Rename"}
                                    </button>
                                </div>
                            </div>
                        </div>
                        </ModalPortal>
                    )}

                    {/* Busy overlay while the rename fans out across collections. */}
                    {renameBusy && (
                        <ModalPortal>
                        <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4">
                            <div className="bg-white rounded-2xl px-6 py-5 flex items-center gap-3 shadow-xl">
                                <div className="w-5 h-5 border-2 border-gray-300 border-t-green-600 rounded-full animate-spin" />
                                <span className="text-sm font-bold text-gray-700">
                                    {language === "es" ? "Actualizando registros vinculados…" : "Updating linked records…"}
                                </span>
                            </div>
                        </div>
                        </ModalPortal>
                    )}

                    {/* ── Import Staff Modal — paste names / upload CSV → diff → configure → commit ── */}
                    {showImportStaff && (
                        <ImportStaffModal
                            existingStaff={staffList}
                            defaultLocation={storeLocation || 'webster'}
                            language={language}
                            onCancel={() => setShowImportStaff(false)}
                            onImport={async (newStaffArray) => {
                                // Optimistic update + Firestore save. Functional
                                // setState avoids stale-closure clobber if a
                                // concurrent admin edit lands mid-import.
                                let latest = null;
                                setStaffList(prev => {
                                    latest = [...(prev || []), ...newStaffArray];
                                    return latest;
                                });
                                try {
                                    if (latest) await saveStaffToFirestore(latest);
                                    toast(language === 'es'
                                        ? `Importados ${newStaffArray.length} miembros del personal`
                                        : `Imported ${newStaffArray.length} staff member${newStaffArray.length === 1 ? '' : 's'}`,
                                        { kind: 'success', duration: 4000 });
                                    setShowImportStaff(false);
                                } catch (err) {
                                    console.error('Import staff save failed:', err);
                                    toast(language === 'es'
                                        ? 'Error al guardar la importación. Vuelve a intentarlo.'
                                        : 'Failed to save import. Try again.',
                                        { kind: 'error', duration: 6000 });
                                    // Roll back the optimistic add so the UI matches Firestore.
                                    setStaffList(prev => (prev || []).filter(s =>
                                        !newStaffArray.find(n => n.id === s.id)
                                    ));
                                }
                            }}
                        />
                    )}

                    {/* ── Required-task admin modal ── */}
                    {showRequiredTaskAdmin && (
                        <ReactSuspense fallback={<div className="fixed inset-0 bg-black/40 z-50" />}>
                            <RequiredTaskAdmin
                                staffList={staffList}
                                staffName={staffName}
                                language={language}
                                onClose={() => setShowRequiredTaskAdmin(false)}
                            />
                        </ReactSuspense>
                    )}

                    {/* ── Bulk Tag Modal — fast scheduleSide / isMinor tagging ── */}
                    {showBulkTag && (() => {
                        const search = bulkSearch.toLowerCase().trim();
                        const visible = staffList
                            .filter(s => staffFilter === "all" || s.location === staffFilter || s.location === "both")
                            .filter(s => !search || (s.name || "").toLowerCase().includes(search) || (s.role || "").toLowerCase().includes(search))
                            // Tagging-state filter (all / untagged / foh / boh)
                            .filter(s => {
                                if (bulkFilter === "all") return true;
                                if (bulkFilter === "untagged") return !s.scheduleSide;
                                if (bulkFilter === "foh") return s.scheduleSide === "foh";
                                if (bulkFilter === "boh") return s.scheduleSide === "boh";
                                return true;
                            })
                            .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
                        // Counts use the EXPLICIT field (no role inference) so the
                        // "Untagged" pill reflects the real state we're trying to fix.
                        const fohExplicit = staffList.filter(s => s.scheduleSide === "foh").length;
                        const bohExplicit = staffList.filter(s => s.scheduleSide === "boh").length;
                        const minorCount = staffList.filter(s => s.isMinor).length;
                        const untagged = staffList.filter(s => !s.scheduleSide).length;
                        const visibleIds = visible.map(s => s.id);
                        return (
                            <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
                                {/* Wider modal so the per-row controls (FOH/BOH, minor, recipes,
                                    ops, language, home view, target hours, availability) fit
                                    side-by-side without crowding. Two-column staff list on
                                    lg+ screens so admins can edit ~12 rows at a time without
                                    scrolling. */}
                                {/* Modal is one big scroll container instead of
                                    a sticky-header + flex-body split. Per
                                    Andrew: makes scrolling through staff
                                    much easier — the search/filters scroll
                                    out of view but the staff list gets the
                                    full vertical space. The 'Done' button at
                                    the bottom + the X in the (now scrolling)
                                    header are both reachable. */}
                                <div className="bg-white w-full sm:max-w-3xl lg:max-w-5xl xl:max-w-6xl sm:rounded-2xl rounded-t-2xl max-h-[95vh] sm:max-h-[92vh] overflow-y-auto">
                                    {/* Andrew 2026-05-20 — "in the bulk edit in
                                        the mobile version the scrolling needs a
                                        done up at the top that floats. its too
                                        long to scroll to the bottom to exit."
                                        Sticky header now carries a prominent
                                        Done button (was a tiny ×) so the exit
                                        affordance is reachable from any scroll
                                        position. Bottom Done stays as a
                                        secondary tap target. */}
                                    <div className="border-b border-gray-200 p-3 sm:p-4 sticky top-0 bg-white z-10 safe-top sm:[--safe-top-base:1rem]">
                                        <div className="flex items-center justify-between gap-2">
                                            <h3 className="text-base sm:text-lg font-bold text-purple-700 truncate">🏷 {language === "es" ? "Etiquetar Personal" : "Bulk Tag Staff"}</h3>
                                            <button onClick={() => { setShowBulkTag(false); setBulkSearch(""); }}
                                                className="flex-shrink-0 px-4 py-2 rounded-full bg-purple-600 text-white text-sm font-bold hover:bg-purple-700 active:scale-95 transition shadow-sm">
                                                ✓ {language === "es" ? "Listo" : "Done"}
                                            </button>
                                        </div>
                                    </div>
                                    <div className="p-4">
                                        <p className="text-xs text-gray-500 mb-2">
                                            {language === "es"
                                                ? "Toca para alternar. Los cambios se guardan al instante."
                                                : "Tap to flip. Changes save instantly."}
                                        </p>
                                        <div className="flex flex-wrap gap-2 text-[10px] mb-2">
                                            <span className="px-2 py-0.5 rounded-full bg-teal-100 text-teal-800 font-bold">FOH: {fohExplicit}</span>
                                            <span className="px-2 py-0.5 rounded-full bg-orange-100 text-orange-800 font-bold">BOH: {bohExplicit}</span>
                                            <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-bold">🔑 {language === "es" ? "Menores" : "Minors"}: {minorCount}</span>
                                            {untagged > 0 && <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-800 font-bold">⚠ {language === "es" ? "Sin etiqueta" : "Untagged"}: {untagged}</span>}
                                        </div>

                                        {/* Auto-tag — one-shot fill of every untagged staff using role inference. */}
                                        {untagged > 0 && (
                                            <button onClick={autoTagUntagged}
                                                className="w-full mb-2 py-2 rounded-lg bg-purple-600 text-white text-sm font-bold hover:bg-purple-700">
                                                ✨ {language === "es" ? `Auto-etiquetar ${untagged} pendientes (por rol)` : `Auto-tag ${untagged} untagged (from role)`}
                                            </button>
                                        )}
                                        {/* Grant Recipes to all — one-shot migration helper for the
                                            opt-OUT recipes policy. Use after first deploy of the new
                                            policy or after onboarding a batch of new hires. */}
                                        <button onClick={grantRecipesToAll}
                                            className="w-full mb-2 py-2 rounded-lg bg-green-600 text-white text-sm font-bold hover:bg-green-700">
                                            🧑‍🍳 {language === "es" ? "Dar acceso a Recetas a TODO el personal" : "Grant Recipes access to ALL staff"}
                                        </button>

                                        {/* Filter chips — narrow the list quickly */}
                                        <div className="flex gap-1 mb-2">
                                            {[
                                                { id: "all",      labelEn: `All (${staffList.length})`, labelEs: `Todos (${staffList.length})` },
                                                { id: "untagged", labelEn: `Untagged (${untagged})`,    labelEs: `Sin etiq. (${untagged})` },
                                                { id: "foh",      labelEn: `FOH (${fohExplicit})`,      labelEs: `FOH (${fohExplicit})` },
                                                { id: "boh",      labelEn: `BOH (${bohExplicit})`,      labelEs: `BOH (${bohExplicit})` },
                                            ].map(f => (
                                                <button key={f.id} onClick={() => setBulkFilter(f.id)}
                                                    className={`flex-1 py-1.5 rounded-md text-[10px] font-bold border ${
                                                        bulkFilter === f.id
                                                            ? "bg-purple-600 text-white border-purple-600"
                                                            : "bg-white text-gray-600 border-gray-300"
                                                    }`}>
                                                    {language === "es" ? f.labelEs : f.labelEn}
                                                </button>
                                            ))}
                                        </div>

                                        <input type="text" value={bulkSearch} onChange={e => setBulkSearch(e.target.value)}
                                            placeholder={language === "es" ? "Buscar nombre o rol…" : "Search name or role…"}
                                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-2" />

                                        {/* Sweep-visible buttons — flip every visible staff to FOH or BOH at once.
                                            Useful after filtering: "show me all the prep staff who got tagged FOH by
                                            mistake → bulk flip them to BOH." */}
                                        {visible.length > 0 && bulkFilter !== "all" && (
                                            <div className="flex gap-1 text-[10px]">
                                                <button onClick={() => bulkSetSide(visibleIds, "foh")}
                                                    className="flex-1 py-1.5 rounded-md bg-teal-100 text-teal-800 font-bold border border-teal-300 hover:bg-teal-200">
                                                    → {language === "es" ? `Marcar ${visible.length} como FOH` : `Tag ${visible.length} as FOH`}
                                                </button>
                                                <button onClick={() => bulkSetSide(visibleIds, "boh")}
                                                    className="flex-1 py-1.5 rounded-md bg-orange-100 text-orange-800 font-bold border border-orange-300 hover:bg-orange-200">
                                                    → {language === "es" ? `Marcar ${visible.length} como BOH` : `Tag ${visible.length} as BOH`}
                                                </button>
                                            </div>
                                        )}
                                        {/* Bulk toggle section — sweep ON/OFF for every staff currently
                                            visible (after search + filter). Operates on `visibleIds`,
                                            so first narrow the list with the filter chips + search box,
                                            then hit a button. Acts on the displayed staff only.
                                            COLLAPSED by default to give the staff list more room —
                                            click the header to expand. */}
                                        {visible.length > 0 && (
                                            <div className="mt-2 pt-2 border-t border-gray-200">
                                                <button
                                                    onClick={() => setBulkTogglesOpen(o => !o)}
                                                    className="w-full flex items-center justify-between px-2 py-1.5 rounded-md text-[10px] font-bold text-gray-700 bg-gray-50 hover:bg-gray-100 border border-gray-200"
                                                    aria-expanded={bulkTogglesOpen}>
                                                    <span>
                                                        🔁 {language === "es" ? `Toggles en lote (${visible.length} visibles)` : `Bulk toggles (${visible.length} visible)`}
                                                    </span>
                                                    <span className="text-gray-400">{bulkTogglesOpen ? '▴' : '▾'}</span>
                                                </button>
                                            </div>
                                        )}
                                        {visible.length > 0 && bulkTogglesOpen && (
                                            <div className="mt-2 px-2 py-2 rounded-md bg-gray-50 border border-gray-200">
                                                {[
                                                    { field: "recipesAccess",        labelEn: "Recipes",      labelEs: "Recetas",      emoji: "🧑‍🍳", onColor: "bg-green-600",  offColor: "bg-gray-300" },
                                                    { field: "opsAccess",            labelEn: "Operations",   labelEs: "Operaciones",  emoji: "📋", onColor: "bg-mint-700",   offColor: "bg-gray-300" },
                                                    { field: "viewLabor",            labelEn: "Labor %",      labelEs: "Mano obra %",  emoji: "📊", onColor: "bg-emerald-600", offColor: "bg-gray-300" },
                                                    { field: "shiftLead",            labelEn: "Shift Lead",   labelEs: "Líder",        emoji: "🛡️", onColor: "bg-purple-600", offColor: "bg-gray-300" },
                                                    { field: "canEditScheduleFOH",   labelEn: "FOH editor",   labelEs: "Editor FOH",   emoji: "📅", onColor: "bg-teal-600",   offColor: "bg-gray-300" },
                                                    { field: "canEditScheduleBOH",   labelEn: "BOH editor",   labelEs: "Editor BOH",   emoji: "📅", onColor: "bg-orange-600", offColor: "bg-gray-300" },
                                                    { field: "canViewOnboarding",    labelEn: "Onboarding (PII)", labelEs: "Onboarding (PII)", emoji: "🪪", onColor: "bg-rose-700",   offColor: "bg-gray-300" },
                                                    { field: "canReceive86Alerts",   labelEn: "86 alerts (push)", labelEs: "Alertas 86 (push)", emoji: "🚫", onColor: "bg-red-700", offColor: "bg-gray-300" },
                                                    // smsOptIn intentionally NOT here — its bulk
                                                    // path needs the audit-event side-effect that
                                                    // bulkSetField doesn't provide. A dedicated
                                                    // SMS row sits just below this table.
                                                ].map(t => (
                                                    <div key={t.field} className="flex items-center gap-1 mb-1">
                                                        <div className="flex-1 text-[10px] font-bold text-gray-700 truncate">
                                                            {t.emoji} {language === "es" ? t.labelEs : t.labelEn}
                                                        </div>
                                                        <button onClick={() => {
                                                            // 2026-06-20 (QA audit AD3) — confirm a mass PII-access flip.
                                                            // canViewOnboarding gates SSN/W-4/I-9/DL-photo access; one
                                                            // fat-finger on a broad filter shouldn't grant it to everyone.
                                                            if (t.field === 'canViewOnboarding' && !window.confirm(language === "es"
                                                                ? `¿Activar acceso a Onboarding (datos sensibles) para ${visible.length} personas?`
                                                                : `Turn Onboarding (PII) access ON for ${visible.length} staff?`)) return;
                                                            bulkSetField(visibleIds, t.field, true);
                                                        }}
                                                            className={`px-2 py-1 rounded text-[9px] font-bold text-white ${t.onColor} hover:opacity-90`}
                                                            title={language === "es" ? `Activar para ${visible.length}` : `Turn ON for ${visible.length}`}>
                                                            ON
                                                        </button>
                                                        <button onClick={() => {
                                                            if (t.field === 'canViewOnboarding' && !window.confirm(language === "es"
                                                                ? `¿Quitar acceso a Onboarding (datos sensibles) para ${visible.length} personas?`
                                                                : `Turn Onboarding (PII) access OFF for ${visible.length} staff?`)) return;
                                                            bulkSetField(visibleIds, t.field, false);
                                                        }}
                                                            className={`px-2 py-1 rounded text-[9px] font-bold text-white ${t.offColor} hover:opacity-90`}
                                                            title={language === "es" ? `Desactivar para ${visible.length}` : `Turn OFF for ${visible.length}`}>
                                                            OFF
                                                        </button>
                                                    </div>
                                                ))}
                                                {/* SMS opt-in sweep — separate from the generic ON/OFF
                                                    rows above because flipping smsOptIn must ALSO write
                                                    a row to sms_opt_in_events (compliance audit). The
                                                    bulk handler captures one row per staff. */}
                                                <div className="flex items-center gap-1 mb-1">
                                                    <div className="flex-1 text-[10px] font-bold text-gray-700 truncate">
                                                        📱 {language === "es" ? "SMS solo para urgente" : "SMS for urgent only"}
                                                    </div>
                                                    <button onClick={() => {
                                                        // 2026-06-20 (QA audit AD3) — SMS opt-in is a legal (TCPA)
                                                        // consent flag with an audit trail; confirm a mass opt-in.
                                                        if (!window.confirm(language === "es"
                                                            ? `¿Inscribir a ${visible.length} personas en SMS? (consentimiento)`
                                                            : `Opt ${visible.length} staff IN to SMS? (consent)`)) return;
                                                        bulkSmsOptIn(visibleIds, true);
                                                    }}
                                                        className="px-2 py-1 rounded text-[9px] font-bold text-white bg-green-700 hover:opacity-90"
                                                        title={language === "es" ? `Activar SMS para ${visible.length}` : `Opt IN ${visible.length} to SMS`}>
                                                        ON
                                                    </button>
                                                    <button onClick={() => {
                                                        if (!window.confirm(language === "es"
                                                            ? `¿Desactivar SMS para ${visible.length} personas?`
                                                            : `Opt ${visible.length} staff OUT of SMS?`)) return;
                                                        bulkSmsOptIn(visibleIds, false);
                                                    }}
                                                        className="px-2 py-1 rounded text-[9px] font-bold text-white bg-gray-300 hover:opacity-90"
                                                        title={language === "es" ? `Desactivar SMS para ${visible.length}` : `Opt OUT ${visible.length} from SMS`}>
                                                        OFF
                                                    </button>
                                                </div>

                                                {/* Language sweep — set ALL visible to a single language at once.
                                                    Two buttons (EN / ES) instead of ON/OFF since this is a value
                                                    not a flag. */}
                                                <div className="flex items-center gap-1 mb-1">
                                                    <div className="flex-1 text-[10px] font-bold text-gray-700 truncate">
                                                        🗣 {language === "es" ? "Idioma de notificaciones" : "Notification language"}
                                                    </div>
                                                    <button onClick={() => bulkSetField(visibleIds, "preferredLanguage", "en")}
                                                        className="px-2 py-1 rounded text-[9px] font-bold text-white bg-blue-600 hover:opacity-90"
                                                        title={language === "es" ? `English para ${visible.length}` : `English for ${visible.length}`}>
                                                        EN
                                                    </button>
                                                    <button onClick={() => bulkSetField(visibleIds, "preferredLanguage", "es")}
                                                        className="px-2 py-1 rounded text-[9px] font-bold text-white bg-blue-800 hover:opacity-90"
                                                        title={language === "es" ? `Español para ${visible.length}` : `Spanish for ${visible.length}`}>
                                                        ES
                                                    </button>
                                                </div>
                                                {/* Home view sweep — set the landing tab for all visible at once.
                                                    Common patterns: "All FOH → Schedule home" or "All trainees →
                                                    Training home" or "All BOH → Recipes home". */}
                                                <div className="flex items-center gap-1 mb-1">
                                                    <div className="flex-1 text-[10px] font-bold text-gray-700 truncate">
                                                        🏠 {language === "es" ? "Vista de inicio" : "Home view"}
                                                    </div>
                                                    <select onChange={e => { if (e.target.value) { bulkSetField(visibleIds, "homeView", e.target.value); e.target.value = ''; } }}
                                                        className="text-[9px] font-bold border border-gray-300 rounded px-1 py-1 bg-white max-w-[110px]"
                                                        defaultValue="">
                                                        <option value="">{language === "es" ? `Aplicar a ${visible.length}…` : `Apply to ${visible.length}…`}</option>
                                                        <option value="auto">🏠 {language === "es" ? "Predet." : "Default"}</option>
                                                        <option value="schedule">📅 {language === "es" ? "Horario" : "Schedule"}</option>
                                                        <option value="recipes">🧑‍🍳 {language === "es" ? "Recetas" : "Recipes"}</option>
                                                        <option value="operations">📋 {language === "es" ? "Operaciones" : "Operations"}</option>
                                                        <option value="training">📚 {language === "es" ? "Capacit." : "Training"}</option>
                                                        <option value="menu">🍜 {language === "es" ? "Menú" : "Menu"}</option>
                                                        <option value="eighty6">🚫 86</option>
                                                    </select>
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    <div className="p-2 space-y-1 lg:grid lg:grid-cols-2 lg:gap-2 lg:space-y-0">
                                        {visible.length === 0 && (
                                            <p className="text-center text-gray-400 text-sm py-8">{language === "es" ? "Sin resultados." : "No results."}</p>
                                        )}
                                        {/* CARD-LAYOUT bulk edit: each staff member is a full
                                            card with controls grouped into clearly-labeled rows.
                                            Was a 1-line cramped strip — controls were 8x8 icon
                                            buttons with no labels, very hard to use during a real
                                            admin session. New layout: 3 rows per card on phone, all
                                            inline on lg+. Each toggle has visible label text so
                                            admins know what they're flipping. */}
                                        {visible.map(s => {
                                            const side = s.scheduleSide || (s.role && ["BOH","Pho","Pho Station","Grill","Fryer","Fried Rice","Dish","Bao/Tacos/Banh Mi","Spring Rolls/Prep","Prep","Kitchen Manager","Asst Kitchen Manager"].includes(s.role) ? "boh" : "foh");
                                            const explicitTagged = !!s.scheduleSide;
                                            const rec = s.recipesAccess !== false;
                                            const ops = s.opsAccess === true;
                                            const labor = s.viewLabor === true || (s.viewLabor !== false && /manager|owner/i.test(s.role || ''));
                                            const lng = s.preferredLanguage === "es" ? "es" : "en";
                                            const cur = s.homeView || 'auto';
                                            return (
                                                <div key={s.id} className={`p-3 rounded-xl border-2 transition ${explicitTagged ? "bg-white border-dd-line" : "bg-red-50 border-red-200"}`}>
                                                    {/* HEADER ROW — name + role + side toggle */}
                                                    <div className="flex items-center gap-3 mb-3">
                                                        <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${side === 'foh' ? 'bg-dd-green-50 text-dd-green-700 border-2 border-dd-green/30' : 'bg-orange-50 text-orange-700 border-2 border-orange-200'}`}>
                                                            {(s.name || '??').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                                                        </div>
                                                        <div className="min-w-0 flex-1">
                                                            <div className="font-bold text-sm text-dd-text truncate flex items-center gap-1.5">
                                                                {s.name}
                                                                {!explicitTagged && <span className="text-[10px] text-red-600 font-bold uppercase tracking-wider">⚠ {language === "es" ? "inferido" : "inferred"}</span>}
                                                            </div>
                                                            <div className="text-[11px] text-dd-text-2 truncate">{s.role} · {LOCATION_LABELS[s.location] || s.location}</div>
                                                        </div>
                                                        <div className="flex gap-1 bg-dd-bg rounded-lg p-0.5 border border-dd-line">
                                                            <button onClick={() => handleBulkUpdate(s.id, { scheduleSide: "foh" })}
                                                                className={`px-3 py-1 rounded-md text-[11px] font-bold transition ${side === "foh" && explicitTagged ? "bg-dd-green text-white shadow-sm" : "text-dd-text-2 hover:bg-white"}`}>
                                                                FOH
                                                            </button>
                                                            <button onClick={() => handleBulkUpdate(s.id, { scheduleSide: "boh" })}
                                                                className={`px-3 py-1 rounded-md text-[11px] font-bold transition ${side === "boh" && explicitTagged ? "bg-orange-600 text-white shadow-sm" : "text-dd-text-2 hover:bg-white"}`}>
                                                                BOH
                                                            </button>
                                                        </div>
                                                    </div>

                                                    {/* LOCATION ROW — where this person works (eligibility)
                                                        AND, when location === 'both', their home store
                                                        (scheduleHome — which schedule grid they live on by
                                                        default). Added 2026-05-15 so admins can fix the
                                                        "appears on both grids but only fills in at one"
                                                        problem without opening the per-staff edit modal.
                                                        When location flips OFF 'both', scheduleHome is
                                                        mirrored to the new location to keep the data
                                                        consistent. */}
                                                    {(() => {
                                                        const loc = s.location || 'webster';
                                                        const home = s.scheduleHome || s.location || 'both';
                                                        const setLoc = (next) => {
                                                            // Mirror scheduleHome to location for non-both
                                                            // locations so getScheduleHome doesn't return
                                                            // a stale value.
                                                            const patch = { location: next };
                                                            if (next !== 'both') patch.scheduleHome = next;
                                                            handleBulkUpdate(s.id, patch);
                                                        };
                                                        return (
                                                            <div className="mb-3">
                                                                <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1.5">
                                                                    {language === "es" ? "Ubicación" : "Location"}
                                                                </div>
                                                                <div className="flex flex-wrap gap-1.5">
                                                                    <button onClick={() => setLoc("webster")}
                                                                        className={`px-2.5 py-1 rounded-md text-[11px] font-bold border transition ${loc === "webster" ? "bg-emerald-600 text-white border-emerald-600" : "bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg"}`}>
                                                                        Webster
                                                                    </button>
                                                                    <button onClick={() => setLoc("maryland")}
                                                                        className={`px-2.5 py-1 rounded-md text-[11px] font-bold border transition ${loc === "maryland" ? "bg-purple-600 text-white border-purple-600" : "bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg"}`}>
                                                                        Maryland Hts
                                                                    </button>
                                                                    <button onClick={() => setLoc("both")}
                                                                        className={`px-2.5 py-1 rounded-md text-[11px] font-bold border transition ${loc === "both" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg"}`}>
                                                                        {language === "es" ? "Ambas" : "Both"}
                                                                    </button>
                                                                </div>
                                                                {/* Home-store picker — only meaningful when
                                                                    location === 'both'. Lets a floater LIVE on
                                                                    one grid by default; still eligible at the
                                                                    other store via Add Shift. */}
                                                                {loc === 'both' && (
                                                                    <div className="mt-2 pl-2 border-l-2 border-amber-300 bg-amber-50 rounded-r-md py-1.5 pr-2">
                                                                        <div className="text-[10px] font-bold uppercase tracking-wider text-amber-700 mb-1">
                                                                            {language === "es" ? "Horario principal" : "Home schedule"}
                                                                        </div>
                                                                        <div className="flex flex-wrap gap-1.5">
                                                                            <button onClick={() => handleBulkUpdate(s.id, { scheduleHome: "webster" })}
                                                                                className={`px-2 py-0.5 rounded text-[10px] font-bold border transition ${home === "webster" ? "bg-emerald-600 text-white border-emerald-600" : "bg-white text-dd-text-2 border-dd-line"}`}>
                                                                                Webster
                                                                            </button>
                                                                            <button onClick={() => handleBulkUpdate(s.id, { scheduleHome: "maryland" })}
                                                                                className={`px-2 py-0.5 rounded text-[10px] font-bold border transition ${home === "maryland" ? "bg-purple-600 text-white border-purple-600" : "bg-white text-dd-text-2 border-dd-line"}`}>
                                                                                Maryland
                                                                            </button>
                                                                            <button onClick={() => handleBulkUpdate(s.id, { scheduleHome: "both" })}
                                                                                className={`px-2 py-0.5 rounded text-[10px] font-bold border transition ${home === "both" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-dd-text-2 border-dd-line"}`}>
                                                                                {language === "es" ? "Ambas" : "Both"}
                                                                            </button>
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })()}

                                                    {/* PAGE ACCESS ROW — what this person can SEE.
                                                        Includes the new viewLabor toggle (was missing). */}
                                                    <div className="mb-3">
                                                        <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1.5">
                                                            {language === "es" ? "Acceso a páginas" : "Page access"}
                                                        </div>
                                                        <div className="flex flex-wrap gap-1.5">
                                                            <AccessToggle
                                                                on={rec} label={language === "es" ? "Recetas" : "Recipes"} icon="🧑‍🍳"
                                                                onClick={() => handleBulkUpdate(s.id, { recipesAccess: !rec })} />
                                                            <AccessToggle
                                                                on={ops} label={language === "es" ? "Operaciones" : "Operations"} icon="📋"
                                                                onClick={() => handleBulkUpdate(s.id, { opsAccess: !ops })} />
                                                            <AccessToggle
                                                                on={labor} label={language === "es" ? "Labor %" : "Labor %"} icon="📊"
                                                                onClick={() => handleBulkUpdate(s.id, { viewLabor: !labor })} />
                                                            <AccessToggle
                                                                on={!!s.shiftLead} label={language === "es" ? "Líder" : "Lead"} icon="🛡"
                                                                onClick={() => handleBulkUpdate(s.id, { shiftLead: !s.shiftLead })} />
                                                            <AccessToggle
                                                                on={!!s.isMinor} label={language === "es" ? "Menor" : "Minor"} icon="🔑"
                                                                onClick={() => handleBulkUpdate(s.id, { isMinor: !s.isMinor })} />
                                                            <AccessToggle
                                                                on={!!s.canReceive86Alerts} label={language === "es" ? "Alertas 86" : "86 alerts"} icon="🚫"
                                                                onClick={() => handleBulkUpdate(s.id, { canReceive86Alerts: !s.canReceive86Alerts })} />
                                                            {/* Hide-from-schedule — owners/admins who shouldn't
                                                                have a row on the grid. 2026-05-16. */}
                                                            <AccessToggle
                                                                on={!!s.hideFromSchedule}
                                                                label={language === "es" ? "Sin horario" : "Off grid"}
                                                                icon="👻"
                                                                onClick={() => handleBulkUpdate(s.id, { hideFromSchedule: !s.hideFromSchedule })} />
                                                        </div>
                                                    </div>

                                                    {/* HIDDEN PAGES ROW — admin can hide tabs from this
                                                        staff. Default = nothing hidden (all visible).
                                                        Click a chip to toggle hidden state. */}
                                                    {(() => {
                                                        const hidden = Array.isArray(s.hiddenPages) ? s.hiddenPages : [];
                                                        const togglePage = (pageId) => {
                                                            const next = hidden.includes(pageId)
                                                                ? hidden.filter(p => p !== pageId)
                                                                : [...hidden, pageId];
                                                            handleBulkUpdate(s.id, { hiddenPages: next });
                                                        };
                                                        return (
                                                            <div className="mb-3">
                                                                <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1.5">
                                                                    {language === "es" ? "Pestañas ocultas" : "Hidden tabs"}
                                                                </div>
                                                                <div className="flex flex-wrap gap-1.5">
                                                                    {HIDEABLE_PAGES.map(pg => {
                                                                        const isHidden = hidden.includes(pg.id);
                                                                        return (
                                                                            <button key={pg.id} onClick={() => togglePage(pg.id)}
                                                                                title={language === "es"
                                                                                    ? (isHidden ? `${pg.labelEs} está OCULTA — clic para mostrar` : `${pg.labelEs} es VISIBLE — clic para ocultar`)
                                                                                    : (isHidden ? `${pg.labelEn} is HIDDEN — click to show` : `${pg.labelEn} is VISIBLE — click to hide`)}
                                                                                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition active:scale-95 ${
                                                                                    isHidden
                                                                                        ? 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
                                                                                        : 'bg-white text-dd-text-2 border-dd-line opacity-60 hover:opacity-100'
                                                                                }`}>
                                                                                <span className="text-sm">{pg.emoji}</span>
                                                                                <span>{language === "es" ? pg.labelEs : pg.labelEn}</span>
                                                                                {isHidden && <span className="text-[10px]">🚫</span>}
                                                                            </button>
                                                                        );
                                                                    })}
                                                                </div>
                                                            </div>
                                                        );
                                                    })()}

                                                    {/* SETTINGS ROW — quick prefs the admin tunes per-staff.
                                                        Always visible, never hidden behind another modal. */}
                                                    <div>
                                                        <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1.5">
                                                            {language === "es" ? "Preferencias" : "Settings"}
                                                        </div>
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <label className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-dd-text-2">
                                                                {language === "es" ? "Inicio:" : "Default tab:"}
                                                                <select value={cur}
                                                                    onChange={e => handleBulkUpdate(s.id, { homeView: e.target.value })}
                                                                    className="border border-dd-line rounded-md px-2 py-1 text-xs bg-white font-bold text-dd-text focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50">
                                                                    <option value="auto">🏠 {language === "es" ? "Auto" : "Auto"}</option>
                                                                    <option value="schedule">📅 {language === "es" ? "Horario" : "Schedule"}</option>
                                                                    <option value="recipes">📖 {language === "es" ? "Recetas" : "Recipes"}</option>
                                                                    <option value="operations">📋 {language === "es" ? "Ops" : "Ops"}</option>
                                                                    <option value="training">📚 {language === "es" ? "Capac." : "Training"}</option>
                                                                    <option value="menu">🍜 {language === "es" ? "Menú" : "Menu"}</option>
                                                                    <option value="eighty6">🚫 86</option>
                                                                    <option value="handoff">🤝 {language === "es" ? "Entrega" : "Handoff"}</option>
                                                                    <option value="tardies">⏰ {language === "es" ? "Tardanzas" : "Tardies"}</option>
                                                                    <option value="labor">📊 Labor</option>
                                                                </select>
                                                            </label>
                                                            <label className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-dd-text-2">
                                                                {language === "es" ? "Idioma:" : "Lang:"}
                                                                <button onClick={() => handleBulkUpdate(s.id, { preferredLanguage: lng === "es" ? "en" : "es" })}
                                                                    className="px-2.5 py-1 rounded-md text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition">
                                                                    {lng.toUpperCase()}
                                                                </button>
                                                            </label>
                                                            <label className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-dd-text-2">
                                                                {language === "es" ? "Hrs/sem:" : "Hrs/wk:"}
                                                                <input type="number" inputMode="numeric" pattern="[0-9]*" min="0" max="80" step="1"
                                                                    value={s.targetHours || 0}
                                                                    onChange={e => handleBulkUpdate(s.id, { targetHours: Number(e.target.value) || 0 })}
                                                                    className="w-14 text-center text-xs font-bold border border-dd-line rounded-md py-1 text-dd-text focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50" />
                                                            </label>
                                                            <button onClick={() => { setShowBulkTag(false); setAvailabilityForId(s.id); }}
                                                                title={language === "es" ? "Disponibilidad" : "Availability"}
                                                                className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold bg-white border border-dd-line text-dd-text-2 hover:bg-dd-bg transition">
                                                                🗓 {language === "es" ? "Disponib." : "Avail"}
                                                            </button>
                                                        </div>

                                                        {/* SMS row — phone number, status pill, opt-in toggle.
                                                            Live edit: typing in the phone field commits on blur
                                                            (or Enter) via setPhoneForStaff which normalizes to
                                                            E.164 and rejects bad input with a toast. Toggle calls
                                                            setSmsOptInForStaff which writes an audit event row. */}
                                                        {(() => {
                                                            const pill = smsStatusPill(s);
                                                            const phoneDraftKey = `phoneDraft_${s.id}`;
                                                            const draft = phoneDrafts[phoneDraftKey];
                                                            const displayValue = draft !== undefined
                                                                ? draft
                                                                : formatE164ForDisplay(s.phoneE164 || '');
                                                            const isStopped = s.smsStopped === true;
                                                            return (
                                                                <div className="mt-2 pt-2 border-t border-dd-line/40">
                                                                    <div className="flex flex-wrap items-center gap-2">
                                                                        <span className="text-[10px] font-bold text-dd-text-2 uppercase tracking-wider">
                                                                            📱 SMS
                                                                        </span>
                                                                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${pill.tone}`}>
                                                                            {language === "es" ? pill.label.es : pill.label.en}
                                                                        </span>
                                                                        <input
                                                                            type="tel"
                                                                            inputMode="tel"
                                                                            placeholder={language === "es" ? "(314) 555-1234" : "(314) 555-1234"}
                                                                            value={displayValue}
                                                                            onChange={e => setPhoneDrafts(prev => ({ ...prev, [phoneDraftKey]: e.target.value }))}
                                                                            onBlur={async () => {
                                                                                const raw = phoneDrafts[phoneDraftKey];
                                                                                if (raw === undefined) return;
                                                                                await setPhoneForStaff(s, raw);
                                                                                setPhoneDrafts(prev => {
                                                                                    const next = { ...prev };
                                                                                    delete next[phoneDraftKey];
                                                                                    return next;
                                                                                });
                                                                            }}
                                                                            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                                                            className="flex-1 min-w-[150px] max-w-[200px] text-xs border border-dd-line rounded-md px-2 py-1 font-mono text-dd-text focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50"
                                                                        />
                                                                        <button
                                                                            onClick={() => setSmsOptInForStaff(s, !s.smsOptIn)}
                                                                            disabled={isStopped || !s.phoneE164}
                                                                            title={isStopped
                                                                                ? (language === "es"
                                                                                    ? "El staffer respondió STOP. Solo START por SMS puede reactivar."
                                                                                    : "Staffer replied STOP. Only an inbound START can re-enable.")
                                                                                : !s.phoneE164
                                                                                    ? (language === "es" ? "Agrega un teléfono primero" : "Add a phone first")
                                                                                    : (language === "es"
                                                                                        ? (s.smsOptIn ? "Desactivar SMS" : "Activar SMS")
                                                                                        : (s.smsOptIn ? "Opt OUT of SMS" : "Opt IN to SMS"))}
                                                                            className={`px-2.5 py-1 rounded-md text-[11px] font-bold border transition ${
                                                                                isStopped
                                                                                    ? 'bg-red-50 text-red-600 border-red-200 cursor-not-allowed'
                                                                                : !s.phoneE164
                                                                                    ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
                                                                                : s.smsOptIn
                                                                                    ? 'bg-green-100 text-green-700 border-green-300 hover:bg-green-200'
                                                                                    : 'bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg'
                                                                            }`}>
                                                                            {s.smsOptIn
                                                                                ? (language === "es" ? "✓ Activo" : "✓ Opted in")
                                                                                : (language === "es" ? "Activar" : "Opt in")}
                                                                        </button>
                                                                    </div>
                                                                    {s.smsLastSentAt && (
                                                                        <div className="text-[10px] text-dd-text-2 mt-1">
                                                                            {language === "es" ? "Último envío: " : "Last sent: "}
                                                                            {(() => {
                                                                                try {
                                                                                    const ts = typeof s.smsLastSentAt === 'string'
                                                                                        ? new Date(s.smsLastSentAt)
                                                                                        : (s.smsLastSentAt.toDate ? s.smsLastSentAt.toDate() : new Date(s.smsLastSentAt));
                                                                                    return ts.toLocaleString(language === 'es' ? 'es' : 'en', {
                                                                                        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                                                                                    });
                                                                                } catch { return '—'; }
                                                                            })()}
                                                                            {s.smsLastDeliveryStatus && ` · ${s.smsLastDeliveryStatus}`}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            );
                                                        })()}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>

                                    <div className="border-t border-gray-200 p-3">
                                        <button onClick={() => { setShowBulkTag(false); setBulkSearch(""); }}
                                            className="w-full py-2 rounded-lg bg-purple-700 text-white font-bold">{language === "es" ? "Listo" : "Done"}</button>
                                    </div>
                                </div>
                            </div>
                        );
                    })()}

                    {/* ── RECIPE AUDIT — who opened what, when, where ────────────────
                        Real audit trail backing the "Your name is logged on every
                        view" disclaimer in Recipes.jsx. Each accordion expand writes
                        to /recipe_views {staffName, recipeTitle, viewedAt, geoStatus,
                        userAgent}. If a recipe ever leaks, we have a starting point. */}
                    {(() => {
                        const shown = showAllViews ? recipeViews : recipeViews.slice(0, 25);
                        const fmtTime = (ts) => {
                            if (!ts) return '—';
                            try {
                                const d = ts.toDate ? ts.toDate() : new Date(ts);
                                return d.toLocaleString(language === 'es' ? 'es' : 'en', {
                                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                                });
                            } catch { return '—'; }
                        };
                        const geoBadge = (k) => {
                            if (k === 'inside')   return { c: 'bg-green-100 text-green-700',  t: language === 'es' ? 'En tienda' : 'In-store' };
                            if (k === 'admin')    return { c: 'bg-purple-100 text-purple-700', t: 'Admin' };
                            if (k === 'denied')   return { c: 'bg-amber-100 text-amber-700',  t: language === 'es' ? 'GPS denegado' : 'GPS denied' };
                            if (k === 'error')    return { c: 'bg-amber-100 text-amber-700',  t: language === 'es' ? 'GPS error' : 'GPS err' };
                            if (k === 'outside')  return { c: 'bg-red-100 text-red-700',      t: language === 'es' ? 'Fuera' : 'Off-prem' };
                            return { c: 'bg-gray-100 text-gray-600', t: '—' };
                        };
                        return (
                            <div className="mt-6 mb-4 border border-gray-200 rounded-xl bg-white p-4">
                                <button onClick={() => setRecipeAuditExpanded(s => !s)}
                                    className="w-full flex items-center justify-between mb-2 -m-1 p-1 rounded hover:bg-gray-50">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xl">🔍</span>
                                        <h3 className="text-base font-bold text-gray-800">
                                            {language === 'es' ? 'Auditoría de recetas' : 'Recipe view audit'}
                                        </h3>
                                    </div>
                                    <span className="text-gray-400 text-sm">{recipeAuditExpanded ? '▼' : '▶'}</span>
                                </button>
                                {recipeAuditExpanded && (<>
                                <p className="text-[11px] text-gray-500 mb-3">
                                    {language === 'es'
                                        ? 'Cada vez que alguien abre una receta queda registrado: quién, qué, cuándo y desde dónde. Las impresiones se marcan con 🖨 y el multiplicador (ej. 3×).'
                                        : 'Every time anyone opens a recipe it\'s logged: who, what, when, and from where. Prints are flagged 🖨 with the batch size (e.g. 3×).'}
                                </p>
                                {recipeViews.length === 0 ? (
                                    <p className="text-xs text-gray-400 italic">{language === 'es' ? 'Sin vistas registradas todavía.' : 'No views recorded yet.'}</p>
                                ) : (
                                    <div className="overflow-x-auto -mx-2">
                                        <table className="w-full text-[11px]">
                                            <thead>
                                                <tr className="text-gray-500 border-b">
                                                    <th className="text-left px-2 py-1 font-semibold">{language === 'es' ? 'Hora' : 'Time'}</th>
                                                    <th className="text-left px-2 py-1 font-semibold">{language === 'es' ? 'Empleado' : 'Staff'}</th>
                                                    <th className="text-left px-2 py-1 font-semibold">{language === 'es' ? 'Receta' : 'Recipe'}</th>
                                                    <th className="text-left px-2 py-1 font-semibold">{language === 'es' ? 'Ubicación' : 'Location'}</th>
                                                    <th className="text-center px-2 py-1 font-semibold" title={language === 'es' ? 'Señales sospechosas' : 'Suspicious signals'}>⚠️</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {shown.map(v => {
                                                    const g = geoBadge(v.geoStatus);
                                                    const sc  = v.screenshotShortcutCount || 0;
                                                    const qb  = v.quickBlurCount || 0;
                                                    const blr = v.blurCount || 0;
                                                    // Highlight rows where the desktop screenshot shortcut fired
                                                    // (definitive) OR more than 1 quick-blur happened (likely iOS
                                                    // screenshot, allowing 1 for an incidental notification).
                                                    const sus = sc > 0 || qb > 1;
                                                    return (
                                                        <tr key={v.id} className={`border-b last:border-0 ${sus ? 'bg-red-50' : ''}`}>
                                                            <td className="px-2 py-1 text-gray-700 whitespace-nowrap">{fmtTime(v.viewedAt)}</td>
                                                            <td className="px-2 py-1 text-gray-800 font-medium">{v.staffName || '—'}</td>
                                                            <td className="px-2 py-1 text-gray-700">
                                                                {v.recipeTitle || `#${v.recipeId}`}
                                                                {v.printed && (
                                                                    <span title={language === 'es'
                                                                            ? `Imprimió los ingredientes (lote ${v.printMultiplier || 1}×)`
                                                                            : `Printed the ingredients (${v.printMultiplier || 1}× batch)`}
                                                                        className="ml-1.5 inline-block bg-purple-100 text-purple-800 px-1.5 py-0.5 rounded font-bold whitespace-nowrap">
                                                                        🖨 {v.printMultiplier && v.printMultiplier !== 1 ? `${v.printMultiplier}×` : (language === 'es' ? 'impreso' : 'printed')}
                                                                    </span>
                                                                )}
                                                            </td>
                                                            <td className="px-2 py-1"><span className={`px-1.5 py-0.5 rounded ${g.c} font-semibold`}>{g.t}</span></td>
                                                            <td className="px-2 py-1 text-center">
                                                                {sc > 0 && (
                                                                    <span title={language === 'es' ? `Atajo de captura presionado ${sc}×` : `Screenshot shortcut pressed ${sc}×`}
                                                                        className="inline-block bg-red-200 text-red-800 px-1.5 py-0.5 rounded font-bold mr-1">📸 {sc}</span>
                                                                )}
                                                                {qb > 0 && (
                                                                    <span title={language === 'es' ? `Foco rápido (probable captura iOS) ${qb}×` : `Quick focus loss (likely iOS screenshot) ${qb}×`}
                                                                        className={`inline-block px-1.5 py-0.5 rounded font-bold mr-1 ${qb > 1 ? 'bg-amber-200 text-amber-800' : 'bg-amber-100 text-amber-700'}`}>👁 {qb}</span>
                                                                )}
                                                                {blr > 0 && sc === 0 && qb === 0 && (
                                                                    <span title={language === 'es' ? `Cambió de app ${blr}×` : `App-switched ${blr}×`}
                                                                        className="inline-block bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">↗ {blr}</span>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                        <div className="mt-2 text-[10px] text-gray-500 px-2 leading-relaxed">
                                            <span className="font-semibold">{language === 'es' ? 'Leyenda:' : 'Legend:'}</span>{' '}
                                            <span className="bg-red-200 text-red-800 px-1 rounded">📸</span> {language === 'es' ? 'atajo de captura (definitivo)' : 'screenshot shortcut (definitive)'} ·{' '}
                                            <span className="bg-amber-200 text-amber-800 px-1 rounded">👁</span> {language === 'es' ? 'foco rápido (probable captura iOS)' : 'quick focus loss (likely iOS screenshot)'} ·{' '}
                                            <span className="bg-gray-100 text-gray-600 px-1 rounded">↗</span> {language === 'es' ? 'cambió de app' : 'app-switched'}
                                        </div>
                                    </div>
                                )}
                                {recipeViews.length > 25 && (
                                    <button onClick={() => setShowAllViews(s => !s)}
                                        className="mt-2 text-[11px] font-bold text-mint-700">
                                        {showAllViews
                                            ? (language === 'es' ? 'Mostrar menos' : 'Show less')
                                            : (language === 'es' ? `Ver todas (${recipeViews.length})` : `View all (${recipeViews.length})`)}
                                    </button>
                                )}
                                </>)}
                            </div>
                        );
                    })()}

                    {/* ── LABOR HISTORY — past days' labor %, by hour (Andrew 2026-06-13) ── */}
                    <LaborHistoryPanel language={language} storeLocation={storeLocation} />

                    {/* ── INVENTORY AUDIT — who added/subtracted what, when ──────────
                        Parallel to the recipe-view audit. Every count change in
                        Operations.jsx already writes to /inventory_audits_{loc}
                        with { itemId, itemName, previous, next, delta, byStaff,
                        at, atLocal, dateKey }. This panel surfaces that history:
                        adds vs subtracts, who did it, what item, when, on which
                        side (webster/maryland), with date + staff + item + dir
                        filters. Use case: "why did the egg count drop by 6 yesterday?" */}
                    {(() => {
                        // ── filters ──
                        // 2026-05-24 audit fix: was using toISOString().slice(0,10)
                        // which returns UTC. dateKey on each audit row is written
                        // in Central time by Operations.jsx. After 6pm Central
                        // (00:00 UTC) UTC-today is one day ahead of Central-today,
                        // so the "today" filter returned ZERO rows — admins
                        // thought no inventory edits happened that evening.
                        // Build the keys in Central time to match storage.
                        const now = new Date();
                        const centralFmt = new Intl.DateTimeFormat('en-CA', {
                            timeZone: 'America/Chicago',
                            year: 'numeric', month: '2-digit', day: '2-digit',
                        });
                        const todayKey = centralFmt.format(now);
                        const yestKey = centralFmt.format(new Date(now.getTime() - 86400_000));
                        const weekAgoMs = now.getTime() - 7 * 86400_000;
                        const searchNorm = invAuditSearch.trim().toLowerCase();

                        const filtered = inventoryAudits.filter(r => {
                            // direction
                            if (invAuditDir === 'adds' && !((r.delta || 0) > 0)) return false;
                            if (invAuditDir === 'subs' && !((r.delta || 0) < 0)) return false;
                            // date — use dateKey for cheap match, fall back to at.toDate
                            const dk = r.dateKey || (r.at?.toDate?.()?.toISOString?.()?.slice(0, 10));
                            const atMs = r.at?.toMillis?.() ?? 0;
                            if (invAuditDateK === 'today' && dk !== todayKey) return false;
                            if (invAuditDateK === 'yest' && dk !== yestKey) return false;
                            if (invAuditDateK === 'week' && atMs < weekAgoMs) return false;
                            // staff
                            if (invAuditStaff && r.byStaff !== invAuditStaff) return false;
                            // item-name substring
                            if (searchNorm) {
                                const name = (r.itemName || r.itemId || '').toLowerCase();
                                if (!name.includes(searchNorm)) return false;
                            }
                            return true;
                        });

                        const totals = { adds: 0, subs: 0, addQty: 0, subQty: 0 };
                        for (const r of filtered) {
                            const d = Number(r.delta) || 0;
                            if (d > 0) { totals.adds++; totals.addQty += d; }
                            else if (d < 0) { totals.subs++; totals.subQty += Math.abs(d); }
                        }

                        const shown = showAllInvAudits ? filtered : filtered.slice(0, 25);

                        // Collect unique staff names that have audit rows
                        // — feeds the staff filter dropdown.
                        const staffSet = new Set();
                        for (const r of inventoryAudits) if (r.byStaff) staffSet.add(r.byStaff);
                        const staffOptions = Array.from(staffSet).sort();

                        const fmtTime = (ts) => {
                            if (!ts) return '—';
                            try {
                                const d = ts.toDate ? ts.toDate() : new Date(ts);
                                return d.toLocaleString(language === 'es' ? 'es' : 'en', {
                                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                                });
                            } catch { return '—'; }
                        };

                        return (
                            <div className="mt-4 mb-4 border border-gray-200 rounded-xl bg-white p-4">
                                <button onClick={() => setInventoryAuditExpanded(s => !s)}
                                    className="w-full flex items-center justify-between mb-2 -m-1 p-1 rounded hover:bg-gray-50">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xl">📋</span>
                                        <h3 className="text-base font-bold text-gray-800">
                                            {language === 'es' ? 'Auditoría de inventario' : 'Inventory audit'}
                                        </h3>
                                    </div>
                                    <span className="text-gray-400 text-sm">{inventoryAuditExpanded ? '▼' : '▶'}</span>
                                </button>
                                {inventoryAuditExpanded && (<>
                                    <p className="text-[11px] text-gray-500 mb-3">
                                        {language === 'es'
                                            ? 'Cada vez que alguien sube o baja una cantidad queda registrado: quién, qué, cuándo, cuánto. Útil para "¿por qué bajaron los huevos ayer?".'
                                            : 'Every time someone adds or subtracts an inventory count it\'s logged: who, what item, when, by how much. Answers "why did eggs drop yesterday?"'}
                                    </p>

                                    {/* Filter bar */}
                                    <div className="flex flex-wrap gap-1.5 mb-3 text-[11px]">
                                        {/* direction */}
                                        <div className="inline-flex border border-dd-line rounded-md overflow-hidden">
                                            {[
                                                { k: 'all', en: 'All', es: 'Todas' },
                                                { k: 'adds', en: '➕ Adds', es: '➕ Sumas' },
                                                { k: 'subs', en: '➖ Subs', es: '➖ Restas' },
                                            ].map(f => (
                                                <button key={f.k} onClick={() => setInvAuditDir(f.k)}
                                                    className={`px-2 py-1 font-bold ${invAuditDir === f.k ? 'bg-dd-text text-white' : 'bg-white text-dd-text-2 hover:bg-dd-bg'}`}>
                                                    {language === 'es' ? f.es : f.en}
                                                </button>
                                            ))}
                                        </div>
                                        {/* date */}
                                        <div className="inline-flex border border-dd-line rounded-md overflow-hidden">
                                            {[
                                                { k: 'today', en: 'Today', es: 'Hoy' },
                                                { k: 'yest', en: 'Yesterday', es: 'Ayer' },
                                                { k: 'week', en: 'Week', es: 'Semana' },
                                                { k: 'all', en: 'All time', es: 'Todo' },
                                            ].map(f => (
                                                <button key={f.k} onClick={() => setInvAuditDateK(f.k)}
                                                    className={`px-2 py-1 font-bold ${invAuditDateK === f.k ? 'bg-dd-text text-white' : 'bg-white text-dd-text-2 hover:bg-dd-bg'}`}>
                                                    {language === 'es' ? f.es : f.en}
                                                </button>
                                            ))}
                                        </div>
                                        {/* staff */}
                                        <select value={invAuditStaff}
                                            onChange={e => setInvAuditStaff(e.target.value)}
                                            className="border border-dd-line rounded-md px-2 py-1 bg-white font-bold">
                                            <option value="">{language === 'es' ? 'Todo el personal' : 'All staff'}</option>
                                            {staffOptions.map(n => (
                                                <option key={n} value={n}>{n}</option>
                                            ))}
                                        </select>
                                        {/* item search */}
                                        <input type="search" value={invAuditSearch}
                                            onChange={e => setInvAuditSearch(e.target.value)}
                                            placeholder={language === 'es' ? 'Buscar artículo…' : 'Search item…'}
                                            className="flex-1 min-w-[120px] border border-dd-line rounded-md px-2 py-1 bg-white" />
                                    </div>

                                    {/* Totals summary */}
                                    <div className="flex flex-wrap gap-2 mb-3 text-[11px]">
                                        <span className="bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded font-bold">
                                            ➕ {totals.adds} {language === 'es' ? `sumas (+${totals.addQty})` : `adds (+${totals.addQty})`}
                                        </span>
                                        <span className="bg-red-50 text-red-700 border border-red-200 px-2 py-0.5 rounded font-bold">
                                            ➖ {totals.subs} {language === 'es' ? `restas (−${totals.subQty})` : `subs (−${totals.subQty})`}
                                        </span>
                                        <span className="bg-gray-50 text-gray-600 border border-gray-200 px-2 py-0.5 rounded font-bold">
                                            {filtered.length} {language === 'es' ? 'eventos' : 'events'}
                                        </span>
                                    </div>

                                    {filtered.length === 0 ? (
                                        <p className="text-xs text-gray-400 italic">
                                            {language === 'es' ? 'No hay cambios en este filtro.' : 'No changes match this filter.'}
                                        </p>
                                    ) : (
                                        <div className="overflow-x-auto -mx-2">
                                            <table className="w-full text-[11px]">
                                                <thead>
                                                    <tr className="text-gray-500 border-b">
                                                        <th className="text-left px-2 py-1 font-semibold">{language === 'es' ? 'Hora' : 'Time'}</th>
                                                        <th className="text-left px-2 py-1 font-semibold">{language === 'es' ? 'Empleado' : 'Staff'}</th>
                                                        <th className="text-left px-2 py-1 font-semibold">{language === 'es' ? 'Artículo' : 'Item'}</th>
                                                        <th className="text-right px-2 py-1 font-semibold">Δ</th>
                                                        <th className="text-right px-2 py-1 font-semibold">{language === 'es' ? 'Antes → Después' : 'Was → Now'}</th>
                                                        {storeLocation === 'both' && (
                                                            <th className="text-center px-2 py-1 font-semibold">{language === 'es' ? 'Tienda' : 'Loc'}</th>
                                                        )}
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {shown.map(r => {
                                                        const d = Number(r.delta) || 0;
                                                        const isAdd = d > 0;
                                                        const isSub = d < 0;
                                                        return (
                                                            <tr key={r.id} className="border-b last:border-0">
                                                                <td className="px-2 py-1 text-gray-700 whitespace-nowrap">{fmtTime(r.at)}</td>
                                                                <td className="px-2 py-1 text-gray-800 font-medium">{r.byStaff || '—'}</td>
                                                                <td className="px-2 py-1 text-gray-700">{r.itemName || r.itemId || '—'}</td>
                                                                <td className={`px-2 py-1 text-right font-black ${isAdd ? 'text-green-700' : isSub ? 'text-red-700' : 'text-gray-500'}`}>
                                                                    {d > 0 ? `+${d}` : d}
                                                                </td>
                                                                <td className="px-2 py-1 text-right text-gray-600 whitespace-nowrap">
                                                                    {r.previous ?? '?'} → <span className="font-bold text-gray-800">{r.next ?? '?'}</span>
                                                                </td>
                                                                {storeLocation === 'both' && (
                                                                    <td className="px-2 py-1 text-center">
                                                                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${r._loc === 'webster' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                                                                            {r._loc === 'webster' ? 'WG' : 'MD'}
                                                                        </span>
                                                                    </td>
                                                                )}
                                                            </tr>
                                                        );
                                                    })}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}

                                    {filtered.length > 25 && (
                                        <button onClick={() => setShowAllInvAudits(s => !s)}
                                            className="mt-2 text-[11px] font-bold text-mint-700">
                                            {showAllInvAudits
                                                ? (language === 'es' ? 'Mostrar menos' : 'Show less')
                                                : (language === 'es' ? `Ver todas (${filtered.length})` : `View all (${filtered.length})`)}
                                        </button>
                                    )}
                                </>)}
                            </div>
                        );
                    })()}

                    {/* ── ORDER LOG — every submitted Order Mode session ─────────────
                        Reads /order_logs (written by OrderMode on Submit). Cross-
                        references with the Inventory audit panel above so admins
                        can answer "we counted X at 10am, when did it actually
                        get ordered and from whom?" */}
                    {(() => {
                        const now = Date.now();
                        const todayMs = now - (now % 86400_000);
                        const weekAgoMs = now - 7 * 86400_000;
                        const monthAgoMs = now - 30 * 86400_000;

                        // Filter by date + location + vendor.
                        const filtered = orderLogs.filter(o => {
                            // Location filter: if admin pinned to one store,
                            // hide orders from the other. 'both' shows
                            // everything.
                            if (storeLocation && storeLocation !== 'both'
                                && o.storeLocation && o.storeLocation !== storeLocation) return false;
                            const at = o.submittedAt?.toMillis?.() ?? 0;
                            if (orderLogDateK === 'today' && at < todayMs) return false;
                            if (orderLogDateK === 'week'  && at < weekAgoMs) return false;
                            if (orderLogDateK === 'month' && at < monthAgoMs) return false;
                            if (orderLogVendor) {
                                const vs = Object.keys(o.vendorTotals || {});
                                if (!vs.includes(orderLogVendor)) return false;
                            }
                            return true;
                        });

                        // Collect all unique vendor names that appear in logs
                        // for the vendor filter dropdown.
                        const vendorSet = new Set();
                        for (const o of orderLogs) {
                            for (const v of Object.keys(o.vendorTotals || {})) vendorSet.add(v);
                        }
                        const vendorOptions = Array.from(vendorSet).filter(v => v && v !== '(unassigned)').sort();

                        const fmtTime = (ts) => {
                            if (!ts) return '—';
                            try {
                                const d = ts.toDate ? ts.toDate() : new Date(ts);
                                return d.toLocaleString(language === 'es' ? 'es' : 'en', {
                                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                                });
                            } catch { return '—'; }
                        };

                        return (
                            <div className="mt-4 mb-4 border border-gray-200 rounded-xl bg-white p-4">
                                <button onClick={() => setOrderLogExpanded(s => !s)}
                                    className="w-full flex items-center justify-between mb-2 -m-1 p-1 rounded hover:bg-gray-50">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xl">📞</span>
                                        <h3 className="text-base font-bold text-gray-800">
                                            {language === 'es' ? 'Historial de pedidos' : 'Order log'}
                                        </h3>
                                    </div>
                                    <span className="text-gray-400 text-sm">{orderLogExpanded ? '▼' : '▶'}</span>
                                </button>
                                {orderLogExpanded && (<>
                                    <p className="text-[11px] text-gray-500 mb-3">
                                        {language === 'es'
                                            ? 'Cada pedido enviado desde Modo Pedido queda registrado: quién, qué, cuándo, a qué proveedor y con qué notas.'
                                            : 'Every order submitted through Order Mode is logged: who, what, when, vendor, and per-item notes.'}
                                    </p>

                                    {/* Filter bar */}
                                    <div className="flex flex-wrap gap-1.5 mb-3 text-[11px]">
                                        <div className="inline-flex border border-dd-line rounded-md overflow-hidden">
                                            {[
                                                { k: 'today', en: 'Today', es: 'Hoy' },
                                                { k: 'week',  en: 'Week',  es: 'Semana' },
                                                { k: 'month', en: 'Month', es: 'Mes' },
                                                { k: 'all',   en: 'All',   es: 'Todo' },
                                            ].map(f => (
                                                <button key={f.k} onClick={() => setOrderLogDateK(f.k)}
                                                    className={`px-2 py-1 font-bold ${orderLogDateK === f.k ? 'bg-amber-700 text-white' : 'bg-white text-dd-text-2 hover:bg-dd-bg'}`}>
                                                    {language === 'es' ? f.es : f.en}
                                                </button>
                                            ))}
                                        </div>
                                        <select value={orderLogVendor} onChange={e => setOrderLogVendor(e.target.value)}
                                            className="border border-dd-line rounded-md px-2 py-1 bg-white font-bold">
                                            <option value="">{language === 'es' ? 'Todos los proveedores' : 'All vendors'}</option>
                                            {vendorOptions.map(v => <option key={v} value={v}>{v}</option>)}
                                        </select>
                                        <span className="ml-auto bg-gray-50 text-gray-600 border border-gray-200 px-2 py-0.5 rounded font-bold">
                                            {filtered.length} {language === 'es' ? 'pedidos' : 'orders'}
                                        </span>
                                    </div>

                                    {filtered.length === 0 ? (
                                        <p className="text-xs text-gray-400 italic">
                                            {language === 'es' ? 'No hay pedidos en este filtro.' : 'No orders match this filter.'}
                                        </p>
                                    ) : (
                                        <div className="space-y-1.5">
                                            {filtered.map(o => {
                                                const isExpanded = expandedOrderId === o.id;
                                                const items = o.items || {};
                                                const itemEntries = Object.entries(items);
                                                const vendorTotals = o.vendorTotals || {};
                                                return (
                                                    <div key={o.id} className="border border-dd-line rounded-lg overflow-hidden">
                                                        <button onClick={() => setExpandedOrderId(isExpanded ? null : o.id)}
                                                            className="w-full p-2.5 text-left hover:bg-dd-bg flex items-center gap-3">
                                                            <span className="text-xl flex-shrink-0">📞</span>
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-1.5 flex-wrap">
                                                                    <span className="text-sm font-bold text-gray-800">{fmtTime(o.submittedAt)}</span>
                                                                    <span className="text-[10px] font-bold text-gray-500">·</span>
                                                                    <span className="text-[11px] text-dd-text-2">
                                                                        {o.submittedBy || '—'}
                                                                    </span>
                                                                    {o.storeLocation && (
                                                                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${o.storeLocation === 'webster' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                                                                            {o.storeLocation === 'webster' ? 'WG' : 'MD'}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                <div className="text-[10px] text-dd-text-2 mt-0.5">
                                                                    {Object.keys(vendorTotals).filter(v => v && v !== '(unassigned)').join(' · ') || (language === 'es' ? '(sin proveedor)' : '(no vendor)')}
                                                                </div>
                                                            </div>
                                                            <div className="flex flex-col items-end flex-shrink-0">
                                                                <div className="text-sm font-black text-green-700">
                                                                    ✓ {o.totalOrdered || 0}
                                                                </div>
                                                                <div className="text-[9px] text-dd-text-2">
                                                                    {o.totalPartial ? `◐${o.totalPartial} ` : ''}
                                                                    {o.totalOos ? `🚫${o.totalOos}` : ''}
                                                                </div>
                                                            </div>
                                                        </button>
                                                        {isExpanded && (
                                                            <div className="border-t border-dd-line bg-dd-bg/30 p-2.5">
                                                                {/* Vendor totals strip */}
                                                                <div className="flex flex-wrap gap-1 mb-2">
                                                                    {Object.entries(vendorTotals).map(([v, t]) => (
                                                                        <span key={v} className="text-[10px] font-bold px-2 py-0.5 rounded bg-white border border-dd-line text-dd-text-2">
                                                                            {v}: {t.items} {language === 'es' ? 'artículos' : 'items'}
                                                                            {t.partialCount ? ` · ${t.partialCount} ◐` : ''}
                                                                            {t.oosCount ? ` · ${t.oosCount} 🚫` : ''}
                                                                        </span>
                                                                    ))}
                                                                </div>
                                                                {/* Item list */}
                                                                <div className="bg-white border border-dd-line rounded divide-y divide-dd-line/50 max-h-80 overflow-y-auto">
                                                                    {itemEntries.length === 0 ? (
                                                                        <div className="p-2 text-center text-[11px] text-dd-text-2 italic">
                                                                            {language === 'es' ? 'Sin artículos' : 'No items'}
                                                                        </div>
                                                                    ) : itemEntries.map(([itemId, it]) => {
                                                                        const sCls = it.status === 'ordered' ? 'text-green-700'
                                                                            : it.status === 'partial' ? 'text-amber-700'
                                                                            : it.status === 'oos' ? 'text-red-700'
                                                                            : 'text-gray-400';
                                                                        const sIcon = it.status === 'ordered' ? '✓'
                                                                            : it.status === 'partial' ? '◐'
                                                                            : it.status === 'oos' ? '🚫'
                                                                            : '⏳';
                                                                        return (
                                                                            <div key={itemId} className="px-2 py-1.5 flex items-start gap-2 text-[11px]">
                                                                                <span className={`font-bold flex-shrink-0 ${sCls}`}>{sIcon}</span>
                                                                                <div className="flex-1 min-w-0">
                                                                                    <div className="text-dd-text font-medium">{it.itemName || itemId}</div>
                                                                                    <div className="text-[10px] text-dd-text-2">
                                                                                        {language === 'es' ? 'Cant.' : 'Qty'}: {it.qty}
                                                                                        {it.vendor && ` · ${it.vendor}`}
                                                                                        {it.checkedBy && ` · ${it.checkedBy}`}
                                                                                        {it.checkedAt && ` · ${fmtTime(it.checkedAt)}`}
                                                                                    </div>
                                                                                    {it.note && (
                                                                                        <div className="text-[10px] text-amber-700 mt-0.5 italic">"{it.note}"</div>
                                                                                    )}
                                                                                </div>
                                                                            </div>
                                                                        );
                                                                    })}
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </>)}
                            </div>
                        );
                    })()}

                    {/* ── CHAT HISTORY (admin audit view) ────────────────────────────
                        Read-only view of every chat in the system + every message
                        in those chats. Useful for HR reviews, dispute resolution,
                        and spot-checking channel usage. Lazy-loaded — the
                        Firestore query only fires when admin expands the panel,
                        so the read cost is zero for admins who never open it.

                        Important: this INCLUDES private DMs and group chats the
                        admin isn't a member of. Andrew (owner) requested this
                        explicitly 2026-05-23 for audit purposes. The same data
                        is technically already readable to any client (catch-all
                        Firestore rule allows reads) but the UI didn't surface it
                        previously. */}
                    <div className="mt-4 mb-4 border border-gray-200 rounded-xl bg-white p-4">
                        <button onClick={() => setChatHistoryExpanded(s => !s)}
                            className="w-full flex items-center justify-between mb-2 -m-1 p-1 rounded hover:bg-gray-50">
                            <div className="flex items-center gap-2">
                                <span className="text-xl">💬</span>
                                <h3 className="text-base font-bold text-gray-800">
                                    {language === 'es' ? 'Historial de chats' : 'Chat history'}
                                </h3>
                            </div>
                            <span className="text-gray-400 text-sm">{chatHistoryExpanded ? '▼' : '▶'}</span>
                        </button>
                        {chatHistoryExpanded && (
                            <ReactSuspense fallback={
                                <p className="text-xs text-gray-400 italic px-2 py-3">
                                    {language === 'es' ? 'Cargando…' : 'Loading…'}
                                </p>
                            }>
                                <ChatHistoryAdmin language={language} staffName={staffName} />
                            </ReactSuspense>
                        )}
                    </div>

                    {/* ── PAYROLL (owner-only, password-gated) ───────────────────────
                        Runs the full payroll engine in-browser (no server) — see
                        src/data/payroll/. Gated behind a second password inside the
                        already owner-only admin tab. Lazy-loaded: the engine +
                        exceljs only download when this section is expanded + unlocked,
                        so it costs admins who never run payroll nothing. */}
                    {isAdmin(staffName, staffList) && (
                        <div className="mt-4 mb-4 border border-gray-200 rounded-xl bg-white p-4">
                            <button onClick={() => setPayrollExpanded(s => !s)}
                                className="w-full flex items-center justify-between mb-2 -m-1 p-1 rounded hover:bg-gray-50">
                                <div className="flex items-center gap-2">
                                    <span className="text-xl">💵</span>
                                    <h3 className="text-base font-bold text-gray-800">
                                        {language === 'es' ? 'Nómina' : 'Payroll'}
                                    </h3>
                                </div>
                                <span className="text-gray-400 text-sm">{payrollExpanded ? '▼' : '▶'}</span>
                            </button>
                            {payrollExpanded && (
                                <ReactSuspense fallback={
                                    <p className="text-xs text-gray-400 italic px-2 py-3">
                                        {language === 'es' ? 'Cargando…' : 'Loading…'}
                                    </p>
                                }>
                                    <PayrollPanel language={language} staffName={staffName} staffList={staffList} />
                                </ReactSuspense>
                            )}
                        </div>
                    )}

                    {/* ── PUSH NOTIFICATIONS DIAGNOSTIC ──────────────────────────────
                        Quick verification panel. Shows the local SW + permission +
                        FCM-token state, and a "Test push" button that writes a
                        notification doc to YOU. If you receive it on your phone
                        with the app CLOSED, end-to-end push is working. If you
                        only receive it with the app open, the Cloud Function
                        isn't deployed (`firebase deploy --only functions`) or
                        background SW isn't registering (check console for
                        "FCM service worker register failed"). */}
                    {(() => {
                        const me = staffList.find(s => s.name === staffName);
                        const tokens = (me?.fcmTokens || []).length;
                        const swSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
                        const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
                        // iOS push gate: iOS Safari refuses to deliver
                        // push to non-standalone (non-PWA) sessions, even
                        // with permission granted. Detect iOS + non-
                        // standalone and surface the exact remediation
                        // ("Add to Home Screen, then open from there"),
                        // otherwise users see a green diagnostic but
                        // never receive a single push.
                        const ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
                        const isIOS = /iPad|iPhone|iPod/.test(ua)
                            || (ua.includes('Mac') && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
                        const isStandalone = typeof window !== 'undefined' && (
                            window.matchMedia?.('(display-mode: standalone)')?.matches
                            || window.navigator?.standalone === true
                            || window.Capacitor?.isNativePlatform?.()
                        );
                        const iosBlocksPush = isIOS && !isStandalone;
                        const sendTestPush = async () => {
                            try {
                                const { addDoc, collection, serverTimestamp } = await import('firebase/firestore');
                                await addDoc(collection(db, 'notifications'), {
                                    forStaff: staffName,
                                    type: 'test',
                                    title: language === 'es' ? '🔔 Prueba de notificación' : '🔔 Push test',
                                    body: language === 'es'
                                        ? `Si recibes esto con la app cerrada, el push funciona. Hora: ${new Date().toLocaleTimeString()}`
                                        : `If you got this with the app closed, push works end-to-end. Sent ${new Date().toLocaleTimeString()}`,
                                    createdAt: serverTimestamp(),
                                    read: false,
                                    createdBy: staffName,
                                });
                                // Confirm the write — before this, the button was
                                // silently writing and the user had no way to
                                // know if the click registered. Toast lasts a
                                // bit long so they can read it and then go
                                // close the app to verify the closed-app push.
                                toast(language === 'es'
                                    ? '🧪 Push de prueba enviado — cierra la app y espera unos segundos.'
                                    : '🧪 Test push sent — close the app and wait a few seconds.',
                                    { kind: 'success', duration: 6000 });
                            } catch (e) {
                                console.error('test push failed:', e);
                                toast((language === 'es' ? '❌ Falló el envío: ' : '❌ Send failed: ') + (e.message || e),
                                    { kind: 'error', duration: 6000 });
                            }
                        };
                        return (
                            <div className="mt-6 mb-4 border border-blue-200 rounded-xl bg-blue-50 p-4">
                                <div className="flex items-center gap-2 mb-2">
                                    <span className="text-xl">🔔</span>
                                    <h3 className="text-base font-bold text-blue-900">
                                        {language === 'es' ? 'Diagnóstico de notificaciones' : 'Push notifications diagnostic'}
                                    </h3>
                                </div>
                                <ul className="text-xs text-blue-900 space-y-1 mb-3">
                                    <li><strong>{language === 'es' ? 'Service Worker:' : 'Service Worker:'}</strong> {swSupported ? '✅' : '❌'} {swSupported ? (language === 'es' ? 'soportado' : 'supported') : (language === 'es' ? 'no soportado en este dispositivo' : 'not supported on this device')}</li>
                                    <li><strong>{language === 'es' ? 'Permiso del navegador:' : 'Browser permission:'}</strong> {perm === 'granted' ? '✅' : perm === 'denied' ? '🚫' : '⚠️'} {perm}</li>
                                    <li><strong>{language === 'es' ? 'Tokens FCM registrados:' : 'FCM tokens registered:'}</strong> {tokens > 0 ? '✅' : '❌'} {tokens}</li>
                                    {isIOS && (
                                        <li>
                                            <strong>{language === 'es' ? 'Modo iOS:' : 'iOS mode:'}</strong>{' '}
                                            {isStandalone ? '✅' : '🚫'}{' '}
                                            {isStandalone
                                                ? (language === 'es' ? 'PWA instalado (pushes funcionarán)' : 'Installed PWA (push works)')
                                                : (language === 'es' ? 'Safari — iOS NO entregará push aquí' : 'Safari — iOS will NOT deliver push here')}
                                        </li>
                                    )}
                                </ul>
                                {iosBlocksPush && (
                                    <div className="mb-3 p-3 rounded-lg bg-amber-100 border-2 border-amber-300 text-xs text-amber-900">
                                        <div className="font-bold mb-1">
                                            🍎 {language === 'es' ? 'iOS bloquea push en Safari' : 'iOS blocks push in Safari'}
                                        </div>
                                        <div className="leading-relaxed">
                                            {language === 'es'
                                                ? 'Apple sólo permite notificaciones push cuando la app está instalada en la pantalla de inicio. Para activar:'
                                                : "Apple only allows push notifications when the app is installed to your Home Screen. To enable:"}
                                            <ol className="list-decimal ml-4 mt-1 space-y-0.5">
                                                <li>{language === 'es' ? 'Toca el ícono de Compartir (cuadro con flecha arriba) en Safari' : 'Tap the Share icon (square with up-arrow) in Safari'}</li>
                                                <li>{language === 'es' ? 'Desplázate y toca "Añadir a pantalla de inicio"' : 'Scroll down → tap "Add to Home Screen"'}</li>
                                                <li>{language === 'es' ? 'Cierra Safari y abre DD Mau desde el ícono nuevo' : 'Close Safari and open DD Mau from the new icon'}</li>
                                                <li>{language === 'es' ? 'Acepta el permiso de notificaciones cuando aparezca' : 'Accept the notification permission when prompted'}</li>
                                            </ol>
                                        </div>
                                    </div>
                                )}
                                {/* Recent notifications for THIS staff — proves
                                    whether the issue is "notification docs aren't
                                    being written" vs "they are written but FCM
                                    delivery is failing." If you see your event
                                    here but no toast on your device, the problem
                                    is delivery (Cloud Function not deployed,
                                    token stale, etc.). If you don't see your
                                    event here at all, the problem is upstream
                                    (notify() didn't fire for some reason). */}
                                <RecentNotificationsFeed staffName={staffName} language={language} />
                                <button onClick={sendTestPush}
                                    className="w-full py-2 rounded-lg bg-blue-600 text-white text-sm font-bold hover:bg-blue-700">
                                    🧪 {language === 'es' ? 'Enviar push de prueba a mí' : 'Send test push to myself'}
                                </button>
                                {/* Register-now — runs enableFcmPush on demand and
                                    surfaces the exact failure reason inline. Use
                                    when token count = 0: the auto-register on app
                                    load may have failed silently (permission
                                    denied, SW register error, getToken throw)
                                    and a full reload doesn't fix it. This button
                                    is the deterministic path to "make my token
                                    appear right now or tell me why it won't." */}
                                <button
                                    onClick={async () => {
                                        try {
                                            const result = await enableFcmPush(staffName, staffList, setStaffList);
                                            if (result.ok) {
                                                toast(language === 'es'
                                                    ? '✅ Registrado. Tu token está guardado. Prueba enviarte un push.'
                                                    : '✅ Registered. Your token is saved. Try sending a test push.',
                                                    { kind: 'success', duration: 5000 });
                                            } else {
                                                const reasonLabel = {
                                                    'no-notification-api': language === 'es' ? 'Este navegador no soporta notificaciones' : "This browser doesn't support notifications",
                                                    'permission-denied': language === 'es' ? 'Permisos bloqueados — actívalos en ajustes del navegador' : 'Permission denied — turn notifications back on in browser settings',
                                                    'no-vapid-key': language === 'es' ? 'Clave VAPID falta (error de despliegue)' : 'VAPID key missing (deploy bug)',
                                                    'messaging-unsupported': language === 'es' ? 'FCM no soportado aquí (Safari sin iOS 16.4+?)' : 'FCM unsupported here (Safari without iOS 16.4+?)',
                                                    'sw-register-failed': language === 'es' ? 'No se pudo registrar el Service Worker' : 'Service Worker failed to register',
                                                    'get-token-failed': language === 'es' ? 'FCM rechazó dar un token (mira la consola)' : 'FCM refused to issue a token (check console)',
                                                    'no-token': language === 'es' ? 'FCM devolvió token vacío' : 'FCM returned empty token',
                                                }[result.reason] || result.reason;
                                                toast((language === 'es' ? '❌ Falló: ' : '❌ Failed: ') + reasonLabel, { kind: 'error', duration: 6000 });
                                            }
                                        } catch (e) {
                                            console.error('register now failed:', e);
                                            toast((language === 'es' ? '❌ Error: ' : '❌ Error: ') + (e.message || e), { kind: 'error', duration: 6000 });
                                        }
                                    }}
                                    className="w-full mt-2 py-2 rounded-lg bg-green-600 text-white text-sm font-bold hover:bg-green-700">
                                    📲 {language === 'es' ? 'Registrar este dispositivo ahora' : 'Register this device now'}
                                </button>
                                {/* Reset push tokens — nukes ALL fcmTokens on this
                                    staff's record. Use when you're getting
                                    duplicate notifications: legacy entries without
                                    a deviceId can't be auto-deduped, so the only
                                    cleanup is to wipe + re-register fresh. After
                                    reset, this device re-registers automatically
                                    on the next page load (via App.jsx's
                                    enableFcmPush useEffect) — that new entry has
                                    a deviceId so future rotations dedupe cleanly. */}
                                <button
                                    onClick={async () => {
                                        if (!confirm(language === 'es'
                                            ? '¿Borrar tus tokens de notificación y volver a registrar? Soluciona notificaciones duplicadas.'
                                            : 'Clear your push tokens and re-register? Fixes duplicate-notification issues.'
                                        )) return;
                                        try {
                                            const { runTransaction, doc } = await import('firebase/firestore');
                                            await runTransaction(db, async (tx) => {
                                                const ref = doc(db, 'config', 'staff');
                                                const snap = await tx.get(ref);
                                                if (!snap.exists()) return;
                                                const liveList = (snap.data() || {}).list || [];
                                                const next = liveList.map(s =>
                                                    s.name === staffName
                                                        ? { ...s, fcmTokens: [] }
                                                        : s
                                                );
                                                tx.set(ref, { list: next });
                                            });
                                            toast(language === 'es'
                                                ? 'Tokens borrados. Recarga la página para re-registrar.'
                                                : 'Tokens cleared. Reload the page to re-register a fresh single token.',
                                                { kind: 'success', duration: 5000 });
                                        } catch (e) {
                                            console.error('reset push tokens failed:', e);
                                            toast('Reset failed: ' + (e.message || e), { kind: 'error', duration: 6000 });
                                        }
                                    }}
                                    className="w-full mt-2 py-2 rounded-lg bg-white border-2 border-blue-300 text-blue-700 text-sm font-bold hover:bg-blue-100">
                                    🔄 {language === 'es' ? 'Borrar mis tokens (resolver duplicados)' : 'Reset my push tokens (fix duplicates)'}
                                </button>
                                <p className="text-[10px] text-blue-800 mt-2 leading-relaxed">
                                    {language === 'es'
                                        ? 'Cierra la app, luego pulsa el botón. Si recibes la notificación con la app cerrada, todo el camino funciona. Si sólo la ves al abrir la app, la Cloud Function no está desplegada o el SW falló.'
                                        : 'Close the app, then tap the button. If the notification arrives while the app is closed, end-to-end push is working. If you only see it after opening the app, the Cloud Function isn\'t deployed or the SW failed to register.'}
                                </p>
                            </div>
                        );
                    })()}

                    {/* ── LABEL PRINTERS — per-location Epson TM-L100 config ────────
                        Andrew 2026-05-20 — Vietnamese equivalent of Jolt's
                        date-code labeling feature. Each location runs an Epson
                        TM-L100 on the kitchen Wi-Fi; this section sets the
                        printer's local IP + lets admin send a test print. The
                        DD Mau app (browser) sends labels directly to the
                        printer's HTTP server — no middleware, no driver. */}
                    <PrintersConfigSection language={language} byName={staffName} />

                    <ReactSuspense fallback={<div className="text-xs text-dd-text-2 italic px-2 py-3">Loading label format editor…</div>}>
                        <LabelFormatEditor language={language} byName={staffName} />
                    </ReactSuspense>

                    {/* ── SaaS-ready menu/brand/buildsheet editor ──────────────
                        Andrew 2026-05-30, Phase 1.B-1.D. The old MenuEditor
                        (overlay-only) was removed 2026-05-24; this is the
                        full-CRUD replacement that writes to /config/menu_v2
                        + /config/brand + /config/build_sheet. Designed for
                        SaaS resale — every part of the menu is editable
                        from this single screen, no code push required. */}
                    <ReactSuspense fallback={<div className="text-xs text-dd-text-2 italic px-2 py-3 mt-6">Loading menu editor…</div>}>
                        <MenuConfigEditor language={language} byName={staffName} />
                    </ReactSuspense>

                    {/* ── TV displays — moved to its own page ────────────────────
                        Andrew 2026-05-23 promoted the TvConfigsEditor block out
                        of this long-scroll admin sheet into a dedicated "Menu
                        Screens" page (sidebar entry · tab='menuscreens'). This
                        card is the breadcrumb so anyone still hunting the old
                        location knows where it went. */}
                    <button
                        type="button"
                        onClick={() => onNavigate?.('menuscreens')}
                        className="w-full text-left mt-6 mb-4 bg-white border-2 border-sky-200 rounded-xl p-4 hover:bg-sky-50 active:bg-sky-100 transition flex items-center gap-3">
                        <span className="text-2xl shrink-0">📺</span>
                        <div className="min-w-0 flex-1">
                            <div className="text-sm font-black text-sky-900">
                                {language === 'es' ? 'Pantallas de menú' : 'Menu TV displays'}
                            </div>
                            <div className="text-[11px] text-sky-700 leading-snug mt-0.5">
                                {language === 'es'
                                    ? 'Ahora tiene su propia página con un panel de control. Toca para abrir.'
                                    : 'Now has its own page with a dashboard view (status pills, live previews, per-screen actions). Tap to open.'}
                            </div>
                        </div>
                        <span className="text-sky-700 text-lg shrink-0">→</span>
                    </button>
                    {/* ── DANGER ZONE — System Refresh broadcast ────────────────────
                        Writes a timestamp to /config/forceRefresh. Every active
                        client subscribes to that doc in App.jsx and force-refreshes
                        on change. Use SPARINGLY — interrupts every staff member
                        mid-action. Reserved for production breakage / critical fixes. */}
                    <div className="mt-8 mb-4 border-2 border-red-300 rounded-xl bg-red-50 p-4">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-2xl">⚠️</span>
                            <h3 className="text-base font-bold text-red-900 uppercase tracking-wide">
                                {language === "es" ? "Zona Peligrosa" : "Danger Zone"}
                            </h3>
                        </div>
                        <p className="text-xs text-red-900 mb-3">
                            {language === "es"
                                ? "El refresco del sistema obliga a TODOS los dispositivos activos a recargar inmediatamente. Cualquier persona en medio de algo perderá su trabajo no guardado. Úsalo solo para fallas reales o correcciones críticas."
                                : "System Refresh forces EVERY active device to reload immediately. Anyone mid-action will lose unsaved work. Use only for real production breakage or critical fixes."}
                        </p>
                        {!confirmingRefresh ? (
                            <button onClick={() => setConfirmingRefresh(true)}
                                className="w-full py-3 rounded-lg bg-red-600 text-white text-sm font-bold uppercase tracking-wide hover:bg-red-700 active:scale-[0.99] transition shadow-lg shadow-red-200">
                                🚨 {language === "es" ? "Refresco del Sistema" : "System Refresh"}
                            </button>
                        ) : (
                            <div className="space-y-2">
                                <div className="bg-red-700 text-white rounded-lg p-3 text-center text-sm font-bold animate-pulse">
                                    {language === "es"
                                        ? "¿Estás SEGURO? Esto interrumpirá a todos los dispositivos activos."
                                        : "Are you SURE? This will interrupt every active device."}
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    <button onClick={() => setConfirmingRefresh(false)}
                                        className="py-3 rounded-lg bg-gray-200 text-gray-800 text-sm font-bold hover:bg-gray-300">
                                        {language === "es" ? "Cancelar" : "Cancel"}
                                    </button>
                                    <button onClick={handleSystemRefresh}
                                        className="py-3 rounded-lg bg-red-700 text-white text-sm font-bold uppercase tracking-wide hover:bg-red-800 shadow-lg">
                                        ✓ {language === "es" ? "Confirmar Refresco" : "Confirm Refresh"}
                                    </button>
                                </div>
                                <p className="text-[10px] text-red-700 text-center">
                                    {language === "es" ? "Auto-cancelar en 10 segundos." : "Auto-cancels in 10 seconds."}
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            );
        }

        // Catering Menu Data — proteinOptions = single pick from list; hasProteins+proteinCount = multi pick
        const CATERING_MENU = [
            {
                category: "Finger Food",
                categoryEs: "Bocadillos",
                emoji: "🥟",
                items: [
                    {
                        name: "Crab Rangoons",
                        nameEs: "Crab Rangoons",
                        sizes: [
                            { label: "15 PCS", price: 23.99 },
                            { label: "30 PCS", price: 43.99 },
                            { label: "60 PCS", price: 84.99 }
                        ],
                        note: "Served w/ Sweet Chili Sauce",
                        noteEs: "Servido con Salsa de Chile Dulce",
                        hasSauces: false,
                        hasProteins: false
                    },
                    {
                        name: "Vietnamese/Vegetarian Egg Rolls",
                        nameEs: "Rollos de Huevo Vietnamitas/Vegetarianos",
                        sizes: [
                            { label: "20 Halves", price: 27.99 },
                            { label: "40 Halves", price: 41.99 },
                            { label: "60 Halves", price: 53.90 }
                        ],
                        typeOptions: ["Vietnamese", "Vegetarian"],
                        typeOptionsEs: ["Vietnamitas", "Vegetarianos"],
                        singleSauceOptions: ["Vietnamese Vinaigrette", "Sweet Chili"],
                        singleSauceOptionsEs: ["Vinagreta Vietnamita", "Chile Dulce"],
                        hasSauces: false,
                        hasProteins: false
                    },
                    {
                        name: "Spring Rolls",
                        nameEs: "Rollos de Primavera",
                        sizes: [
                            { label: "16 PCS", price: 92.99, sauceCount: 2, proteinCount: 2 },
                            { label: "32 PCS", price: 177.99, sauceCount: 3, proteinCount: 3 },
                            { label: "48 PCS", price: 246.99, sauceCount: 4, proteinCount: 4 }
                        ],
                        hasSauces: true,
                        hasProteins: true
                    },
                    {
                        name: "Bao Sliders",
                        nameEs: "Mini Baos",
                        sizes: [
                            { label: "12 PCS", price: 77.99, sauceCount: 2, proteinCount: 2 },
                            { label: "24 PCS", price: 130.99, sauceCount: 3, proteinCount: 3 },
                            { label: "36 PCS", price: 192.99, sauceCount: 4, proteinCount: 4 }
                        ],
                        hasSauces: true,
                        hasProteins: true
                    },
                    {
                        name: "Banh Mi",
                        nameEs: "Bánh Mì",
                        sizes: [
                            { label: "12 PCS", price: 77.99, sauceCount: 2, proteinCount: 2 },
                            { label: "24 PCS", price: 154.99, sauceCount: 3, proteinCount: 3 },
                            { label: "36 PCS", price: 223.99, sauceCount: 4, proteinCount: 4 }
                        ],
                        hasSauces: true,
                        hasProteins: true
                    }
                ]
            },
            {
                category: "Fork & Knife Trays",
                categoryEs: "Bandejas con Cubiertos",
                emoji: "🍴",
                items: [
                    {
                        name: "Tray — Chicken, Pork, or Tofu",
                        nameEs: "Bandeja — Pollo, Puerco o Tofu",
                        sizes: [
                            { label: "Serves 6-8", price: 146.99 },
                            { label: "Serves 10-12", price: 223.99 }
                        ],
                        proteinOptions: ["Chicken", "Pork", "Tofu"],
                        proteinOptionsEs: ["Pollo", "Puerco", "Tofu"],
                        hasBase: true,
                        hasSauces: true,
                        sauceCount: 3,
                        hasProteins: false,
                        hasUtensils: true
                    },
                    {
                        name: "Tray — Steak, Shrimp, Veggie, or Vegan Beef",
                        nameEs: "Bandeja — Res, Camarón, Vegetal o Res Vegana",
                        sizes: [
                            { label: "Serves 6-8", price: 161.99 },
                            { label: "Serves 10-12", price: 246.99 }
                        ],
                        proteinOptions: ["Steak", "Shrimp", "Veggie", "Vegan Beef"],
                        proteinOptionsEs: ["Res", "Camarón", "Vegetal", "Res Vegana"],
                        hasBase: true,
                        hasSauces: true,
                        sauceCount: 3,
                        hasProteins: false,
                        hasUtensils: true
                    }
                ]
            },
            {
                category: "Mini Bowls",
                categoryEs: "Mini Tazones",
                emoji: "🥢",
                items: [
                    {
                        name: "Mini Bowls — Chicken, Pork, or Tofu",
                        nameEs: "Mini Tazones — Pollo, Puerco o Tofu",
                        sizes: [
                            { label: "10 Bowls", price: 130.99 },
                            { label: "20 Bowls", price: 254.99 }
                        ],
                        proteinOptions: ["Chicken", "Pork", "Tofu"],
                        proteinOptionsEs: ["Pollo", "Puerco", "Tofu"],
                        hasBase: true,
                        hasSauces: true,
                        sauceCount: 3,
                        hasProteins: false,
                        hasUtensils: true
                    },
                    {
                        name: "Mini Bowls — Steak, Shrimp, Veggie, or Vegan Beef",
                        nameEs: "Mini Tazones — Res, Camarón, Vegetal o Res Vegana",
                        sizes: [
                            { label: "10 Bowls", price: 146.99 },
                            { label: "20 Bowls", price: 284.99 }
                        ],
                        proteinOptions: ["Steak", "Shrimp", "Veggie", "Vegan Beef"],
                        proteinOptionsEs: ["Res", "Camarón", "Vegetal", "Res Vegana"],
                        hasBase: true,
                        hasSauces: true,
                        sauceCount: 3,
                        hasProteins: false,
                        hasUtensils: true
                    }
                ]
            },
            {
                category: "Fried Rice Trays",
                categoryEs: "Bandejas de Arroz Frito",
                emoji: "🍚",
                items: [
                    {
                        name: "Fried Rice — Plain",
                        nameEs: "Arroz Frito — Solo",
                        sizes: [
                            { label: "Serves 6-8", price: 61.99 },
                            { label: "Serves 10-12", price: 107.99 }
                        ],
                        note: "Eggs, Scallions, and White Onions",
                        noteEs: "Huevos, Cebollín y Cebolla Blanca",
                        hasSauces: false,
                        hasProteins: false,
                        hasUtensils: true
                    },
                    {
                        name: "Fried Rice — Chicken, Pork, or Tofu",
                        nameEs: "Arroz Frito — Pollo, Puerco o Tofu",
                        sizes: [
                            { label: "Serves 6-8", price: 77.99 },
                            { label: "Serves 10-12", price: 138.99 }
                        ],
                        note: "Eggs, Scallions, and White Onions",
                        noteEs: "Huevos, Cebollín y Cebolla Blanca",
                        proteinOptions: ["Chicken", "Pork", "Tofu"],
                        proteinOptionsEs: ["Pollo", "Puerco", "Tofu"],
                        hasSauces: false,
                        hasProteins: false,
                        hasUtensils: true
                    },
                    {
                        name: "Fried Rice — Steak, Shrimp, Veggie, or Vegan Beef",
                        nameEs: "Arroz Frito — Res, Camarón, Vegetal o Res Vegana",
                        sizes: [
                            { label: "Serves 6-8", price: 92.99 },
                            { label: "Serves 10-12", price: 169.99 }
                        ],
                        note: "Eggs, Scallions, and White Onions",
                        noteEs: "Huevos, Cebollín y Cebolla Blanca",
                        proteinOptions: ["Steak", "Shrimp", "Veggie", "Vegan Beef"],
                        proteinOptionsEs: ["Res", "Camarón", "Vegetal", "Res Vegana"],
                        hasSauces: false,
                        hasProteins: false,
                        hasUtensils: true
                    }
                ]
            },
            {
                category: "DD Mau Sampler",
                categoryEs: "Muestra DD Mau",
                emoji: "🎉",
                items: [
                    {
                        name: "DD Mau Sampler",
                        nameEs: "Muestra DD Mau",
                        sizes: [
                            { label: "Serves 4-6", price: 154.99 }
                        ],
                        note: "6 Banh Mi Bites, 4 Mini Vermicelli Bowls, 8 Rice Paper Roll Halves, 10 Egg Roll Halves. Cutlery & napkins included.",
                        noteEs: "6 Banh Mi, 4 Mini Tazones de Fideos, 8 Mitades de Rollos de Arroz, 10 Mitades de Rollos de Huevo. Cubiertos y servilletas incluidos.",
                        hasSauces: true,
                        sauceCount: 2,
                        hasProteins: false, 
                        isSampler: true,
                        samplerPicks: [
                            { name: "Banh Mi Bites (6 pcs)", nameEs: "Banh Mi (6 pzas)", count: 3 },
                            { name: "Mini Vermicelli Bowls (4)", nameEs: "Mini Tazones de Fideos (4)", count: 2 },
                            { name: "Rice Paper Rolls (8 halves)", nameEs: "Rollos de Arroz (8 mitades)", count: 2 }
                        ],
                        samplerEggRollType: true
                    }
                ]
            }
        ];

        const ALL_SAUCES = ["Vietnamese Vinaigrette", "Peanut", "Hoisin", "Sweet Chili", "DD", "Spicy DD"];
        const ALL_SAUCES_ES = ["Vinagreta Vietnamita", "Cacahuate", "Hoisin", "Chile Dulce", "DD", "DD Picante"];
        const ALL_PROTEINS = ["Steak", "Shrimp", "Chicken", "Pork", "Tofu"];
        const ALL_PROTEINS_ES = ["Res", "Camarón", "Pollo", "Puerco", "Tofu"];
        const BASE_OPTIONS = ["Vermicelli", "Salad", "Rice"];
        const BASE_OPTIONS_ES = ["Fideos", "Ensalada", "Arroz"];

        // Catering Order Component
