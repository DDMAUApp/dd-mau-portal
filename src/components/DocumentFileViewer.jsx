// Full-screen view of one onboarding file, drawn onto canvases. Older versions get
// the watermark drawn into the picture itself, so it's on any screenshot, and the
// stored file stays exactly as it was signed.
import { useEffect, useRef, useState } from 'react';
import { ref as sref, getBytes } from 'firebase/storage';
import { storage } from '../firebase';
import { isOwnFilePath, olderVersionLines, olderVersionLabel } from '../data/staffDocuments';

const MAX_BYTES = 30 * 1024 * 1024;
const MAX_PAGES = 30;

export function drawOlderWatermark(canvas, lines) {
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const size = Math.max(24, Math.round(Math.min(width, height) / 11));
    const small = Math.round(size * 0.5);
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate(-Math.PI / 6);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(200, 20, 20, 0.28)';
    const span = Math.hypot(width, height);
    for (let y = -span / 2; y < span / 2; y += size * 4.5) {
        ctx.font = `bold ${size}px sans-serif`;
        ctx.fillText(lines[0], 0, y);
        if (lines[1]) { ctx.font = `bold ${small}px sans-serif`; ctx.fillText(lines[1], 0, y + size * 0.8); }
    }
    ctx.restore();
}

async function renderPdf(bytes, host, lines, isLive) {
    const pdfjs = await import('pdfjs-dist');
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    }
    const pdf = await pdfjs.getDocument({ data: bytes }).promise;
    try {
        for (let n = 1; n <= Math.min(pdf.numPages, MAX_PAGES) && isLive(); n++) {
            const page = await pdf.getPage(n);
            const viewport = page.getViewport({ scale: 2 });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            canvas.className = 'w-full h-auto bg-white rounded shadow mb-3';
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            if (lines) drawOlderWatermark(canvas, lines);
            if (isLive()) host.appendChild(canvas);
        }
    } finally {
        pdf.destroy();
    }
}

async function renderImage(bytes, host, lines) {
    const url = URL.createObjectURL(new Blob([bytes]));
    try {
        const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = reject;
            i.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.className = 'w-full h-auto bg-white rounded shadow';
        canvas.getContext('2d').drawImage(img, 0, 0);
        if (lines) drawOlderWatermark(canvas, lines);
        host.appendChild(canvas);
    } finally {
        URL.revokeObjectURL(url);
    }
}

export default function DocumentFileViewer({ hireId, path, title, older, replacedAt, isEs, onClose }) {
    const tx = (en, es) => (isEs ? es : en);
    const hostRef = useRef(null);
    const [state, setState] = useState('loading');
    useEffect(() => {
        let alive = true;
        const host = hostRef.current;
        (async () => {
            if (!isOwnFilePath(path, hireId)) { setState('error'); return; }
            try {
                const bytes = await getBytes(sref(storage, path), MAX_BYTES);
                if (!alive) return;
                const lines = older ? olderVersionLines(replacedAt, isEs) : null;
                if (/\.pdf$/i.test(path)) await renderPdf(new Uint8Array(bytes), host, lines, () => alive);
                else await renderImage(bytes, host, lines);
                if (alive) setState('ready');
            } catch (e) {
                console.warn('document view failed', e?.code || e?.message);
                if (alive) setState('error');
            }
        })();
        return () => { alive = false; if (host) host.replaceChildren(); };
    }, [hireId, path, older, replacedAt, isEs]);

    return (
        <div className="fixed inset-0 z-[95] bg-black/90 flex flex-col" role="dialog" aria-modal="true" aria-label={title}>
            <div className="flex items-center gap-2 px-3 py-2 bg-white" style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}>
                <p className="flex-1 min-w-0 font-bold text-sm truncate">{title}</p>
                <button onClick={onClose} className="px-3 py-2 rounded-lg bg-gray-200 font-bold text-sm">{tx('Close', 'Cerrar')}</button>
            </div>
            {older && (
                <p className="px-3 py-2 bg-red-700 text-white text-xs font-bold text-center">
                    {olderVersionLabel(replacedAt, isEs)}
                </p>
            )}
            <div className="flex-1 overflow-auto p-3">
                {state === 'loading' && <p className="text-white text-sm text-center py-6">{tx('Loading…', 'Cargando…')}</p>}
                {state === 'error' && <p className="text-white text-sm text-center py-6">{tx('This file could not be opened.', 'No se pudo abrir este archivo.')}</p>}
                <div ref={hostRef} className="max-w-3xl mx-auto" />
            </div>
        </div>
    );
}
