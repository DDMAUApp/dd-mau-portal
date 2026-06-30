// In-app payroll — the password-gated 6-step wizard that runs the JS payroll
// engine entirely in the browser (no server). Faithful to the standalone app's
// flow (Import → People & DD → Pay adds → Tips → Review → Create docs), with the
// cloud upgrades: shared roster, auto run history + comparison, prefill from the
// portal staff list. The math engine (src/data/payroll/*) is proven byte-for-byte
// against the standalone Python engine (see __local__/parity.mjs).
//
// Lazy-loaded from AdminPanel only when the section is expanded, so the engine +
// (dynamically imported) exceljs never cost anything for admins who don't run
// payroll.

import { useEffect, useRef, useState } from 'react';
import ModalPortal from '../ModalPortal';
import { toast } from '../../toast';
import { downloadFile } from '../../capacitor-bridge';
import { isAdmin } from '../../data/staff';

import { loadInputs, compute } from '../../data/payroll/compute.js';
import { fileToBytes, parseToastFiles } from '../../data/payroll/toastParse.js';
import {
    buildRosterView, syncWithToast, upsertPerson, staffDefaultsByKey,
} from '../../data/payroll/roster.js';
import { validate as validateExtra } from '../../data/payroll/extras.js';
import { buildPayrollWorkbook, buildComparisonWorkbook } from '../../data/payroll/excelOut.js';
import {
    loadPayrollMeta, setPayrollPassword, verifyPayrollPassword, nameAliasesFromMeta,
    loadRoster, saveRoster, saveRun, loadLatestRunSummary,
} from '../../data/payroll/payrollStore.js';
import { logError } from '../../data/logger.js';

const LOCS = ['WG', 'MH'];
const LOC_NAMES = { WG: 'Webster Groves', MH: 'Maryland Heights' };
const STEPS = ['Import', 'People & Direct Deposit', 'Pay adds', 'Tips', 'Review', 'Create docs'];
const UNLOCK_KEY = 'ddmau:payrollUnlocked';

const money = (cents) => (cents < 0 ? '-' : '') + '$' + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const h2 = (x) => (x == null ? '' : Number(x).toFixed(2));
const numPos = (v) => Number(v) > 0;

function guessPeriod(names) {
    for (const n of names) {
        const m = n.match(/(\d{4})_(\d{2})_(\d{2})-(\d{4})_(\d{2})_(\d{2})/);
        if (m) return `${+m[2]}.${+m[3]}.${m[1].slice(2)}-${+m[5]}.${+m[6]}.${m[4].slice(2)}`;
    }
    return '';
}

// ───────────────────────────── password gate ─────────────────────────────
function PayrollGate({ onUnlock, staffName }) {
    const [meta, setMeta] = useState(undefined); // undefined=loading, null=none, obj=set
    const [pw, setPw] = useState('');
    const [pw2, setPw2] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let alive = true;
        loadPayrollMeta().then((m) => { if (alive) setMeta(m); });
        return () => { alive = false; };
    }, []);

    const reload = () => { setMeta(undefined); loadPayrollMeta().then(setMeta); };
    // A read FAILURE must not be mistaken for "no password set" — that would
    // fail OPEN (offer to set a fresh password while offline). loadPayrollMeta
    // returns {__error:true} on failure, null only when the doc truly is absent.
    const loadErr = !!(meta && meta.__error);
    const needsSetup = !loadErr && (meta === null || (meta && !meta.passwordHash));

    const submit = async () => {
        if (busy) return;
        if (needsSetup) {
            if (pw.length < 4) { toast('Password must be at least 4 characters.'); return; }
            if (pw !== pw2) { toast('Passwords don\'t match.'); return; }
            setBusy(true);
            try {
                await setPayrollPassword(pw, staffName);
                try { sessionStorage.setItem(UNLOCK_KEY, '1'); } catch { /* ignore */ }
                toast('Payroll password set.');
                onUnlock();
            } catch (e) {
                toast('Could not save the password. ' + (e?.message || ''));
            } finally { setBusy(false); }
            return;
        }
        setBusy(true);
        try {
            const ok = await verifyPayrollPassword(pw, meta);
            if (ok) {
                try { sessionStorage.setItem(UNLOCK_KEY, '1'); } catch { /* ignore */ }
                onUnlock();
            } else {
                toast('Incorrect payroll password.');
            }
        } finally { setBusy(false); }
    };

    return (
        <ModalPortal onBackPress={() => {}}>
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
                <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl border border-dd-line p-5">
                    <div className="flex items-center gap-2 mb-1">
                        <span className="text-2xl">🔒</span>
                        <h3 className="text-base font-bold text-dd-text">Payroll</h3>
                    </div>
                    {meta === undefined ? (
                        <p className="text-sm text-dd-text-2 py-4">Checking…</p>
                    ) : loadErr ? (
                        <>
                            <p className="text-sm text-red-700 mb-3">Couldn't reach payroll. Check your connection and try again.</p>
                            <button onClick={reload} className="w-full py-2.5 rounded-lg bg-dd-green text-white font-bold">Try again</button>
                        </>
                    ) : needsSetup ? (
                        <>
                            <p className="text-sm text-dd-text-2 mb-3">
                                Set a payroll password. You and Julie will enter it each session to open payroll.
                            </p>
                            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)}
                                placeholder="New payroll password"
                                className="w-full mb-2 px-3 py-2 text-base border border-dd-line rounded-lg" />
                            <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)}
                                placeholder="Confirm password"
                                onKeyDown={(e) => e.key === 'Enter' && submit()}
                                className="w-full mb-3 px-3 py-2 text-base border border-dd-line rounded-lg" />
                        </>
                    ) : (
                        <>
                            <p className="text-sm text-dd-text-2 mb-3">Enter the payroll password to continue.</p>
                            <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)}
                                placeholder="Payroll password"
                                onKeyDown={(e) => e.key === 'Enter' && submit()}
                                className="w-full mb-3 px-3 py-2 text-base border border-dd-line rounded-lg" />
                        </>
                    )}
                    {meta !== undefined && !loadErr && (
                        <button onClick={submit} disabled={busy}
                            className="w-full py-2.5 rounded-lg bg-dd-green text-white font-bold disabled:opacity-50">
                            {busy ? '…' : (needsSetup ? 'Set password & open' : 'Unlock')}
                        </button>
                    )}
                </div>
            </div>
        </ModalPortal>
    );
}

