# TRAINING HUB DEEP DIVE — 2026-08-17

**Trigger (Andrew):** "the training tab is loading kinda slow and some pages aren't working… go through each lesson… make sure the content is right too" + (mid-turn) "make the content window larger — on the iPad it's the modules and next to it the lessons… hard to read".

**Method:** 2 code lenses (perf, correctness) on `TrainingHub.jsx` + the load path; 11 per-module content reviewers (one per module, EN + ES, vs the official manuals, Master Recipe Book, Allergen Matrix docx/PDF, live `config/menu_v2` + `build_sheet`, `onboardingPolicies.js`, the June-2026 team-meeting deck, the drink build chart) → 11 adversarial verifiers → 1 cross-module architect → fixes applied per module in isolated worktrees → 4 post-apply re-readers. ~55 agents. Live checks in the browser pane (desktop / iPad 820px / phone 375px) against prod data.

Shipped as **v1.0.427**. 896 tests green (13 new).

---

## 0. TL;DR — what was actually wrong

**Code (why it felt slow / broken):**
1. Full-page `Loading…` gate on the first `training_v2` snapshot — a doc never seen on the device (every new hire, every fresh device) had to round-trip to the server before *anything* rendered; on a wedged transport (post-resume iOS) it sat there until the 3-min liveness probe. → List renders instantly; progress pills fill in; quiz gated on `progressReady`; 8-s first-snapshot watchdog pokes `reviveFirestore`.
2. **Mark as read** and **Submit Quiz** awaited the Firestore write ack before advancing — every lesson advance = server RTT; on bad store Wi-Fi the button looked dead for seconds and the 18-s watchdog reload could land mid-quiz (with answers still in localStorage → second submit → spurious lock). → Advance/show result first, persist in the background, toast on hard failure, visible "Submitting…" state.
3. No scroll reset — "Next →" at the bottom of a lesson opened the next lesson **scrolled to its bottom** (measured: scrollY 1455 → 1455). → scroll-to-top on every view/lesson change (now 1455 → 0).
4. iPad: the app nav (256 px) + an always-on module rail (256–288 px) left ~200 px for the lesson at 820 px. → Rail is collapsible; open by default only ≥1280 px; "☰ Modules" pill on tablets; picking a module closes it. Lesson body 15/16 px.
5. Tab switch remounted the page and lost your place. → Position persisted in `sessionStorage` per staff (module/lesson views only).
6. `lessonsCompleted` was written as the whole local array (a cold-cache tap could shorten it). → `arrayUnion`.
7. A module that was already ✅ could be 🔒 by two failed retakes. → Fixed.
8. Only owners could see the Tracker / Unlock although the lock copy says "ask your manager". → Managers can now.
9. Empty in-app override (`''` / `[]`) rendered a blank lesson for everyone. → Falls back to default; editor refuses to save empty.
10. Quiz options rendered in source order and M7 + M9 had the key at **b** on every question. → Deterministic per-attempt shuffle (`orderQuizOptions`).
11. Android back went to Home from inside a lesson. → Steps up one level.
12. Staff rename dropped `training_v2` (progress "vanished", tracker showed both names). → `renameStaffEverywhere` migrates the doc.
13. Training chunk not pre-warmed. → third-wave prewarm; doubled bottom padding removed; quiz-answer debounce that never flushed → immediate write.

