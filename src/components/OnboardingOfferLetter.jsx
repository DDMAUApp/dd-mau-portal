// OnboardingOfferLetter — auto-generated offer letter for the hire.
//
// Pre-baked DD Mau offer letter text. We fill in placeholders from the
// hire record (name, position, location → legal entity + address, hire
// date, offerAmount). The hire reads the letter, signs once, hits
// Submit. We then use pdf-lib to render the same letter as a proper PDF
// with their signature embedded and upload it as the hire's signed copy.
//
// Two reasons this is a hardcoded component rather than a "letter mode
// template" the admin edits in-app:
//   1. It's the same letter for every hire — only the variables change.
//   2. No setup required — admin doesn't have to upload anything for the
//      offer letter to work end-to-end.
//
// If Andrew ever wants to change the wording, edit the LETTER_BODY
// constant below.

import { useRef, useState, useEffect } from 'react';
import { storage } from '../firebase';
import { ref as sref, uploadBytes } from 'firebase/storage';
import { LOCATION_INFO } from '../data/onboarding';

async function loadPdfLib() {
    return await import('pdf-lib');
}

// Letter content. Both `LETTER_BODY_EN` / `LETTER_BODY_ES` and the
// `letterVars` helper are EXPORTED so the admin-side editor in
// Onboarding.jsx can pre-fill the textarea with the same default text
// the hire would have seen. Keep these in sync if you ever split them.
export const LETTER_BODY_EN = (vars) => `Hi ${vars.firstName},

We are pleased to offer you a position at our company, ${vars.legalEntity}, as a ${vars.position}! We think that your experience and skills will be a valuable asset to our company!

If you are to accept this offer you will be eligible for the following in accordance with our company's policies:

Wage of ${vars.offerAmount} per Hour plus tip.

- You will be working at the following location: ${vars.locationAddress}
- Your expected hire date will be ${vars.hireDate}.

Your employment will also be subject to, and dependent upon, the completion of all onboarding paperwork included here, and subsequent verification of your work eligibility and relevant background checks.

We look forward to welcoming you to our team. Feel free to contact us if you have any questions or concerns.

To accept this offer, please sign below.

Sincerely,
Julie Shih`;

export const LETTER_BODY_ES = (vars) => `Hola ${vars.firstName},

Nos complace ofrecerte un puesto en nuestra empresa, ${vars.legalEntity}, como ${vars.position}. Creemos que tu experiencia y habilidades serán un activo valioso para nuestra empresa.

Si aceptas esta oferta, serás elegible para lo siguiente de acuerdo con las políticas de la empresa:

Salario de ${vars.offerAmount} por hora más propina.

- Trabajarás en la siguiente ubicación: ${vars.locationAddress}
- Tu fecha de inicio prevista será el ${vars.hireDate}.

Tu empleo también estará sujeto a, y dependerá de, la finalización de toda la documentación de incorporación incluida aquí, y la verificación posterior de tu elegibilidad para trabajar y las verificaciones de antecedentes correspondientes.

Esperamos darte la bienvenida a nuestro equipo. No dudes en contactarnos si tienes preguntas o inquietudes.

Para aceptar esta oferta, firma abajo.

Atentamente,
Julie Shih`;

export function letterVars(hire) {
    const firstName = (hire?.personal?.legalName || hire?.name || '').split(' ')[0] || hire?.name || '';
    const locInfo = (hire?.location && LOCATION_INFO[hire.location]) || LOCATION_INFO.webster;
    // Format hire date as M/D/YYYY for readability (the PDF in Andrew's
    // example used 3/30/2026 not 2026-03-30).
    let hireDate = hire?.hireDate || '___________';
    if (hire?.hireDate) {
        const parts = String(hire.hireDate).split('-').map(Number);
        if (parts.length === 3 && !parts.some(isNaN)) {
            hireDate = `${parts[1]}/${parts[2]}/${parts[0]}`;
        }
    }
    return {
        firstName: firstName || '___________',
        legalEntity: locInfo.legalEntity,
        legalEntityAddress: locInfo.address,
        locationAddress: locInfo.address,
        position: hire?.position || '___________',
        offerAmount: hire?.offerAmount || '$_______',
        hireDate,
    };
}

