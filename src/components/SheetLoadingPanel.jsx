import { useEffect, useState } from 'react';
import { sheetText } from '../data/sheetGate';

export const SHEET_SLOW_MS = 15000;

// Takes the place of the whole inventory sheet until a snapshot has landed, so no
// count, add or reset control exists while the numbers on screen wouldn't be real.
export default function SheetLoadingPanel({ language, onGoHome }) {
    const [slow, setSlow] = useState(false);
    useEffect(() => {
        const id = setTimeout(() => setSlow(true), SHEET_SLOW_MS);
        return () => clearTimeout(id);
    }, []);
    const text = sheetText(language);
    return (
        <div role="status" data-testid="sheet-loading" className="text-center py-12 px-4 space-y-3">
            <p className="text-base font-bold text-dd-text">{text.loading}</p>
            {slow && <p className="text-sm text-dd-text-2">{text.slow}</p>}
            {slow && onGoHome && (
                <button type="button" onClick={onGoHome}
                    className="px-4 py-2 rounded-xl text-sm font-bold bg-white border border-dd-line text-dd-text active:scale-95">
                    {text.home}
                </button>
            )}
        </div>
    );
}
