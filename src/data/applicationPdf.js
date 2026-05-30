// applicationPdf.js — render a /onboarding_applications doc as a
// signed PDF that the admin can save / email / file for records.
//
// 2026-05-29 — Andrew: "also i need to be able to export the
// application because at the end they sign it and agree to terms
// that might need to export one day". The PDF preserves everything
// the applicant filled out, every consent they checked, the at-will
// acknowledgment, the typed/drawn signature image, and the frozen
// DocuSign-style timestamp captured at sign time. If the applicant
// drew their signature, the PNG is embedded; if they typed it, the
// typed name renders in a script-style italic line.
//
// Lazy import of pdf-lib (~360KB) — only paid when the admin clicks
// "Export PDF". Same load pattern as OnboardingOfferLetter.jsx.

import {
    POSITIONS, LOCATIONS, DAYS, SHIFT_BLOCKS, DESIRED_HOURS,
    EXPERIENCE_YEARS, PREVIOUS_ROLES, SKILLS, CERTIFICATIONS,
    TRANSPORT_OPTIONS, DISTANCE_OPTIONS, LIFTING_CAPACITY,
    STANDING_HOURS, EDUCATION_LEVELS, LANGUAGES,
    REFERENCE_RELATIONS, REFERRAL_SOURCES,
} from './applyForm';

function loadPdfLib() {
    return import('pdf-lib');
}

// Friendly label lookup against an option array — matches the
// pattern in the apply form / review UI.
function lbl(arr, id) {
    if (!id) return '';
    const found = (arr || []).find(o => o.id === id);
    return found ? (found.en || '') : String(id);
}

function fmtDate(value) {
    if (!value) return '';
    try {
        if (typeof value === 'object' && typeof value.toDate === 'function') {
            return value.toDate().toLocaleString('en-US', {
                weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
                hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
            });
        }
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return String(value);
        return d.toLocaleString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
        });
    } catch {
        return String(value);
    }
}

// Build a human-readable availability summary from the grid.
// Returns lines like: "Mon: Lunch, Dinner".
function availabilityLines(app) {
    const out = [];
    for (const day of DAYS) {
        const slots = (app.availability && app.availability[day.id]) || {};
        const picked = SHIFT_BLOCKS.filter(b => slots[b.id]).map(b => b.en);
        if (picked.length > 0) {
            out.push(`${day.en}: ${picked.join(', ')}`);
        }
    }
    if (out.length === 0) out.push('No shifts selected.');
    return out;
}

// Strip the "data:image/png;base64," prefix and decode to bytes for
// pdf-lib's embedPng. Returns null on any parse failure (and the
// caller falls back to the typed-name rendering).
function dataUrlToBytes(dataUrl) {
    try {
        if (!dataUrl || !dataUrl.startsWith('data:image')) return null;
        const commaIdx = dataUrl.indexOf(',');
        if (commaIdx < 0) return null;
        const b64 = dataUrl.slice(commaIdx + 1);
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    } catch {
        return null;
    }
}

// Sanitize a string for the PDF — pdf-lib's WinAnsi encoding chokes
// on some emoji / non-Latin characters. Strip anything outside the
// BMP basic Latin + Latin-1 supplement so we never throw mid-render.
function safe(s) {
    if (s === null || s === undefined) return '';
    try {
        return String(s).replace(/[^\x00-\xFF]/g, '');
    } catch {
        return '';
    }
}

