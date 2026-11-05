// reportContext.js: what a stuck-app report needs to know about the page.
//
// Plain in-memory state with no firebase import, so the logger, the watchdog
// and main.jsx can all use it without an import cycle. Everything here only
// labels reports. Nothing reads it to make a decision.

const TAB_TRAIL = 5;
let _tabs = [];
let _who = null;
let _lastResumeAt = 0;
let _resumeCount = 0;
let _idbNoise = 0;

export function pageAgeMs() {
    try { return Math.round(performance.now()); } catch { return null; }
}

export function noteTab(tab) {
    if (!tab || _tabs[_tabs.length - 1] === tab) return;
    _tabs = [..._tabs, tab].slice(-TAB_TRAIL);
}

export function setReportWho(who) { _who = who || null; }

export function noteResume() {
    _lastResumeAt = Date.now();
    _resumeCount += 1;
}

export function countIdbNoise() { _idbNoise += 1; }
export function getIdbNoise() { return _idbNoise; }

export function getReportContext() {
    return {
        activeTab: _tabs[_tabs.length - 1] || null,
        tabTrail: _tabs,
        pageAgeMs: pageAgeMs(),
        bootMs: typeof window !== 'undefined' ? (window.__ddmauBootMs ?? null) : null,
        resumeAgeMs: _lastResumeAt ? Date.now() - _lastResumeAt : null,
        resumeCount: _resumeCount,
        idbNoise: _idbNoise,
        who: _who,
    };
}
