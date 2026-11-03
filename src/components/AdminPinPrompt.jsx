// AdminPinPrompt — re-confirm a sensitive admin action with an OWNER PIN
// (Andrew or Julie). First use: putting a staff member into test mode
// (Andrew 2026-11-03: "requires an admin pin again so we don't accidentally
// put staff into test mode").
import { useState } from 'react';
import ModalPortal from './ModalPortal';
import { isOwnerPin } from '../data/staff';

export default function AdminPinPrompt({ title, message, confirmLabel, staffList, language = 'en', onConfirm, onCancel }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [pin, setPin] = useState('');
    const [error, setError] = useState('');

    const submit = () => {
        if (isOwnerPin(pin, staffList)) {
            setPin('');
            onConfirm();
        } else {
            setError(tx('Wrong admin PIN', 'PIN de administrador incorrecto'));
            setPin('');
        }
    };

    return (
        <ModalPortal onBackPress={onCancel}>
            <div className="fixed inset-0 bg-black/60 z-[90] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onCancel}>
                <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
                    <h3 className="text-base font-bold text-gray-900">🔐 {title}</h3>
                    {message && <p className="text-xs text-gray-600 leading-snug">{message}</p>}
                    <input
                        type="password"
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={4}
                        autoFocus
                        aria-label={tx('Admin PIN', 'PIN de administrador')}
                        value={pin}
                        onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setError(''); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                        className="w-full border border-gray-300 rounded px-3 py-2 text-center text-xl tracking-widest"
                        placeholder="••••"
                    />
                    {error && <p className="text-xs text-red-600 text-center">{error}</p>}
                    <div className="flex gap-2">
                        <button type="button" onClick={onCancel}
                            className="flex-1 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-bold">
                            {tx('Cancel', 'Cancelar')}
                        </button>
                        <button type="button" onClick={submit} disabled={pin.length !== 4}
                            className="flex-1 py-2 rounded-lg bg-amber-600 text-white text-sm font-bold disabled:opacity-40">
                            {confirmLabel || tx('Confirm', 'Confirmar')}
                        </button>
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
}
