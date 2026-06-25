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
// Uses the repo-root service account (present on Andrew's Mac, same as every
// other scripts/*.mjs admin tool). No new Cloud Function needed.

import admin from "firebase-admin";
import { readFileSync } from "fs";

const CHAT_ID = "debug_agent";
const AGENT_NAME = "Debug Agent";
const OWNER = "Andrew Shih";

const saPath = new URL("../../firebase-service-account.json", import.meta.url);
const sa = JSON.parse(readFileSync(saPath));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

async function ensureChat() {
    const ref = db.doc(`chats/${CHAT_ID}`);
    const snap = await ref.get();
    if (!snap.exists) {
        await ref.set({
            type: "group",
            name: "🐛 Debug Agent",
            emoji: "🐛",
            members: [OWNER, AGENT_NAME],
            admins: [OWNER],
            createdBy: AGENT_NAME,
            createdByTier: "admin",
            editTier: "admin",
            createdAt: FV.serverTimestamp(),
            lastActivityAt: FV.serverTimestamp(),
        }, { merge: true });
    }
    return ref;
}

async function post(text, urgent) {
    const body = String(text || "").trim().slice(0, 4000);
    if (!body) { console.error("post: empty message"); process.exit(1); }
    const ref = await ensureChat();
    await ref.collection("messages").add({
        senderName: AGENT_NAME,
        type: "text",
        text: body,
        createdAt: FV.serverTimestamp(),
    });
    await ref.set({
        lastMessage: { text: body.slice(0, 120), sender: AGENT_NAME, ts: FV.serverTimestamp(), type: "text" },
        lastActivityAt: FV.serverTimestamp(),
    }, { merge: true });
    // Push Andrew via the existing notifications → dispatchNotification path.
    await db.collection("notifications").add({
        forStaff: OWNER,
        type: "chat_message",
        chatId: CHAT_ID,
        title: urgent ? "🐛 Debug agent — needs you" : "🐛 Debug agent",
        body: body.slice(0, 160),
        deepLink: "chat",
        link: "/chat",
        read: false,
        forceDeliver: !!urgent,
        createdAt: FV.serverTimestamp(),
    });
    console.log(`posted + pushed to ${OWNER}${urgent ? " (urgent)" : ""}`);
}

async function read(limit) {
    const ref = db.doc(`chats/${CHAT_ID}`);
    const snap = await ref.collection("messages")
        .orderBy("createdAt", "desc").limit(limit || 30).get();
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
    const ref = db.doc(`chats/${CHAT_ID}`);
    const snap = await ref.collection("messages").orderBy("createdAt", "desc").limit(1).get();
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
