// OnboardingAcknowledgment — hire-side renderer for acknowledgment-kind
// onboarding docs (handbook, tip credit notice, workers' comp notice).
//
// Renders the policy text (loaded from /config/policies/{policyKey} if
// admin has overridden the default, else from DEFAULT_POLICIES) as a
// scrollable card the hire reads, then captures:
//   - Three explicit consent checkboxes ("I read it", "I understand",
//     "I agree to follow it")
//   - A typed signature that must match hire.name
//
// On submit:
//   1. Generate a "Signed Acknowledgment.pdf" via pdf-lib (policy text +
//      signature + date + ip-hash + user-agent) for the legal record.
//   2. Upload to onboarding/{hireId}/{docId}/signed_{ts}.pdf
//   3. Flip the doc to SUBMITTED via onSubmitted prop.
//
// Same Complete + Edit pattern as OnboardingFillablePdf — the success
// view becomes locked when admin moves the hire to the Complete folder.

import { useState, useEffect } from 'react';
import { db, storage } from '../firebase';
import { doc, getDoc } from 'firebase/firestore';
import { ref as sref, uploadBytes } from 'firebase/storage';
import { DEFAULT_POLICIES } from '../data/onboardingPolicies';

async function loadPdfLib() { return await import('pdf-lib'); }

