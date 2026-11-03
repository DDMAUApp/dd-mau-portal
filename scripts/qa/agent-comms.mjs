#!/usr/bin/env node
// Two-way bridge between the self-healing debug agent and Andrew, over the
// app's EXISTING chat + push pipeline. The agent shells out to this:
//
//   node scripts/qa/agent-comms.mjs post "message text" [--urgent]
//   node scripts/qa/agent-comms.mjs read [--limit 30]
//
// `post`  writes a message into the "🐛 Debug Agent" chat thread (so it shows
//         on Andrew's normal chat page) AND creates a /notifications doc for
//         him, which the existing dispatchNotification Cloud Function turns
//         into an FCM/APNs push. Andrew taps it, opens the thread, and replies
//         like any chat.
// `read`  prints the recent thread messages (newest last) so the agent can see
//         Andrew's replies/instructions and act on them on its next run.
//
// Uses the app's public web config and the same client SDK + security rules as
// the phones, NOT the service account: the agent reads a chat anyone can write
// to, so it must not hold a credential that bypasses the rules.

import { initializeApp } from "firebase/app";
import {
    getFirestore, doc, getDoc, setDoc, addDoc, getDocs, collection,
    query, orderBy, limit as limitTo, serverTimestamp,
} from "firebase/firestore";

const CHAT_ID = "debug_agent";
const AGENT_NAME = "Debug Agent";
const OWNER = "Andrew Shih";

const db = getFirestore(initializeApp({
    apiKey: "AIzaSyDTJccmQHzvbgwW_9_1aDDkAgK0B4PJfkQ",
    projectId: "dd-mau-staff-app",
}));

async function ensureChat() {
    const ref = doc(db, "chats", CHAT_ID);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
        await setDoc(ref, {
            type: "group",
            name: "🐛 Debug Agent",
            emoji: "🐛",
            members: [OWNER, AGENT_NAME],
            admins: [OWNER],
            createdBy: AGENT_NAME,
            createdByTier: "admin",
            editTier: "admin",
            createdAt: serverTimestamp(),
            lastActivityAt: serverTimestamp(),
        }, { merge: true });
    }
    return ref;
}

async function post(text, urgent) {
    const body = String(text || "").trim().slice(0, 4000);
    if (!body) { console.error("post: empty message"); process.exit(1); }
    const ref = await ensureChat();
    await addDoc(collection(ref, "messages"), {
        senderName: AGENT_NAME,
        type: "text",
        text: body,
        createdAt: serverTimestamp(),
    });
    await setDoc(ref, {
        lastMessage: { text: body.slice(0, 120), sender: AGENT_NAME, ts: serverTimestamp(), type: "text" },
        lastActivityAt: serverTimestamp(),
    }, { merge: true });
    // Push Andrew via the existing notifications → dispatchNotification path.
    await addDoc(collection(db, "notifications"), {
        forStaff: OWNER,
        type: "chat_message",
        chatId: CHAT_ID,
        title: urgent ? "🐛 Debug agent — needs you" : "🐛 Debug agent",
        body: body.slice(0, 160),
        deepLink: "chat",
        link: "/chat",
        read: false,
        forceDeliver: !!urgent,
        createdAt: serverTimestamp(),
    });
    console.log(`posted + pushed to ${OWNER}${urgent ? " (urgent)" : ""}`);
}

async function read(limit) {
    const messages = collection(db, "chats", CHAT_ID, "messages");
    const snap = await getDocs(query(messages, orderBy("createdAt", "desc"), limitTo(limit || 30)));
    const msgs = snap.docs.map((d) => d.data()).reverse();
    if (!msgs.length) { console.log("(no messages yet — thread is empty)"); return; }
    for (const m of msgs) {
        const ts = m.createdAt && m.createdAt.toDate ? m.createdAt.toDate().toISOString() : "?";
        console.log(`[${ts}] ${m.senderName}: ${(m.text || "").slice(0, 800)}`);
    }
}

// ensure-reply: post a fallback ONLY if the newest message isn't from the agent
// (i.e., the owner is still waiting because the run ended without a reply). This
// is a PURE Firestore write — it works even when the agent/Claude errored, timed
// out, or the API key is out of credit, so the owner is NEVER left hanging.
// One-shot: once it posts, the newest message is the agent's, so the next run
// won't double-post.
async function ensureReply(text) {
    const messages = collection(db, "chats", CHAT_ID, "messages");
    const snap = await getDocs(query(messages, orderBy("createdAt", "desc"), limitTo(1)));
    const last = snap.docs[0] && snap.docs[0].data();
    if (last && last.senderName === AGENT_NAME) {
        console.log("ensure-reply: agent already replied — no fallback needed");
        return;
    }
    await post(text || "⚠️ I saw your message but this run didn't finish a reply. Re-send once it's sorted and I'll pick it right back up.", false);
    console.log("ensure-reply: owner was waiting — posted fallback");
}

const [cmd, ...rest] = process.argv.slice(2);
const urgent = rest.includes("--urgent");
const limIdx = rest.indexOf("--limit");
const limit = limIdx >= 0 ? parseInt(rest[limIdx + 1], 10) : 30;
const textArg = rest.filter((a) => !a.startsWith("--")).join(" ");

if (cmd === "post") { await post(textArg, urgent); }
else if (cmd === "read") { await read(limit); }
else if (cmd === "ensure-reply") { await ensureReply(textArg); }
else { console.log('usage: agent-comms.mjs post "message" [--urgent]  |  read [--limit N]  |  ensure-reply "fallback"'); }
process.exit(0);
