import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot } from 'firebase/firestore';
import { t } from '../data/translations';
import { LOCATION_LABELS } from '../data/staff';

// Convert 24h time "14:30" to "2:30pm"
function formatTime(t24) {
    if (!t24) return '';
    const [h, m] = t24.split(':').map(Number);
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return m === 0 ? `${h12}${ampm}` : `${h12}:${m.toString().padStart(2, '0')}${ampm}`;
}

// Format date key "2026-04-20" to "Sunday, Apr 20"
function formatDateLabel(dateKey) {
    const [y, mo, d] = dateKey.split('-').map(Number);
    const dt = new Date(y, mo - 1, d);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${days[dt.getDay()]}, ${months[dt.getMonth()]} ${d}`;
}

// Check if a date is today
function isToday(dateKey) {
    const now = new Date();
    const [y, mo, d] = dateKey.split('-').map(Number);
    return now.getFullYear() === y && now.getMonth() === mo - 1 && now.getDate() === d;
}

export default function Schedule({ staffName, language, storeLocation, staffList }) {
    const [scheduleData, setScheduleData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        const unsub = onSnapshot(
            doc(db, 'ops', 'schedule'),
            (snap) => {
                if (snap.exists()) {
                    setScheduleData(snap.data());
                    setError(null);
                } else {
                    setError('no-data');
                }
                setLoading(false);
            },
            (err) => {
                console.error('Schedule fetch error:', err);
                setError('fetch-error');
                setLoading(false);
            }
        );
        return () => unsub();
    }, []);

    if (loading) {
        return (
            <div className="p-4 pb-24 text-center">
                <div className="animate-pulse mt-12">
                    <div className="text-4xl mb-4">📅</div>
                    <p className="text-gray-500">{language === 'es' ? 'Cargando horario...' : 'Loading schedule...'}</p>
                </div>
            </div>
        );
    }

    if (error || !scheduleData) {
        return (
            <div className="p-4 pb-24 text-center">
                <div className="mt-12">
                    <div className="text-4xl mb-4">📅</div>
                    <p className="text-gray-500">{language === 'es' ? 'Horario no disponible' : 'Schedule not available'}</p>
                </div>
            </div>
        );
    }

    const { weekStart, weekEnd, schedule, updatedAt } = scheduleData;

    // Build sorted list of date keys for the week
    const dateKeys = Object.keys(schedule || {}).sort();

    // Format week label: "Apr 20 - Apr 26, 2026"
    const formatWeekLabel = () => {
        if (!weekStart || !weekEnd) return '';
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const [sy, sm, sd] = weekStart.split('-').map(Number);
        const [ey, em, ed] = weekEnd.split('-').map(Number);
        return `${months[sm - 1]} ${sd} - ${months[em - 1]} ${ed}, ${ey}`;
    };

    // Format last updated time
    const formatUpdated = () => {
        if (!updatedAt) return '';
        try {
            const dt = new Date(updatedAt);
            const now = new Date();
            const diffMin = Math.floor((now - dt) / 60000);
            if (diffMin < 1) return language === 'es' ? 'Justo ahora' : 'Just now';
            if (diffMin < 60) return language === 'es' ? `Hace ${diffMin} min` : `${diffMin}m ago`;
            const diffHr = Math.floor(diffMin / 60);
            if (diffHr < 24) return language === 'es' ? `Hace ${diffHr}h` : `${diffHr}h ago`;
            return dt.toLocaleDateString();
        } catch { return ''; }
    };

    // Find the current staff member's shifts for the "My Shifts" summary
    const myShifts = [];
    for (const dk of dateKeys) {
        const dayShifts = (schedule[dk] || []).filter(s => s.name === staffName);
        for (const s of dayShifts) {
            myShifts.push({ dateKey: dk, ...s });
        }
    }

    return (
        <div className="p-4 pb-24">
            {/* Header */}
            <div className="flex items-center justify-between mb-1">
                <h2 className="text-2xl font-bold text-mint-700">
                    {language === 'es' ? 'Horario Semanal' : 'Weekly Schedule'}
                </h2>
                <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full font-bold">
                    LIVE
                </span>
            </div>
            <p className="text-gray-600 text-sm mb-1">
                {formatWeekLabel()} — <span className="font-bold text-mint-700">{LOCATION_LABELS[storeLocation]}</span>
            </p>
            <p className="text-xs text-gray-400 mb-4">
                {language === 'es' ? 'Actualizado' : 'Updated'}: {formatUpdated()}
            </p>

            {/* My Shifts Card */}
            {staffName && myShifts.length > 0 && (
                <div className="mb-5 bg-gradient-to-r from-green-50 to-mint-50 border-2 border-green-600 rounded-xl p-4">
                    <h3 className="font-bold text-green-700 text-sm mb-2">
                        {language === 'es' ? 'Mis Turnos Esta Semana' : 'My Shifts This Week'}
                    </h3>
                    <div className="space-y-1">
                        {myShifts.map((s, i) => (
                            <div key={i} className="flex justify-between items-center">
                                <span className="text-sm font-medium text-gray-700">
                                    {formatDateLabel(s.dateKey).split(',')[0]}
                                </span>
                                <span className="text-sm font-bold text-green-700">
                                    {formatTime(s.start)} - {formatTime(s.end)}
                                </span>
                            </div>
                        ))}
                    </div>
                    <p className="text-xs text-green-600 mt-2 font-medium">
                        {myShifts.length} {language === 'es' ? 'turnos' : myShifts.length === 1 ? 'shift' : 'shifts'}
                    </p>
                </div>
            )}

            {/* Daily Schedule Cards */}
            <div className="space-y-4">
                {dateKeys.map((dk) => {
                    const dayShifts = schedule[dk] || [];
                    const today = isToday(dk);

                    return (
                        <div key={dk} className={`bg-white rounded-lg border-2 overflow-hidden ${today ? 'border-mint-600 shadow-lg' : 'border-gray-200'}`}>
                            {/* Day Header */}
                            <div className={`p-3 border-b ${today ? 'bg-gradient-to-r from-mint-600 to-mint-500 text-white' : 'bg-gradient-to-r from-mint-50 to-white'}`}>
                                <div className="flex items-center justify-between">
                                    <h3 className={`font-bold text-lg ${today ? 'text-white' : 'text-mint-700'}`}>
                                        {formatDateLabel(dk)}
                                    </h3>
                                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${today ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'}`}>
                                        {dayShifts.length} {language === 'es' ? 'personas' : 'staff'}
                                    </span>
                                </div>
                                {today && (
                                    <p className="text-xs text-mint-100 mt-0.5">
                                        {language === 'es' ? 'Hoy' : 'Today'}
                                    </p>
                                )}
                            </div>

                            {/* Shifts */}
                            <div className="p-3 space-y-2">
                                {dayShifts.length === 0 && (
                                    <p className="text-gray-400 text-sm text-center py-3">
                                        {language === 'es' ? 'Sin turnos programados' : 'No shifts scheduled'}
                                    </p>
                                )}
                                {dayShifts.map((shift, idx) => {
                                    const isMe = shift.name === staffName;
                                    return (
                                        <div
                                            key={idx}
                                            className={`flex items-center justify-between p-3 rounded-lg ${isMe ? 'bg-green-50 border-2 border-green-600' : 'bg-gray-50 border border-gray-200'}`}
                                        >
                                            <div className="flex items-center gap-2 min-w-0">
                                                {isMe && <span className="text-green-600 text-xs font-bold flex-shrink-0">You</span>}
                                                <p className={`font-medium truncate ${isMe ? 'text-green-700' : 'text-gray-800'}`}>
                                                    {shift.name}
                                                </p>
                                            </div>
                                            <p className={`text-sm font-bold flex-shrink-0 ml-2 ${isMe ? 'text-green-700' : 'text-mint-700'}`}>
                                                {formatTime(shift.start)} - {formatTime(shift.end)}
                                            </p>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>

            {dateKeys.length === 0 && (
                <div className="text-center mt-8">
                    <p className="text-4xl mb-3">📅</p>
                    <p className="text-gray-500">{language === 'es' ? 'No hay turnos esta semana' : 'No shifts this week'}</p>
                </div>
            )}
        </div>
    );
}
