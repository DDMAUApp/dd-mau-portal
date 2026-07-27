// AnnouncementPopup — announcements greet staff when they open the app
// (Andrew 2026-07-26: "announcements pop up when the app is opened by staff
// that is part of the announcement"). Mounted once in AppShellV2, so it
// covers every logged-in surface on every platform.
//
// Shows the newest unacked announcement whose audience matches the viewer
// (see audienceMatches). "Got it" stamps acks.{name} on the doc — the
// announcement never re-shows for that person, and the poster can see who
// has seen it. Multiple pending → shown one at a time, oldest first, so
// nothing is skipped.
import { useEffect, useMemo, useState } from 'react';
import { Megaphone } from 'lucide-react';
import ModalPortal from './ModalPortal';
import { subscribeAnnouncements, ackAnnouncement, audienceMatches } from '../data/announcements';

const FRESH_DAYS = 14;   // stop popping announcements older than this

export default function AnnouncementPopup({ staffName, staffList = [], language = 'en' }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [all, setAll] = useState([]);
    const [acking, setAcking] = useState(false);
    // Local hide for docs just acked (covers the snapshot round-trip so the
    // popup doesn't flash back between tap and echo).
    const [ackedLocal, setAckedLocal] = useState(() => new Set());

    useEffect(() => {
        if (!staffName) return undefined;
        return subscribeAnnouncements(setAll);
    }, [staffName]);

    const me = useMemo(
        () => (staffList || []).find(s => s.name === staffName) || null,
        [staffList, staffName],
    );

    const pending = useMemo(() => {
        if (!staffName || !me) return [];
        const cutoff = Date.now() - FRESH_DAYS * 86400000;
        return all
            .filter(a => a.active !== false)
            .filter(a => {
                const at = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0;
                return at === 0 || at >= cutoff;   // serverTimestamp still pending → keep
            })
            .filter(a => audienceMatches(a, me))
            .filter(a => !a.acks?.[staffName] && !ackedLocal.has(a.id))
            .reverse();                             // oldest un-seen first
    }, [all, me, staffName, ackedLocal]);

    const current = pending[0] || null;
    if (!current) return null;

    // Body in the viewer's language when a reviewed translation exists.
    const displayText = (isEs && current.translations?.es)
        ? current.translations.es
        : (!isEs && current.translations?.en ? current.translations.en : current.text);

    const when = current.createdAt?.toDate
        ? current.createdAt.toDate().toLocaleDateString(isEs ? 'es-MX' : 'en-US', { month: 'short', day: 'numeric' })
        : '';

    const gotIt = async () => {
        if (acking) return;
        setAcking(true);
        try {
            await ackAnnouncement(current.id, staffName);
        } catch (e) {
            console.warn('ackAnnouncement failed:', e);
            // Still hide locally — an offline ack queues via Firestore's
            // offline persistence on native; worst case it re-shows later.
        } finally {
            setAckedLocal(prev => new Set(prev).add(current.id));
            setAcking(false);
        }
    };

    return (
        <ModalPortal>
            <div className="fixed inset-0 z-[85] bg-black/55 flex items-center justify-center p-4">
                <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl overflow-hidden border-t-4 border-dd-green">
                    <div className="flex items-center gap-2.5 px-4 pt-4">
                        <span className="w-9 h-9 rounded-xl bg-dd-sage-50 text-dd-green-700 flex items-center justify-center shrink-0">
                            <Megaphone size={18} strokeWidth={2.25} />
                        </span>
                        <div className="min-w-0">
                            <h2 className="text-base font-black text-dd-text leading-tight">
                                {tx('Announcement', 'Anuncio')}
                            </h2>
                            <p className="text-[11px] text-dd-text-2 truncate">
                                {current.createdBy}{when ? ` · ${when}` : ''}
                            </p>
                        </div>
                        {pending.length > 1 && (
                            <span className="ml-auto text-[10px] font-bold text-dd-text-2 bg-dd-bg rounded-full px-2 py-0.5">
                                1 / {pending.length}
                            </span>
                        )}
                    </div>
                    <div className="px-4 py-3 max-h-[55vh] overflow-y-auto">
                        {current.mediaUrl && (
                            <img src={current.mediaUrl} alt="" className="w-full rounded-lg mb-2.5 max-h-64 object-cover" />
                        )}
                        <p className="text-[15px] text-dd-text leading-relaxed whitespace-pre-wrap">{displayText}</p>
                    </div>
                    <div className="px-4 pb-4 pt-1">
                        <button
                            onClick={gotIt}
                            disabled={acking}
                            className="w-full py-3 rounded-xl bg-dd-green text-white font-black text-sm active:scale-[0.99] disabled:opacity-50">
                            {acking ? tx('Saving…', 'Guardando…') : tx('✓ Got it', '✓ Entendido')}
                        </button>
                        <p className="text-center text-[10px] text-dd-text-2 mt-1.5">
                            {tx('A copy is in the 📣 Announcements chat.', 'Hay una copia en el chat 📣 Anuncios.')}
                        </p>
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
}
