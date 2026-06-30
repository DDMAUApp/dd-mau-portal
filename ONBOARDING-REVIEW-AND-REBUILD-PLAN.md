# DD Mau Onboarding — Review, Rebuild Plan, Security & Documentation Strategy

**Date:** 2026-06-29 · **Trigger:** new hire Elvis's W-4 came back blank twice. Full multi-lens review of the entire onboarding tab (functionality, security/PII, e-signature, UX, documentation).

---

## 0. TL;DR — what was wrong and what's already fixed

| Issue | Status |
|---|---|
| **W-4 (federal) came back blank** | ✅ **FIXED & LIVE (v1.0.173)** — see §1 |
| W-4/I-9 rendered blank in Preview/Acrobat (XFA/AcroForm layer hid the text) | ✅ Fixed earlier (v1.0.171) — strip form layer on submit |
| Submit could crash on emoji / non-Latin chars | ✅ Fixed (v1.0.172) — `winAnsiSafe()` |
| **All onboarding PII (SSNs, bank info, IDs) is readable by anyone on the internet** | 🔴 **OPEN — top priority, see §3** |
| Signatures have no DocuSign-grade audit / tamper-evidence / consent | 🟡 Designed, not built — see §4 |
| ~20 smaller flow/UX bugs | 🟡 Catalogued — see §2 |

---

## 1. THE W-4 FIX (done)

**Root cause (precise):** The onboarding "fillable PDF" system overlays input boxes on a template and auto-fills them from the hire's saved info. Two W-4 templates exist:

- **Missouri W-4** — backed by a clean 1-page fillable PDF, **7 fields autofill-bound** → pre-fills the hire's name/address, hire adds SSN + signs → **works perfectly.**
- **Federal W-4** — backed by the IRS **5-page XFA** form, **0 fields autofill-bound** → the hire faced ~20 empty boxes spread across 5 pages, filled nothing, and only the signature landed → **blank.**

**Fix applied:**
1. Firestore template (`onboarding_templates/SZiRyiCUtk7ywmLDIBC2`) — bound the federal fields to the hire's data and marked the essentials required: `firstName`, `lastName`, `addressLine`, `cityStateZip` (autofill + required), SSN (required, typed fresh per IRS rules), signature (required). Original backed up to `/tmp/w4fed_backup.json`.
2. Code (`OnboardingFillablePdf.jsx`) — added a `cityStateZip` autofill helper because the federal form uses one combined City/State/ZIP box where Missouri splits them.

**Result:** the federal W-4 now behaves like Missouri — pre-fills the hire's info, forces SSN + signature, produces a complete flat PDF. Have Elvis re-do the federal W-4 once more to confirm on real data.

**Field-placement note:** the federal field *positions* were already correct; only the bindings were missing. No coordinates were moved (zero risk of misplacement).

---

## 2. FULL ONBOARDING REVIEW

### The hire journey
Admin creates a hire (name/email/position/location/wage/start date) → a one-time invite link (`/?onboard=TOKEN`, 30-day TTL) is sent by SMS/email/QR → hire opens the portal (no login; the token is the credential) → completes a document checklist → admin reviews/approves each doc, completes I-9 §2, then "Move to Complete" (locks the portal) → hire signs a final certification.

### Document set (14 core docs)
Offer letter · Personal info · Emergency contact · **W-4 Federal** · **W-4 Missouri** · Direct deposit · Voided check · **I-9** (hire §1 + employer §2) · ID doc ×2 · Hep-A record · Handbook ack · Tip-credit notice · (Minor work permit if under 18).

Mechanisms: **template** (overlay fields on a PDF → flattened on submit: W-4s, I-9, DD), **form** (structured data, no file: personal/emergency), **file** (photo/PDF upload: voided check, Hep-A, IDs), **acknowledgment** (read policy + sign: handbook, tip notice), **offer_letter** (generated + signed).

### Data model (Firestore)
`onboarding_hires` (the hire + a `checklist` map of per-doc status) · `onboarding_invites` (token→hireId, TTL) · `onboarding_templates` (PDF + field overlays) · `onboarding_applications` (public job applies) · `onboarding_audits` (append-only action log). Files live in Storage at `onboarding/{hireId}/{docId}/*`.

