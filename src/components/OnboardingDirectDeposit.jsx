// OnboardingDirectDeposit — structured form for the direct-deposit doc.
//
// Replaces the previous template-PDF approach where admin uploaded a PDF
// form and the hire typed into floating overlays. Problems with that
// approach:
//   - PDF form fields varied per template — every bank has a different
//     form, no consistent UX
//   - Typing routing/account numbers into tiny overlays was error-prone
//   - No validation (ABA checksum, length checks)
//   - Voided check ended up being the source of truth, not the form
//
// This form captures structured data + validates routing number via
// ABA checksum + requires re-typing the account number to catch typos.
// On submit:
//   1. Generate a clean DD Mau-branded PDF (bankName, account type,
//      routing, account, deposit type, signature, date) for the
//      payroll system.
//   2. Upload to onboarding/{hireId}/direct_deposit/signed_{ts}.pdf.
//   3. Save a SANITIZED version (last 4 of account # only) to
//      hire.directDeposit so admin can see "Bank of America ✓✓✓✓1234"
//      in the dashboard without exposing the full number.
//
// The voided_check doc is still required separately as verification —
// admin compares its routing/account to what the hire typed.

import { useState, useEffect } from 'react';
import { db, storage } from '../firebase';
import { doc, updateDoc } from 'firebase/firestore';
import { ref as sref, uploadBytes } from 'firebase/storage';

async function loadPdfLib() { return await import('pdf-lib'); }

// ABA routing number checksum — 9 digits. The weighted sum
//   3*d0 + 7*d1 + 1*d2 + 3*d3 + 7*d4 + 1*d5 + 3*d6 + 7*d7 + 1*d8
// must be divisible by 10. Catches single-digit typos + most
// transpositions in the 9-digit string.
function isValidRoutingNumber(raw) {
    if (!raw) return false;
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length !== 9) return false;
    const w = [3,7,1,3,7,1,3,7,1];
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(digits[i], 10) * w[i];
    return sum % 10 === 0 && sum > 0;
}