async function sha256Hex(input) {
    if (!input || typeof crypto === 'undefined' || !crypto.subtle) return '';
    try {
        const bytes = new TextEncoder().encode(String(input));
        const buf = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch { return ''; }
}

export default function OnboardingAcknowledgment({
    docDef, hire, hireId, isEs, isLocked, onSubmitted, onStart,
}) {
    const tx = (en, es) => (isEs ? es : en);
    const [policy, setPolicy] = useState(null);
    const [readConfirmed, setReadConfirmed] = useState(false);
    const [understoodConfirmed, setUnderstoodConfirmed] = useState(false);
    const [agreeConfirmed, setAgreeConfirmed] = useState(false);
    const [typedSignature, setTypedSignature] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [err, setErr] = useState('');

    const docStatus = (hire?.checklist && hire.checklist[docDef.id] && hire.checklist[docDef.id].status) || 'needed';
    const wasSubmitted = docStatus === 'submitted' || docStatus === 'approved';
    const [showSubmitted, setShowSubmitted] = useState(wasSubmitted);

    // Load policy text. Admin override at /config/policies/{key} wins,
    // else fall back to the bundled default.
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const ref = doc(db, 'config', 'policies');
                const snap = await getDoc(ref);
                let overrides = {};
                if (snap.exists()) overrides = snap.data() || {};
                const key = docDef.policyKey;
                const override = overrides[key];
                const fallback = DEFAULT_POLICIES[key];
                if (!alive) return;
                const chosen = override && override[isEs ? 'es' : 'en']
                    ? override
                    : fallback;
                setPolicy(chosen ? chosen[isEs ? 'es' : 'en'] : null);
            } catch (e) {
                console.warn('policy load failed, using default', e);
                const fallback = DEFAULT_POLICIES[docDef.policyKey];
                if (alive && fallback) setPolicy(fallback[isEs ? 'es' : 'en']);
            }
        })();
        return () => { alive = false; };
    }, [docDef.policyKey, isEs]);

    const legalName = hire?.personal?.legalName || hire?.name || '';
    const sigOk = typedSignature.trim().toLowerCase() === legalName.trim().toLowerCase() &&
                  typedSignature.trim().length > 1;
    const canSubmit = readConfirmed && understoodConfirmed && agreeConfirmed && sigOk && !submitting;

    const onAnyChange = () => {
        if (typeof onStart === 'function' && !wasSubmitted) onStart();
    };

    const submit = async () => {
        if (!canSubmit || !policy) return;
        setSubmitting(true);
        setErr('');
        try {
            const pdfLib = await loadPdfLib();
            const { PDFDocument, StandardFonts, rgb } = pdfLib;
            const pdfDoc = await PDFDocument.create();
            const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
            const PAGE_W = 612, PAGE_H = 792;
            const MARGIN = 50;
            const black = rgb(0, 0, 0);
            const gray = rgb(0.4, 0.4, 0.4);

            const ipHash = await sha256Hex(navigator.userAgent + '|' + Date.now());
            const signedAt = new Date();
            const signedAtStr = signedAt.toLocaleString('en-US');

            // Word-wrap a string at a given width. Helvetica is not great
            // for non-ASCII, so we strip characters it can't encode.
            const sanitize = (s) => String(s || '').replace(/[‘’]/g, "'")
                .replace(/[“”]/g, '"')
                .replace(/[–—]/g, '-')
                .replace(/[…]/g, '...')
                .replace(/[^\x00-\xFF]/g, '?');
            const wrap = (text, fnt, size, maxW) => {
                const out = [];
                const paragraphs = String(text).split('\n');
                for (const p of paragraphs) {
                    if (!p.trim()) { out.push(''); continue; }
                    const words = p.split(/\s+/);
                    let line = '';
                    for (const w of words) {
                        const test = line ? line + ' ' + w : w;
                        const width = fnt.widthOfTextAtSize(test, size);
                        if (width > maxW) {
                            if (line) out.push(line);
                            line = w;
                        } else {
                            line = test;
                        }
                    }
                    if (line) out.push(line);
                }
                return out;
            };

            let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
            let y = PAGE_H - MARGIN;
            const writeLine = (text, fnt, size, color = black, indent = 0) => {
                if (y < MARGIN + size + 4) {
                    page = pdfDoc.addPage([PAGE_W, PAGE_H]);
                    y = PAGE_H - MARGIN;
                }
                page.drawText(sanitize(text), { x: MARGIN + indent, y, size, font: fnt, color });
                y -= size + 4;
            };

            // Header
            writeLine('DD Mau', fontBold, 14);
            writeLine(policy.title, fontBold, 12);
            y -= 8;

            // Body — word-wrapped at the page width
            const bodyLines = wrap(policy.body, font, 10, PAGE_W - MARGIN * 2);
            for (const line of bodyLines) {
                if (!line) { y -= 6; continue; }
                writeLine(line, font, 10);
            }

            // Signature block
            y -= 18;
            if (y < MARGIN + 80) {
                page = pdfDoc.addPage([PAGE_W, PAGE_H]);
                y = PAGE_H - MARGIN;
            }
            writeLine('— ELECTRONIC SIGNATURE —', fontBold, 10);
            y -= 4;
            writeLine(`Signed by: ${typedSignature.trim()}`, font, 10);
            writeLine(`Legal name on file: ${legalName}`, font, 10);
            writeLine(`Date / time: ${signedAtStr}`, font, 10);
            writeLine(`User agent: ${(navigator.userAgent || '').slice(0, 120)}`, font, 9, gray);
            writeLine(`Audit hash: ${ipHash.slice(0, 24)}…`, font, 9, gray);
            y -= 4;
            writeLine('Boxes checked at signing:', fontBold, 9, gray);
            writeLine('  [x] I have read this document', font, 9, gray);
            writeLine('  [x] I understand what it means', font, 9, gray);
            writeLine('  [x] I agree to follow it as a condition of employment', font, 9, gray);

            const outBytes = await pdfDoc.save();
            const ts = Date.now();
            const path = `onboarding/${hireId}/${docDef.id}/signed_${ts}.pdf`;
            await uploadBytes(sref(storage, path), new Blob([outBytes], { type: 'application/pdf' }), { contentType: 'application/pdf' });
            onSubmitted?.();
            setShowSubmitted(true);
        } catch (e) {
            console.error('ack submit failed', e);
            setErr(tx('Submit failed: ', 'Falló: ') + (e.message || e));
        } finally {
            setSubmitting(false);
        }
    };

    // Locked / submitted view
    if (showSubmitted || isLocked) {
        return (
            <div className="space-y-2">
                <div className="p-4 rounded-xl bg-green-50 border-2 border-green-300 text-center">
                    <p className="text-3xl mb-1">{isLocked ? '🔒' : '✓'}</p>
                    <p className="font-black text-green-800 text-sm">
                        {isLocked
                            ? tx('Locked', 'Bloqueado')
                            : tx('Acknowledgment signed', 'Reconocimiento firmado')}
                    </p>
                    <p className="text-[11px] text-green-700 mt-1">
                        {isLocked
                            ? tx('Your onboarding is locked. Ask your manager to unlock if you need to update this.',
                                'Bloqueado. Pídele al gerente que desbloquee.')
                            : tx('A signed copy is saved to your file.', 'Una copia firmada está guardada.')}
                    </p>
                </div>
                {!isLocked && (
                    <button onClick={() => {
                        setShowSubmitted(false);
                        setReadConfirmed(false);
                        setUnderstoodConfirmed(false);
                        setAgreeConfirmed(false);
                        setTypedSignature('');
                        setErr('');
                    }}
                        className="w-full py-2.5 rounded-xl bg-white border-2 border-dd-green text-dd-green-700 font-bold text-sm hover:bg-dd-sage-50 active:scale-95">
                        ✏️ {tx('Re-read / re-sign', 'Releer / re-firmar')}
                    </button>
                )}
            </div>
        );
    }

    if (!policy) {
        return <p className="text-xs text-gray-500 italic py-3">{tx('Loading policy…', 'Cargando política…')}</p>;
    }

    return (
        <div className="space-y-3">
            {wasSubmitted && (
                <div className="p-2 rounded-lg bg-amber-50 border-2 border-amber-300 text-[12px] text-amber-900">
                    <p className="font-bold">✏️ {tx('Re-signing previously submitted acknowledgment', 'Re-firmando reconocimiento ya enviado')}</p>
                    <p className="text-[11px] mt-0.5">
                        {tx('Re-check the boxes and type your name. Submitting again replaces the prior copy in your file.',
                            'Vuelve a marcar las casillas y escribe tu nombre. Reemplaza la copia anterior.')}
                    </p>
                </div>
            )}
            <div>
                <h3 className="text-sm font-black text-dd-text mb-2">{policy.title}</h3>
                <div className="max-h-[50vh] overflow-y-auto bg-gray-50 border border-gray-200 rounded-lg p-3">
                    <pre className="whitespace-pre-wrap font-sans text-[12px] text-gray-800 leading-relaxed">{policy.body}</pre>
                </div>
            </div>

            <label className="flex items-start gap-2 cursor-pointer p-2 hover:bg-gray-50 rounded-lg">
                <input type="checkbox" checked={readConfirmed}
                    onChange={e => { setReadConfirmed(e.target.checked); onAnyChange(); }}
                    className="mt-0.5 w-5 h-5 accent-dd-green flex-shrink-0" />
                <span className="text-[12px] text-gray-700 leading-snug">
                    {tx('I have read this document in full.', 'He leído este documento completo.')}
                </span>
            </label>

            <label className="flex items-start gap-2 cursor-pointer p-2 hover:bg-gray-50 rounded-lg">
                <input type="checkbox" checked={understoodConfirmed}
                    onChange={e => { setUnderstoodConfirmed(e.target.checked); onAnyChange(); }}
                    className="mt-0.5 w-5 h-5 accent-dd-green flex-shrink-0" />
                <span className="text-[12px] text-gray-700 leading-snug">
                    {tx('I understand what it means. If something wasn\'t clear, I\'ve asked a manager.',
                        'Entiendo lo que significa. Si algo no estaba claro, le pregunté a un gerente.')}
                </span>
            </label>

            <label className="flex items-start gap-2 cursor-pointer p-2 hover:bg-gray-50 rounded-lg">
                <input type="checkbox" checked={agreeConfirmed}
                    onChange={e => { setAgreeConfirmed(e.target.checked); onAnyChange(); }}
                    className="mt-0.5 w-5 h-5 accent-dd-green flex-shrink-0" />
                <span className="text-[12px] text-gray-700 leading-snug">
                    {tx('I agree to follow it as a condition of my employment.',
                        'Acepto seguir esta política como condición de mi empleo.')}
                </span>
            </label>

            <div>
                <label className="block text-[11px] font-bold uppercase text-gray-600 mb-1">
                    {tx('Signature — type your full legal name', 'Firma — escribe tu nombre legal completo')}
                </label>
                <input value={typedSignature} onChange={e => { setTypedSignature(e.target.value); onAnyChange(); }}
                    placeholder={legalName || tx('Your legal name', 'Tu nombre legal')}
                    maxLength={80} autoComplete="off"
                    className={`w-full border-2 rounded-lg px-3 py-3 text-sm font-bold italic ${
                        sigOk ? 'border-green-500 bg-green-50' :
                        typedSignature ? 'border-amber-500 bg-amber-50' :
                        'border-gray-300'
                    }`} />
                {typedSignature && !sigOk && (
                    <p className="text-[11px] text-amber-700 mt-1">
                        {tx('Must match your legal name exactly:', 'Debe coincidir exactamente:')} {legalName}
                    </p>
                )}
            </div>

            {err && <p className="text-xs text-red-600">{err}</p>}
            <button onClick={submit} disabled={!canSubmit}
                className="w-full py-3 rounded-xl bg-dd-green text-white font-bold text-sm disabled:opacity-50 active:scale-95">
                {submitting
                    ? tx('Generating signed PDF…', 'Generando PDF firmado…')
                    : tx('✓ Sign + submit', '✓ Firmar y enviar')}
            </button>
        </div>
    );
}
