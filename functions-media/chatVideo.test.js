const test = require('node:test');
const assert = require('node:assert');
const { buildTranscodeArgs, buildPosterArgs, buildAudioArgs, needsTranscode, outputPaths, parseOutputDims, downloadUrl } = require('./chatVideo');

test('needsTranscode only for live, un-processed chat videos', () => {
    const base = { type: 'video', mediaPath: 'chats/c1/1_ab.mov' };
    assert.equal(needsTranscode(base), true);
    assert.equal(needsTranscode({ ...base, playbackUrl: 'x' }), false);
    assert.equal(needsTranscode({ ...base, deleted: true }), false);
    assert.equal(needsTranscode({ ...base, type: 'image' }), false);
    assert.equal(needsTranscode({ ...base, mediaPath: 'announcements/x.mov' }), false);
    assert.equal(needsTranscode({ type: 'video' }), false);
    assert.equal(needsTranscode(null), false);
});

test('outputs sit next to the original (purge prefix cleans them)', () => {
    assert.deepEqual(outputPaths('chats/c1/1700_ab12cd.mov'), {
        playbackPath: 'chats/c1/1700_ab12cd_720.mp4',
        posterPath: 'chats/c1/1700_ab12cd_poster.jpg',
        audioPath: 'chats/c1/1700_ab12cd_aac.m4a',
    });
    assert.deepEqual(outputPaths('chats/c1/clip.MP4').playbackPath, 'chats/c1/clip_720.mp4');
});

test('transcode args: H.264 main 720p ≤30fps, AAC, faststart, optional audio', () => {
    const a = buildTranscodeArgs('/tmp/in.mov', '/tmp/out.mp4');
    const s = a.join(' ');
    assert.match(s, /-c:v libx264/);
    assert.match(s, /-profile:v main/);
    assert.match(s, /-pix_fmt yuv420p/);
    assert.match(s, /-fpsmax 30/);
    assert.match(s, /min\(720,ih\)/);
    assert.match(s, /-map 0:a:0\?/);
    assert.match(s, /\+faststart/);
    assert.equal(a[a.length - 1], '/tmp/out.mp4');
    assert.equal(a[a.indexOf('-i') + 1], '/tmp/in.mov');
});

test('poster args seek then grab one frame', () => {
    const a = buildPosterArgs('/tmp/in.mp4', '/tmp/p.jpg', 0);
    assert.equal(a[a.indexOf('-ss') + 1], '0');
    assert.equal(a[a.indexOf('-frames:v') + 1], '1');
});

test('parseOutputDims reads the OUTPUT stream, not the input', () => {
    const stderr = `Input #0, mov,mp4 from 'in.mov':\n  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 15000 kb/s\n`
        + `Output #0, mp4, to 'out.mp4':\n  Stream #0:0: Video: h264 (avc1), yuv420p(progressive), 1280x720, q=2-31\n`;
    assert.deepEqual(parseOutputDims(stderr), { width: 1280, height: 720 });
    assert.equal(parseOutputDims('nothing'), null);
});

test('download URL encodes the object path', () => {
    assert.equal(downloadUrl('b.firebasestorage.app', 'chats/c 1/x.mp4', 'tok'),
        'https://firebasestorage.googleapis.com/v0/b/b.firebasestorage.app/o/chats%2Fc%201%2Fx.mp4?alt=media&token=tok');
});

test('voice memos: only WebM/Ogg (Android) get an AAC copy', () => {
    assert.equal(needsTranscode({ type: 'audio', mediaPath: 'chats/c1/1_ab.webm' }), true);
    assert.equal(needsTranscode({ type: 'audio', mediaPath: 'chats/c1/1_ab.m4a' }), false);
    assert.equal(needsTranscode({ type: 'audio', mediaPath: 'chats/c1/1_ab.webm', playbackUrl: 'x' }), false);
    assert.equal(outputPaths('chats/c1/1_ab.webm').audioPath, 'chats/c1/1_ab_aac.m4a');
    const a = buildAudioArgs('/tmp/in.webm', '/tmp/o.m4a').join(' ');
    assert.match(a, /-c:a aac/);
    assert.match(a, /-vn/);
});
