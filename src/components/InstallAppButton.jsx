import { useState, useEffect, lazy, Suspense } from 'react';
import ModalPortal from './ModalPortal';

// Lazy-load the full install splash (IOSSteps / AndroidSteps / DesktopHint).
// 2026-05-24: lock-screen Install button used to do nothing on platforms
// without the deferredInstallPrompt event AND that weren't iOS (most
// notably desktop Chrome/Safari, plus Android Chrome that hadn't yet
// fired beforeinstallprompt). The button now routes through the same
// add-to-home-screen guide reached via the NFC-sticker install URL,
// so EVERY tap shows OS-appropriate steps. Splash is rendered inline
// in a fixed overlay so we don't leave the lock screen.
const InstallSplash = lazy(() => import('./InstallSplash'));

let deferredInstallPrompt = null;

export default function InstallAppButton({ language, compact = false }) {
    const [installable, setInstallable] = useState(!!deferredInstallPrompt);
    const [installed, setInstalled] = useState(false);
    const [showInstallGuide, setShowInstallGuide] = useState(false);

    // Detect if already installed as PWA
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

    useEffect(() => {
        const handler = () => setInstallable(true);
        window.addEventListener('pwainstallready', handler);
        return () => window.removeEventListener('pwainstallready', handler);
    }, []);

    if (isStandalone) return null; // Already running as app

    const handleInstall = async () => {
        if (deferredInstallPrompt) {
            // Native Android Chrome / desktop Chrome prompt available —
            // use it for the smoothest experience.
            deferredInstallPrompt.prompt();
            const result = await deferredInstallPrompt.userChoice;
            if (result.outcome === 'accepted') {
                setInstalled(true);
                deferredInstallPrompt = null;
            }
            return;
        }
        // No native prompt — fall back to the platform-aware guide.
        // This is what 2026-05-24 fixed: previously on iOS we showed
        // an iOS-only modal here, and on every other platform the tap
        // was a no-op. Now we always open the full guide which
        // detects platform and shows the right steps (iOS Share->Add,
        // Android Chrome menu->Install, desktop tip).
        setShowInstallGuide(true);
    };

    if (installed) {
        return (
            <div className="p-4 bg-gradient-to-br from-green-50 to-green-100 border-2 border-green-300 rounded-lg text-center">
                <div className="text-3xl mb-2">✅</div>
                <div className="font-bold text-green-700">{language === "es" ? "App Instalada" : "App Installed!"}</div>
                <div className="text-xs text-green-600">{language === "es" ? "Busca DD Mau en tu pantalla de inicio" : "Find DD Mau on your home screen"}</div>
            </div>
        );
    }

    // Compact variant — a slim chip-style button (one line, no big icon).
    // Used on the lock screen as a secondary action below the larger
    // "Apply here" CTA. Set compact={true} from the parent.
    if (compact) {
        return (
            <div>
                <button
                    onClick={handleInstall}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-cyan-50 border border-cyan-200 rounded-full text-[12px] font-semibold text-cyan-700 hover:bg-cyan-100 transition"
                >
                    <span className="text-base leading-none">📲</span>
                    <span>{language === "es" ? "Instalar app" : "Install app"}</span>
                </button>
                {showInstallGuide && (
                    <InstallGuideOverlay
                        language={language}
                        onClose={() => setShowInstallGuide(false)}
                    />
                )}
            </div>
        );
    }
    return (
        <div>
            <button
                onClick={handleInstall}
                className="w-full p-4 bg-gradient-to-br from-cyan-50 to-cyan-100 border-2 border-cyan-300 rounded-lg hover:shadow-lg transition text-left"
            >
                <div className="text-3xl mb-2">📲</div>
                <div className="font-bold text-cyan-700">{language === "es" ? "Descargar App" : "Download App"}</div>
                <div className="text-xs text-cyan-600">
                    {language === "es"
                        ? "Instala DD Mau en tu teléfono para acceso rápido"
                        : "Install DD Mau on your phone for quick access"}
                </div>
            </button>

            {showInstallGuide && (
                <InstallGuideOverlay
                    language={language}
                    onClose={() => setShowInstallGuide(false)}
                />
            )}
        </div>
    );
}

// InstallGuideOverlay — full-viewport scrollable overlay that wraps
// the existing InstallSplash component. Same content as the page reached
// via the NFC sticker URL (?install=1), rendered as a modal overlay so
// the lock screen stays in the stack underneath. InstallSplash already
// handles platform detection and language; we just supply onSkip to
// dismiss the overlay.
function InstallGuideOverlay({ language, onClose }) {
    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 bg-white overflow-y-auto" role="dialog" aria-modal="true">
            <Suspense fallback={
                <div className="min-h-screen flex items-center justify-center text-sm text-dd-text-2">
                    {language === 'es' ? 'Cargando…' : 'Loading…'}
                </div>
            }>
                <InstallSplash language={language} onSkip={onClose} />
            </Suspense>
        </div>
        </ModalPortal>
    );
}

// Legacy iOS-only bottom-sheet (kept here for posterity; replaced by the
// InstallGuideOverlay above which reuses the full platform-aware
// InstallSplash component). Safe to delete once the lock-screen install
// flow has been live for a release without issues.
