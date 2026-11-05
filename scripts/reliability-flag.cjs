#!/usr/bin/env node
// Turns a reliability flag on or off. Usage:
//   node scripts/reliability-flag.cjs on  <flag>            everyone
//   node scripts/reliability-flag.cjs on  <flag> <deviceId> one pilot device (whole ID, or the 6 on the badge)
//   node scripts/reliability-flag.cjs off <flag>            everyone, and every pilot device
//   node scripts/reliability-flag.cjs off <flag> <deviceId> that device only
//   node scripts/reliability-flag.cjs show
//
// Shape on config/minVersion:
//   reliability: { flags: { <flag>: true|false }, pilot: { devices: { <id>: { <flag>: true } } } }
// Flags are per device, so `on otherFlag dev2` can't hand dev2 a flag dev1 has.
//
// Writes with mergeFields: ['reliability'], which replaces that one field whole
// (a plain merge can't delete a nested key, so "off" wouldn't stick) and can't
// touch `min`. Then reads back and asserts both. Never touches config/forceRefresh.
const path = require('path');

const FLAG_NAME = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,}$/;

// Same rule as resolveFlags in src/data/reliabilityFlags.js: a whole ID, or a
// suffix of at least 6. Either side may be the shorter one here.
function sameDevice(stored, given) {
    if (stored.length < 6 || given.length < 6) return false;
    return stored === given || stored.endsWith(given) || given.endsWith(stored);
}

function matchingDevices(rel, device) {
    return Object.keys(rel?.pilot?.devices || {}).filter((id) => sameDevice(id, device));
}

function next(rel, cmd, flag, device) {
    const devices = {};
    for (const [id, flags] of Object.entries(rel?.pilot?.devices || {})) devices[id] = { ...flags };
    const out = { flags: { ...(rel?.flags || {}) }, pilot: { devices } };
    const dropFlag = (id) => {
        delete devices[id][flag];
        if (!Object.keys(devices[id]).length) delete devices[id];
    };
    if (device) {
        if (!DEVICE_ID.test(device)) throw new Error('device ID needs at least 6 letters, digits, - or _');
        const matches = matchingDevices(rel, device);
        if (cmd === 'on') {
            if (matches.length > 1) throw new Error(`${device} matches more than one device: ${matches.join(', ')}. Use the whole ID.`);
            const id = matches[0] || device;
            devices[id] = { ...(devices[id] || {}), [flag]: true };
        } else {
            const holding = matches.filter((id) => flag in devices[id]);
            if (!holding.length) throw new Error(`Nothing changed: no pilot device matching ${device} has ${flag}.`);
            holding.forEach(dropFlag);
        }
    } else if (cmd === 'on') {
        out.flags[flag] = true;
    } else {
        // Off wins everywhere: pilot flags are applied on top of fleet flags.
        out.flags[flag] = false;
        Object.keys(devices).forEach((id) => { if (flag in devices[id]) dropFlag(id); });
    }
    return out;
}

// What the document must say after the write. Returns a problem, or null.
function readBackProblem(rel, cmd, flag, device) {
    const devices = rel?.pilot?.devices || {};
    if (cmd === 'on') {
        if (device) return matchingDevices(rel, device).some((id) => devices[id]?.[flag] === true) ? null : `${flag} is not on for ${device}`;
        return rel?.flags?.[flag] === true ? null : `${flag} is not on for everyone`;
    }
    if (device) {
        if (matchingDevices(rel, device).some((id) => flag in devices[id])) return `${flag} is still set on ${device}`;
        return rel?.flags?.[flag] === true ? `${flag} left the pilot entry for ${device}, but it is still ON for everyone, including that device. Use: off ${flag}` : null;
    }
    if (rel?.flags?.[flag] !== false) return `${flag} is not off for everyone`;
    const holder = Object.keys(devices).find((id) => flag in devices[id]);
    return holder ? `${flag} is still set on pilot device ${holder}` : null;
}

async function run({ db, argv, log = console.log, error = console.error }) {
    const [cmd, flag, device] = argv;
    const ref = db.doc('config/minVersion');
    if (cmd === 'show') {
        const d = (await ref.get()).data() || {};
        log(JSON.stringify({ min: d.min ?? null, reliability: d.reliability ?? null }, null, 2));
        return 0;
    }
    if (!['on', 'off'].includes(cmd) || !FLAG_NAME.test(flag || '')) {
        error('usage: reliability-flag.cjs on|off <flag> [deviceId] | show');
        return 2;
    }
    let minBefore;
    await db.runTransaction(async (txn) => {
        const d = (await txn.get(ref)).data() || {};
        minBefore = d.min;
        txn.set(ref, { reliability: next(d.reliability || {}, cmd, flag, device) }, { mergeFields: ['reliability'] });
    });
    const after = (await ref.get()).data() || {};
    if (after.min !== minBefore) {
        error(`STOP: min changed from ${minBefore} to ${after.min}`);
        return 1;
    }
    log(JSON.stringify(after.reliability, null, 2));
    const problem = readBackProblem(after.reliability, cmd, flag, device);
    if (problem) {
        error(`STOP: ${problem}`);
        return 1;
    }
    log(`min unchanged: ${after.min}. A device that can reach the server hears this within a minute.`);
    return 0;
}

module.exports = { next, readBackProblem, run, sameDevice };

if (require.main === module) {
    const root = path.join(__dirname, '..');
    const admin = require(path.join(root, 'functions/node_modules/firebase-admin'));
    admin.initializeApp({ credential: admin.credential.cert(require(path.join(root, 'firebase-service-account.json'))) });
    run({ db: admin.firestore(), argv: process.argv.slice(2) })
        .then((code) => process.exit(code))
        .catch((e) => { console.error(e.message); process.exit(1); });
}
