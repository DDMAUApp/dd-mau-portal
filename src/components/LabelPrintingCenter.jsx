// LabelPrintingCenter — admin dashboard for the label printers.
//
// Andrew 2026-05-23 audit follow-up. Before this page existed, admins
// had no way to answer "why didn't my date sticker print?" without
// opening DevTools and watching the console. Every sendToPrinter now
// writes a /print_jobs row with the outcome (ok / error code /
// printer message / latency) so this page can surface failures and
// help diagnose them.
//
// What's here:
//   • Per-printer status row (configured / enabled / last successful
//     print N min ago / recent failure rate)
//   • "Test print" button per printer — fires a short free-text label
//     ("Test print · DD Mau · <time>") so the admin can confirm the
//     printer responds without typing anything.
//   • Recent print jobs feed (last 50) — newest first, each row
//     showing label title, who printed, success/fail, duration, and
//     the printer's error message if it rejected.
//   • Failure tooltip — common error codes get a human translation
//     ("media empty" instead of "ERR_TEMPLATE_NOT_FOUND") so the
//     person reading the page knows what to fix.
//
// What's NOT here (yet):
//   • Reprint last label — would need to log the full label payload,
//     not just the metadata. Filed for follow-up.
//   • Persistent failed-job queue with retry — same reason.
//   • Label format editor — lives in AdminPanel already.

import { useEffect, useMemo, useState } from 'react';
import {
    subscribePrintJobs, subscribePrinterConfig, printFreeText,
    PRINTER_SLOTS,
} from '../data/labelPrinting';

const LOC_LABEL = { webster: 'Webster', maryland: 'MD Heights' };

// Map error codes to human-readable messages. Anything not in this
// table renders the raw code. Encoded inline so this page doesn't
// have a "string catalog" file to lose track of.
function humanizeError(code, isEs) {
    const tx = (en, es) => (isEs ? es : en);
    if (!code) return null;
    switch (String(code)) {
        case 'not_configured':       return tx('No printer registered for this slot', 'Sin impresora registrada');
        case 'disabled':              return tx('Printer is disabled in admin', 'Impresora deshabilitada');
        case 'timeout':               return tx('Printer didn\'t respond (off, or wrong IP?)', 'No respondió (¿apagada o IP equivocada?)');
        case 'no_printer_configured': return tx('No printer registered for this slot', 'Sin impresora registrada');
        case 'printer_disabled':      return tx('Printer is disabled in admin', 'Impresora deshabilitada');
        case 'empty_text':            return tx('Tried to print blank text', 'Texto vacío');
        case 'text_too_long':         return tx('Label too long (>2000 chars)', 'Etiqueta muy larga');
        case 'network_error':         return tx('Network error — printer off / wrong Wi-Fi? (Web browsers can\'t print — use the phone/iPad app)', 'Error de red — ¿impresora apagada / otra Wi-Fi? (Desde el navegador no se imprime — usa la app)');
        default:
            if (code.startsWith('http_')) return tx(`Printer rejected (HTTP ${code.slice(5)})`, `Impresora rechazó (HTTP ${code.slice(5)})`);
            return code;
    }
}

function minutesSince(ts) {
    if (!ts) return null;
    const ms = ts.toMillis ? ts.toMillis()
        : ts.seconds  ? ts.seconds * 1000
        : 0;
    if (!ms) return null;
    return Math.round((Date.now() - ms) / 60000);
}

function fmtRelative(ts, isEs) {
    const m = minutesSince(ts);
    if (m === null) return '—';
    if (m < 1)  return isEs ? 'ahora'   : 'just now';
    if (m < 60) return `${m} min`;
    if (m < 60 * 24) return `${Math.floor(m / 60)}h`;
    return `${Math.floor(m / 60 / 24)}d`;
}

