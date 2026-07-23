import { IOS_APP_URL, ANDROID_APP_URL, ANDROID_JOIN_URL } from './InstallAppButton';

// Full-screen post-login gate for PHONE browsers (2026-07-12, Andrew:
// "whoever is still using the web app version on next login, send them to
// the download page"). Phones must use the native app — it gets push
// notifications, instant OTA updates, and never hits stale-web issues.
// Desktop/laptop browsers are NOT gated (App.jsx only renders this for
// phone user agents), TVs never log in, and the public apply/onboarding
// links return before the gate.
export default function DownloadAppGate({ language, staffName, onSignOut }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    return (
        <div className="min-h-screen bg-dd-bg flex items-center justify-center p-5"
            style={{ paddingTop: 'calc(env(safe-area-inset-top) + 1.25rem)', paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)' }}>
            <div className="glass-card w-full max-w-sm p-6 text-center">
                <div className="text-5xl mb-3">📲</div>
                <h1 className="text-xl font-bold text-dd-text mb-1">
                    {tx('Time to switch to the app!', '¡Es hora de cambiar a la app!')}
                </h1>
                <p className="text-sm text-dd-text-2 mb-1">
                    {tx(`Hi ${staffName?.split(' ')[0] || ''}! The DD Mau app replaced the phone website.`,
                        `¡Hola ${staffName?.split(' ')[0] || ''}! La app de DD Mau reemplazó el sitio web en el teléfono.`)}
                </p>
                <p className="text-sm text-dd-text-2 mb-5">
                    {tx('Install it to see your schedule, chat, and get shift reminders.',
                        'Instálala para ver tu horario, el chat y recibir recordatorios de turnos.')}
                </p>
                <div className="space-y-3">
                    <a href={IOS_APP_URL} target="_blank" rel="noopener noreferrer"
                        className="w-full flex items-center gap-3 px-4 py-4 rounded-2xl bg-white border border-dd-line shadow-sm active:scale-95 transition">
                        <span className="text-3xl">📱</span>
                        <div className="text-left flex-1">
                            <div className="font-bold text-dd-text">iPhone</div>
                            <div className="text-xs text-dd-text-2">{tx('Open the App Store', 'Abrir el App Store')}</div>
                        </div>
                        <span className="text-dd-text-2">›</span>
                    </a>
                    <a href={ANDROID_APP_URL} target="_blank" rel="noopener noreferrer"
                        className="w-full flex items-center gap-3 px-4 py-4 rounded-2xl bg-white border border-dd-line shadow-sm active:scale-95 transition">
                        <span className="text-3xl">🤖</span>
                        <div className="text-left flex-1">
                            <div className="font-bold text-dd-text">Android</div>
                            <div className="text-xs text-dd-text-2">{tx('Become a tester, then install', 'Conviértete en probador e instala')}</div>
                        </div>
                        <span className="text-dd-text-2">›</span>
                    </a>
                </div>
                <p className="text-[11px] text-dd-text-2 mt-4">
                    {tx('Android: ask a manager to add your Google email to the tester list first. If Play says “not available,” ',
                        'Android: pide a un gerente que agregue tu correo de Google a la lista de probadores primero. Si Play dice “no disponible”, ')}
                    <a href={ANDROID_JOIN_URL} target="_blank" rel="noopener noreferrer" className="underline text-cyan-700 font-semibold">
                        {tx('join the test here', 'únete a la prueba aquí')}
                    </a>.
                </p>
                <button onClick={onSignOut}
                    className="mt-5 text-xs text-dd-text-2 underline underline-offset-2">
                    {tx('Sign out', 'Cerrar sesión')}
                </button>
            </div>
        </div>
    );
}