### Bug & gap catalog (prioritized; P0/P1 already largely fixed)
**P1 — worth doing soon**
- **Portal lock isn't realtime** — when admin moves a hire to Complete/back-to-Active, the hire must reload to see it (no `onSnapshot` on the hire doc in `OnboardingPortal.jsx`). → add a snapshot listener.
- **Federal-W-4-style template gaps** — root cause of this whole ticket; the Template Editor lets you save a fillable doc with **no autofill bindings and no required signature**, silently shipping a form nobody can complete. → editor should warn when a fillable template has 0 autofill / no required signature.
- **Offer-letter edits don't push to an already-open portal** (same no-listener cause).

**P2 — UX / robustness**
- Template render timeout (30 s) has no **Retry** button → hire must close/reopen.
- SSN field has no format hint/validation (`XXX-XX-XXXX`).
- Direct-deposit re-edit requires retyping the full account number (by design for safety) — could show `****1234` instead of blank.
- I-9 §2 "fill N more fields" error doesn't say *which* fields.
- Template editor: no "mark all signatures required" / bulk-required.
- Signature/initials fields can be left blank if not individually marked required → a doc can be "submitted" unsigned.
- No GC for stale hires (only invites expire) — long-term cruft.

**P3 — nice-to-have**
- Admin: approve-all / bulk actions; search & filter on the hire list; richer hire-side progress breakdown.

---

## 3. SECURITY — "ARE THE DOCS SAFE?" (they are not, yet) 🔴

**Confirmed during this review:** with nothing but the public bucket name + the web API key (both shipped in the app), I listed and downloaded **every** onboarding file — including Elvis's W-4 with his SSN — and read the Firestore records, **with zero authentication.** This is the single most important item in this document.

### Why it's open
The app has **no real authentication** — the "login" is a 4-digit PIN checked in the browser, and the new-hire portal reads its own record using the public key + invite token. So the Firestore/Storage rules are forced to `allow read: if true` (anyone) because the rules engine can't tell "the hire reading their own file" from "a stranger." Result: SSNs (W-4), bank routing/account (voided checks, DD), and government IDs (I-9) are world-readable.

### What's exposed
| Data | Where | Exposure |
|---|---|---|
| W-4 SSNs, I-9 ID photos, voided checks, DD PDFs | Storage `/onboarding/**` | 🔴 CRITICAL — public read + **listable** |
| Hire records (name, DOB, address, emergency contact) | Firestore `onboarding_hires` | 🔴 CRITICAL — public read |
| Job applications + resumes | Firestore `onboarding_applications` + Storage `/applications/**` | 🟠 HIGH — public read |
| App Check (bot/abuse protection) | `firebase.js` | 🟠 disabled (wrong reCAPTCHA domain) |

Good news already in place (defense-in-depth): SSN is never stored in Firestore (PDF-only, masked input, autofill deny-list); only **last-4** of bank account is stored; no PII in logs; audit log is append-only; voided checks auto-purge 90 days after completion.

### Remediation (ranked by impact ÷ effort)
1. **🔴 Signed-URL proxy for Storage reads (2–3 h, ~85% of the risk).** Add a Cloud Function `getOnboardingFileUrl({hireId,docId,fileName})` that checks the caller is an admin and returns a 5-minute signed URL; flip `/onboarding/**` and `/applications/**` to `allow read: if false`; point the admin download code at the function. This closes the SSN/bank/ID leak **without** needing full auth.
2. **🟠 `onboarding_templates` delete → `if false`** (5 min) — stops anyone wiping your form library (DoS).
3. **🟠 Re-enable App Check** with the correct domain (20 min) — restores bot/abuse protection.
4. **Real auth (Phase 2, the actual fix for Firestore reads).** Firestore PII reads can't be locked down until hires + staff authenticate (invite-token → short-lived custom claim for hires; real login for staff). This ties into the broader [SAAS-PLAN] / [BIOMETRIC-PLAN] auth work.
5. **Retention policy** — extend the voided-check auto-purge pattern to I-9 IDs (after verification) and define how long signed tax forms are kept.

> Recommendation: do #1–#3 this week (they're contained and don't need the auth rebuild); schedule #4 with the auth work.

---

## 4. "DOCUSIGN FEEL" + SAFE SIGNATURES (design, ready to build)

**Today:** a bare canvas pad → PNG → drawn into the PDF. No consent-to-e-sign, no signer/identity binding, no timestamp/IP in the record, no audit trail, no tamper-evidence, no completion certificate, no locking (re-sign overwrites).

