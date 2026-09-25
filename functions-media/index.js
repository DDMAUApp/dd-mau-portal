// functions-media — heavy media processing, deployed as its own codebase
// ("media" in firebase.json) so the ffmpeg binary never bloats the main
// functions image. Deploy: firebase deploy --only functions:media
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const ffmpegPath = require('ffmpeg-static');
const { processChatVideo, needsTranscode } = require('./chatVideo');

admin.initializeApp();

// One ffmpeg at a time per instance (it wants all 4 CPUs); other videos
// that land on this instance wait their turn. Non-video messages never
// touch the queue — they return in microseconds, and concurrency > 1 means
// a burst of ordinary texts can't throttle (and drop) a video's event.
let _queue = Promise.resolve();
function oneAtATime(fn) {
    const run = _queue.then(fn, fn);
    _queue = run.catch(() => {});
    return run;
}

// Chat video → phone-friendly 720p MP4 + poster (see chatVideo.js).
// Own trigger on message create (separate from onChatMessageCreated's push
// fan-out, which must stay fast and small).
exports.transcodeChatVideo = onDocumentCreated(
    {
        document: 'chats/{chatId}/messages/{messageId}',
        region: 'us-central1',
        memory: '4GiB',
        cpu: 4,
        timeoutSeconds: 540,
        concurrency: 8,
        maxInstances: 10,
        retry: false,
    },
    async (event) => {
        const msg = event.data?.data();
        if (!needsTranscode(msg)) return;
        const status = await oneAtATime(() => processChatVideo({
            msgRef: event.data.ref,
            msg,
            bucket: admin.storage().bucket(),
            ffmpegPath,
            log: logger,
            FieldValue: admin.firestore.FieldValue,
        }));
        logger.info(`transcodeChatVideo ${event.params.chatId}/${event.params.messageId}: ${status}`);
    },
);
