// chatVideo.js — make every chat video play on every phone, fast.
//
// Andrew 2026-09-25: "for some android users cant see the video". Real
// uploads (Storage audit that day): iPhone .MOV at 1080p 15.5 Mbps
// (127–189 MB for 1–2 min), 4K 60fps level-5.1 .MOV (many Androids can't
// decode), and HEVC .mp4 (needs an HEVC decoder). None had a poster, so the
// bubble was a blank box until the whole file streamed.
//
// Fix: when a video message is created, transcode the original ONCE to
// H.264 Main 720p ≤30fps + AAC, faststart MP4 (plays on every Android /
// iPhone / browser, ~10× smaller), plus a JPEG poster. The message gets
// playbackUrl / thumbnailUrl; the original stays as mediaUrl (fallback +
// full quality). Outputs live next to the original under chats/{chatId}/ so
// the chat purge's prefix delete cleans them too.
//
// The arg builders + decision helpers are pure (node --test).

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MAX_SHORT_SIDE = 720;

// Short side → ≤720 (never upscale), even dims, rotation already applied
// (ffmpeg autorotates by default, so iw/ih are the DISPLAY size).
const SCALE_FILTER =
    `scale=w='if(gte(iw,ih),-2,min(${MAX_SHORT_SIDE},iw))':h='if(gte(iw,ih),min(${MAX_SHORT_SIDE},ih),-2)'`;

function buildTranscodeArgs(input, output) {
    return [
        '-hide_banner', '-y',
        '-i', input,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', SCALE_FILTER,
        '-fpsmax', '30',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
        '-maxrate', '2500k', '-bufsize', '5000k',
        '-profile:v', 'main', '-level:v', '3.1', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-movflags', '+faststart',
        output,
    ];
}

// Poster: one frame, long side 640. `atSec` 0.5 skips black first frames;
// callers retry at 0 for sub-second clips.
function buildPosterArgs(input, output, atSec = 0.5) {
    return [
        '-hide_banner', '-y',
        '-ss', String(atSec),
        '-i', input,
        '-frames:v', '1',
        '-vf', "scale=w='if(gte(iw,ih),640,-2)':h='if(gte(iw,ih),-2,640)'",
        '-q:v', '4',
        output,
    ];
}

// Voice memos: Android records WebM/Opus, which older iPhones can't play.
// Those get an AAC .m4a copy; iPhone memos (already m4a/mp4) are left alone.
function isNonAacAudio(msg) {
    return msg && msg.type === 'audio' && /\.(webm|ogg|oga|opus)$/i.test(String(msg.mediaPath || ''));
}

// Should this message doc be processed?
function needsTranscode(msg) {
    if (!msg || !msg.mediaPath || typeof msg.mediaPath !== 'string') return false;
    if (!msg.mediaPath.startsWith('chats/') || msg.playbackUrl || msg.deleted) return false;
    return msg.type === 'video' || isNonAacAudio(msg);
}

function buildAudioArgs(input, output) {
    return ['-hide_banner', '-y', '-i', input, '-vn', '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-movflags', '+faststart', output];
}

// Output object paths next to the original: chats/c1/123_ab.mov →
// chats/c1/123_ab_720.mp4 + chats/c1/123_ab_poster.jpg
function outputPaths(mediaPath) {
    const dir = path.posix.dirname(mediaPath);
    const base = path.posix.basename(mediaPath).replace(/\.[^.]+$/, '');
    return {
        playbackPath: `${dir}/${base}_720.mp4`,
        posterPath: `${dir}/${base}_poster.jpg`,
        audioPath: `${dir}/${base}_aac.m4a`,
    };
}

// "Stream #0:0 ... Video: h264 ..., 720x1280 ..." from the OUTPUT section.
function parseOutputDims(stderr) {
    const outIdx = String(stderr || '').lastIndexOf('Output #0');
    if (outIdx < 0) return null;
    const m = String(stderr).slice(outIdx).match(/Video: [^\n]*?(\d{2,5})x(\d{2,5})/);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

function downloadUrl(bucketName, objectPath, token) {
    return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

function runFfmpeg(ffmpegPath, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-100000); });
        const t = setTimeout(() => { p.kill('SIGKILL'); }, timeoutMs);
        p.on('error', (e) => { clearTimeout(t); reject(e); });
        p.on('close', (code) => {
            clearTimeout(t);
            if (code === 0) resolve(err);
            else reject(Object.assign(new Error(`ffmpeg exited ${code}`), { stderr: err.slice(-2000) }));
        });
    });
}