**Content (why it wasn't right):** ~150 confirmed findings across all 11 modules (P0 ×2, P1 ×~35). Highlights:
- **P0 M17 L1** said "oat and soy milk are the only milk-allergy-safe substitutes for milk teas" — inside the boba-creamer bullet — contradicting M6, M9, M17 L4 and `aiContext`. Boba milk tea has **no** safe sub (fruit tea only); Matcha Latte / Chai / Thai Tea can sub oat/soy.
- **P0 M3** told staff sani buckets "live on the floor" (FDA Food Code violation).
- **M17 matrix**: Fried Rice missing WHEAT, Lo Mein missing EGG, Vegan Cheese Rolls (tree nut) missing entirely, egg roll called an "add-on" (it's default), no PROTEINS section although L2's method depends on it, MSG column data missing, Buffalo tofu missing dairy flag, several notes weaker than the official PDF. Now: PROTEINS section (15 rows), Churros/Viet-Coffee-Tres-Leches rows, MSG data + column, disclosure script in the boba row.
- The May bulk-edit damage (Andrew's TRAINING_EDIT round-trip) — 8 garbled EN sentences ("Do NOT share it with anyone — .", "hand book,", "color, dark, khaki", "no acrylics clean nails—", "replacement. — not", "The very late", "5-team or 7-team", "Just the modification when possible") where ES was never touched, so EN≠ES on real rules (pant color, polish, wage theft, Sling).
- **Live overrides** (6 keys, all EN-only edits): truncated M10 title ("What the Shift Lead"), lone "•" bullet in M6, the M9 milk-allergy redirect sentence cut in EN, M7 EN/ES 19 vs 20 paragraphs, sticker owner cashier(ES) vs bagger(EN). Intentional edits (bagger places the dot, bowls-under-pho, cash sheet gone, laminated menus, milk & cakes gone, no apron for bagger) folded into the static file; the 6 override keys then deleted so the file is the single source of truth again.
- Cross-module contradictions fixed: RESTORE ES "Tell al líder", "coming soon" Customer Service module (3 months stale), pho garnish plate (jalapeños in M7/M8-L1 vs 3-item plate everywhere else — sources say 3), number tents (M11/M12 "on every table" vs M6 "stacked at register" — register is right), voids "manager" (M6) vs "Shift Lead" (M10/manual), "All day" definition, sweetness levels, clock-in ordering (M2 says apron/hands **before** clock-in; station openers said the reverse), open sign (M6 automatic vs M10 manual → timer), Sling in M2-ES, sick-day policy promised in the M3 L4 title but absent (added), 2-Bite Check missing (M11), Last Call 7:45 missing (M6), allergy escalation weakened to "if unsure" (M3) / "consult M17 yourself" (M6) → always get the Shift Lead.
- Spanish: ~60 calques/anglicisms fixed ("Toweld", "rehaces", "performance", "brotes de soja", "proteínas prepa", "Qué Posee X" titles, "GM", "expear", tú/usted mixing in guest scripts, "(regla PCI)" hint only in ES options…). Wall-of-caps boba paragraphs kept but consistent.
- Quiz: two new M9 questions (milk-allergy mid-build; 4-hour boba), option "tells" removed (only the correct answer carried its justification in 6 places), one ambiguous fish-allergy distractor fixed.
- Flow: M17 moved into the New Hire track (M1→M2→M3→M17 — it's the prerequisite M3/M6 point at); M10 into Manager Ops; durations reset to realistic minutes (was 315 min total shown, ≈170 realistic).

---

## 1. Measurements (dev build, prod data)

| | before | after |
|---|---|---|
| Tap Training → module list (warm) | 116 ms, behind a full-page "Loading…" until snapshot | list paints immediately (no gate) |
| "Mark as read" → next lesson visible | after server ack (100–400 ms healthy; seconds on bad Wi-Fi; dead on wedged) | immediate; write in background |
| "Next →" scroll position | stays at old scrollY (1455 px) | 0 |
| iPad portrait content column | ~200 px | full width (~500 px) |
| Chunk | 55 kB gz data + 10 kB gz page, not prewarmed | same size, prewarmed after My Hours; parse cost measured 0.42 ms (splitting not worth it) |

## 2. Decisions I made that Andrew should confirm (all are live)
1. **Nail polish**: allowed if fresh/unchipped, no acrylics (your May edit intent + the signed handbook; the manuals still say no polish).
2. **Cash sheet at open**: removed (Julie deleted it in the M6 override). M10 L4 still mentions the register person signing the cash sheet — left as-is; say the word and I'll drop it there too.
3. **Milk & cakes to the fridge**: removed from M7 (Julie's edit); M10's Lead sign-off still lists it under Bagging/Expo.
4. **Apron**: bagger/cashier no longer told "apron on" (Julie's edits); Expo/Drinks/Food Runner still say apron on. Tell me if nobody wears one and I'll strip it everywhere (+ manual).
5. **Pho garnish plate** = thai basil, bean sprouts, lime (no jalapeños) — every source says 3 items.
6. **Mid-shift skim**: kept the lesson (no skim, $300 bank). The Onboarding Manual §10 still says "skim if > $300" — the manual is stale.
7. **RESTORE letters**: kept the module's/deck's version (Recognize, Empathize, Solve it now, Tell the Lead, Offer something extra, Re-greet, Examine). Both official manuals still spell it Say Sorry / Take Action / Overdeliver / Reconnect / Elevate — update the manuals or tell me to switch the module.
8. **Tardiness**: grammar-only fix ("Very late with no word from you is treated as a no-call/no-show"). Where "very late" starts vs the 30-min written warning is still undefined.
9. **Sweetness**: kept 100%/50% only.
10. **Founder**: module says "Julie Truong" (all sources agree); roster says Julie Shih. Left as-is.
11. **M17 kitchen confirmations** (marked ◐ / "confirm with kitchen" in the chart until you tell me): veggie egg roll wrapper (egg?), which hoisin goes in the Vegan Beef marinade (peanut?), lemongrass shrimp marinade (fish sauce or just sesame oil?), Buffalo sauce label (dairy/wheat/tree nut), Creamy Sweet Chili base (dairy?), Vegan Lo Mein sauce, roast pork (soy-dipped) vs lemongrass pork on the line, Salmon Bowl soy source.
12. `training_v2` docs of renamed staff from BEFORE today are still orphaned (only future renames migrate).

## 3. Not done (deliberately) / follow-ups
- **New modules the manuals justify** (cross-module review): G1 *Menu Mastery* (the empty "menu" track; 8 sauces, bowl anatomy, power descriptions), G2 *Guest Service Playbook* (full RESTORE, Kitchen Calls, phone/third-party orders, Last Call 7:45), G3 *Cross-contact basics* (color boards, shared fryer, allergen-order prep). Outlines are in the audit transcript; ~1 day each incl. ES + quiz. Say which.
- Signed handbook (`onboardingPolicies.js`) still says **Sling** in 4 places and "15 min late = may be terminated" — legal text, left for you.
- Onboarding Manual / FOH manual / Cross-Contamination PDF have the stale items above (skim, RESTORE letters, DD sauce "has fish sauce", "Refrigerate hoisin at open"). Docs, not app.
- iOS YouTube embeds may show "Video unavailable" (capacitor:// origin sends no referrer) — no lesson has a video today, so unverified.
- `firestore.rules` `config/training_overrides` growth-cap clause is dead code (harmless); a rules deploy for a P3 wasn't worth the risk.
- Per-module code-splitting of `training.js`: measured parse 0.42 ms — not worth it.

## 4. Safety of the batch
- All Firestore write primitives unchanged except: `lessonsCompleted` → `arrayUnion` (strictly safer), `training_v2` copy on rename (batched set+delete), override keys deleted (backup JSON kept in the session scratchpad; static file now contains everything they said, corrected).
- Content: every lesson still has EN/ES paragraph parity (test-enforced), every quiz key exists and is taught, matrix rows validated (`v` keys, marks, vegan values, ES fields) by script + 4 independent re-readers.
