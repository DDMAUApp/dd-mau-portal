// Shared by chat (ChatThread) and recipe media (RecipeMedia) — moved out of
// ChatThread.jsx 2026-09-28 unchanged.
//
// Reads duration + display size and grabs a small JPEG poster (long side
// 640) so the bubble shows a frame the moment it's sent. 2026-09-25: it had
// no time limit — a clip this phone can't decode (HEVC on some Androids)
// never fired either event and the composer stayed frozen. Every path now
// resolves within ~8s; the poster is best-effort (null when undecodable —
// the server makes one either way).
export async function probeVideo(file) {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const v = document.createElement('video');
        let meta = {};
        let settled = false;
        const finish = (poster = null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
            URL.revokeObjectURL(url);
            resolve({ ...meta, posterBlob: poster });
        };
        const timer = setTimeout(() => finish(null), 8000);
        v.muted = true;
        v.playsInline = true;
        v.setAttribute('playsinline', '');
        v.preload = 'auto';
        v.onloadedmetadata = () => {
            meta = { duration: Math.round(v.duration || 0), width: v.videoWidth, height: v.videoHeight };
            try { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); } catch { finish(null); }
        };
        v.onseeked = () => {
            try {
                const w = v.videoWidth, h = v.videoHeight;
                if (!w || !h) { finish(null); return; }
                const k = Math.min(1, 640 / Math.max(w, h));
                const c = document.createElement('canvas');
                c.width = Math.round(w * k); c.height = Math.round(h * k);
                c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
                c.toBlob((b) => { c.width = 0; c.height = 0; finish(b && b.size > 1000 ? b : null); }, 'image/jpeg', 0.72);
            } catch { finish(null); }
        };
        v.onerror = () => finish(null);
        v.src = url;
    });
}
