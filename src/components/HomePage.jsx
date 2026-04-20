import { useState } from 'react';
import { t } from '../data/translations';
import InstallAppButton from './InstallAppButton';

export default function HomePage({ onSelectStaff, language, staffList }) {
    const [pin, setPin] = useState("");
    const [error, setError] = useState("");

    const handlePinSubmit = () => {
        const match = staffList.find(s => s.pin === pin);
        if (match) {
            onSelectStaff(match.name);
        } else {
            setError(language === "es" ? "PIN incorrecto" : "Incorrect PIN");
            setPin("");
        }
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-mint-50 to-white p-4">
            <div className="text-center mb-8">
                <h1 className="text-5xl font-bold mb-2">🍜</h1>
                <h1 className="text-4xl font-bold text-mint-700 mb-2">DD Mau</h1>
                <p className="text-gray-600 text-lg">{t("staffPortal", language)}</p>
            </div>
            <p className="text-gray-500 text-sm mb-4">{language === "es" ? "Ingresa tu PIN" : "Enter your PIN"}</p>
            <div className="flex gap-2 mb-3">
                {[0,1,2,3].map(i => (
                    <div key={i} className={"w-12 h-14 rounded-lg border-2 flex items-center justify-center text-2xl font-bold " +
                        (pin.length > i ? "border-mint-400 bg-mint-50 text-mint-700" : "border-gray-200 bg-white text-gray-300")}>
                        {pin.length > i ? "●" : ""}
                    </div>
                ))}
            </div>
            {error && <p className="text-red-500 text-xs mb-2">{error}</p>}
            <div className="grid grid-cols-3 gap-2 w-60 mt-2">
                {[1,2,3,4,5,6,7,8,9].map(n => (
                    <button key={n} onClick={() => { setError(""); if (pin.length < 4) setPin(pin + n); }}
                        className="h-14 rounded-lg bg-white border border-gray-200 text-xl font-semibold text-gray-700 hover:bg-mint-50 hover:border-mint-200 active:bg-mint-100 transition">
                        {n}
                    </button>
                ))}
                <button onClick={() => setPin("")}
                    className="h-14 rounded-lg bg-gray-100 border border-gray-200 text-sm font-medium text-gray-500 hover:bg-gray-200 transition">
                    {language === "es" ? "Borrar" : "Clear"}
                </button>
                <button onClick={() => { setError(""); if (pin.length < 4) setPin(pin + "0"); }}
                    className="h-14 rounded-lg bg-white border border-gray-200 text-xl font-semibold text-gray-700 hover:bg-mint-50 hover:border-mint-200 active:bg-mint-100 transition">
                    0
                </button>
                <button onClick={handlePinSubmit}
                    className={"h-14 rounded-lg text-sm font-bold transition " +
                        (pin.length === 4 ? "bg-mint-700 text-white hover:bg-mint-700" : "bg-gray-100 text-gray-400 border border-gray-200")}>
                    OK
                </button>
            </div>
            <InstallAppButton language={language} />
        </div>
    );
}
