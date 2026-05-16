// Coverage-request state-machine helpers.
//
// Encapsulates the multi-doc transactions so the in-thread coverage
// card stays a thin renderer. Three transitions:
//
//   claimCoverage()    — open → claimed (volunteer tap)
//   approveCoverage()  — claimed → approved (manager tap), reassigns shift
//   denyCoverage()     — claimed → open (manager tap), notify both
//   withdrawCoverage() — open|claimed → withdrawn (requester tap)
//
// Each runs as a Firestore transaction so two simultaneous claims
// don't both succeed and a denial can't race a manager's approve.

import { db } from '../firebase';
import {
    doc, runTransaction, collection, addDoc, serverTimestamp, updateDoc,
} from 'firebase/firestore';
import { notifyStaff } from './notify';
import { recordAudit } from './audit';

export async function claimCoverage({ chatId, messageId, claimerName, claimerId }) {
    const msgRef = doc(db, 'chats', chatId, 'messages', messageId);
    let snapshot = null;
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(msgRef);
        if (!snap.exists()) throw new Error('coverage_request_missing');
        const data = snap.data();
        if (data.coverageStatus !== 'open') throw new Error('coverage_not_open');
        if (data.requesterId === claimerName) throw new Error('cannot_claim_own');
        tx.update(msgRef, {
            coverageStatus: 'claimed',
            claimedBy: claimerName,
            claimedAt: serverTimestamp(),
        });
        snapshot = data;
    });
    // Notify the requester + managers (best-effort, outside transaction).
    if (snapshot) {
        notifyStaff({
            forStaff: snapshot.requesterId,
            type: 'coverage_request',
            title: '✋ ' + 'Coverage claimed',
            body: `${claimerName} wants to take your ${snapshot.shiftSnapshot?.date || ''} shift`,
            deepLink: 'chat',
            tag: `coverage_claimed:${messageId}`,
            createdBy: claimerName,
        }).catch(() => {});
        recordAudit({
            action: 'chat.coverage.claim',
            actorName: claimerName,
            actorId: claimerId,
            targetType: 'message',
            targetId: messageId,
            details: {
                chatId,
                shiftId: snapshot.linkedShiftId,
                requesterId: snapshot.requesterId,
            },
        });
    }
    return { ok: true };
}

// Manager approves the claim → shift gets reassigned, message closes.
export async function approveCoverage({ chatId, messageId, managerName, managerId }) {
    const msgRef = doc(db, 'chats', chatId, 'messages', messageId);
    let snapshot = null;
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(msgRef);
        if (!snap.exists()) throw new Error('coverage_request_missing');
        const data = snap.data();
        if (data.coverageStatus !== 'claimed') throw new Error('not_in_claimed_state');
        if (!data.linkedShiftId || !data.claimedBy) throw new Error('missing_shift_or_claimer');
        const shiftRef = doc(db, 'shifts', data.linkedShiftId);
        const shiftSnap = await tx.get(shiftRef);
        if (!shiftSnap.exists()) throw new Error('shift_missing');
        // Reassign the shift to the claimer.
        tx.update(shiftRef, {
            staffName: data.claimedBy,
            coverageNote: `Covered for ${data.requesterId} via chat request`,
            coverageApprovedBy: managerName,
            coverageApprovedAt: serverTimestamp(),
            coverageOriginalStaff: data.requesterId,
        });
        // Close the request.
        tx.update(msgRef, {
            coverageStatus: 'approved',
            approvedBy: managerName,
            approvedAt: serverTimestamp(),
        });
        snapshot = data;
    });
    if (snapshot) {
        for (const recipient of [snapshot.requesterId, snapshot.claimedBy]) {
            notifyStaff({
                forStaff: recipient,
                type: 'coverage_request',
                title: '✅ ' + 'Coverage approved',
                body: `${snapshot.shiftSnapshot?.date || ''} ${snapshot.shiftSnapshot?.startTime || ''}-${snapshot.shiftSnapshot?.endTime || ''} reassigned to ${snapshot.claimedBy}`,
                deepLink: 'schedule',
                tag: `coverage_approved:${messageId}:${recipient}`,
                createdBy: managerName,
            }).catch(() => {});
        }
        recordAudit({
            action: 'chat.coverage.approve',
            actorName: managerName,
            actorId: managerId,
            targetType: 'shift',
            targetId: snapshot.linkedShiftId,
            details: {
                messageId,
                chatId,
                fromStaff: snapshot.requesterId,
                toStaff: snapshot.claimedBy,
            },
        });
    }
    return { ok: true };
}

export async function denyCoverage({ chatId, messageId, managerName, managerId }) {
    const msgRef = doc(db, 'chats', chatId, 'messages', messageId);
    let snapshot = null;
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(msgRef);
        if (!snap.exists()) throw new Error('coverage_request_missing');
        const data = snap.data();
        if (data.coverageStatus !== 'claimed') throw new Error('not_in_claimed_state');
        tx.update(msgRef, {
            coverageStatus: 'open',  // back to open so others can claim
            deniedBy: managerName,
            deniedAt: serverTimestamp(),
            previousClaimer: data.claimedBy,
            claimedBy: null,
            claimedAt: null,
        });
        snapshot = data;
    });
    if (snapshot) {
        for (const recipient of [snapshot.requesterId, snapshot.claimedBy]) {
            if (!recipient) continue;
            notifyStaff({
                forStaff: recipient,
                type: 'coverage_request',
                title: '✕ ' + 'Coverage claim denied',
                body: `Manager declined the claim. Request is open again.`,
                deepLink: 'chat',
                tag: `coverage_denied:${messageId}:${recipient}`,
                createdBy: managerName,
            }).catch(() => {});
        }
        recordAudit({
            action: 'chat.coverage.deny',
            actorName: managerName,
            actorId: managerId,
            targetType: 'message',
            targetId: messageId,
            details: { chatId, claimedBy: snapshot.claimedBy },
        });
    }
    return { ok: true };
}

export async function withdrawCoverage({ chatId, messageId, requesterName, requesterId }) {
    const msgRef = doc(db, 'chats', chatId, 'messages', messageId);
    let snapshot = null;
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(msgRef);
        if (!snap.exists()) throw new Error('coverage_request_missing');
        const data = snap.data();
        if (data.requesterId !== requesterName) throw new Error('not_your_request');
        if (data.coverageStatus === 'approved') throw new Error('already_approved');
        tx.update(msgRef, {
            coverageStatus: 'withdrawn',
            withdrawnAt: serverTimestamp(),
        });
        snapshot = data;
    });
    if (snapshot?.claimedBy) {
        notifyStaff({
            forStaff: snapshot.claimedBy,
            type: 'coverage_request',
            title: 'ℹ️ ' + 'Coverage request withdrawn',
            body: `${requesterName} withdrew their coverage request.`,
            deepLink: 'chat',
            tag: `coverage_withdrawn:${messageId}`,
            createdBy: requesterName,
        }).catch(() => {});
    }
    recordAudit({
        action: 'chat.coverage.withdraw',
        actorName: requesterName,
        actorId: requesterId,
        targetType: 'message',
        targetId: messageId,
        details: { chatId },
    });
    return { ok: true };
}
