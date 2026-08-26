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

import { useEffect, useMemo, useRef, useState } from 'react';
import ModalPortal from '../ModalPortal';
import { toast } from '../../toast';
import { downloadFile } from '../../capacitor-bridge';
import { lockPullToRefresh } from '../hooks/usePullToRefresh';
import { isAdmin } from '../../data/staff';

import { loadInputs, compute } from '../../data/payroll/compute.js';
import { fileToBytes, parseToastFiles } from '../../data/payroll/toastParse.js';
import {
    buildRosterView, syncWithToast, upsertPerson, staffDefaultsByKey,
} from '../../data/payroll/roster.js';
import { keyFromMaster } from '../../data/payroll/names.js';
import { validate as validateExtra } from '../../data/payroll/extras.js';
import { buildPayrollWorkbook, buildComparisonWorkbook } from '../../data/payroll/excelOut.js';
import {
    loadPayrollMeta, setPayrollPassword, verifyPayrollPassword, nameAliasesFromMeta,
    loadRoster, saveRoster, saveRun, loadLatestRunSummary, loadRunHistory,
} from '../../data/payroll/payrollStore.js';
import {
    loadQueuedAdds, saveQueuedAdds, activeQueueItems, consumedQueueItems,
    seedAdjustmentsFromQueue, requeueItem, validateQueueItem,
} from '../../data/payroll/queuedAdds.js';
import { logError } from '../../data/logger.js';
import { db } from '../../firebase';
import { collection, query, where, getDocs, orderBy } from 'firebase/firestore';
import { cardHours } from '../../data/timecards';
import { computeCrossLocOt, normCardKey, parsePeriodRange } from '../../data/payroll/crossLocOt.js';

const LOCS = ['WG', 'MH'];
const LOC_NAMES = { WG: 'Webster Groves', MH: 'Maryland Heights' };
const STEPS = ['Import', 'People & Direct Deposit', 'Pay adds', 'Tips', 'Review', 'Create docs'];
const UNLOCK_KEY = 'ddmau:payrollUnlocked';

const money = (cents) => (cents < 0 ? '-' : '') + '$' + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const h2 = (x) => (x == null ? '' : Number(x).toFixed(2));

// Pay-add line-item types, in the order shown in the picker. `field` drives which
// input(s) the row renders. Labels are plain-English for non-accountants.
const ADJ_TYPES = [
    { type: 'bonus', label: 'Bonus', field: 'amount', help: 'Flat $ added' },
    { type: 'advance', label: 'Advance (deduct)', field: 'amount', help: 'Money already paid — DEDUCTED. Note required (check #).' },
    { type: 'vacation', label: 'Vacation hours', field: 'hours', help: 'Hours paid at their base rate' },
    { type: 'holiday', label: 'Holiday hours', field: 'hours+rate', help: 'Hours at base rate (or set a holiday rate)' },
    { type: 'backpay', label: 'Back pay', field: 'hours+perhour', help: 'Hours × $/hour' },
    { type: 'reg_hours', label: 'Add regular hours', field: 'hours', help: 'Missed regular hours @ base rate' },
    { type: 'ot_hours', label: 'Add OT hours', field: 'hours', help: 'Missed OT hours @ base rate ×1.5' },
    { type: 'other', label: 'Other $', field: 'amount', help: 'Any other flat add (note recommended)' },
];
const ADJ_BY_TYPE = Object.fromEntries(ADJ_TYPES.map((t) => [t.type, t]));

function guessPeriod(names) {
    for (const n of names) {
        const m = n.match(/(\d{4})_(\d{2})_(\d{2})-(\d{4})_(\d{2})_(\d{2})/);
        if (m) return `${+m[2]}.${+m[3]}.${m[1].slice(2)}-${+m[5]}.${+m[6]}.${m[4].slice(2)}`;
    }
    return '';
}