export default function LabelPrintingCenter({ language = 'en', staffName }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    // ── Printers — same source as the System Health page ───────
    const [printers, setPrinters] = useState({});
    useEffect(() => {
        const unsubs = [];
        for (const loc of ['webster', 'maryland']) {
            for (const slot of PRINTER_SLOTS) {
                const key = `${loc}/${slot}`;
                const u = subscribePrinterConfig(loc, (cfg) => {
                    setPrinters(prev => ({ ...prev, [key]: cfg }));
                }, slot);
                unsubs.push(u);
            }
        }
        return () => unsubs.forEach(u => { try { u(); } catch {} });
    }, []);

    // ── Recent print jobs ──────────────────────────────────────
    const [jobs, setJobs] = useState([]);
    useEffect(() => subscribePrintJobs(setJobs), []);
    // Tick once a minute so the "Xm ago" labels roll forward.
    const [, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick(t => t + 1), 60_000);
        return () => clearInterval(id);
    }, []);

    // Per-printer derived stats — most recent job (success or fail),
    // last successful job, recent failure rate. Computed from the
    // shared jobs feed so we don't keep separate subscriptions per
    // printer slot.
    const statsByPrinter = useMemo(() => {
        const out = {};
        for (const loc of ['webster', 'maryland']) {
            for (const slot of PRINTER_SLOTS) {
                const key = `${loc}/${slot}`;
                const matching = jobs.filter(j => j.location === loc && j.slot === slot);
                const lastSuccess = matching.find(j => j.ok);
                const lastJob = matching[0] || null;
                const recent = matching.slice(0, 10);
                const failures = recent.filter(j => !j.ok).length;
                out[key] = {
                    total24h: matching.length,
                    lastSuccess,
                    lastJob,
                    recentFailRate: recent.length ? Math.round(failures / recent.length * 100) : 0,
                };
            }
        }
        return out;
    }, [jobs]);

    // ── Test print ─────────────────────────────────────────────
    const [testingKey, setTestingKey] = useState(null);
    const [testResults, setTestResults] = useState({});
    async function handleTestPrint(loc, slot) {
        const key = `${loc}/${slot}`;
        if (testingKey) return;
        setTestingKey(key);
        try {
            const now = new Date();
            const result = await printFreeText({
                location: loc,
                slot,
                text: `Test print — ${LOC_LABEL[loc]} ${slot} — ${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
                size: 'medium',
                bold: false,
                align: 'center',
                copies: 1,
                byName: staffName,
            });
            setTestResults(prev => ({ ...prev, [key]: { ts: Date.now(), ...result } }));
        } catch (e) {
            setTestResults(prev => ({ ...prev, [key]: { ts: Date.now(), ok: false, error: e?.message || 'unknown' } }));
        } finally {
            setTestingKey(null);
        }
    }

    return (
        <section className="w-full max-w-6xl mx-auto px-3 md:px-6 py-4 md:py-6 space-y-5">
            <header>
                <h1 className="text-2xl md:text-3xl font-black text-dd-text tracking-tight">
                    🏷 {tx('Label Printing', 'Impresión de etiquetas')}
                </h1>
                <p className="text-[12px] text-dd-text-2 mt-0.5">
                    {tx(
                        'Status, test prints, and recent job history for every label printer.',
                        'Estado, impresiones de prueba e historial reciente de cada impresora.',
                    )}
                </p>
            </header>

            {/* Printer cards — one per (location, slot) pair. Each
                card shows config, recent-failure ratio, last
                successful print, and a Test Print button. */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {['webster', 'maryland'].map(loc => (
                    PRINTER_SLOTS.map(slot => {
                        const key = `${loc}/${slot}`;
                        const cfg = printers[key];
                        const stats = statsByPrinter[key] || {};
                        const lastSuccess = stats.lastSuccess;
                        const lastSuccessMin = minutesSince(lastSuccess?.createdAt);
                        const testResult = testResults[key];
                        const testing = testingKey === key;
                        const slotLabel = slot === 'kitchen' ? tx('Kitchen', 'Cocina') : tx('Office', 'Oficina');
                        const isConfigured = !!cfg;
                        const isEnabled = isConfigured && cfg.enabled !== false;
                        const tone = !isConfigured
                            ? { border: 'border-dd-line', bg: 'bg-white' }
                            : !isEnabled
                            ? { border: 'border-amber-300', bg: 'bg-amber-50/40' }
                            : stats.recentFailRate >= 50
                            ? { border: 'border-red-300', bg: 'bg-red-50/40' }
                            : { border: 'border-emerald-300', bg: 'bg-emerald-50/30' };
                        return (
                            <div key={key} className={`border ${tone.border} ${tone.bg} rounded-2xl p-4 shadow-sm`}>
                                <div className="flex items-baseline justify-between gap-2">
                                    <h2 className="text-sm font-black text-dd-text">
                                        {LOC_LABEL[loc]} · {slotLabel}
                                    </h2>
                                    <span className={`text-[10px] font-black uppercase tracking-widest ${
                                        !isConfigured ? 'text-dd-text-2'
                                        : !isEnabled  ? 'text-amber-700'
                                        :                'text-emerald-700'
                                    }`}>
                                        {!isConfigured ? tx('Not set up', 'Sin configurar')
                                            : !isEnabled  ? tx('Disabled', 'Deshabilitada')
                                            :                tx('Ready', 'Lista')}
                                    </span>
                                </div>
                                <p className="text-[12px] text-dd-text-2 mt-0.5 truncate">
                                    {cfg
                                        ? (cfg.name || `${cfg.model || 'printer'}${cfg.ip ? ` @ ${cfg.ip}` : ''}`)
                                        : tx('No printer registered for this slot', 'Sin impresora registrada')}
                                </p>

                                <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                                    <div className="bg-white border border-dd-line rounded-lg py-1.5">
                                        <div className="text-[10px] font-bold uppercase tracking-widest text-dd-text-2">{tx('Last ok', 'Último ok')}</div>
                                        <div className="text-sm font-black tabular-nums text-dd-text">
                                            {lastSuccessMin === null ? '—' : fmtRelative(lastSuccess.createdAt, isEs)}
                                        </div>
                                    </div>
                                    <div className="bg-white border border-dd-line rounded-lg py-1.5">
                                        <div className="text-[10px] font-bold uppercase tracking-widest text-dd-text-2">{tx('Recent', 'Reciente')}</div>
                                        <div className="text-sm font-black tabular-nums text-dd-text">{stats.total24h || 0}</div>
                                    </div>
                                    <div className="bg-white border border-dd-line rounded-lg py-1.5">
                                        <div className="text-[10px] font-bold uppercase tracking-widest text-dd-text-2">{tx('Fail %', 'Fallos %')}</div>
                                        <div className={`text-sm font-black tabular-nums ${stats.recentFailRate >= 50 ? 'text-red-700' : stats.recentFailRate >= 20 ? 'text-amber-700' : 'text-dd-text'}`}>
                                            {stats.recentFailRate}%
                                        </div>
                                    </div>
                                </div>

                                <button onClick={() => handleTestPrint(loc, slot)}
                                    disabled={!isConfigured || !isEnabled || testing}
                                    className="w-full mt-3 py-2 rounded-lg bg-dd-charcoal text-white text-sm font-bold disabled:opacity-40 hover:bg-black active:scale-95 transition">
                                    {testing ? tx('Printing…', 'Imprimiendo…') : `🧪 ${tx('Test print', 'Imprimir prueba')}`}
                                </button>

                                {testResult && (
                                    <p className={`text-[11px] mt-2 ${testResult.ok ? 'text-emerald-700' : 'text-red-700'}`}>
                                        {testResult.ok
                                            ? `✓ ${tx('Sent — check the printer', 'Enviado — revisa la impresora')}`
                                            : `⚠ ${humanizeError(testResult.error, isEs) || testResult.error}`}
                                    </p>
                                )}
                            </div>
                        );
                    })
                ))}
            </div>

            {/* Recent jobs feed */}
            <div className="bg-white border border-dd-line rounded-2xl p-4">
                <h2 className="text-sm font-black text-dd-text mb-2">
                    📜 {tx('Recent print jobs', 'Trabajos recientes')}
                </h2>
                {jobs.length === 0 ? (
                    <div className="text-center py-8">
                        <div className="text-4xl mb-2">🖨</div>
                        <p className="text-sm text-dd-text-2 max-w-md mx-auto">
                            {tx(
                                'No print attempts logged yet. Once anyone prints a label, the result shows up here.',
                                'Sin intentos registrados aún. Cuando alguien imprima una etiqueta, el resultado aparecerá aquí.',
                            )}
                        </p>
                    </div>
                ) : (
                    <div className="divide-y divide-dd-line/60 max-h-[60vh] overflow-y-auto">
                        {jobs.map(j => {
                            const errMsg = !j.ok ? humanizeError(j.error, isEs) : null;
                            return (
                                <div key={j.id} className="py-2 flex items-start gap-2 text-[12.5px]">
                                    <span className={`text-base shrink-0 mt-0.5 ${j.ok ? 'text-emerald-600' : 'text-red-600'}`}>
                                        {j.ok ? '✓' : '⚠'}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-baseline gap-2 flex-wrap">
                                            <span className="font-bold text-dd-text truncate">{j.title || j.kind || tx('Label', 'Etiqueta')}</span>
                                            {j.copies > 1 && (
                                                <span className="text-[10px] text-dd-text-2">× {j.copies}</span>
                                            )}
                                            <span className="text-[10px] text-dd-text-2 ml-auto">
                                                {fmtRelative(j.createdAt, isEs)}
                                            </span>
                                        </div>
                                        <div className="text-[11px] text-dd-text-2 flex items-baseline gap-1.5 flex-wrap">
                                            {j.location && <span>{LOC_LABEL[j.location] || j.location}</span>}
                                            {j.slot && <span>· {j.slot}</span>}
                                            {j.byName && <span>· {j.byName}</span>}
                                            {Number(j.durationMs) > 0 && (
                                                <span>· {Math.round(j.durationMs)}ms</span>
                                            )}
                                        </div>
                                        {!j.ok && errMsg && (
                                            <p className="text-[11px] text-red-700 font-bold mt-0.5">
                                                {errMsg}
                                                {j.printerMessage && (
                                                    <span className="font-normal opacity-70 ml-1">— {String(j.printerMessage).slice(0, 80)}</span>
                                                )}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            <p className="text-[11px] text-dd-text-2 text-center italic">
                {tx(
                    'Logged from the browser — only label prints sent through the in-app flow show up here. Direct printer access (USB / OS print dialog) bypasses logging.',
                    'Registrado desde el navegador — solo las impresiones enviadas desde la app aparecen aquí. El acceso directo (USB / impresión del SO) no se registra.',
                )}
            </p>
        </section>
    );
}