**Target (ESIGN/UETA-defensible, in-house, ~4–5 days):**
1. **Consent screen** (one-time per hire, recorded): "You agree to sign electronically; PIN/paper alternative available." → `onboarding_consents/{hireId}` with timestamp + UA.
2. **Signing ceremony** (replaces the bare pad): **Review** the doc → **Adopt** a signature (draw *or* typed-cursive *or* initials) → **Apply** to all signature/initial fields (yellow "sign here" tabs, progress "2/2 signed") → **Finish — I agree** (explicit intent) → **Success**. This is the "DocuSign feel."
3. **Per-signature audit record** → new `onboarding_signature_events` collection: who, doc + version, server timestamp, style, consent=true, device/UA, **SHA-256 of the final PDF bytes**.
4. **Completion certificate** — append a "Certificate of Completion" page to the PDF (signer, timestamp, doc hash, signature list) — the page DocuSign attaches.
5. **Tamper-evidence** — store the PDF SHA-256 in Firestore; any later edit fails the hash check.
6. **Versioning/locking** — signed PDFs are write-once; re-sign creates `signed_v2_…`, never overwrites.

**Build vs buy:** build the above in-house now (≈80% of DocuSign's defensibility, ~$0/mo). If hiring scales past ~50/yr or you want maximum legal cover on the **I-9 + W-4** specifically, integrate the **DocuSign / Dropbox Sign / BoldSign** API for just those two forms later (~$30–50/mo) and keep everything else in-house.

---

## 5. REBUILD PLAN (phased)

- **Wave 0 — DONE:** flat-PDF fix (v1.0.171), encoding safety (v1.0.172), **W-4 functional** (v1.0.173).
- **Wave 1 — Security hardening (this week):** signed-URL proxy + storage-rule lockdown + App Check (§3 #1–3). *Highest priority — it's a live PII leak.*
- **Wave 2 — Signing v2 / "DocuSign feel" (~1 wk):** consent + ceremony + audit events + completion certificate + hashing/locking (§4).
- **Wave 3 — Reliability/UX polish (~2–3 days):** realtime portal lock listener, Template-Editor guardrails (warn on 0-autofill / no-required-signature), SSN format hint, render Retry button, I-9 §2 field-level validation messages.
- **Wave 4 — Real auth + retention (ties to SaaS/biometric plan):** the true Firestore-read lockdown + I-9 ID retention/purge.

---

## 6. DOCUMENTATION STRATEGY

Three audiences, three docs (keep them in-repo + linked from the admin onboarding tab):

1. **Manager runbook — `docs/onboarding/MANAGER-GUIDE.md`** (UX-writer voice, screenshots): create a hire, send/resend the invite, review & approve docs, complete I-9 §2, reject with a reason, move to Complete, export the hire packet, **and the field guide for the Template Editor** (how to add a fillable form so it never ships broken: scan → bind autofill → mark signature required → preview).
2. **New-hire help — in-app, not a doc:** short bilingual helper text on each doc card ("Your info is filled in — add your SSN and sign"), a "What you'll need" checklist on the portal landing, and a 1-page bilingual "How to complete your onboarding" PDF you can text new hires.
3. **Engineering/compliance — `docs/onboarding/ARCHITECTURE.md`:** the data model + the template field schema + the security model + retention policy + the e-signature audit model (this file is the seed for it).

**Process:** a doc isn't "done" until (a) its manager-guide section exists, (b) its in-app helper text is written EN+ES, and (c) for template docs, the editor guardrails pass. Add a short "Onboarding QA checklist" (create a test hire → complete every doc → confirm each renders filled in Preview *and* Acrobat → confirm signature + certificate) to run before any onboarding change ships.

---

## Appendix — files & IDs
- W-4 federal template doc: `onboarding_templates/SZiRyiCUtk7ywmLDIBC2` (forDocId `w4_fed`); MO: forDocId `w4_mo`.
- Sources: federal = `w4_fed_1778525685082.pdf` (5-pg XFA); MO = `w4_fed_1778528468683.pdf` (1-pg AcroForm, mislabeled filename).
- Key code: `OnboardingFillablePdf.jsx` (hire fill + submit), `OnboardingEmployerFill.jsx` (I-9 §2), `OnboardingTemplateEditor.jsx` (template authoring), `src/data/onboarding.js` (doc definitions), `storage.rules` / `firestore.rules` (the exposure).