// ───────────────────── queued pay adds (standing list) ───────────────────
// (2026-08-10, Andrew: "update as we need before we run payroll so we dont
// forget".) Editable any time the panel is unlocked; every edit persists
// immediately. A NEW period import pulls these into the run's Pay Adds
// step and marks them used — used items keep a Requeue button in case a
// run gets scrapped. Row layout intentionally mirrors the run's Pay Adds
// editor so the two feel like the same thing.
function QueuedPayAdds({ queue, peopleByLoc, staffName, mintId, onChange, saveState = 'idle', onRetry }) {
    const [showUsed, setShowUsed] = useState(false);
    if (queue === null) return <div className="mt-3 text-[11px] text-dd-text-2">Loading queued pay adds…</div>;
    const items = queue.items || [];
    const active = activeQueueItems(items);
    const used = consumedQueueItems(items);
    const edit = (id, patch) => onChange(items.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    const remove = (id) => onChange(items.filter((x) => x.id !== id));
    const add = (loc) => onChange([...items, {
        id: mintId(), loc, key: '', name: '', type: 'bonus',
        amount: '', hours: '', perHour: '', rate: '', note: '',
        addedBy: staffName || 'owner', addedAt: new Date().toISOString(), consumedIn: null,
    }]);
    return (
        <div className="mt-3 rounded-lg border border-dd-green/40 bg-dd-green/5 p-2">
            <div className="flex items-center justify-between gap-2 mb-1">
                <div className="text-[12px] font-bold text-dd-text">📌 Queued pay adds — loaded into the next payroll automatically</div>
                {/* Autosave status — the "save button" that needs no pressing. */}
                {saveState === 'saving' && <span className="text-[11px] text-dd-text-2 whitespace-nowrap">Saving…</span>}
                {saveState === 'saved' && <span className="text-[11px] text-dd-green font-bold whitespace-nowrap">✓ Saved</span>}
                {saveState === 'error' && (
                    <button onClick={onRetry} className="text-[11px] text-red-700 font-bold border border-red-300 bg-red-50 rounded px-2 py-0.5 whitespace-nowrap">
                        ⚠ Not saved — Retry
                    </button>
                )}
            </div>
            <p className="text-[11px] text-dd-text-2 mb-2">
                Write down advances, bonuses, back pay, etc. <b>the moment they happen</b> — they save instantly and
                pre-fill the Pay adds step when you import the next period, so nothing gets forgotten on payroll day.
            </p>
            {LOCS.map((loc) => {
                const locItems = active.filter((x) => x.loc === loc);
                const people = peopleByLoc[loc] || [];
                return (
                    <div key={loc} className="mb-2">
                        <div className="flex items-center justify-between mb-1">
                            <div className="font-bold text-dd-green text-[12px]">{LOC_NAMES[loc]}</div>
                            <button onClick={() => add(loc)} className="text-dd-green text-[12px] font-bold border border-dd-green/40 rounded px-2 py-0.5">+ Queue pay add</button>
                        </div>
                        {!locItems.length && <div className="text-[11px] text-dd-text-2">Nothing queued.</div>}
                        <div className="space-y-1.5">
                            {locItems.map((it) => {
                                const meta = ADJ_BY_TYPE[it.type] || ADJ_BY_TYPE.bonus;
                                const problem = validateQueueItem(it);
                                const numInput = (field, ph, w = 'w-20') => (
                                    <input type="number" step="0.01" min="0" value={it[field]} onChange={(e) => edit(it.id, { [field]: e.target.value })} placeholder={ph} className={`border border-dd-line rounded px-1 py-1 ${w} text-right text-[12px]`} />
                                );
                                return (
                                    <div key={it.id} className="rounded-lg border border-dd-line bg-white p-2 space-y-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <select value={it.key} onChange={(e) => { const k = e.target.value; const p = people.find((x) => x.key === k); edit(it.id, { key: k, name: p ? `${p.first} ${p.last}` : '' }); }}
                                                className="border border-dd-line rounded px-1 py-1 text-[12px] min-w-[10rem]">
                                                <option value="">— pick person —</option>
                                                {people.map((p) => <option key={p.key} value={p.key}>{p.first} {p.last}</option>)}
                                            </select>
                                            <select value={it.type} onChange={(e) => edit(it.id, { type: e.target.value })}
                                                className="border border-dd-line rounded px-1 py-1 text-[12px]">
                                                {ADJ_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
                                            </select>
                                            {meta.field === 'amount' && (
                                                <span className="inline-flex items-center gap-0.5"><span className="text-dd-text-2">$</span>{numInput('amount', '0.00', 'w-24')}</span>
                                            )}
                                            {meta.field === 'hours' && (
                                                <span className="inline-flex items-center gap-1">{numInput('hours', 'hrs')}<span className="text-dd-text-2 text-[11px]">hrs</span></span>
                                            )}
                                            {meta.field === 'hours+rate' && (<>
                                                <span className="inline-flex items-center gap-1">{numInput('hours', 'hrs')}<span className="text-dd-text-2 text-[11px]">hrs</span></span>
                                                <span className="inline-flex items-center gap-0.5"><span className="text-dd-text-2 text-[11px]">@ $</span>{numInput('rate', 'base')}<span className="text-dd-text-2 text-[11px]">/hr</span></span>
                                            </>)}
                                            {meta.field === 'hours+perhour' && (<>
                                                <span className="inline-flex items-center gap-1">{numInput('hours', 'hrs')}<span className="text-dd-text-2 text-[11px]">hrs</span></span>
                                                <span className="inline-flex items-center gap-0.5"><span className="text-dd-text-2 text-[11px]">@ $</span>{numInput('perHour', '0.00')}<span className="text-dd-text-2 text-[11px]">/hr</span></span>
                                            </>)}
                                            <input value={it.note} onChange={(e) => edit(it.id, { note: e.target.value })}
                                                placeholder={it.type === 'advance' ? 'note — check # (required)' : 'note'}
                                                className={`border rounded px-1 py-1 text-[12px] flex-1 min-w-[8rem] ${it.type === 'advance' && !String(it.note).trim() ? 'border-red-400 bg-red-50' : 'border-dd-line'}`} />
                                            <button onClick={() => remove(it.id)} className="text-red-600 text-[13px] px-1" title="Remove">✕</button>
                                        </div>
                                        <div className="text-[11px] pl-1">
                                            {problem
                                                ? <span className="text-amber-700">⚠ {problem} — it will still queue, fix before payroll.</span>
                                                : <span className="text-dd-text-2">{meta.help}{it.addedAt ? ` · queued ${new Date(it.addedAt).toLocaleDateString()}` : ''}</span>}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                );
            })}
            {!!used.length && (
                <div className="mt-1">
                    <button onClick={() => setShowUsed((v) => !v)} className="text-[11px] text-dd-text-2 underline">
                        {showUsed ? 'Hide' : 'Show'} used ({used.length})
                    </button>
                    {showUsed && (
                        <div className="mt-1 space-y-1">
                            {used.map((it) => (
                                <div key={it.id} className="flex items-center gap-2 text-[11px] text-dd-text-2 flex-wrap">
                                    <span>{it.name || '?'} · {(ADJ_BY_TYPE[it.type] || {}).label || it.type}{it.amount ? ` · $${it.amount}` : ''}{it.hours ? ` · ${it.hours}h` : ''} → used in <b>{it.consumedIn}</b></span>
                                    <button onClick={() => onChange(requeueItem(items, it.id))}
                                        className="text-dd-green font-bold border border-dd-green/40 rounded px-1.5 py-0">Requeue</button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ───────────────────────────── password gate ─────────────────────────────
function PayrollGate({ onUnlock, onClose, staffName }) {
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
                        <h3 className="text-base font-bold text-dd-text flex-1">Payroll</h3>
                        {/* 2026-07-12 Andrew: "that window needs a close button" —
                            without it the gate trapped you until a correct password. */}
                        <button onClick={onClose} aria-label="Close"
                            className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 text-lg flex-shrink-0">×</button>
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

// Inline "add an hourly person" mini-form for the People step. Keyed the same
// way Toast rows are (keyFromMaster on first+last), so a person added here a
// week early merges with their Toast row on the next import instead of duping.
function AddPersonRow({ onAdd }) {
    const [first, setFirst] = useState('');
    const [last, setLast] = useState('');
    const add = () => {
        if (!first.trim() || !last.trim()) { toast('Enter first and last name.'); return; }
        onAdd(first.trim(), last.trim());
        setFirst(''); setLast('');
    };
    return (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
            <input value={first} onChange={(e) => setFirst(e.target.value)} placeholder="First"
                className="border border-dd-line rounded px-1 py-0.5 w-24" />
            <input value={last} onChange={(e) => setLast(e.target.value)} placeholder="Last"
                onKeyDown={(e) => e.key === 'Enter' && add()}
                className="border border-dd-line rounded px-1 py-0.5 w-24" />
            <button onClick={add} className="text-dd-green font-bold">+ add hourly person</button>
        </div>
    );
}

// Bulk holiday pay (Andrew 2026-07-28: "if i have a holiday pay i want to
// pay staff … is there a bulk extra pay add?") — one tap seeds a 'holiday'
// Pay Add line for every hourly person at the location who doesn't already
// have one. The lines are ORDINARY adjustments after that: individually
// editable/deletable, validated by the same validateExtra path, and PH1's
// re-import keeps them. Blank rate = each person's own base rate.
function BulkHolidayAdd({ people, existingHolidayKeys, workedHours, onAdd }) {
    const [hours, setHours] = useState('8');
    const [rate, setRate] = useState('');
    // Eligibility rules (Andrew 2026-07-28: "lets give it rules we can
    // click, like how many hours they work. only to people on the current
    // payroll with hours worked") — the base rule is ALWAYS "worked this
    // period" (hours > 0 in the imported Toast files); the chips add a
    // minimum-hours threshold on top.
    const [minWorked, setMinWorked] = useState(0);
    const imported = workedHours.size > 0;
    const eligible = people.filter((p) => {
        const h = workedHours.get(p.key) || 0;
        return h > 0 && h >= minWorked;
    });
    const missing = eligible.filter((p) => !existingHolidayKeys.has(p.key));
    if (!people.length) return null;
    if (!imported) {
        return (
            <div className="rounded-lg border border-dashed border-dd-line bg-dd-bg/40 px-2 py-1.5 mb-2 text-[11px] text-dd-text-2">
                🎉 Bulk holiday unlocks after the Toast import — it only pays people with hours this period.
            </div>
        );
    }
    return (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-dd-green/40 bg-dd-sage-50/40 px-2 py-1.5 mb-2 text-[12px]">
            <span className="font-bold text-dd-green">🎉 Bulk holiday:</span>
            <span className="inline-flex items-center gap-1">
                {[[0, 'Worked any'], [10, '10+ hrs'], [20, '20+ hrs'], [30, '30+ hrs']].map(([min, label]) => (
                    <button key={min} onClick={() => setMinWorked(min)}
                        className={`rounded-full px-2 py-0.5 text-[11px] font-bold border ${minWorked === min
                            ? 'bg-dd-green text-white border-dd-green'
                            : 'bg-white text-dd-text-2 border-dd-line'}`}>
                        {label}
                    </button>
                ))}
            </span>
            <span className="inline-flex items-center gap-1">
                <input type="number" step="0.25" min="0" value={hours} onChange={(e) => setHours(e.target.value)}
                    className="border border-dd-line rounded px-1 py-1 w-16 text-right" />
                <span className="text-dd-text-2 text-[11px]">hrs</span>
            </span>
            <span className="inline-flex items-center gap-0.5">
                <span className="text-dd-text-2 text-[11px]">@ $</span>
                <input type="number" step="0.01" min="0" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="base"
                    className="border border-dd-line rounded px-1 py-1 w-20 text-right" />
                <span className="text-dd-text-2 text-[11px]">/hr</span>
            </span>
            <button onClick={() => onAdd(missing, hours, rate)} disabled={!missing.length || !(Number(hours) > 0)}
                className="text-dd-green font-bold border border-dd-green/40 rounded px-2 py-0.5 disabled:opacity-40">
                {missing.length ? `+ Add for all ${missing.length}` : '✓ Everyone added'}
            </button>
            <span className="text-[10px] text-dd-text-2 basis-full">
                {eligible.length} of {people.length} on the roster worked this period{minWorked > 0 ? ` and hit ${minWorked}+ hrs` : ''}.
                One editable holiday line each — delete anyone who doesn't qualify. Blank rate = their base rate.
            </span>
        </div>
    );
}

// ───────────────────────────── main wizard ─────────────────────────────
export default function PayrollPanel({ language, staffName, staffList, onClose }) {
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
    const [adjustments, setAdjustments] = useState([]); // pay-adds as discrete line items
    const bump = () => setRev((r) => r + 1);

    // ── Work-loss protection (2026-07-28, Andrew: "if i moved the page
    // down too much it reloaded the page and i lose all my work") ──────
    // The whole wizard lives in React state — any reload wipes it. Three
    // layers while the panel is mounted:
    //   1. lockPullToRefresh() — the app's own pull gesture is inert.
    //   2. body overscroll-behavior contain — Chrome/Android's built-in
    //      pull-to-refresh can't fire either.
    //   3. beforeunload guard — anything else that would navigate/reload
    //      (deploy auto-refresh broadcast, ⌘R, closing the tab) pops the
    //      browser's "Leave site?" confirm while real work is in flight.
    // Declared ABOVE its first read below (house TDZ rule — see the
    // Operations 2026-07-01 mount crash). Holds the latest unsaved queue
    // items; null = clean. The queue autosave block further down owns it.
    const queueDirtyRef = useRef(null);
    const hasWorkRef = useRef(false);
    hasWorkRef.current = !!(parsed || pending.length || adjustments.length || generated
        // A queue save still debouncing counts as work — the pagehide flush
        // usually lands it, but the beforeunload confirm buys it time.
        || queueDirtyRef.current != null);

    // ── Run history + resume (Andrew 2026-07-28: "once i create a payroll
    // doc can the payroll automatically save in a history tab … so i can
    // exit out and comeback and make changes and recreate docs") ────────
    // Every Generate already saves the run summary; it now also carries a
    // `draft` (cash, FOH split, every pay-add line). Resume restores that
    // draft; the owner re-imports the same Toast files and regenerates —
    // PH1's same-period import keeps the restored pay adds intact.
    const [runHistory, setRunHistory] = useState(null); // null = loading
    useEffect(() => {
        if (!unlocked) return;
        let alive = true;
        loadRunHistory().then((h) => { if (alive) setRunHistory(h); });
        return () => { alive = false; };
    }, [unlocked]);

    // ── Queued pay adds (2026-08-10, Andrew: "update as we need before we
    // run payroll so we dont forget") — a standing list, editable any time
    // the panel is unlocked, persisted immediately to Firestore. A NEW
    // period import pulls every queued item into that run's Pay Adds step.
    const [queue, setQueue] = useState(null);          // null = loading
    const queueIdRef = useRef(0);
    useEffect(() => {
        if (!unlocked) return;
        let alive = true;
        loadQueuedAdds().then((q) => {
            if (!alive) return;
            // Keep the local id counter ahead of stored ids.
            for (const it of q.items) {
                const m = /^q_(\d+)$/.exec(it.id || '');
                if (m) queueIdRef.current = Math.max(queueIdRef.current, Number(m[1]) + 1);
            }
            // prev ?? q, not q (2026-08-11 audit): doImport can fetch the
            // queue itself and persistQueue() the consumed markers BEFORE
            // this initial load resolves — letting the stale load land would
            // clobber those markers and the step-2 banner would re-offer
            // items already seeded into the run (double-add on tap).
            setQueue(prev => prev ?? q);
        });
        return () => { alive = false; };
    }, [unlocked]);
    // Autosave, no save button (2026-08-10, Andrew: "do we need a save
    // button?" — no: a button is one more thing to forget). Every change
    // shows "Saving…" immediately, writes are DEBOUNCED 600ms so typing a
    // note is one write instead of one per keystroke, and the pending
    // write is flushed on tab-hide/close/unmount so nothing typed can be
    // lost. Failures keep the dirty items and surface a retry chip.
    const [queueSaveState, setQueueSaveState] = useState('idle'); // idle|saving|saved|error
    const queueSaveTimer = useRef(null);
    // (queueDirtyRef is declared above hasWorkRef — TDZ rule.)
    const flushQueueSaveRef = useRef(() => {});
    flushQueueSaveRef.current = () => {
        clearTimeout(queueSaveTimer.current);
        if (queueDirtyRef.current == null) return;
        const items = queueDirtyRef.current;
        queueDirtyRef.current = null;
        setQueueSaveState('saving');
        saveQueuedAdds(items, staffName)
            .then(() => { if (queueDirtyRef.current == null) setQueueSaveState('saved'); })
            .catch((e) => {
                // Keep the failed items dirty unless a newer edit superseded them.
                if (queueDirtyRef.current == null) queueDirtyRef.current = items;
                setQueueSaveState('error');
                toast('Queued pay adds did NOT save — tap Retry. ' + (e?.message || ''), { kind: 'error' });
            });
    };
    const persistQueue = (items) => {
        setQueue({ items });
        queueDirtyRef.current = items;
        setQueueSaveState('saving');
        clearTimeout(queueSaveTimer.current);
        queueSaveTimer.current = setTimeout(() => flushQueueSaveRef.current(), 600);
    };
    useEffect(() => {
        const onHide = () => { if (document.visibilityState === 'hidden') flushQueueSaveRef.current(); };
        document.addEventListener('visibilitychange', onHide);
        window.addEventListener('pagehide', onHide);
        return () => {
            document.removeEventListener('visibilitychange', onHide);
            window.removeEventListener('pagehide', onHide);
            flushQueueSaveRef.current();   // unmount (closing the panel) flushes too
        };
    }, []);
    const resumeRun = (run) => {
        setPeriod(run.period || '');
        const d = run.draft || {};
        if (d.cash) setCash({ WG: d.cash.WG ?? '', MH: d.cash.MH ?? '' });
        if (d.foh) setFoh({ WG: d.foh.WG ?? 50, MH: d.foh.MH ?? 50 });
        const adjs = Array.isArray(d.adjustments) ? d.adjustments : [];
        // Keep this session's id counter ahead of the restored ids so a new
        // "+ Add" can never collide with a resumed line.
        let maxN = adjIdRef.current;
        for (const a of adjs) {
            const m = /^adj_(\d+)$/.exec(a.id || '');
            if (m) maxN = Math.max(maxN, Number(m[1]) + 1);
        }
        adjIdRef.current = maxN;
        setAdjustments(adjs);
        setAck(false);
        toast(run.draft
            ? `Resumed ${run.period} — re-import the same Toast files, then adjust and regenerate.`
            : `${run.period} restored (older run — no saved inputs; re-enter tips/pay adds).`);
    };
    useEffect(() => {
        const unlock = lockPullToRefresh();
        const prevOverscroll = document.body.style.overscrollBehaviorY;
        document.body.style.overscrollBehaviorY = 'contain';
        const guard = (e) => {
            if (!hasWorkRef.current) return;
            e.preventDefault();
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', guard);
        return () => {
            unlock();
            document.body.style.overscrollBehaviorY = prevOverscroll;
            window.removeEventListener('beforeunload', guard);
        };
    }, []);

    // STALE-ACK GUARD: the Review "I checked these numbers" acknowledgment unlocks
    // generation past WARN-level checks. If ANY input that feeds the computed
    // numbers changes after it's ticked (cash tips, FOH split, period, or any
    // roster/pay-add edit — every such edit calls bump() → rev++), the prior
    // acknowledgment is stale and must be re-given, so a payroll can never ship
    // under an acknowledgment that referred to different figures. (Fails always
    // hard-block regardless of ack.)
    // ── Cross-location overtime clock data (2026-08-26) ─────────────────
    // For people on BOTH stores' exports, combined weekly hours come from
    // the /timecards feed. null = fetch in flight (computeCrossLocOt emits a
    // FAIL check, so a run can't generate while this is loading); {ready...}
    // once resolved. Keyed by staffKey (normName of the Toast name).
    const [crossCards, setCrossCards] = useState(null);
    useEffect(() => {
        if (!parsed) { setCrossCards(null); return undefined; }
        const emps = (parsed.exports && parsed.exports.employees) || {};
        const wg = emps.WG || {}; const mh = emps.MH || {};
        const bothKeys = Object.keys(wg).filter((k) => k in mh);
        if (bothKeys.length === 0) { setCrossCards({ ready: true, byKey: {}, sig: 'none' }); return undefined; }
        const range = parsePeriodRange(period);
        if (!range) { setCrossCards({ ready: true, byKey: {}, sig: 'noperiod' }); return undefined; }
        // MUST mirror crossLocOt's staffKeys derivation: /timecards keys are
        // "first last", the raw toast_name is "Last, First" — parsed
        // first+last is the primary key, raw names the fallback.
        const staffKeys = [...new Set(bothKeys.flatMap((k) => [
            normCardKey(`${wg[k].first || ''} ${wg[k].last || ''}`),
            normCardKey(`${mh[k].first || ''} ${mh[k].last || ''}`),
            normCardKey(wg[k].toast_name), normCardKey(mh[k].toast_name),
        ]).filter(Boolean))];
        let alive = true;
        setCrossCards(null);
        (async () => {
            try {
                const byKey = {};
                let rowCount = 0; let hourSum = 0;
                for (const sk of staffKeys) {
                    // orderBy desc rides the EXISTING (staffKey, date DESC)
                    // composite index (same one subscribeMyTimecards uses) —
                    // without it this range query needs a date-ASC composite
                    // that doesn't exist and FAILED_PRECONDITIONs (found in
                    // the 2026-08-26 dry run).
                    const snap = await getDocs(query(
                        collection(db, 'timecards'),
                        where('staffKey', '==', sk),
                        where('date', '>=', range.start),
                        where('date', '<=', range.end),
                        orderBy('date', 'desc'),
                    ));
                    byKey[sk] = snap.docs.map((d) => {
                        const data = d.data();
                        const hours = cardHours(data);
                        rowCount += 1; hourSum += hours;
                        return { id: d.id, date: data.date, location: data.location, hours };
                    });
                }
                if (alive) setCrossCards({ ready: true, byKey, sig: `${rowCount}:${Math.round(hourSum * 100)}` });
            } catch (e) {
                console.warn('cross-location clock fetch failed:', e);
                if (alive) setCrossCards({ ready: true, error: e?.message || 'load failed', byKey: {}, sig: 'error' });
            }
        })();
        return () => { alive = false; };
    }, [parsed, period]);

    // `xot:` — the cross-location OT clock data arrives async AFTER import;
    // its arrival can add pay, so it must stale any earlier acknowledgment.
    const ackSig = `${rev}|${JSON.stringify(cash)}|${JSON.stringify(foh)}|${period}|${JSON.stringify(adjustments)}|xot:${crossCards ? crossCards.sig : 'pending'}`;
    const ackSigRef = useRef(ackSig);
    useEffect(() => {
        if (ackSigRef.current !== ackSig) { ackSigRef.current = ackSig; setAck(false); }
    }, [ackSig]);

    // 2026-07-30 perf: BulkHolidayAdd's two derived inputs used to be built
    // INLINE in the step-2 JSX (a fresh `new Set(...)` plus an IIFE that
    // rebuilt a Map) — new objects on every render, and every keystroke in
    // the wizard re-renders it, so the roster got re-filtered twice per
    // location per character. Memoized here, above every use (house TDZ
    // rule). `live.inputs.exports` IS `parsed.exports` — loadInputs passes
    // it straight through — so `parsed` is the honest dependency.
    const holidayKeysByLoc = useMemo(() => {
        const out = {};
        for (const loc of LOCS) {
            out[loc] = new Set(adjustments
                .filter((x) => x.loc === loc && x.type === 'holiday')
                .map((x) => x.key));
        }
        return out;
    }, [adjustments]);
    const workedHoursByLoc = useMemo(() => {
        const out = {};
        for (const loc of LOCS) {
            // Worked hours this period from the imported Toast files
            // (reg + OT), keyed like the roster.
            const m = new Map();
            const emps = (parsed && parsed.exports && parsed.exports.employees
                && parsed.exports.employees[loc]) || {};
            for (const [k, e] of Object.entries(emps)) {
                m.set(k, (Number(e.reg_hours) || 0) + (Number(e.ot_hours) || 0));
            }
            out[loc] = m;
        }
        return out;
    }, [parsed]);

    const rosterRef = useRef(null);                    // cloud roster (mutated in place)
    const adjIdRef = useRef(0);                         // monotonic id for pay-add line items

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
    if (!unlocked) return <PayrollGate staffName={staffName} onUnlock={() => setUnlocked(true)} onClose={onClose} />;
    if (!rosterRef.current) return <p className="text-sm text-dd-text-2 px-1 py-2">Loading payroll…</p>;
    // Read FAILURE (offline/flaky) — block the wizard entirely (2026-07-26
    // audit): proceeding on a blank roster meant the next save silently
    // wiped config/payroll_roster. Close + reopen retries the load.
    if (rosterRef.current.__error) {
        return (
            <div className="px-1 py-3">
                <p className="text-sm font-bold text-red-700 mb-1">Couldn't load the payroll roster.</p>
                <p className="text-xs text-dd-text-2">Check your connection, then close and reopen Payroll. Nothing was changed.</p>
            </div>
        );
    }

    const roster = rosterRef.current;
    const imported = !!parsed;

    // Live compute (pure, cheap) — recomputed each render once files are in.
    let live = null;
    if (imported) {
        // (name aliases were already applied at parse time, in doImport)
        const inputs = loadInputs(parsed.exports, parsed.salesByLoc, parsed.salesConflicts, roster);
        // Pay-adds are discrete line items now (one row = one adjustment for one
        // person), not a sparse per-person grid. The engine (validateExtra) is
        // unchanged — it still computes the signed cents and enforces all-or-nothing
        // + the advance-needs-a-note rule. A row with no person picked yet is skipped
        // until completed; a row missing its amount/hours surfaces a blocking error.
        const periodExtras = [];
        const extrasErrors = [];
        const adjResults = {}; // per-line preview: { [id]: { amount_cents, error } }
        for (const adj of adjustments) {
            if (!adj.key) continue; // person not chosen yet
            const master = inputs.masters[adj.loc];
            const byKey = master ? master.by_key : {};
            const fields = {};
            if (adj.type === 'bonus' || adj.type === 'advance' || adj.type === 'other') {
                fields.amount = adj.amount;
            } else if (adj.type === 'backpay') {
                fields.hours = adj.hours; fields.per_hour = adj.perHour;
            } else if (adj.type === 'holiday') {
                fields.hours = adj.hours;
                if (adj.rate !== '' && adj.rate != null) fields.rate = adj.rate;
            } else { // vacation, reg_hours, ot_hours → hours at base rate
                fields.hours = adj.hours;
            }
            const [x, err] = validateExtra({ type: adj.type, location: adj.loc, key: adj.key, name: adj.name, note: adj.note, ...fields }, byKey);
            if (err) { extrasErrors.push(err); adjResults[adj.id] = { error: err }; }
            else { periodExtras.push(x); adjResults[adj.id] = { amount_cents: x.amount_cents }; }
        }
        // PM2 — cash tips are physically-collected cash: never negative. Clamp to
        // >=0 so a mistyped/pasted negative can't flip the whole tip-pool sign.
        const cashNum = { WG: Math.max(0, Number(cash.WG) || 0), MH: Math.max(0, Number(cash.MH) || 0) };
        // Only default FOH% to 50 when the field is truly blank/invalid — NOT when
        // it's a deliberate 0 (a BOH-only day). `Number('0') || 50` would wrongly
        // turn 0% into 50/50 and misallocate the whole pool.
        // Blank/non-numeric → default 50; otherwise clamp to [0,100] so a stray 150
        // or −20 can't misallocate the pool (the engine also clamps defensively).
        const fohPctVal = (v) => (v === '' || v == null || Number.isNaN(Number(v)))
            ? 50 : Math.min(100, Math.max(0, Number(v)));
        const fohNum = { WG: fohPctVal(foh.WG), MH: fohPctVal(foh.MH) };
        // Cross-location overtime (2026-08-26): people on BOTH stores'
        // exports get their combined weekly hours checked against the clock
        // data; any missing OT premium is injected as a pay-add with the
        // full math in its note, and a warn check forces acknowledgment.
        // While the clock data is loading it emits a FAIL check instead, so
        // a payroll can never generate before the verification ran.
        const crossOt = computeCrossLocOt({
            period,
            employees: (parsed.exports && parsed.exports.employees) || {},
            masters: inputs.masters,
            cards: crossCards,
        });
        const results = compute(inputs, period, cashNum, fohNum, [...periodExtras, ...crossOt.extras]);
        for (const loc of LOCS) {
            if (results[loc]) results[loc].checks.push(...(crossOt.checksByLoc[loc] || []));
        }
        live = { inputs, results, extrasErrors, adjResults, crossOt };
    }

    // People & Direct Deposit works WITHOUT a Toast import (Andrew 2026-07-23):
    // the cloud roster persists from the last payroll run, so the owner can add
    // a person, flip Direct Deposit, or pin a rate any day of the period — not
    // just on payroll day. With no import, Toast-derived columns (hours, Toast
    // rate, NEW flags) simply show "—"; the rate shown is the last known rate.
    const rosterView = buildRosterView(roster, imported ? parsed.exports.employees : { WG: {}, MH: {} });

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
            // Warm the heavy doc-generation chunks NOW, while THIS bundle is known
            // good, so "Create docs" later resolves exceljs/jszip from cache and
            // can't fail on a stale lazy import even if a deploy lands mid-session.
            import('exceljs').catch(() => {});
            import('jszip').catch(() => {});
            if (isNewPeriod) {
                // Cash tips, FOH split, pay-adds, and the acknowledgment are
                // PER-PERIOD — never carry them from the previous period into a new
                // one (silent stale tips/advances would misallocate or mis-deduct).
                // PH1: clear pay-adds ONLY here. A SAME-period re-import (fixing one
                // bad Toast file) now KEEPS the advances/bonuses the owner already
                // entered — clearing them unconditionally was a silent-data-loss bug
                // that could ship an over- or under-paid check.
                setPeriod(guessed);
                setCash({ WG: '', MH: '' });
                setFoh({ WG: 50, MH: 50 });
                // Queued pay adds (2026-08-10): a NEW period starts from the
                // standing queue instead of empty — every reminder written
                // down mid-period lands in this run's Pay Adds step and is
                // marked used (visible + requeue-able in the queue history).
                // FRESH queue read at import time (2026-08-11 — Andrew's two
                // backpay adds missed the run). The state copy is null until
                // the async load finishes, so unlock-then-import-fast seeded
                // from an EMPTY queue and silently dropped every reminder.
                // Awaiting the doc here makes the seed authoritative.
                const liveQueue = queue ?? (await loadQueuedAdds().catch(() => null));
                const seeded = seedAdjustmentsFromQueue(
                    liveQueue?.items || [], guessed || period,
                    () => `adj_${adjIdRef.current++}`);
                setAdjustments(seeded.adjustments);
                if (seeded.count > 0) {
                    persistQueue(seeded.items);
                    toast(`${seeded.count} queued pay add${seeded.count === 1 ? '' : 's'} loaded into this run — review them on the Pay adds step.`, { duration: 5000 });
                }
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

    // ── pay-adds (discrete line items) ──
    // One adjustment = one pay add for one person. Far less error-prone than a
    // sparse per-person grid, supports EVERY extra type (incl. holiday + back pay
    // the grid couldn't), and can target anyone on the roster — even someone who
    // didn't clock in this period (advance square-up / bonus / back pay).
    const addAdjustment = (loc) => {
        const id = `adj_${adjIdRef.current++}`;
        setAdjustments((a) => [...a, { id, loc, key: '', name: '', type: 'bonus', amount: '', hours: '', perHour: '', rate: '', note: '' }]);
        setAck(false);
    };
    const editAdjustment = (id, patch) => {
        setAdjustments((a) => a.map((x) => (x.id === id ? { ...x, ...patch } : x)));
        setAck(false);
    };
    // Bulk holiday (2026-07-28): append one holiday adjustment per person.
    // Same row shape as addAdjustment so every downstream path (edit,
    // delete, validateExtra, re-import keep) treats them identically.
    const bulkHolidayAdd = (loc) => (peopleToAdd, hours, rate) => {
        setAdjustments((a) => [...a,
            ...peopleToAdd.map((p) => ({
                id: `adj_${adjIdRef.current++}`,
                loc, key: p.key, name: `${p.first} ${p.last}`,
                type: 'holiday', amount: '', hours: String(hours), perHour: '',
                rate: rate === '' ? '' : String(rate), note: 'Holiday',
            }))]);
        setAck(false);
    };
    const removeAdjustment = (id) => {
        setAdjustments((a) => a.filter((x) => x.id !== id));
        setAck(false);
    };

    // ── generate ──
    const fails = live ? LOCS.flatMap((l) => (live.results[l]?.checks || []).filter((k) => k.level === 'fail').map((k) => k.title)) : [];
    const warns = live ? LOCS.reduce((n, l) => n + (live.results[l]?.checks || []).filter((k) => k.level === 'warn').length, 0) : 0;
    // PM1 — a blank period would name the files "WG_PAYROLL_.xlsx" and key the
    // saved run + comparison history on an empty string. Block generation until
    // it's set (it's normally auto-filled from the Toast filenames on import).
    const noPeriod = !String(period || '').trim();
    const blocked = noPeriod || fails.length > 0 || (live && live.extrasErrors.length > 0) || (warns && !ack);

    const generate = async () => {
        // busy too (2026-07-26 audit): a fast double-tap before React
        // disabled the button ran TWO full generations → duplicate
        // payroll_runs docs corrupting the next run's comparison.
        if (blocked || busy) return;
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
                await saveRun(period, live.results, staffName, { cash, foh, adjustments });
                setGenerated({ written, zipName, previous_period: prev ? prev.period : null });
                toast('Payroll docs created.');
                // Refresh the Past payrolls list so this run (with its draft)
                // shows up immediately for a later Resume.
                loadRunHistory().then(setRunHistory).catch(() => {});
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


    // ───────────────────────── render ─────────────────────────
    const tx = (en, es) => (language === 'es' ? es : en);
    // People & DD (step 1) is reachable without an import; everything past it
    // needs this period's Toast files.
    const canAdvance = step === 2 ? imported : true;

    return (
        <div className="text-sm">
            {/* step chips */}
            <div className="flex flex-wrap gap-1.5 mb-3">
                {/* Steps 0-2 are always open: Import, the always-live People
                    & DD editor (v312), and Pay adds (2026-08-10 — without an
                    import it shows the standing QUEUE, so "Pay adds" is
                    clickable any day of the period). Tips onward need
                    imported Toast files. */}
                {STEPS.map((s, i) => (
                    <button key={s} onClick={() => { if (i <= 2 || imported) setStep(i); else toast('Import the 4 files first.'); }}
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
                        {/* placeholder — history card renders below the import row */}
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
                    {/* 📂 Past payrolls — every Generate auto-saves here (with the
                        working inputs). Resume restores period + cash tips + FOH
                        split + every pay add; re-import the same files to continue. */}
                    {!!(runHistory && runHistory.length) && (
                        <div className="mt-3 rounded-lg border border-dd-line bg-dd-bg/30 p-2">
                            <div className="text-[12px] font-bold text-dd-text mb-1">📂 Past payrolls</div>
                            <div className="space-y-1">
                                {runHistory.slice(0, 6).map((r) => (
                                    <div key={r.id} className="flex items-center gap-2 text-[12px] flex-wrap">
                                        <span className="font-bold">{r.period}</span>
                                        <span className="text-dd-text-2">
                                            {r.ranBy || ''}{r.ranAt?.toDate ? ` · ${r.ranAt.toDate().toLocaleDateString()}` : ''}
                                            {Array.isArray(r.draft?.adjustments) && r.draft.adjustments.length > 0
                                                ? ` · ${r.draft.adjustments.length} pay add(s)` : ''}
                                        </span>
                                        <button onClick={() => resumeRun(r)}
                                            className="ml-auto text-dd-green font-bold border border-dd-green/40 rounded px-2 py-0.5">
                                            Resume
                                        </button>
                                    </div>
                                ))}
                            </div>
                            <p className="text-[10px] text-dd-text-2 mt-1.5">
                                Every generate saves here automatically. Resume restores the period, cash tips, FOH split and all pay adds —
                                then re-import the same Toast files, make your changes, and regenerate (it overwrites that period's history entry).
                            </p>
                        </div>
                    )}
                    <QueuedPayAdds
                        queue={queue}
                        staffName={staffName}
                        mintId={() => `q_${queueIdRef.current++}`}
                        onChange={(items) => persistQueue(items)}
                        saveState={queueSaveState}
                        onRetry={() => flushQueueSaveRef.current()}
                        peopleByLoc={Object.fromEntries(LOCS.map((loc) => [loc,
                            (rosterView[loc].people || [])
                                .filter((p) => p.section === 'FOH' || p.section === 'BOH')
                                .slice()
                                .sort((a, b) => (`${a.last} ${a.first}`.toLowerCase() < `${b.last} ${b.first}`.toLowerCase() ? -1 : 1)),
                        ]))} />
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

            {step === 1 && (
                <div className="rounded-xl border border-dd-line bg-white p-4 space-y-4">
                    {!imported && (
                        <div className="text-[11px] text-dd-text bg-dd-bg border border-dd-line rounded px-2 py-1.5">
                            📋 <b>No Toast files imported</b> — this is the live roster carried from the last payroll run.
                            You can add people, change Direct Deposit, or set pay rates now; everything saves and is
                            already in place when you import the next period's files. Hours and Toast rates appear after an import.
                        </div>
                    )}
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
                            {/* Pre-add a new hire before they exist on Toast (Andrew
                                2026-07-23): set their section/DD/rate today; the next
                                import matches them by first+last name key and just
                                fills in the hours. */}
                            <AddPersonRow onAdd={(first, last) => {
                                const key = keyFromMaster(first, last);
                                if (!key) { toast('Enter a name.'); return; }
                                if (roster[loc].people[key]) { toast('That name is already on the roster.'); return; }
                                upsertPerson(roster, loc, key, { first, last });
                                bump();
                                persistRosterQuiet();
                            }} />
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

            {/* Pay adds WITHOUT an import = the standing queue (2026-08-10,
                Andrew: "pay adds is not opening when clicked"). Same editor
                as the landing-screen card; these seed the next new-period
                import automatically. */}
            {step === 2 && !imported && (
                <div className="rounded-xl border border-dd-line bg-white p-4">
                    <h4 className="font-bold text-dd-text mb-1">Pay adds</h4>
                    <p className="text-xs text-dd-text-2">
                        No period imported yet — anything you add here goes into the <b>standing queue</b> and
                        loads automatically when you import the next period's Toast files.
                    </p>
                    <QueuedPayAdds
                        queue={queue}
                        staffName={staffName}
                        mintId={() => `q_${queueIdRef.current++}`}
                        onChange={(items) => persistQueue(items)}
                        saveState={queueSaveState}
                        onRetry={() => flushQueueSaveRef.current()}
                        peopleByLoc={Object.fromEntries(LOCS.map((loc) => [loc,
                            (rosterView[loc].people || [])
                                .filter((p) => p.section === 'FOH' || p.section === 'BOH')
                                .slice()
                                .sort((a, b) => (`${a.last} ${a.first}`.toLowerCase() < `${b.last} ${b.first}`.toLowerCase() ? -1 : 1)),
                        ]))} />
                </div>
            )}
            {step === 2 && imported && (
                <div className="rounded-xl border border-dd-line bg-white p-4 space-y-4">
                    <div>
                        <h4 className="font-bold text-dd-text mb-1">Pay adds</h4>
                        <p className="text-xs text-dd-text-2">Add one line per adjustment — pick the person, the type, and the amount. You can add one for <b>anyone on the roster</b>, even if they had no hours this period (e.g. a back-pay or advance square-up). <b>Advance</b> is money already paid and is <b>deducted</b> (note required — put the check #). Cash tips go on the next step.</p>
                    </div>
                    {/* 2026-08-11 — queued adds that are NOT in this run yet.
                        The old design only pulled the queue at NEW-period
                        import, so items added after the import (or missed by
                        the load race fixed above) sat in the queue invisibly
                        while the run calculated without them. This banner
                        makes the miss impossible to overlook: any unconsumed
                        queue item shows here with a one-tap pull-in, at any
                        point before the docs are created. */}
                    {activeQueueItems(queue?.items).length > 0 && (
                        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 flex items-start gap-3">
                            <span className="text-xl">⚠️</span>
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-bold text-amber-900">
                                    {activeQueueItems(queue?.items).length} queued pay add{activeQueueItems(queue?.items).length === 1 ? ' is' : 's are'} NOT in this run
                                </div>
                                <div className="text-xs text-amber-800 truncate">
                                    {activeQueueItems(queue?.items).map(it =>
                                        `${it.name || '(no person)'} — ${it.type}${it.hours ? ` ${it.hours}h` : ''}${it.amount ? ` $${it.amount}` : ''}`
                                    ).join(' · ')}
                                </div>
                            </div>
                            <button
                                onClick={() => {
                                    const seeded = seedAdjustmentsFromQueue(
                                        queue?.items || [], period || 'current run',
                                        () => `adj_${adjIdRef.current++}`);
                                    if (!seeded.count) return;
                                    setAdjustments(prev => [...prev, ...seeded.adjustments]);
                                    persistQueue(seeded.items);
                                    toast(`${seeded.count} pay add${seeded.count === 1 ? '' : 's'} added to this run.`);
                                }}
                                className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-bold hover:bg-amber-700 active:scale-95"
                            >
                                Add to this run
                            </button>
                        </div>
                    )}
                    {LOCS.map((loc) => {
                        const people = (rosterView[loc].people || [])
                            .filter((p) => p.section === 'FOH' || p.section === 'BOH')
                            .slice()
                            .sort((a, b) => (`${a.last} ${a.first}`.toLowerCase() < `${b.last} ${b.first}`.toLowerCase() ? -1 : 1));
                        const locAdjs = adjustments.filter((x) => x.loc === loc);
                        return (
                            <div key={loc}>
                                <div className="flex items-center justify-between mb-1">
                                    <div className="font-bold text-dd-green">{LOC_NAMES[loc]}</div>
                                    <button onClick={() => addAdjustment(loc)} className="text-dd-green text-[12px] font-bold border border-dd-green/40 rounded px-2 py-0.5">+ Add pay adjustment</button>
                                </div>
                                <BulkHolidayAdd people={people}
                                    existingHolidayKeys={holidayKeysByLoc[loc]}
                                    workedHours={workedHoursByLoc[loc]}
                                    onAdd={bulkHolidayAdd(loc)} />
                                {!locAdjs.length && <div className="text-[11px] text-dd-text-2 mb-1">No pay adjustments for this location.</div>}
                                <div className="space-y-2">
                                    {locAdjs.map((adj) => {
                                        const meta = ADJ_BY_TYPE[adj.type] || ADJ_BY_TYPE.bonus;
                                        const r = (live && live.adjResults && live.adjResults[adj.id]) || null;
                                        const numInput = (field, ph, w = 'w-20') => (
                                            <input type="number" step="0.01" min="0" value={adj[field]} onChange={(e) => editAdjustment(adj.id, { [field]: e.target.value })} placeholder={ph} className={`border border-dd-line rounded px-1 py-1 ${w} text-right text-[12px]`} />
                                        );
                                        return (
                                            <div key={adj.id} className="rounded-lg border border-dd-line p-2 space-y-1">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <select value={adj.key} onChange={(e) => { const k = e.target.value; const p = people.find((x) => x.key === k); editAdjustment(adj.id, { key: k, name: p ? `${p.first} ${p.last}` : '' }); }}
                                                        className="border border-dd-line rounded px-1 py-1 text-[12px] min-w-[10rem]">
                                                        <option value="">— pick person —</option>
                                                        {people.map((p) => <option key={p.key} value={p.key}>{p.first} {p.last}</option>)}
                                                    </select>
                                                    <select value={adj.type} onChange={(e) => editAdjustment(adj.id, { type: e.target.value })}
                                                        className="border border-dd-line rounded px-1 py-1 text-[12px]">
                                                        {ADJ_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
                                                    </select>
                                                    {meta.field === 'amount' && (
                                                        <span className="inline-flex items-center gap-0.5"><span className="text-dd-text-2">$</span>{numInput('amount', '0.00', 'w-24')}</span>
                                                    )}
                                                    {meta.field === 'hours' && (
                                                        <span className="inline-flex items-center gap-1">{numInput('hours', 'hrs')}<span className="text-dd-text-2 text-[11px]">hrs</span></span>
                                                    )}
                                                    {meta.field === 'hours+rate' && (<>
                                                        <span className="inline-flex items-center gap-1">{numInput('hours', 'hrs')}<span className="text-dd-text-2 text-[11px]">hrs</span></span>
                                                        <span className="inline-flex items-center gap-0.5"><span className="text-dd-text-2 text-[11px]">@ $</span>{numInput('rate', 'base')}<span className="text-dd-text-2 text-[11px]">/hr</span></span>
                                                    </>)}
                                                    {meta.field === 'hours+perhour' && (<>
                                                        <span className="inline-flex items-center gap-1">{numInput('hours', 'hrs')}<span className="text-dd-text-2 text-[11px]">hrs</span></span>
                                                        <span className="inline-flex items-center gap-0.5"><span className="text-dd-text-2 text-[11px]">@ $</span>{numInput('perHour', '0.00')}<span className="text-dd-text-2 text-[11px]">/hr</span></span>
                                                    </>)}
                                                    <input value={adj.note} onChange={(e) => editAdjustment(adj.id, { note: e.target.value })}
                                                        placeholder={adj.type === 'advance' ? 'note — check # (required)' : 'note'}
                                                        className={`border rounded px-1 py-1 text-[12px] flex-1 min-w-[8rem] ${adj.type === 'advance' && !String(adj.note).trim() ? 'border-red-400 bg-red-50' : 'border-dd-line'}`} />
                                                    <button onClick={() => removeAdjustment(adj.id)} className="text-red-600 text-[13px] px-1" title="Remove">✕</button>
                                                </div>
                                                <div className="text-[11px] pl-1">
                                                    {!adj.key ? <span className="text-dd-text-2">Pick a person to apply this.</span>
                                                        : r && r.error ? <span className="text-red-700">{r.error}</span>
                                                            : r && r.amount_cents != null
                                                                ? <span className={r.amount_cents < 0 ? 'text-red-700 font-bold' : 'text-dd-green-700 font-bold'}>{r.amount_cents < 0 ? 'Deduct ' : 'Add '}{money(Math.abs(r.amount_cents))}</span>
                                                                : <span className="text-dd-text-2">{meta.help}</span>}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                    {!!(live && live.extrasErrors.length) && (
                        <div className="text-[11px] text-red-700 bg-red-50 rounded px-2 py-1">Fix before generating: {live.extrasErrors.join('; ')}</div>
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
                                        <input type="number" step="0.01" min="0" value={cash[loc]} onChange={(e) => setCash((c) => ({ ...c, [loc]: e.target.value }))} placeholder="0" className="px-2 py-1 border border-dd-line rounded w-24" /></label>
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
                    {noPeriod && (
                        <div className="text-[11px] text-red-700 bg-red-50 rounded px-2 py-1 mb-2"><b>Set the pay period first</b> — go to the Import step and fill in "Pay period". It names the files and the saved run.</div>
                    )}
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