// ───────────────────────────── main wizard ─────────────────────────────
export default function PayrollPanel({ language, staffName, staffList }) {
    const owner = isAdmin(staffName, staffList);
    const [unlocked, setUnlocked] = useState(() => {
        try { return sessionStorage.getItem(UNLOCK_KEY) === '1'; } catch { return false; }
    });

    const [meta, setMeta] = useState(null);
    const [step, setStep] = useState(0);
    const [period, setPeriod] = useState('');
    const [pending, setPending] = useState([]);       // picked File objects (not yet imported)
    const [parsed, setParsed] = useState(null);        // parseToastFiles result
    const [cash, setCash] = useState({ WG: '', MH: '' });
    const [foh, setFoh] = useState({ WG: 50, MH: 50 });
    const [ack, setAck] = useState(false);
    const [busy, setBusy] = useState(false);
    const [generated, setGenerated] = useState(null);
    const [rev, setRev] = useState(0);                 // bump to re-render on ref mutation
    const bump = () => setRev((r) => r + 1);

    // STALE-ACK GUARD: the Review "I checked these numbers" acknowledgment unlocks
    // generation past WARN-level checks. If ANY input that feeds the computed
    // numbers changes after it's ticked (cash tips, FOH split, period, or any
    // roster/pay-add edit — every such edit calls bump() → rev++), the prior
    // acknowledgment is stale and must be re-given, so a payroll can never ship
    // under an acknowledgment that referred to different figures. (Fails always
    // hard-block regardless of ack.)
    const ackSig = `${rev}|${JSON.stringify(cash)}|${JSON.stringify(foh)}|${period}`;
    const ackSigRef = useRef(ackSig);
    useEffect(() => {
        if (ackSigRef.current !== ackSig) { ackSigRef.current = ackSig; setAck(false); }
    }, [ackSig]);

    const rosterRef = useRef(null);                    // cloud roster (mutated in place)
    const gridRef = useRef(null);                      // pay-adds grid {loc:{key:{...}}}

    // Load roster + meta once unlocked.
    useEffect(() => {
        if (!unlocked) return;
        let alive = true;
        (async () => {
            const [r, m] = await Promise.all([loadRoster(), loadPayrollMeta()]);
            if (!alive) return;
            rosterRef.current = r;
            setMeta(m);
            bump();
        })();
        return () => { alive = false; };
    }, [unlocked]);

    if (!owner) return <p className="text-sm text-dd-text-2 px-1 py-2">Payroll is owner-only.</p>;
    if (!unlocked) return <PayrollGate staffName={staffName} onUnlock={() => setUnlocked(true)} />;
    if (!rosterRef.current) return <p className="text-sm text-dd-text-2 px-1 py-2">Loading payroll…</p>;

    const roster = rosterRef.current;
    const imported = !!parsed;

    // Live compute (pure, cheap) — recomputed each render once files are in.
    let live = null;
    if (imported) {
        // (name aliases were already applied at parse time, in doImport)
        const inputs = loadInputs(parsed.exports, parsed.salesByLoc, parsed.salesConflicts, roster);
        const periodExtras = [];
        const extrasErrors = [];
        const g = gridRef.current || {};
        for (const loc of LOCS) {
            const byKey = inputs.masters[loc].by_key;
            const rows = g[loc] || {};
            for (const key of Object.keys(rows)) {
                const row = rows[key];
                const add = (type, fields) => {
                    const [x, err] = validateExtra({ type, location: loc, key, name: row.name, note: row.note, ...fields }, byKey);
                    if (err) extrasErrors.push(err); else periodExtras.push(x);
                };
                if (numPos(row.reg_hours)) add('reg_hours', { hours: Number(row.reg_hours) });
                if (numPos(row.ot_hours)) add('ot_hours', { hours: Number(row.ot_hours) });
                if (numPos(row.vacation)) add('vacation', { hours: Number(row.vacation) });
                if (numPos(row.bonus)) add('bonus', { amount: Number(row.bonus) });
                if (numPos(row.advance)) add('advance', { amount: Number(row.advance) });
                if (numPos(row.other)) add('other', { amount: Number(row.other) });
            }
        }
        const cashNum = { WG: Number(cash.WG) || 0, MH: Number(cash.MH) || 0 };
        // Only default FOH% to 50 when the field is truly blank/invalid — NOT when
        // it's a deliberate 0 (a BOH-only day). `Number('0') || 50` would wrongly
        // turn 0% into 50/50 and misallocate the whole pool.
        // Blank/non-numeric → default 50; otherwise clamp to [0,100] so a stray 150
        // or −20 can't misallocate the pool (the engine also clamps defensively).
        const fohPctVal = (v) => (v === '' || v == null || Number.isNaN(Number(v)))
            ? 50 : Math.min(100, Math.max(0, Number(v)));
        const fohNum = { WG: fohPctVal(foh.WG), MH: fohPctVal(foh.MH) };
        const results = compute(inputs, period, cashNum, fohNum, periodExtras);
        live = { inputs, results, extrasErrors };
    }

    const rosterView = imported ? buildRosterView(roster, parsed.exports.employees) : null;

    // Effective "natural" rate = this period's Toast rate, else the last known
    // rate. An override is anything the owner types that differs from it.
    const naturalRate = (p) => (p.toast_rate != null ? p.toast_rate : (p.last_rate != null ? p.last_rate : 0));
    // A pinned master rate counts only if it's a real positive number. The ENGINE
    // (asRateData) treats a 0 override as "no override" and pays the Toast rate, so
    // the UI must NOT show 0 as a locked master — that would display $0 while paying
    // something else. Mirror the engine: 0 / non-numeric ⇒ not an override.
    const hasOverride = (p) => p.rate_override !== '' && p.rate_override != null
        && Number.isFinite(Number(p.rate_override)) && Number(p.rate_override) !== 0;
    const payRate = (p) => (hasOverride(p) ? Number(p.rate_override) : naturalRate(p));
    // True when this period's Pay Rate doesn't match what Toast reported (i.e. an
    // override that differs from Toast) — used to flag the row red so a mismatch
    // is impossible to miss before payroll runs.
    const rateMismatch = (p) => p.toast_rate != null && Math.abs(payRate(p) - p.toast_rate) > 0.0001;

    // Every active rate override, for the "changes" summary at the bottom of the
    // People step (so the owner can see exactly which rates are pinned over Toast).
    const rateOverrides = [];
    if (rosterView) {
        for (const loc of LOCS) {
            for (const p of rosterView[loc].people) {
                if (hasOverride(p)) {
                    rateOverrides.push({
                        loc, name: `${p.first} ${p.last}`,
                        from: (p.toast_rate != null ? p.toast_rate : (p.last_rate != null ? p.last_rate : null)),
                        to: p.rate_override,
                    });
                }
            }
        }
    }

    // ── import ──
    const onPick = (fileList) => {
        const arr = [...fileList];
        setPending(arr);
        if (!period) setPeriod(guessPeriod(arr.map((f) => f.name)));
    };
    const doImport = async () => {
        if (!pending.length) { toast('Choose the 4 Toast files first.'); return; }
        setBusy(true);
        try {
            const files = await Promise.all(pending.map(fileToBytes));
            const p = await parseToastFiles(files, nameAliasesFromMeta(meta));
            // Re-derive the period from THIS import's filenames so a re-import of a
            // DIFFERENT period can't inherit the previous period's label — and so we
            // know whether to clear the previous period's per-period entries below.
            const guessed = guessPeriod(pending.map((f) => f.name));
            const isNewPeriod = !!guessed && guessed !== period;
            const per = guessed || period;
            const defaults = staffDefaultsByKey(staffList);
            for (const loc of LOCS) {
                syncWithToast(roster, loc, p.exports.employees[loc] || {}, per, defaults);
            }
            await saveRoster(roster);     // new names persist (section pre-filled or null)
            gridRef.current = null;       // rebuild grid for the new period
            if (isNewPeriod) {
                // Cash tips, FOH split, and the acknowledgment are PER-PERIOD — never
                // carry them from the previous period into a new one (silent stale
                // tips would misallocate the pool). Re-entered fresh for this period.
                setPeriod(guessed);
                setCash({ WG: '', MH: '' });
                setFoh({ WG: 50, MH: 50 });
            }
            setAck(false);                // a fresh import always needs re-acknowledgment
            setParsed(p);
            setGenerated(null);
            bump();
            toast('Imported.');
        } catch (e) {
            toast('Import failed: ' + (e?.message || e));
        } finally { setBusy(false); }
    };

    // ── people edits ──
    const editPerson = (loc, key, field, val) => {
        upsertPerson(roster, loc, key, { [field]: val });
        bump();
    };
    // Editing the pay rate PINS a per-person master rate (rate_override) that wins
    // over Toast in the engine AND persists across every future period until it's
    // changed again — that's the whole point: a rate you set stays put even if
    // Toast later reports something different. Any number you type becomes the
    // master (even one that happens to equal today's Toast rate, so you can lock a
    // rate in place); only clearing the field reverts that person to the Toast rate.
    const editRate = (loc, p, val) => {
        const s = String(val).trim();
        if (s === '') { upsertPerson(roster, loc, p.key, { rate_override: '' }); setAck(false); bump(); return; }
        const n = Number(s);
        // Reject 0 and negatives: a pay rate must be positive, and pinning $0 would
        // be a no-op the engine ignores (paying the Toast rate) while the UI showed
        // it as a locked master — a display-vs-pay mismatch. Clearing the field is
        // the way to remove a pin.
        if (!Number.isFinite(n) || n <= 0) { bump(); return; }
        upsertPerson(roster, loc, p.key, { rate_override: n });
        setAck(false);
        bump();
    };
    // Drop the master pin → this person falls back to the Toast rate again.
    const resetRate = (loc, p) => { upsertPerson(roster, loc, p.key, { rate_override: '' }); bump(); persistRosterQuiet(); };
    // Persist the roster in the background (no toast) so a pinned master rate is
    // saved the moment the owner moves off the field — they shouldn't have to
    // remember to press "Save" for a rate change to stick to the next period.
    const persistRosterQuiet = () => { saveRoster(roster).catch((e) => console.warn('[payroll] roster autosave failed:', e?.message)); };
    const addSalary = (loc) => { roster[loc].salary.push({ first: '', last: '', amount: '', direct_deposit: true, no_tip: true, legal_name: '' }); bump(); };
    const editSalary = (loc, i, field, val) => { roster[loc].salary[i][field] = val; bump(); };
    const delSalary = (loc, i) => { roster[loc].salary.splice(i, 1); bump(); };
    const savePeople = async () => {
        setBusy(true);
        try { await saveRoster(roster); toast('Saved — carries to next payroll.'); }
        catch (e) { toast('Save failed: ' + (e?.message || e)); }
        finally { setBusy(false); }
    };

    // ── pay-adds grid ──
    // Reconcile (not build-once): make sure EVERY person who worked this period
    // has a grid row, while preserving any values already typed. This way someone
    // set up in the People step AFTER visiting Pay-adds still gets a row, and a
    // person no longer on the export is dropped. Guards on rosterView so it's a
    // no-op before import.
    const ensureGrid = () => {
        if (!rosterView) return;
        if (!gridRef.current) gridRef.current = { WG: {}, MH: {} };
        const g = gridRef.current;
        for (const loc of LOCS) {
            if (!g[loc]) g[loc] = {};
            const present = new Set();
            for (const p of (rosterView[loc].people || [])) {
                if (!p.on_toast) continue;
                present.add(p.key);
                if (!g[loc][p.key]) g[loc][p.key] = { name: `${p.first} ${p.last}`, reg_hours: '', ot_hours: '', vacation: '', bonus: '', advance: '', other: '', note: '' };
                else g[loc][p.key].name = `${p.first} ${p.last}`;
            }
            for (const k of Object.keys(g[loc])) if (!present.has(k)) delete g[loc][k];
        }
    };
    const editGrid = (loc, key, field, val) => { gridRef.current[loc][key][field] = val; bump(); };

    // ── generate ──
    const fails = live ? LOCS.flatMap((l) => (live.results[l]?.checks || []).filter((k) => k.level === 'fail').map((k) => k.title)) : [];
    const warns = live ? LOCS.reduce((n, l) => n + (live.results[l]?.checks || []).filter((k) => k.level === 'warn').length, 0) : 0;
    const blocked = fails.length > 0 || (live && live.extrasErrors.length > 0) || (warns && !ack);

    const generate = async () => {
        if (blocked) return;
        setBusy(true);
        // Track which stage we're in so a failure tells us (and the owner) exactly
        // where it broke instead of an opaque "Generate failed".
        let stage = 'start';
        try {
            // Lock in the roster used for THIS payroll (incl. any master pay rates)
            // before cutting the run — so a rate you ran payroll at can never be lost
            // by next period, even if you skipped the "Save people" button. Tolerant:
            // a save hiccup shouldn't block handing the accountant their files.
            try { await saveRoster(roster); } catch (e) { console.warn('[payroll] roster save before generate failed:', e?.message); }

            stage = 'read history';
            const prev = await loadLatestRunSummary(period); // internally tolerant → null on failure

            stage = 'build documents';
            const { default: JSZip } = await import('jszip');
            const zip = new JSZip();
            const written = [];
            for (const loc of Object.keys(live.results)) {
                const wb = await buildPayrollWorkbook(live.results[loc]);
                const fileName = `${loc}_PAYROLL_${period}.xlsx`;
                zip.file(fileName, await wb.xlsx.writeBuffer());
                written.push(fileName);
            }
            const cmp = await buildComparisonWorkbook(period, live.results, prev);
            const cmpName = `COMPARISON_${period}.xlsx`;
            zip.file(cmpName, await cmp.xlsx.writeBuffer());
            written.push(cmpName);
            // ONE download (a zip). Browsers silently drop the 2nd/3rd back-to-back
            // programmatic download (Safari especially) — which would hand the
            // accountant a partial payroll. A single file is bulletproof on web +
            // native (one share sheet instead of three).
            const zipBlob = await zip.generateAsync({ type: 'blob' });
            const zipName = `DD_Mau_Payroll_${period}.zip`;

            stage = 'download';
            await downloadFile({ data: zipBlob, fileName: zipName, mimeType: 'application/zip' });

            // Files are in the owner's hands now. Saving the run to history is a
            // NICE-TO-HAVE (it powers next period's comparison) — if it fails, the
            // payroll is NOT a failure: report success with a soft note, don't throw
            // away the files the accountant needs.
            stage = 'save history';
            try {
                await saveRun(period, live.results, staffName);
                setGenerated({ written, zipName, previous_period: prev ? prev.period : null });
                toast('Payroll docs created.');
            } catch (e) {
                console.warn('[payroll] saveRun failed:', e?.message);
                logError({ error: e, severity: 'warning', feature: 'payroll', meta: { stage, period } }).catch(() => {});
                setGenerated({ written, zipName, previous_period: prev ? prev.period : null, historyWarn: true });
                toast('Payroll files downloaded ✓ — but run history didn\'t save (next period\'s comparison may be off).');
            }
        } catch (e) {
            const msg = e?.message || String(e);
            // A dynamic-import/chunk-load failure means the open tab is running an
            // OLD app bundle whose lazy chunks (exceljs/jszip) were replaced by a
            // newer deploy → a plain reload fixes it. Tell the owner that plainly
            // instead of a scary generic error.
            const isStaleBundle = /dynamically imported module|Importing a module script failed|Failed to fetch|ChunkLoadError|Loading chunk|error loading dynamically/i.test(msg);
            logError({ error: e, severity: 'error', feature: 'payroll', meta: { stage, period } }).catch(() => {});
            if (isStaleBundle) {
                toast('The app updated in the background — please refresh the page (or pull down to reload) and press Create docs again.');
            } else {
                toast(`Create docs failed while it tried to ${stage}: ${msg}`);
            }
        } finally { setBusy(false); }
    };

    if (step === 2) ensureGrid();

    // ───────────────────────── render ─────────────────────────
    const tx = (en, es) => (language === 'es' ? es : en);
    const canAdvance = step === 0 ? imported : true;

    return (
        <div className="text-sm">
            {/* step chips */}
            <div className="flex flex-wrap gap-1.5 mb-3">
                {STEPS.map((s, i) => (
                    <button key={s} onClick={() => { if (i === 0 || imported) setStep(i); }}
                        className={`px-2.5 py-1 rounded-full text-xs font-bold border transition ${
                            i === step ? 'bg-dd-green text-white border-dd-green'
                                : i < step ? 'text-dd-green border-dd-green/40 bg-white'
                                    : 'text-dd-text-2 border-dd-line bg-white'}`}>
                        {i + 1}. {s}
                    </button>
                ))}
            </div>

            {step === 0 && (
                <div className="rounded-xl border border-dd-line bg-white p-4">
                    <h4 className="font-bold text-dd-text mb-1">Import this period's Toast files</h4>
                    <p className="text-xs text-dd-text-2 mb-3">
                        Pick the <b>4 files</b> from Toast: WG + MH payroll exports and WG + MH Sales Summaries.
                        Rates and names come from these files. Nothing leaves this device except the run you save.
                    </p>
                    <div className="flex flex-wrap items-end gap-3">
                        <label className="block">
                            <span className="block text-xs font-bold text-dd-text-2 mb-1">Pay period (goes on the doc)</span>
                            <input value={period} onChange={(e) => setPeriod(e.target.value.trim())} placeholder="5.18.26-5.30.26"
                                className="px-3 py-2 text-base border border-dd-line rounded-lg" />
                        </label>
                        <label className="block">
                            <span className="block text-xs font-bold text-dd-text-2 mb-1">The 4 files</span>
                            <input type="file" multiple accept=".csv,.xlsx" onChange={(e) => onPick(e.target.files)}
                                className="text-xs" />
                        </label>
                        <button onClick={doImport} disabled={busy || !pending.length}
                            className="px-4 py-2 rounded-lg bg-dd-green text-white font-bold disabled:opacity-50">
                            {busy ? '…' : 'Import'}
                        </button>
                    </div>
                    {!!pending.length && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            {pending.map((f) => (
                                <span key={f.name} className="text-[11px] bg-dd-bg border border-dd-line rounded px-2 py-0.5">{f.name}</span>
                            ))}
                        </div>
                    )}
                    {imported && (
                        <div className="mt-3 space-y-1.5">
                            {LOCS.map((l) => {
                                const hasPay = !!(parsed.exports.employees[l] && Object.keys(parsed.exports.employees[l]).length);
                                const hasSales = !!parsed.salesByLoc[l];
                                return (
                                    <div key={l} className="flex gap-2 text-[11px]">
                                        <span className={`px-2 py-0.5 rounded ${hasPay ? 'bg-dd-green-50 text-dd-green-700' : 'bg-red-50 text-red-700'}`}>{l} payroll {hasPay ? '✓' : '— missing'}</span>
                                        <span className={`px-2 py-0.5 rounded ${hasSales ? 'bg-dd-green-50 text-dd-green-700' : 'bg-red-50 text-red-700'}`}>{l} sales {hasSales ? '✓' : '— missing'}</span>
                                    </div>
                                );
                            })}
                            {(parsed.classified.unrecognized || []).map((f) => (
                                <div key={f} className="text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-1">Ignored (not a payroll export or sales summary): {f}</div>
                            ))}
                            {(live?.inputs.problems || []).map((p, i) => (
                                <div key={i} className="text-[11px] text-red-700 bg-red-50 rounded px-2 py-1 font-semibold">{p}</div>
                            ))}
                            {!(live?.inputs.problems || []).length && (
                                <div className="text-[11px] text-dd-green-700 bg-dd-green-50 rounded px-2 py-1">Imported for <b>{period}</b>. Click Next.</div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {step === 1 && imported && (
                <div className="rounded-xl border border-dd-line bg-white p-4 space-y-4">
                    <div>
                        <h4 className="font-bold text-dd-text mb-1">People & Direct Deposit</h4>
                        <p className="text-xs text-dd-text-2">This list is live — what you set carries to every future payroll. Set anyone marked <span className="text-red-600 font-bold">NEW</span> (FOH/BOH + Direct Deposit). Hours come from Toast; the <b>pay rate</b> defaults to Toast but you can change it here. <b>A rate you set becomes that person's master rate</b> — it stays at that price every period (even if Toast later reports something else) until you change it again or tap <b>↺</b> to go back to Toast. Rows where the master rate differs from the current Toast Rate are highlighted <span className="text-red-600 font-bold">red</span>.</p>
                    </div>
                    {LOCS.map((loc) => (
                        <div key={loc}>
                            <div className="font-bold text-dd-green mb-1">{LOC_NAMES[loc]}</div>
                            <div className="overflow-x-auto">
                                <table className="w-full text-[11px]">
                                    <thead><tr className="text-left text-dd-text-2">
                                        <th className="py-1 pr-2">Name (Toast)</th><th className="px-1 text-right">Hrs</th><th className="px-1 text-right">Pay Rate</th><th className="px-1 text-right">Toast Rate</th>
                                        <th className="px-1">Section</th><th className="px-1">DD</th><th className="px-1">In pool</th>
                                    </tr></thead>
                                    <tbody>
                                        {rosterView[loc].people.map((p) => (
                                            <tr key={p.key} className={rateMismatch(p) ? 'bg-red-100' : (p.needs_setup ? 'bg-red-50' : '')}>
                                                <td className="py-1 pr-2">{p.first} {p.last}
                                                    {p.needs_setup && <span className="ml-1 text-red-600 font-bold">NEW</span>}
                                                    {!p.on_toast && !p.needs_setup && <span className="ml-1 text-dd-text-2">(no hours)</span>}</td>
                                                <td className="px-1 text-right">{p.on_toast ? h2((p.reg_hours || 0) + (p.ot_hours || 0)) : '—'}</td>
                                                <td className="px-1 text-right">
                                                    <span className="inline-flex items-center gap-0.5 justify-end">
                                                        <span className="text-dd-text-2">$</span>
                                                        <input type="number" step="0.01" min="0"
                                                            value={hasOverride(p) ? p.rate_override : naturalRate(p)}
                                                            onChange={(e) => editRate(loc, p, e.target.value)}
                                                            onBlur={persistRosterQuiet}
                                                            title={hasOverride(p) ? `Master rate — locked at $${h2(p.rate_override)} (Toast says $${h2(naturalRate(p))}). Stays until you change it.` : 'From Toast — type to set a master rate that sticks'}
                                                            className={`w-16 text-right rounded px-1 py-0.5 border ${hasOverride(p) ? 'border-dd-green bg-dd-green-50 font-bold text-dd-green-700' : 'border-dd-line'}`} />
                                                        {hasOverride(p) && (
                                                            <button type="button" onClick={() => resetRate(loc, p)}
                                                                title={`Reset to Toast rate ($${h2(naturalRate(p))})`}
                                                                className="text-dd-text-2 hover:text-red-600 leading-none px-0.5">↺</button>
                                                        )}
                                                    </span>
                                                </td>
                                                <td className="px-1 text-right text-dd-text-2">{p.toast_rate != null ? '$' + h2(p.toast_rate) : '—'}</td>
                                                <td className="px-1">
                                                    <select value={p.section || ''} onChange={(e) => editPerson(loc, p.key, 'section', e.target.value)}
                                                        className="border border-dd-line rounded px-1 py-0.5 text-[11px]">
                                                        <option value="">— set —</option><option value="FOH">FOH</option><option value="BOH">BOH</option>
                                                    </select>
                                                </td>
                                                <td className="px-1 text-center"><input type="checkbox" checked={!!p.direct_deposit} onChange={(e) => editPerson(loc, p.key, 'direct_deposit', e.target.checked)} /></td>
                                                <td className="px-1 text-center"><input type="checkbox" checked={!p.no_tip} onChange={(e) => editPerson(loc, p.key, 'no_tip', !e.target.checked)} /></td>
                                            </tr>
                                        ))}
                                        {!rosterView[loc].people.length && <tr><td colSpan={7} className="text-dd-text-2 py-1">no one yet</td></tr>}
                                    </tbody>
                                </table>
                            </div>
                            <div className="mt-2">
                                <div className="text-[11px] font-bold text-dd-text-2 mb-1">Salary (fixed each period, not on Toast)</div>
                                <table className="w-full text-[11px]">
                                    <tbody>
                                        {(roster[loc].salary || []).map((s, i) => (
                                            <tr key={i}>
                                                <td className="pr-1"><input value={s.first || ''} onChange={(e) => editSalary(loc, i, 'first', e.target.value)} placeholder="First" className="border border-dd-line rounded px-1 py-0.5 w-24" /></td>
                                                <td className="pr-1"><input value={s.last || ''} onChange={(e) => editSalary(loc, i, 'last', e.target.value)} placeholder="Last" className="border border-dd-line rounded px-1 py-0.5 w-24" /></td>
                                                <td className="pr-1"><input type="number" step="0.01" value={s.amount || ''} onChange={(e) => editSalary(loc, i, 'amount', e.target.value)} placeholder="$/period" className="border border-dd-line rounded px-1 py-0.5 w-24" /></td>
                                                <td className="pr-1 text-center"><label className="text-[10px]"><input type="checkbox" checked={s.direct_deposit !== false} onChange={(e) => editSalary(loc, i, 'direct_deposit', e.target.checked)} /> DD</label></td>
                                                <td><button onClick={() => delSalary(loc, i)} className="text-red-600 text-[11px]">remove</button></td>
                                            </tr>
                                        ))}
                                        <tr><td colSpan={5}><button onClick={() => addSalary(loc)} className="text-dd-green text-[11px] font-bold">+ add salary person</button></td></tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    ))}
                    {rateOverrides.length > 0 && (
                        <div className="rounded-lg border border-dd-green/40 bg-dd-green-50 p-2 text-[11px]">
                            <div className="font-bold text-dd-green-700 mb-1">Master pay rates — locked, carry to every period ({rateOverrides.length})</div>
                            {rateOverrides.map((r, i) => {
                                const differs = r.from != null && Math.abs(Number(r.to) - Number(r.from)) > 0.0001;
                                return (
                                    <div key={i} className="text-dd-text">
                                        {r.loc} · {r.name}: <b>${h2(r.to)}</b>
                                        {differs && <span className="text-dd-text-2"> (Toast says ${h2(r.from)})</span>}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    <button onClick={savePeople} disabled={busy} className="px-4 py-2 rounded-lg bg-dd-green text-white font-bold disabled:opacity-50">Save people & Direct Deposit</button>
                </div>
            )}

            {step === 2 && imported && (
                <div className="rounded-xl border border-dd-line bg-white p-4 space-y-4">
                    <div>
                        <h4 className="font-bold text-dd-text mb-1">Pay adds</h4>
                        <p className="text-xs text-dd-text-2">Fill only the boxes that apply. Added reg/OT hours are wages (not tips). <b>Advance</b> is money already paid, <b>deducted</b> this run (put the check # in the note). Cash tips go on the next step.</p>
                    </div>
                    {LOCS.map((loc) => {
                        const keys = Object.keys((gridRef.current && gridRef.current[loc]) || {});
                        if (!keys.length) return null;
                        return (
                            <div key={loc}>
                                <div className="font-bold text-dd-green mb-1">{LOC_NAMES[loc]}</div>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-[11px]">
                                        <thead><tr className="text-left text-dd-text-2">
                                            <th className="py-1 pr-2">Person</th><th className="px-1">Reg hrs</th><th className="px-1">OT hrs</th><th className="px-1">Vac hrs</th><th className="px-1">Bonus $</th><th className="px-1">Advance $</th><th className="px-1">Other $</th><th className="px-1">Note</th>
                                        </tr></thead>
                                        <tbody>
                                            {keys.map((k) => {
                                                const g = gridRef.current[loc][k];
                                                const num = (field, w = 'w-16') => (
                                                    <input type="number" step="0.01" value={g[field]} onChange={(e) => editGrid(loc, k, field, e.target.value)} className={`border border-dd-line rounded px-1 py-0.5 ${w}`} />
                                                );
                                                return (
                                                    <tr key={k}>
                                                        <td className="py-1 pr-2">{g.name}</td>
                                                        <td className="px-1">{num('reg_hours')}</td><td className="px-1">{num('ot_hours')}</td>
                                                        <td className="px-1">{num('vacation')}</td><td className="px-1">{num('bonus')}</td>
                                                        <td className="px-1">{num('advance')}</td><td className="px-1">{num('other')}</td>
                                                        <td className="px-1"><input value={g.note} onChange={(e) => editGrid(loc, k, 'note', e.target.value)} className="border border-dd-line rounded px-1 py-0.5 w-40" /></td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        );
                    })}
                    {!!(live && live.extrasErrors.length) && (
                        <div className="text-[11px] text-red-700 bg-red-50 rounded px-2 py-1">{live.extrasErrors.join('; ')}</div>
                    )}
                </div>
            )}

            {step === 3 && live && (
                <div className="rounded-xl border border-dd-line bg-white p-4 space-y-4">
                    <div>
                        <h4 className="font-bold text-dd-text mb-1">Tips</h4>
                        <p className="text-xs text-dd-text-2">Card tips come from each Sales Summary. Enter cash tips. FOH/BOH split is 50/50 unless you change it.</p>
                    </div>
                    {LOCS.map((loc) => {
                        const res = live.results[loc];
                        if (!res) return null;
                        const t = res.tips;
                        return (
                            <div key={loc}>
                                <div className="font-bold text-dd-green mb-1">{LOC_NAMES[loc]}</div>
                                {res.checks.find((k) => k.id === 'sales') && (
                                    <div className="text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-1 mb-1">{res.checks.find((k) => k.id === 'sales').detail}</div>
                                )}
                                <div className="flex flex-wrap items-end gap-3 mb-2">
                                    <label className="block"><span className="block text-[11px] text-dd-text-2 mb-0.5">Card tips</span>
                                        <input value={money(t.card_cents)} disabled className="px-2 py-1 border border-dd-line rounded bg-dd-bg w-28 text-right" /></label>
                                    <label className="block"><span className="block text-[11px] text-dd-text-2 mb-0.5">Cash tips $</span>
                                        <input type="number" step="0.01" value={cash[loc]} onChange={(e) => setCash((c) => ({ ...c, [loc]: e.target.value }))} placeholder="0" className="px-2 py-1 border border-dd-line rounded w-24" /></label>
                                    <label className="block"><span className="block text-[11px] text-dd-text-2 mb-0.5">FOH %</span>
                                        <input type="number" step="0.5" min="0" max="100" value={foh[loc]} onChange={(e) => setFoh((c) => ({ ...c, [loc]: e.target.value }))} className="px-2 py-1 border border-dd-line rounded w-20" /></label>
                                </div>
                                <table className="w-full text-[11px]">
                                    <thead><tr className="text-left text-dd-text-2"><th></th><th className="text-right px-1">Pool</th><th className="text-right px-1">Hours</th><th className="text-right px-1">$/hr</th></tr></thead>
                                    <tbody>
                                        <tr><td className="font-bold">FOH</td><td className="text-right px-1">{money(t.foh_pool_cents)}</td><td className="text-right px-1">{h2(res.sections.FOH.eligible_hours)}</td><td className="text-right px-1">${h2(res.sections.FOH.tips_per_hour)}</td></tr>
                                        <tr><td className="font-bold">BOH</td><td className="text-right px-1">{money(t.boh_pool_cents)}</td><td className="text-right px-1">{h2(res.sections.BOH.eligible_hours)}</td><td className="text-right px-1">${h2(res.sections.BOH.tips_per_hour)}</td></tr>
                                        <tr className="font-bold"><td>Total</td><td className="text-right px-1">{money(t.total_cents)}</td><td></td><td></td></tr>
                                    </tbody>
                                </table>
                            </div>
                        );
                    })}
                </div>
            )}

            {step === 4 && live && (
                <div className="space-y-3">
                    {LOCS.map((loc) => {
                        const res = live.results[loc];
                        if (!res) return null;
                        const order = { fail: 0, warn: 1, pass: 2, info: 3 };
                        const checks = [...res.checks].sort((a, b) => order[a.level] - order[b.level]);
                        return (
                            <div key={loc} className="rounded-xl border border-dd-line bg-white p-4">
                                <h4 className="font-bold text-dd-text mb-2">{LOC_NAMES[loc]} — review</h4>
                                <div className="space-y-1 mb-3">
                                    {checks.map((k, i) => (
                                        <div key={i} className={`text-[11px] rounded px-2 py-1 ${k.level === 'fail' ? 'bg-red-50 text-red-700' : k.level === 'warn' ? 'bg-amber-50 text-amber-800' : k.level === 'pass' ? 'bg-dd-green-50 text-dd-green-700' : 'bg-dd-bg text-dd-text-2'}`}>
                                            <b>{k.level.toUpperCase()}</b> {k.title}{k.detail ? ` — ${k.detail}` : ''}
                                        </div>
                                    ))}
                                </div>
                                {['FOH', 'BOH'].map((sec) => (
                                    <div key={sec} className="mb-2 overflow-x-auto">
                                        <div className="text-[11px] font-bold text-dd-green">{sec} — pool {money(res.sections[sec].pool_cents)}</div>
                                        <table className="w-full text-[11px]">
                                            <thead><tr className="text-left text-dd-text-2"><th className="pr-2">Person</th><th className="text-right px-1">Rate</th><th className="text-right px-1">Hrs</th><th className="text-right px-1">Tips</th><th className="text-right px-1">Reg</th><th className="text-right px-1">OT</th><th className="text-right px-1">Extra</th><th className="text-right px-1">TOTAL</th><th>DD</th></tr></thead>
                                            <tbody>
                                                {res.sections[sec].rows.map((r) => (
                                                    <tr key={r.key} className={(r.toast_rate != null && Math.abs(r.rate - r.toast_rate) > 0.005) ? 'bg-red-100' : (r.multi_line ? 'bg-amber-50' : '')}>
                                                        <td className="pr-2">{r.display_first} {r.display_last}{r.no_tip ? <span className="text-dd-text-2"> (no tips)</span> : ''}</td>
                                                        <td className="text-right px-1">${h2(r.rate)}</td>
                                                        <td className="text-right px-1">{h2(r.total_hours)}</td>
                                                        <td className="text-right px-1">{money(r.tip_cents)}</td>
                                                        <td className="text-right px-1">{money(r.reg_cents)}</td>
                                                        <td className="text-right px-1">{money(r.ot_cents)}</td>
                                                        <td className={`text-right px-1 ${r.extra_cents < 0 ? 'text-red-600' : ''}`}>{r.extra_cents ? money(r.extra_cents) : ''}</td>
                                                        <td className="text-right px-1 font-bold">{money(r.comp_cents)}</td>
                                                        <td>{r.direct_deposit ? 'DD' : ''}</td>
                                                    </tr>
                                                ))}
                                                <tr className="font-bold border-t border-dd-line">
                                                    <td>TOTAL {sec}</td><td></td><td className="text-right px-1">{h2(res.sections[sec].totals.total_hours)}</td>
                                                    <td className="text-right px-1">{money(res.sections[sec].totals.tip_cents)}</td>
                                                    <td className="text-right px-1">{money(res.sections[sec].totals.reg_cents)}</td>
                                                    <td className="text-right px-1">{money(res.sections[sec].totals.ot_cents)}</td>
                                                    <td className="text-right px-1">{money(res.sections[sec].totals.extra_cents)}</td>
                                                    <td className="text-right px-1">{money(res.sections[sec].totals.comp_cents)}</td><td></td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>
                                ))}
                                {!!res.review.length && (
                                    <div className="text-[11px] text-red-700 bg-red-50 rounded px-2 py-1">
                                        <b>NEW — not set up (in NO tip pool). Go to People & Direct Deposit:</b><br />
                                        {res.review.map((u) => `${u.toast_name} — ${h2(u.total_hours)}h`).join(' · ')}
                                    </div>
                                )}
                                {!!res.salary.length && (
                                    <div className="mt-1 text-[11px] text-dd-text-2">Salary: {res.salary.map((s) => `${s.first} ${s.last} ${money(s.amount_cents)}`).join(' · ')}</div>
                                )}
                            </div>
                        );
                    })}
                    <label className="flex items-center gap-2 text-sm rounded-xl border border-dd-line bg-white p-3">
                        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                        I checked the review items above — the numbers are right
                    </label>
                </div>
            )}

            {step === 5 && live && (
                <div className="rounded-xl border border-dd-line bg-white p-4">
                    <h4 className="font-bold text-dd-text mb-2">Create the payroll docs</h4>
                    {fails.length > 0 && (
                        <div className="text-[11px] text-red-700 bg-red-50 rounded px-2 py-1 mb-2"><b>Can't create — fix these first:</b><br />{fails.join(' · ')}</div>
                    )}
                    {!!(live.extrasErrors.length) && (
                        <div className="text-[11px] text-red-700 bg-red-50 rounded px-2 py-1 mb-2"><b>Pay-adds problem:</b> {live.extrasErrors.join('; ')}</div>
                    )}
                    {warns > 0 && !ack && (
                        <div className="text-[11px] text-amber-800 bg-amber-50 rounded px-2 py-1 mb-2">There are {warns} review item(s) — tick the acknowledgment on the Review step.</div>
                    )}
                    <p className="text-xs text-dd-text-2 mb-3">
                        Downloads <b>WG_PAYROLL_{period}.xlsx</b>, <b>MH_PAYROLL_{period}.xlsx</b> and <b>COMPARISON_{period}.xlsx</b>.
                        Send the two PAYROLL files to the accountant. The run is saved to history for next period's comparison.
                    </p>
                    <button onClick={generate} disabled={busy || blocked}
                        className="px-5 py-3 rounded-lg bg-dd-green text-white font-bold disabled:opacity-50">
                        {busy ? 'Working…' : 'Create payroll docs'}
                    </button>
                    {generated && (
                        <div className="mt-3 text-[11px] text-dd-green-700 bg-dd-green-50 rounded px-2 py-2">
                            <b>Done.</b> Downloaded <b>{generated.zipName}</b> — contains {generated.written.join(', ')}. Unzip, then send the two PAYROLL files to the accountant.<br />
                            {generated.previous_period ? `Compared against ${generated.previous_period}.` : '(First run — next time you\'ll get a real comparison.)'}
                        </div>
                    )}
                </div>
            )}

            {/* nav */}
            <div className="flex justify-between mt-4">
                <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}
                    className="px-4 py-2 rounded-lg border border-dd-line text-dd-text font-bold disabled:opacity-40">← Back</button>
                {step < STEPS.length - 1 && (
                    <button onClick={() => { if (!canAdvance) { toast('Import the 4 files first.'); return; } setStep((s) => Math.min(STEPS.length - 1, s + 1)); }}
                        className="px-4 py-2 rounded-lg bg-dd-green text-white font-bold">Next →</button>
                )}
            </div>
        </div>
    );
}
