// 📝 Payroll notes & reminders tab (2026-08-29, Andrew). Free-text reminders
// ("edith needs to be paid vacation pay") with the author's name + timestamp,
// and a done checkbox that strikes the line through. Lives as its own step in
// the payroll wizard, reachable WITHOUT a Toast import (like People & DD).
// Own component so its hooks mount/unmount with the tab — the parent panel's
// hook order never changes.

import { useEffect, useRef, useState } from 'react';
import { subscribePayrollNotes, addPayrollNote, setPayrollNoteDone, deletePayrollNote } from '../../data/payroll/payrollNotes.js';
import { toast } from '../../toast';

function fmtStamp(ts) {
    const ms = ts?.toMillis ? ts.toMillis() : (ts?.seconds ? ts.seconds * 1000 : null);
    if (!ms) return 'just now'; // serverTimestamp still pending on a fresh write
    return new Date(ms).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
}

export default function PayrollNotes({ staffName }) {
    const [notes, setNotes] = useState(undefined);   // undefined=loading, null=error, []=empty
    const [draft, setDraft] = useState('');
    const [busyId, setBusyId] = useState(null);
    const [gen, setGen] = useState(0);               // bump to resubscribe after an error
    const addBusyRef = useRef(false);

    useEffect(() => subscribePayrollNotes(setNotes), [gen]);

    const handleAdd = async () => {
        if (addBusyRef.current) return;
        const text = draft.trim();
        if (!text) return;
        addBusyRef.current = true;
        try {
            const res = await addPayrollNote({ text, byName: staffName });
            if (res.ok) setDraft('');
            else toast('Note did not save — check your connection.', { kind: 'error' });
        } finally {
            addBusyRef.current = false;
        }
    };

    const handleToggle = async (n) => {
        if (busyId) return;
        setBusyId(n.id);
        try {
            const res = await setPayrollNoteDone(n.id, !n.done, staffName);
            if (!res.ok) toast('Change did not save — check your connection.', { kind: 'error' });
        } finally {
            setBusyId(null);
        }
    };

    const handleDelete = async (n) => {
        if (!window.confirm(`Delete this note?\n\n“${String(n.text).slice(0, 120)}”`)) return;
        const res = await deletePayrollNote(n.id);
        if (!res.ok) toast('Delete failed — check your connection.', { kind: 'error' });
    };

    return (
        <div className="space-y-3">
            <p className="text-xs text-dd-text-2">
                Reminders for payroll day — e.g. “Edith needs to be paid vacation pay.”
                Notes are shared between owners; checking Done strikes the line through
                (uncheck to bring it back).
            </p>

            <div className="flex gap-2 items-start">
                <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAdd(); } }}
                    rows={2}
                    placeholder="Write a note or reminder…"
                    className="flex-1 text-sm border border-dd-line rounded-lg px-3 py-2 bg-white resize-y"
                />
                <button
                    onClick={handleAdd}
                    disabled={!draft.trim()}
                    className="px-4 py-2 rounded-lg bg-dd-green-700 text-white font-bold text-sm disabled:opacity-40 shrink-0">
                    Add
                </button>
            </div>

            {notes === undefined && <p className="text-sm text-dd-text-2 animate-pulse">Loading notes…</p>}
            {notes === null && (
                <p className="text-sm text-red-700">
                    Couldn’t load notes.{' '}
                    <button className="underline font-bold" onClick={() => { setNotes(undefined); setGen((g) => g + 1); }}>Retry</button>
                </p>
            )}
            {Array.isArray(notes) && notes.length === 0 && (
                <p className="text-sm text-dd-text-2">No notes yet.</p>
            )}

            {Array.isArray(notes) && notes.map((n) => (
                <div key={n.id}
                    className={`flex items-start gap-3 p-3 rounded-xl border ${n.done ? 'bg-dd-bg/50 border-dd-line/60' : 'bg-white border-dd-line'}`}>
                    <input
                        type="checkbox"
                        checked={!!n.done}
                        disabled={busyId === n.id}
                        onChange={() => handleToggle(n)}
                        aria-label={n.done ? 'Mark not done' : 'Mark done'}
                        className="mt-0.5 w-5 h-5 accent-dd-green-700 shrink-0 cursor-pointer"
                    />
                    <div className="flex-1 min-w-0">
                        <p className={`text-sm whitespace-pre-wrap break-words ${n.done ? 'line-through text-dd-text-2' : 'text-dd-text'}`}>
                            {n.text}
                        </p>
                        <p className="text-[11px] text-dd-text-2 mt-1">
                            — {n.byName || 'unknown'} · {fmtStamp(n.createdAt)}
                            {n.done && n.doneBy && (
                                <span className="ml-2 text-dd-green-700">✓ done by {n.doneBy} · {fmtStamp(n.doneAt)}</span>
                            )}
                        </p>
                    </div>
                    <button
                        onClick={() => handleDelete(n)}
                        title="Delete note"
                        className="text-dd-text-2 hover:text-red-600 text-sm shrink-0 px-1">
                        🗑
                    </button>
                </div>
            ))}
        </div>
    );
}
