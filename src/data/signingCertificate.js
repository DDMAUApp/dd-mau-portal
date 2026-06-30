// signingCertificate.js — Wave 2 "DocuSign-feel + as safe" signing layer.
//
// Two things for every signed onboarding PDF:
//   1. A SHA-256 fingerprint of the signed document, recorded in Firestore, so
//      any later alteration is detectable (tamper-evidence).
//   2. A "Certificate of Completion" page appended to the PDF (signer, time,
//      fingerprint, ESIGN/UETA statement) — the page DocuSign attaches.
//
// The fingerprint is computed over the signed document BEFORE the certificate is
// appended, and that same value is printed on the certificate + stored in
// Firestore. To verify a file later: drop its last (certificate) page, re-hash,
// and compare to the stored fingerprint.

// SHA-256 of raw bytes → lowercase hex.
export async function sha256HexBytes(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const buf = await crypto.subtle.digest('SHA-256', view);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Keep certificate text WinAnsi-safe (the cert only uses ASCII, but names can
// carry accents) so drawText can never throw here.
function asciiSafe(s) {
    return String(s == null ? '' : s).replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ]/g, '');
}

// Append a Certificate of Completion page. `pdfLib` is the already-loaded pdf-lib
// module so we don't import it twice. info = { signerName, docTitle, signedAt
// (Date|ISO), contentHash, signatureCount, platform }.
export async function appendCompletionCertificate(pdfDoc, pdfLib, info) {
    const { StandardFonts, rgb } = pdfLib;
    const page = pdfDoc.addPage([612, 792]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const green = rgb(0.063, 0.451, 0.302);
    const ink = rgb(0.12, 0.12, 0.12);
    const grey = rgb(0.4, 0.4, 0.4);
    const M = 56;

    // header band
    page.drawRectangle({ x: 0, y: 740, width: 612, height: 52, color: green });
    page.drawText('Certificate of Completion', { x: M, y: 757, size: 18, font: bold, color: rgb(1, 1, 1) });

    let y = 700;
    const row = (label, value, opts = {}) => {
        const { size = 11, gap = 20, color = ink, f = font } = opts;
        page.drawText(asciiSafe(label), { x: M, y, size, font: f, color });
        if (value != null) page.drawText(asciiSafe(value), { x: M + 130, y, size, font, color });
        y -= gap;
    };

    page.drawText('DD Mau - Electronic Signature Record', { x: M, y, size: 12, font: bold, color: ink });
    y -= 30;
    const when = info.signedAt instanceof Date ? info.signedAt : new Date(info.signedAt || Date.now());
    row('Document', info.docTitle, { f: bold });
    row('Signed by', info.signerName);
    row('Signed at', when.toLocaleString());
    row('Signatures', String(info.signatureCount ?? 1));
    if (info.signId) row('Record ID', info.signId);
    row('Platform', info.platform || 'web', { gap: 30 });

    page.drawText('Document fingerprint (SHA-256)', { x: M, y, size: 11, font: bold, color: ink });
    y -= 18;
    const h = asciiSafe(info.contentHash || '');
    page.drawText(h.slice(0, 32), { x: M, y, size: 9, font, color: grey }); y -= 13;
    page.drawText(h.slice(32), { x: M, y, size: 9, font, color: grey }); y -= 30;

    const legal = [
        'This document was signed electronically and is legally binding under the U.S.',
        'ESIGN Act and the Uniform Electronic Transactions Act (UETA). The fingerprint',
        'above lets DD Mau confirm the document has not been altered since it was signed.',
    ];
    legal.forEach((ln) => { page.drawText(ln, { x: M, y, size: 9, font, color: grey }); y -= 13; });
    return pdfDoc;
}