export default function OnboardingOfferLetter({
    hire,
    hireId,
    isEs,
    onSubmitted,
    onStart,
}) {
    const tx = (en, es) => (isEs ? es : en);
    const vars = letterVars(hire);
    // Admin override: if the hire's record has offerLetterBody set,
    // it's the admin-edited version of the letter — use it verbatim
    // (admin already saw the live variables filled in while editing).
    // Falls back to the default templated letter when no override.
    const body = hire?.offerLetterBody
        ? hire.offerLetterBody
        : (isEs ? LETTER_BODY_ES(vars) : LETTER_BODY_EN(vars));

    const [sigDataUrl, setSigDataUrl] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [err, setErr] = useState('');
    const canvasRef = useRef(null);
    const drawing = useRef(false);
    const lastPoint = useRef(null);
    const [empty, setEmpty] = useState(true);

    useEffect(() => {
        const c = canvasRef.current;
        if (!c) return;
        const r = c.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        c.width = r.width * dpr;
        c.height = r.height * dpr;
        const ctx = c.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#1f2937';
    }, []);

    const pos = (e) => {
        const r = canvasRef.current.getBoundingClientRect();
        const t = e.touches ? e.touches[0] : e;
        return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const start = (e) => {
        e.preventDefault();
        drawing.current = true;
        lastPoint.current = pos(e);
        setEmpty(false);
        if (typeof onStart === 'function') onStart();
    };
    const move = (e) => {
        if (!drawing.current) return;
        e.preventDefault();
        const ctx = canvasRef.current.getContext('2d');
        const p = pos(e);
        ctx.beginPath();
        ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        lastPoint.current = p;
    };
    const end = () => {
        drawing.current = false;
        lastPoint.current = null;
        if (!empty) {
            try { setSigDataUrl(canvasRef.current.toDataURL('image/png')); } catch {}
        }
    };
    const clearSig = () => {
        const c = canvasRef.current;
        c.getContext('2d').clearRect(0, 0, c.width, c.height);
        setEmpty(true);
        setSigDataUrl(null);
    };

    const submit = async () => {
        if (!sigDataUrl) {
            setErr(tx('Please sign before submitting.', 'Por favor firma antes de enviar.'));
            return;
        }
        setSubmitting(true);
        setErr('');
        try {
            // Generate a clean PDF letter with the signature embedded.
            const pdfLib = await loadPdfLib();
            const { PDFDocument, StandardFonts, rgb } = pdfLib;
            const pdfDoc = await PDFDocument.create();
            const page = pdfDoc.addPage([612, 792]); // US Letter
            const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
            const black = rgb(0, 0, 0);
            const gray = rgb(0.45, 0.45, 0.45);

            const margin = 54;
            let y = 792 - margin;

            // Letterhead — legal entity + address (Andrew's existing PDF
            // had a gray header band; we render similar styling).
            page.drawText(vars.legalEntity, { x: margin, y, size: 13, font: bold, color: black });
            y -= 18;
            page.drawText(vars.legalEntityAddress, { x: margin, y, size: 10, font, color: gray });
            y -= 28;
            // Horizontal rule
            page.drawLine({ start: { x: margin, y }, end: { x: 612 - margin, y }, thickness: 0.5, color: gray });
            y -= 22;

            // Body — word-wrap each paragraph to fit the page width.
            const maxWidth = 612 - margin * 2;
            const lineHeight = 14;
            const paragraphs = body.split('\n');
            const drawWrapped = (text, opts = {}) => {
                if (!text.trim()) { y -= lineHeight; return; }
                const words = text.split(/\s+/);
                let line = '';
                const f = opts.bold ? bold : font;
                const size = opts.size || 10.5;
                for (const w of words) {
                    const test = line ? line + ' ' + w : w;
                    const wid = f.widthOfTextAtSize(test, size);
                    if (wid > maxWidth && line) {
                        page.drawText(line, { x: margin, y, size, font: f, color: black });
                        y -= lineHeight;
                        line = w;
                    } else {
                        line = test;
                    }
                }
                if (line) {
                    page.drawText(line, { x: margin, y, size: size, font: f, color: black });
                    y -= lineHeight;
                }
            };
            for (const p of paragraphs) drawWrapped(p);
            y -= 18;
            // Signature line + signature image.
            page.drawLine({ start: { x: margin, y }, end: { x: margin + 280, y }, thickness: 0.6, color: black });
            // Embed signature ABOVE the line so it reads like a real sig.
            try {
                const pngBytes = Uint8Array.from(atob(sigDataUrl.split(',')[1]), c => c.charCodeAt(0));
                const sigImg = await pdfDoc.embedPng(pngBytes);
                const sigW = 200;
                const ar = sigImg.height / sigImg.width;
                const sigH = sigW * ar;
                page.drawImage(sigImg, { x: margin, y: y + 4, width: sigW, height: Math.min(sigH, 50) });
            } catch (e) { console.warn('sig embed failed', e); }
            y -= 14;
            page.drawText((vars.firstName + ' ' + ((hire?.name || '').split(' ').slice(1).join(' '))).trim() || 'Signed', { x: margin, y, size: 10, font, color: black });
            y -= 14;
            page.drawText(new Date().toLocaleDateString('en-US'), { x: margin, y, size: 9, font, color: gray });

            const outBytes = await pdfDoc.save();
            const ts = Date.now();
            const path = `onboarding/${hireId}/offer_letter/signed_${ts}.pdf`;
            await uploadBytes(sref(storage, path), new Blob([outBytes], { type: 'application/pdf' }), { contentType: 'application/pdf' });
            onSubmitted?.();
        } catch (e) {
            console.error('offer letter submit failed', e);
            setErr(tx('Submit failed: ', 'Falló: ') + (e.message || e));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="space-y-3">
            {/* Letterhead preview — matches the generated PDF style. */}
            <div className="bg-white border border-gray-200 rounded-lg p-3 text-[12px] leading-relaxed">
                <div className="bg-gray-100 -mx-3 -mt-3 mb-3 p-3 rounded-t-lg">
                    <p className="font-bold text-gray-900">{vars.legalEntity}</p>
                    <p className="text-[11px] text-gray-600">{vars.legalEntityAddress}</p>
                </div>
                <pre className="whitespace-pre-wrap font-sans text-gray-800">{body}</pre>
            </div>

            <div className="bg-white border-2 border-dd-green/40 rounded-xl p-3">
                <p className="text-[11px] font-bold uppercase text-dd-text-2 mb-1">
                    {tx('Sign here to accept', 'Firma aquí para aceptar')}
                </p>
                <canvas
                    ref={canvasRef}
                    className="w-full h-32 bg-gray-50 border-2 border-dashed border-dd-green/40 rounded touch-none"
                    onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
                    onTouchStart={start} onTouchMove={move} onTouchEnd={end}
                />
                <div className="flex items-center gap-2 mt-2">
                    <button type="button" onClick={clearSig}
                        className="flex-1 py-1.5 rounded bg-gray-100 text-gray-700 text-xs font-bold">
                        {tx('Clear', 'Borrar')}
                    </button>
                    {sigDataUrl && (
                        <span className="flex-1 text-center py-1.5 rounded bg-green-100 text-green-800 text-xs font-bold">
                            ✓ {tx('Signed', 'Firmado')}
                        </span>
                    )}
                </div>
            </div>

            {err && <p className="text-[11px] text-red-600">{err}</p>}
            <button onClick={submit} disabled={submitting || !sigDataUrl}
                className="w-full py-3 rounded-xl bg-dd-green text-white font-bold text-sm hover:bg-dd-green/90 disabled:opacity-50">
                {submitting
                    ? tx('Generating PDF…', 'Generando PDF…')
                    : tx('✓ Accept offer + submit', '✓ Aceptar oferta y enviar')}
            </button>
        </div>
    );
}
