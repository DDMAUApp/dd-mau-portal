import { useState, useEffect } from 'react';

let deferredInstallPrompt = null;

export default function InstallAppButton({ language, compact = false }) {
    const [installable, setInstallable] = useState(!!deferredInstallPrompt);
    const [installed, setInstalled] = useState(false);
    const [showIOSGuide, setShowIOSGuide] = useState(false);

    // Detect if already installed as PWA
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

    // Detect iOS
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/.test(navigator.userAgent);

    useEffect(() => {
        const handler = () => setInstallable(true);
        window.addEventListener('pwainstallready', handler);
        return () => window.removeEventListener('pwainstallready', handler);
    }, []);

    if (isStandalone) return null; // Already running as app

    const handleInstall = async () => {
        if (deferredInstallPrompt) {
            deferredInstallPrompt.prompt();
            const result = await deferredInstallPrompt.userChoice;
            if (result.outcome === 'accepted') {
                setInstalled(true);
                deferredInstallPrompt = null;
            }
        } else if (isIOS) {
            setShowIOSGuide(true);
        }
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
                {showIOSGuide && renderIOSGuide(language, setShowIOSGuide)}
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

            {showIOSGuide && renderIOSGuide(language, setShowIOSGuide)}
        </div>
    );
}

// Shared iOS install-guide bottom sheet, used by both the full and compact
// variants. The 3-step "tap Share → Add to Home Screen → Add" walkthrough.
function renderIOSGuide(language, setShowIOSGuide) {
    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-end justify-center z-50" onClick={() => setShowIOSGuide(false)}>
            <div className="bg-white rounded-t-2xl w-full max-w-lg p-6 pb-10 animate-slide-up" onClick={e => e.stopPropagation()}>
                <div className="w-12 h-1.5 bg-gray-300 rounded-full mx-auto mb-4"></div>
                <h3 className="text-lg font-bold text-gray-800 mb-4 text-center">
                    {language === "es" ? "Instalar DD Mau" : "Install DD Mau"}
                </h3>
                <div className="space-y-4">
                    <div className="flex items-start gap-3">
                        <div className="bg-cyan-100 text-cyan-700 rounded-full w-8 h-8 flex items-center justify-center font-bold flex-shrink-0">1</div>
                        <div>
                            <p className="font-bold text-gray-700">{language === "es" ? "Toca el botón de Compartir" : "Tap the Share button"}</p>
                            <p className="text-sm text-gray-500">{language === "es" ? "El ícono de cuadrado con flecha hacia arriba en la barra inferior" : "The square with arrow icon at the bottom of Safari"}</p>
                            <div className="mt-1 text-2xl">⬆️</div>
                        </div>
                    </div>
                    <div className="flex items-start gap-3">
                        <div className="bg-cyan-100 text-cyan-700 rounded-full w-8 h-8 flex items-center justify-center font-bold flex-shrink-0">2</div>
                        <div>
                            <p className="font-bold text-gray-700">{language === "es" ? "Desplázate y toca" : "Scroll down and tap"}</p>
                            <p className="text-sm text-gray-500 font-bold">"➕ {language === "es" ? "Agregar a Inicio" : "Add to Home Screen"}"</p>
                        </div>
                    </div>
                    <div className="flex items-start gap-3">
                        <div className="bg-cyan-100 text-cyan-700 rounded-full w-8 h-8 flex items-center justify-center font-bold flex-shrink-0">3</div>
                        <div>
                            <p className="font-bold text-gray-700">{language === "es" ? "Toca \"Agregar\"" : "Tap \"Add\""}</p>
                            <p className="text-sm text-gray-500">{language === "es" ? "DD Mau aparecerá en tu pantalla de inicio como una app" : "DD Mau will appear on your home screen as an app"}</p>
                        </div>
                    </div>
                </div>
                <button
                    onClick={() => setShowIOSGuide(false)}
                    className="mt-6 w-full bg-cyan-600 text-white py-3 rounded-lg font-bold text-sm hover:bg-cyan-700 transition"
                >
                    {language === "es" ? "Entendido" : "Got it!"}
                </button>
            </div>
        </div>
    );
}