async function uploadWithToken(bucket, localPath, dest, contentType) {
    const token = crypto.randomUUID();
    await bucket.upload(localPath, {
        destination: dest,
        resumable: false,
        metadata: {
            contentType,
            cacheControl: 'public, max-age=31536000',
            metadata: { firebaseStorageDownloadTokens: token },
        },
    });
    return downloadUrl(bucket.name, dest, token);
}

// Do the work for one message. Never throws; returns a status string.
//   msgRef: DocumentReference of chats/{chatId}/messages/{id}
async function processChatVideo({ msgRef, msg, bucket, ffmpegPath, log = console, timeoutMs = 480000, FieldValue }) {
    if (!needsTranscode(msg)) return 'skip';
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chatvid-'));
    const ext = (path.posix.extname(msg.mediaPath) || '.mov').toLowerCase();
    const src = path.join(work, `src${ext}`);
    const out = path.join(work, 'out.mp4');
    const poster = path.join(work, 'poster.jpg');
    const { playbackPath, posterPath, audioPath } = outputPaths(msg.mediaPath);
    try {
        await bucket.file(msg.mediaPath).download({ destination: src });
        const t0 = Date.now();
        if (msg.type === 'audio') {
            const outA = path.join(work, 'out.m4a');
            await runFfmpeg(ffmpegPath, buildAudioArgs(src, outA), 120000);
            const freshA = await msgRef.get();
            if (!freshA.exists || freshA.data().deleted) return 'deleted';
            const url = await uploadWithToken(bucket, outA, audioPath, 'audio/mp4');
            await msgRef.update({ playbackUrl: url, playbackPath: audioPath, playbackSize: fs.statSync(outA).size, transcodedAt: FieldValue.serverTimestamp() });
            log.info?.(`chatVideo(audio): ${msg.mediaPath} → ${audioPath} (${Math.round((Date.now() - t0) / 1000)}s)`);
            return 'ok';
        }
        const stderr = await runFfmpeg(ffmpegPath, buildTranscodeArgs(src, out), timeoutMs);
        const dims = parseOutputDims(stderr);
        let havePoster = false;
        for (const at of [0.5, 0]) {
            try {
                await runFfmpeg(ffmpegPath, buildPosterArgs(out, poster, at), 60000);
                if (fs.existsSync(poster) && fs.statSync(poster).size > 0) { havePoster = true; break; }
            } catch { /* try the next seek point */ }
        }
        // Deleted while we worked? Don't resurrect media for it.
        const fresh = await msgRef.get();
        if (!fresh.exists || fresh.data().deleted) return 'deleted';
        const playbackUrl = await uploadWithToken(bucket, out, playbackPath, 'video/mp4');
        const update = {
            playbackUrl, playbackPath,
            playbackSize: fs.statSync(out).size,
            transcodedAt: FieldValue.serverTimestamp(),
            ...(dims ? { playbackWidth: dims.width, playbackHeight: dims.height } : {}),
        };
        if (havePoster) {
            update.posterUrl = await uploadWithToken(bucket, poster, posterPath, 'image/jpeg');
            update.posterPath = posterPath;
            // The bubble's poster: keep a client-captured one if the sender
            // already attached it (it showed instantly); fill it otherwise.
            if (!fresh.data().thumbnailUrl) update.thumbnailUrl = update.posterUrl;
        }
        await msgRef.update(update);
        log.info?.(`chatVideo: ${msg.mediaPath} → ${playbackPath} (${Math.round((Date.now() - t0) / 1000)}s, ${update.playbackSize} bytes)`);
        return 'ok';
    } catch (e) {
        log.error?.(`chatVideo failed for ${msg.mediaPath}: ${e.message}`, e.stderr || '');
        try { await msgRef.update({ transcodeFailedAt: FieldValue.serverTimestamp() }); } catch { /* doc gone */ }
        return 'failed';
    } finally {
        try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* tmp cleanup best-effort */ }
    }
}

module.exports = {
    buildTranscodeArgs, buildPosterArgs, buildAudioArgs, needsTranscode, outputPaths, parseOutputDims, downloadUrl,
    processChatVideo, runFfmpeg, SCALE_FILTER,
};