export async function buildApplicationPdf(app) {
    const pdfLib = await loadPdfLib();
    const { PDFDocument, StandardFonts, rgb } = pdfLib;
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

    const black = rgb(0, 0, 0);
    const gray  = rgb(0.45, 0.45, 0.45);
    const green = rgb(0.10, 0.43, 0.25);

    // US Letter portrait. Reasonable margins matching the offer letter.
    const pageW = 612;
    const pageH = 792;
    const margin = 54;
    const contentW = pageW - margin * 2;
    let page = pdfDoc.addPage([pageW, pageH]);
    let y = pageH - margin;

    // ── Layout helpers ───────────────────────────────────────────
    const newPage = () => {
        page = pdfDoc.addPage([pageW, pageH]);
        y = pageH - margin;
    };
    const ensureSpace = (need) => {
        if (y - need < margin) newPage();
    };
    const drawText = (text, opts = {}) => {
        const f = opts.bold ? bold : (opts.italic ? italic : font);
        const size = opts.size || 10;
        const color = opts.color || black;
        const x = opts.x === undefined ? margin : opts.x;
        page.drawText(safe(text), { x, y, size, font: f, color });
    };
    const moveDown = (n) => { y -= n; };
    const drawHr = () => {
        ensureSpace(8);
        page.drawLine({
            start: { x: margin, y: y + 2 },
            end:   { x: pageW - margin, y: y + 2 },
            thickness: 0.4, color: gray,
        });
        moveDown(10);
    };
    const drawWrapped = (text, opts = {}) => {
        const safeText = safe(text);
        if (!safeText.trim()) { moveDown(opts.size || 10); return; }
        const f = opts.bold ? bold : (opts.italic ? italic : font);
        const size = opts.size || 10;
        const color = opts.color || black;
        const lineH = opts.lineHeight || size + 4;
        const words = safeText.split(/\s+/);
        let line = '';
        for (const w of words) {
            const test = line ? line + ' ' + w : w;
            const wid = f.widthOfTextAtSize(test, size);
            if (wid > contentW && line) {
                ensureSpace(lineH);
                page.drawText(line, { x: margin, y, size, font: f, color });
                moveDown(lineH);
                line = w;
            } else {
                line = test;
            }
        }
        if (line) {
            ensureSpace(lineH);
            page.drawText(line, { x: margin, y, size, font: f, color });
            moveDown(lineH);
        }
    };
    const drawKV = (label, value) => {
        if (!value && value !== 0) return;
        ensureSpace(14);
        page.drawText(safe(label) + ':', { x: margin, y, size: 10, font: bold, color: black });
        const labelW = bold.widthOfTextAtSize(safe(label) + ':', 10);
        const valStr = String(value);
        const remaining = contentW - labelW - 6;
        // Wrap the value if it overflows.
        const words = safe(valStr).split(/\s+/);
        let line = '';
        let first = true;
        const xStart = margin + labelW + 6;
        const drawLine = (s, x) => {
            page.drawText(s, { x, y, size: 10, font, color: black });
        };
        for (const w of words) {
            const test = line ? line + ' ' + w : w;
            const limit = first ? remaining : contentW;
            const wid = font.widthOfTextAtSize(test, 10);
            if (wid > limit && line) {
                drawLine(line, first ? xStart : margin);
                moveDown(13);
                ensureSpace(14);
                line = w;
                first = false;
            } else {
                line = test;
            }
        }
        if (line) drawLine(line, first ? xStart : margin);
        moveDown(14);
    };
    const drawSectionTitle = (title) => {
        ensureSpace(28);
        moveDown(4);
        page.drawText(safe(title), { x: margin, y, size: 12, font: bold, color: green });
        moveDown(4);
        drawHr();
    };

    // ── Header ──────────────────────────────────────────────────
    drawText('DD Mau Vietnamese Eatery', { size: 14, bold: true });
    moveDown(18);
    drawText('Job Application', { size: 11, color: gray });
    moveDown(8);
    drawText(`Application ID: ${app.id || ''}`, { size: 9, color: gray });
    moveDown(11);
    drawText(`Submitted: ${fmtDate(app.createdAt)}`, { size: 9, color: gray });
    moveDown(14);
    drawHr();

    // ── Position & start ────────────────────────────────────────
    drawSectionTitle('Position & start');
    const positions = Array.isArray(app.positionsAppliedFor) && app.positionsAppliedFor.length
        ? app.positionsAppliedFor.map(p => lbl(POSITIONS, p)).filter(Boolean).join(', ')
        : (app.position || '');
    const locs = Array.isArray(app.locations) && app.locations.length
        ? app.locations.map(l => lbl(LOCATIONS, l)).filter(Boolean).join(', ')
        : (app.location || '');
    drawKV('Position(s)', positions);
    drawKV('Location(s)', locs);
    drawKV('Earliest start', app.soonestStartDate || '');
    drawKV('Desired hours', lbl(DESIRED_HOURS, app.desiredHours));
    if (app.desiredHourlyWage) drawKV('Hoped hourly wage', `$${app.desiredHourlyWage}/hr`);

    // ── Contact ─────────────────────────────────────────────────
    drawSectionTitle('Contact');
    drawKV('Legal name', app.legalName || '');
    if (app.preferredName) drawKV('Preferred name', app.preferredName);
    drawKV('Phone', app.phone || '');
    drawKV('Email', app.email || '');
    drawKV('City / State', [app.city, app.state].filter(Boolean).join(', '));
    drawKV('Distance from restaurant', lbl(DISTANCE_OPTIONS, app.howFarFromRestaurant));
    drawKV('Transportation', lbl(TRANSPORT_OPTIONS, app.transportationMethod));

    // ── Availability ────────────────────────────────────────────
    drawSectionTitle('Availability');
    for (const line of availabilityLines(app)) drawWrapped(line);
    if (app.minHoursPerWeek) drawKV('Minimum hours / week', `${app.minHoursPerWeek}`);
    if (app.availabilityNote) {
        moveDown(4);
        drawText('Note from applicant:', { bold: true, size: 10 });
        moveDown(13);
        drawWrapped(app.availabilityNote, { italic: true });
    }

    // ── Experience ──────────────────────────────────────────────
    drawSectionTitle('Experience');
    drawKV('Years in restaurants', lbl(EXPERIENCE_YEARS, app.restaurantExperienceYears));
    if (Array.isArray(app.previousRoles) && app.previousRoles.length) {
        drawKV('Previous roles',
            app.previousRoles.map(r => lbl(PREVIOUS_ROLES, r)).filter(Boolean).join(', '));
    }
    if (Array.isArray(app.skillsList) && app.skillsList.length) {
        drawKV('Skills',
            app.skillsList.map(s => lbl(SKILLS, s)).filter(Boolean).join(', '));
    }
    if (Array.isArray(app.certifications) && app.certifications.length) {
        drawKV('Certifications',
            app.certifications.map(c => lbl(CERTIFICATIONS, c)).filter(Boolean).join(', '));
    }
    drawKV('Can lift', lbl(LIFTING_CAPACITY, app.canLiftHowMuch));
    drawKV('Can stand', lbl(STANDING_HOURS, app.canStandHowLong));

    if (Array.isArray(app.pastEmployers) && app.pastEmployers.length) {
        moveDown(4);
        drawText('Past employers:', { bold: true, size: 10 });
        moveDown(14);
        for (const e of app.pastEmployers) {
            const end = e.stillHere ? 'present' : (e.endMonth || '?');
            const line = `${e.role || '?'} @ ${e.employer || '?'}  (${e.startMonth || '?'} – ${end})`;
            drawWrapped(line);
            if (e.reasonLeft) drawWrapped(`Reason left: ${e.reasonLeft}`, { italic: true, color: gray, size: 9 });
        }
    }

    // ── Education ───────────────────────────────────────────────
    drawSectionTitle('Education');
    drawKV('Highest level', lbl(EDUCATION_LEVELS, app.highestEducationLevel));
    if (app.schoolName) drawKV('School', app.schoolName);
    if (app.expectedGraduation) drawKV('Expected graduation', app.expectedGraduation);
    if (app.isStudent === true) drawWrapped('Currently a student.', { italic: true });
    if (app.isStudent === false) drawWrapped('Not currently a student.', { italic: true });

    // ── Eligibility ─────────────────────────────────────────────
    drawSectionTitle('Eligibility');
    drawKV('Authorized to work in the US',
        app.workAuthorized === true ? 'Yes'
        : app.workAuthorized === false ? 'No'
        : 'Not answered');
    drawKV('Under 18',
        app.isUnder18 === true ? 'Yes' : app.isUnder18 === false ? 'No' : 'Not answered');
    if (app.isUnder18 === true) {
        drawKV('Under 16',
            app.isUnder16 === true ? 'Yes' : app.isUnder16 === false ? 'No' : 'Not answered');
    }

    // ── References ──────────────────────────────────────────────
    if (Array.isArray(app.references) && app.references.length) {
        drawSectionTitle('References');
        for (const r of app.references) {
            const line = `${r.name || '?'}  (${(r.relation || '').replace(/_/g, ' ') || lbl(REFERENCE_RELATIONS, r.relation)})  ${r.phone || ''}`.trim();
            drawWrapped(line);
            if (r.mayContact === false) drawWrapped('Asked not to contact.', { italic: true, color: gray, size: 9 });
        }
    }

    // ── Attribution ─────────────────────────────────────────────
    if (app.referralSource || app.referredByName) {
        drawSectionTitle('How they heard about us');
        if (app.referralSource) drawKV('Source', lbl(REFERRAL_SOURCES, app.referralSource) || app.referralSource);
        if (app.referredByName) drawKV('Referred by', app.referredByName);
    }

    // ── Languages + extras ──────────────────────────────────────
    if ((Array.isArray(app.spokenLanguages) && app.spokenLanguages.length) || app.anythingElse) {
        drawSectionTitle('Languages & extras');
        if (Array.isArray(app.spokenLanguages) && app.spokenLanguages.length) {
            drawKV('Spoken languages',
                app.spokenLanguages.map(l => lbl(LANGUAGES, l)).filter(Boolean).join(', '));
        }
        if (app.anythingElse) {
            drawText('Anything else:', { bold: true, size: 10 });
            moveDown(13);
            drawWrapped(app.anythingElse, { italic: true });
        }
    }

    // ── Consents + signature ────────────────────────────────────
    ensureSpace(220); // try to keep this block together
    drawSectionTitle('Consents & signature');
    const consentText = (ok, text) => {
        const marker = ok ? '[X] ' : '[ ] ';
        drawWrapped(marker + text);
    };
    consentText(app.contactConsent === true,
        'I agree DD Mau may text or email me about my application using the contact info I provided. Standard message and data rates may apply. Reply STOP to opt out.');
    consentText(app.truthfulnessConsent === true,
        'I certify the info I provided is true and complete to the best of my knowledge. False statements may be grounds for not hiring me or, if hired, for termination.');
    consentText(app.atWillAck === true,
        'I understand that, if hired, my employment with DD Mau is at-will — either I or DD Mau can end the employment relationship at any time, with or without cause or notice.');

    moveDown(10);
    drawText('Signature:', { bold: true, size: 10 });
    moveDown(14);

    // Try to embed the drawn signature image. If we have neither a
    // drawing nor a typed name, render a placeholder so the reviewer
    // can see the application wasn't actually signed.
    let signatureRendered = false;
    if (app.drawnSignature) {
        const bytes = dataUrlToBytes(app.drawnSignature);
        if (bytes) {
            try {
                const sigImg = await pdfDoc.embedPng(bytes);
                const targetW = Math.min(220, contentW);
                const ratio = sigImg.height / sigImg.width;
                const targetH = Math.min(70, targetW * ratio);
                ensureSpace(targetH + 6);
                page.drawImage(sigImg, {
                    x: margin, y: y - targetH + 4,
                    width: targetW, height: targetH,
                });
                moveDown(targetH + 4);
                signatureRendered = true;
            } catch (e) {
                // Fall through to typed.
                console.warn('signature PNG embed failed:', e);
            }
        }
    }
    if (!signatureRendered) {
        if (app.typedSignature) {
            drawText(`/s/  ${app.typedSignature}`,
                { italic: true, size: 14, color: black });
            moveDown(20);
        } else {
            drawText('(no signature on file)', { italic: true, color: gray });
            moveDown(14);
        }
    }
    // Underline the signature line
    page.drawLine({
        start: { x: margin, y: y + 2 },
        end:   { x: margin + 240, y: y + 2 },
        thickness: 0.5, color: black,
    });
    moveDown(12);
    drawText('Signed by ' + (app.legalName || ''), { size: 9 });
    moveDown(11);
    if (app.signedAt) {
        drawText(`Signed at: ${fmtDate(app.signedAt)}`, { size: 9, color: gray });
        moveDown(11);
    }
    drawText(`Signature method: ${app.signatureMethod === 'draw' ? 'Hand-drawn' : 'Typed name match'}`,
        { size: 9, color: gray });
    moveDown(12);

    // ── Audit footer ────────────────────────────────────────────
    moveDown(10);
    drawHr();
    drawText('Application metadata', { bold: true, size: 9, color: gray });
    moveDown(11);
    drawText(`Source: ${app.source || ''}     Status: ${app.status || ''}`,
        { size: 8, color: gray });
    moveDown(10);
    if (app.ipHash) {
        drawText(`Submitter IP hash: ${app.ipHash}`, { size: 8, color: gray });
        moveDown(10);
    }
    if (app.userAgent) {
        drawWrapped(`User-Agent: ${app.userAgent}`,
            { size: 8, color: gray, lineHeight: 10 });
    }

    return await pdfDoc.save();
}

// Save Uint8Array PDF bytes as a browser download with a friendly
// filename like "DD Mau Application - Jane Doe - 2026-05-29.pdf".
export function downloadApplicationPdf(bytes, app) {
    const safeName = (app.legalName || 'applicant').replace(/[^A-Za-z0-9 .'_-]/g, '_').trim();
    const submitted = (() => {
        try {
            const d = app.createdAt && app.createdAt.toDate
                ? app.createdAt.toDate()
                : new Date(app.createdAt || Date.now());
            return d.toISOString().slice(0, 10);
        } catch { return ''; }
    })();
    const filename = `DD Mau Application - ${safeName}${submitted ? ` - ${submitted}` : ''}.pdf`;
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
