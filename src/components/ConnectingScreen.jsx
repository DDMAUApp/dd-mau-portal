import { useEffect, useState } from 'react';

export const CONNECTING_GO_HOME_MS = 10000;

// Shown instead of Home while the roster hasn't answered and this person's access
// to the tab they're on can't be told. The button keeps a device with nothing
// saved from being trapped here.
export default function ConnectingScreen({ language, onGoHome }) {
    const [showHome, setShowHome] = useState(false);
    useEffect(() => {
        const id = setTimeout(() => setShowHome(true), CONNECTING_GO_HOME_MS);
        return () => clearTimeout(id);
    }, []);
    const isEs = language === 'es';
    return (
        <div role="status" data-testid="connecting-screen" className="text-center py-16 px-4 space-y-4">
            <p className="text-base font-bold text-dd-text">{isEs ? 'Conectando…' : 'Connecting…'}</p>
            {showHome && (
                <button type="button" onClick={onGoHome}
                    className="px-4 py-2 rounded-xl text-sm font-bold bg-white border border-dd-line text-dd-text active:scale-95">
                    {isEs ? 'Ir al inicio' : 'Go Home'}
                </button>
            )}
        </div>
    );
}