export default function OnboardingDirectDeposit({
    docDef, hire, hireId, isEs, isLocked, onSubmitted, onStart,
}) {
    const tx = (en, es) => (isEs ? es : en);
    const [bankName, setBankName] = useState('');
    const [routingNumber, setRoutingNumber] = useState('');
    const [accountNumber, setAccountNumber] = useState('');
    const [accountNumberConfirm, setAccountNumberConfirm] = useState('');
    const [accountType, setAccountType] = useState('checking');
    const [depositType, setDepositType] = useState('full');
    const [partialAmount, setPartialAmount] = useState('');
    const [partialUnit, setPartialUnit] = useState('dollar'); // 'dollar' | 'percent'
    const [authConfirmed, setAuthConfirmed] = useState(false);
    const [typedSignature, setTypedSignature] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [err, setErr] = useState('');

    const docStatus = (hire?.checklist && hire.checklist[docDef.id] && hire.checklist[docDef.id].status) || 'needed';
    const wasSubmitted = docStatus === 'submitted' || docStatus === 'approved';
    const [showSubmitted, setShowSubmitted] = useState(wasSubmitted);

    // Pre-fill from hire's previously-submitted DD record (admin may
    // have unlocked them to update bank info). We only re-load the
    // non-sensitive parts since the full account # was never stored
    // in Firestore — that's by design.
    useEffect(() => {
        if (hire?.directDeposit) {
            setBankName(hire.directDeposit.bankName || '');
            setAccountType(hire.directDeposit.accountType || 'checking');
            setDepositType(hire.directDeposit.depositType || 'full');
        }
    }, [hire?.directDeposit]);

    const legalName = hire?.personal?.legalName || hire?.name || '';
    const routingOk = isValidRoutingNumber(routingNumber);
    const accountOk = accountNumber.replace(/\D/g, '').length >= 4 &&
                      accountNumber.replace(/\D/g, '').length <= 17;
    const accountMatches = accountNumber === accountNumberConfirm;
    const partialOk = depositType === 'full' ||
                      (partialAmount && Number(partialAmount) > 0 &&
                       (partialUnit === 'dollar' || Number(partialAmount) <= 100));
    const sigOk = typedSignature.trim().length > 1 &&
                  typedSignature.trim().toLowerCase() === legalName.trim().toLowerCase();
    const canSubmit = bankName.trim().length > 1 && routingOk && accountOk &&
                      accountMatches && partialOk && authConfirmed && sigOk && !submitting;

    const onAnyChange = () => {
        if (typeof onStart === 'function' && !wasSubmitted) onStart();
    };

    const submit = async () => {
        if (!canSubmit) return;
        setSubmitting(true);
        setErr('');
        try {
            // 1. Generate the signed PDF.
            const pdfLib = await loadPdfLib();
            const { PDFDocument, StandardFonts, rgb } = pdfLib;
            const pdfDoc = await PDFDocument.create();
            const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
            const PAGE_W = 612, PAGE_H = 792;
            const MARGIN = 60;
            const black = rgb(0, 0, 0);
            const gray = rgb(0.4, 0.4, 0.4);
            const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
            let y = PAGE_H - MARGIN;

            const writeLine = (text, fnt, size, color = black) => {
                page.drawText(String(text), { x: MARGIN, y, size, font: fnt, color });
                y -= size + 6;
            };

            writeLine('DD Mau', fontBold, 16);
            writeLine('Direct Deposit Authorization', fontBold, 13);
            y -= 8;
            writeLine(`Employee: ${legalName}`, font, 11);
            writeLine(`Date: ${new Date().toLocaleDateString('en-US')}`, font, 11);
            y -= 12;
            writeLine('BANK INFORMATION', fontBold, 11);
            y -= 2;
            writeLine(`Bank: ${bankName}`, font, 11);
            writeLine(`Account type: ${accountType === 'checking' ? 'Checking' : 'Savings'}`, font, 11);
            writeLine(`Routing number: ${routingNumber}`, font, 11);
            writeLine(`Account number: ${accountNumber}`, font, 11);
            y -= 12;
            writeLine('DEPOSIT INSTRUCTION', fontBold, 11);
            y -= 2;
            if (depositType === 'full') {
                writeLine('Deposit my entire net pay into this account.', font, 11);
            } else {
                const unit = partialUnit === 'dollar' ? '$' : '%';
                const prefix = partialUnit === 'dollar' ? '$' : '';
                const suffix = partialUnit === 'percent' ? '%' : '';
                writeLine(`Deposit ${prefix}${partialAmount}${suffix} of my net pay into this account; the remainder is paid by check.`, font, 11);
            }
            y -= 18;
            writeLine('AUTHORIZATION', fontBold, 11);
            y -= 2;
            const auth = [
                'I authorize DD Mau to deposit my pay into the account listed above.',
                'I understand DD Mau may reverse erroneous deposits.',
                'This authorization stays in effect until I provide written notice of cancellation.',
            ];
            for (const line of auth) writeLine(line, font, 10);
            y -= 16;
            writeLine('— SIGNATURE —', fontBold, 10);
            writeLine(`Signed by: ${typedSignature.trim()}`, font, 11);
            writeLine(`Date / time: ${new Date().toLocaleString('en-US')}`, font, 10);
            writeLine(`User agent: ${(navigator.userAgent || '').slice(0, 120)}`, font, 9, gray);

            const outBytes = await pdfDoc.save();
            const ts = Date.now();
            const path = `onboarding/${hireId}/direct_deposit/signed_${ts}.pdf`;
            await uploadBytes(sref(storage, path), new Blob([outBytes], { type: 'application/pdf' }), { contentType: 'application/pdf' });

            // 2. Save sanitized metadata on hire record so admin sees
            //    "Bank: BofA · ****1234" without the full account #
            //    sitting in Firestore.
            const digitsOnly = accountNumber.replace(/\D/g, '');
            const last4 = digitsOnly.slice(-4);
            await updateDoc(doc(db, 'onboarding_hires', hireId), {
                directDeposit: {
                    bankName: bankName.trim(),
                    accountType,
                    accountLast4: last4,
                    routingNumberLast4: routingNumber.slice(-4),
                    depositType,
                    partialAmount: depositType === 'full' ? null : Number(partialAmount),
                    partialUnit: depositType === 'full' ? null : partialUnit,
                    signedAt: new Date().toISOString(),
                    storagePath: path,
                },
            });

            onSubmitted?.();
            setShowSubmitted(true);
        } catch (e) {
            console.error('direct deposit submit failed', e);
            setErr(tx('Submit failed: ', 'Falló: ') + (e.message || e));
        } finally {
            setSubmitting(false);
        }
    };

    if (showSubmitted || isLocked) {
        const dd = hire?.directDeposit;
        return (
            <div className="space-y-2">
                <div className="p-4 rounded-xl bg-green-50 border-2 border-green-300 text-center">
                    <p className="text-3xl mb-1">{isLocked ? '🔒' : '✓'}</p>
                    <p className="font-black text-green-800 text-sm">
                        {isLocked
                            ? tx('Locked', 'Bloqueado')
                            : tx('Direct deposit set up', 'Depósito directo listo')}
                    </p>
                    {dd && !isLocked && (
                        <p className="text-[11px] text-green-700 mt-1">
                            {dd.bankName} · {dd.accountType === 'checking' ? tx('Checking', 'Corriente') : tx('Savings', 'Ahorros')} · ****{dd.accountLast4}
                        </p>
                    )}
                    {isLocked && (
                        <p className="text-[11px] text-green-700 mt-1">
                            {tx('Ask your manager to unlock to update bank info.',
                                'Pídele al gerente que desbloquee para actualizar el banco.')}
                        </p>
                    )}
                </div>
                {!isLocked && (
                    <button onClick={() => {
                        setShowSubmitted(false);
                        setAccountNumber('');
                        setAccountNumberConfirm('');
                        setTypedSignature('');
                        setAuthConfirmed(false);
                        setErr('');
                    }}
                        className="w-full py-2.5 rounded-xl bg-white border-2 border-dd-green text-dd-green-700 font-bold text-sm hover:bg-dd-sage-50 active:scale-95">
                        ✏️ {tx('Update bank info', 'Actualizar info bancaria')}
                    </button>
                )}
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {wasSubmitted && (
                <div className="p-2 rounded-lg bg-amber-50 border-2 border-amber-300 text-[12px] text-amber-900">
                    <p className="font-bold">✏️ {tx('Updating your direct deposit', 'Actualizando tu depósito directo')}</p>
                    <p className="text-[11px] mt-0.5">
                        {tx('Re-type the account number — we don\'t store the full number in our system. Don\'t forget to also upload a new voided check.',
                            'Vuelve a escribir el número de cuenta — no guardamos el número completo. No olvides subir un nuevo cheque cancelado.')}
                    </p>
                </div>
            )}

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-2.5 text-[12px] text-blue-900">
                <p className="font-bold">💡 {tx('Where to find these numbers', '¿Dónde encontrar estos números?')}</p>
                <p className="text-[11px] mt-0.5">
                    {tx('On a personal check: the 9-digit ROUTING is the first number at the bottom left. The ACCOUNT is the second number. You can also find them in your bank app under "Account details."',
                        'En un cheque: el RUTEO de 9 dígitos es el primer número abajo a la izquierda. La CUENTA es el segundo número. También en tu app bancaria bajo "Detalles de cuenta".')}
                </p>
            </div>

            <div>
                <label className="block text-[11px] font-bold uppercase text-gray-600 mb-1">
                    {tx('Bank name', 'Nombre del banco')}
                    <span className="text-red-500 ml-0.5">*</span>
                </label>
                <input value={bankName} onChange={e => { setBankName(e.target.value); onAnyChange(); }}
                    placeholder={tx('e.g. Bank of America', 'ej: Bank of America')} maxLength={60}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-dd-green focus:outline-none focus:ring-2 focus:ring-dd-green/30" />
            </div>

            <div>
                <label className="block text-[11px] font-bold uppercase text-gray-600 mb-1">
                    {tx('Account type', 'Tipo de cuenta')}
                    <span className="text-red-500 ml-0.5">*</span>
                </label>
                <div className="flex gap-2">
                    {[
                        { id: 'checking', en: 'Checking', es: 'Corriente' },
                        { id: 'savings',  en: 'Savings',  es: 'Ahorros' },
                    ].map(o => (
                        <button key={o.id} type="button"
                            onClick={() => { setAccountType(o.id); onAnyChange(); }}
                            className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-bold transition active:scale-95 ${
                                accountType === o.id
                                    ? 'bg-dd-sage-50 border-dd-green text-dd-green-700'
                                    : 'bg-white border-gray-300 text-gray-700'
                            }`}>
                            {isEs ? o.es : o.en}
                        </button>
                    ))}
                </div>
            </div>

            <div>
                <label className="block text-[11px] font-bold uppercase text-gray-600 mb-1">
                    {tx('Routing number (9 digits)', 'Número de ruteo (9 dígitos)')}
                    <span className="text-red-500 ml-0.5">*</span>
                </label>
                <input value={routingNumber}
                    onChange={e => { setRoutingNumber(e.target.value.replace(/\D/g, '').slice(0, 9)); onAnyChange(); }}
                    inputMode="numeric" placeholder="123456789" maxLength={9}
                    className={`w-full border-2 rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 ${
                        routingNumber.length === 9
                            ? (routingOk ? 'border-green-500 focus:ring-green-500/30' : 'border-red-500 focus:ring-red-500/30')
                            : 'border-gray-300 focus:ring-dd-green/30 focus:border-dd-green'
                    }`} />
                {routingNumber.length === 9 && !routingOk && (
                    <p className="text-[11px] text-red-600 mt-1">
                        ⚠ {tx('This doesn\'t look like a valid routing number. Double-check the 9 digits.',
                            'No parece un ruteo válido. Verifica los 9 dígitos.')}
                    </p>
                )}
            </div>

            <div>
                <label className="block text-[11px] font-bold uppercase text-gray-600 mb-1">
                    {tx('Account number', 'Número de cuenta')}
                    <span className="text-red-500 ml-0.5">*</span>
                </label>
                <input value={accountNumber}
                    onChange={e => { setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 17)); onAnyChange(); }}
                    inputMode="numeric" placeholder="000123456789" maxLength={17} autoComplete="off"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm font-mono focus:border-dd-green focus:outline-none focus:ring-2 focus:ring-dd-green/30" />
            </div>

            <div>
                <label className="block text-[11px] font-bold uppercase text-gray-600 mb-1">
                    {tx('Confirm account number', 'Confirma cuenta')}
                    <span className="text-red-500 ml-0.5">*</span>
                </label>
                <input value={accountNumberConfirm}
                    onChange={e => { setAccountNumberConfirm(e.target.value.replace(/\D/g, '').slice(0, 17)); onAnyChange(); }}
                    inputMode="numeric" placeholder={tx('Re-type to confirm', 'Vuelve a escribir')} maxLength={17} autoComplete="off"
                    className={`w-full border-2 rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 ${
                        accountNumberConfirm
                            ? (accountMatches ? 'border-green-500 focus:ring-green-500/30' : 'border-red-500 focus:ring-red-500/30')
                            : 'border-gray-300 focus:ring-dd-green/30 focus:border-dd-green'
                    }`} />
                {accountNumberConfirm && !accountMatches && (
                    <p className="text-[11px] text-red-600 mt-1">
                        ⚠ {tx('Doesn\'t match. Re-type carefully.', 'No coincide. Escribe con cuidado.')}
                    </p>
                )}
            </div>

            <div>
                <label className="block text-[11px] font-bold uppercase text-gray-600 mb-1">
                    {tx('Deposit type', 'Tipo de depósito')}
                </label>
                <div className="space-y-1.5">
                    <button type="button" onClick={() => { setDepositType('full'); onAnyChange(); }}
                        className={`w-full text-left px-3 py-2.5 rounded-xl border-2 text-sm font-semibold transition ${
                            depositType === 'full'
                                ? 'bg-dd-sage-50 border-dd-green text-dd-green-700'
                                : 'bg-white border-gray-300 text-gray-700'
                        }`}>
                        {tx('Deposit my entire paycheck into this account', 'Depositar todo mi cheque en esta cuenta')}
                    </button>
                    <button type="button" onClick={() => { setDepositType('partial'); onAnyChange(); }}
                        className={`w-full text-left px-3 py-2.5 rounded-xl border-2 text-sm font-semibold transition ${
                            depositType === 'partial'
                                ? 'bg-dd-sage-50 border-dd-green text-dd-green-700'
                                : 'bg-white border-gray-300 text-gray-700'
                        }`}>
                        {tx('Deposit a portion (rest paid by check)', 'Depositar una parte (resto en cheque)')}
                    </button>
                </div>
                {depositType === 'partial' && (
                    <div className="mt-2 flex gap-2 items-center">
                        <span className="text-sm text-gray-500">{partialUnit === 'dollar' ? '$' : ''}</span>
                        <input value={partialAmount}
                            onChange={e => { setPartialAmount(e.target.value.replace(/[^0-9.]/g, '')); onAnyChange(); }}
                            placeholder="200"
                            inputMode="decimal"
                            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                        <select value={partialUnit} onChange={e => setPartialUnit(e.target.value)}
                            className="border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white">
                            <option value="dollar">{tx('$ per pay', '$ por pago')}</option>
                            <option value="percent">% {tx('of pay', 'del pago')}</option>
                        </select>
                    </div>
                )}
            </div>

            <label className="flex items-start gap-2 cursor-pointer p-2 hover:bg-gray-50 rounded-lg">
                <input type="checkbox" checked={authConfirmed}
                    onChange={e => { setAuthConfirmed(e.target.checked); onAnyChange(); }}
                    className="mt-0.5 w-5 h-5 accent-dd-green flex-shrink-0" />
                <span className="text-[12px] text-gray-700 leading-snug">
                    {tx(
                        'I authorize DD Mau to deposit my pay into the account above. I understand DD Mau may reverse any erroneous deposits. This authorization stays in effect until I cancel it in writing.',
                        'Autorizo a DD Mau a depositar mi pago en la cuenta de arriba. Entiendo que DD Mau puede revertir depósitos erróneos. Esta autorización permanece hasta que la cancele por escrito.',
                    )}
                </span>
            </label>

            <div>
                <label className="block text-[11px] font-bold uppercase text-gray-600 mb-1">
                    {tx('Signature — type your full legal name', 'Firma — escribe tu nombre legal completo')}
                    <span className="text-red-500 ml-0.5">*</span>
                </label>
                <input value={typedSignature} onChange={e => { setTypedSignature(e.target.value); onAnyChange(); }}
                    placeholder={legalName || tx('Your legal name', 'Tu nombre legal')}
                    maxLength={80} autoComplete="off"
                    className={`w-full border-2 rounded-lg px-3 py-3 text-sm font-bold italic ${
                        sigOk ? 'border-green-500 bg-green-50' :
                        typedSignature ? 'border-amber-500 bg-amber-50' :
                        'border-gray-300'
                    }`} />
                {typedSignature && !sigOk && (
                    <p className="text-[11px] text-amber-700 mt-1">
                        {tx('Must match your legal name exactly:', 'Debe coincidir exactamente:')} {legalName}
                    </p>
                )}
            </div>

            {err && <p className="text-xs text-red-600">{err}</p>}
            <button onClick={submit} disabled={!canSubmit}
                className="w-full py-3 rounded-xl bg-dd-green text-white font-bold text-sm disabled:opacity-50 active:scale-95">
                {submitting
                    ? tx('Generating signed form…', 'Generando formulario firmado…')
                    : tx('✓ Sign + submit direct deposit', '✓ Firmar y enviar depósito directo')}
            </button>
        </div>
    );
}
