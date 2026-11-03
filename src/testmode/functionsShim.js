// firebase/functions, as the app sees it (aliased in vite.config.js).
// Outside test mode every export is the real SDK. In TEST MODE only the
// read-only AI helpers reach the server (they return an answer and change
// no app data); every other callable is refused before it is sent.
import * as fn from '@firebase/functions';
import { TEST_MODE } from '../data/testMode';

export * from '@firebase/functions';

const T = !!TEST_MODE;

export const TEST_MODE_ALLOWED_CALLABLES = Object.freeze(new Set([
    // Return an answer and change no app data. translateMessage is sent
    // text-only in test mode (translation.js) so the server writes nothing.
    'aiSearch', 'translateMessage', 'aiFixText', 'aiGeneratePromo', 'parseReceipt',
]));

function refused() {
    const e = new Error('Test mode — this was not sent to the server.');
    e.code = 'functions/test-mode';
    return Promise.reject(e);
}

export const httpsCallable = T
    ? (functions, name, options) => (TEST_MODE_ALLOWED_CALLABLES.has(name)
        ? fn.httpsCallable(functions, name, options)
        : () => refused())
    : fn.httpsCallable;
export const httpsCallableFromURL = T ? () => () => refused() : fn.httpsCallableFromURL;
