// V2 design system — shell preview. Mounted under ?v2=1 in App.jsx so
// you can preview it live without breaking the existing app.
//
// Architecture:
//   <AppShellV2>
//     <Sidebar />          — persistent left nav (260px desktop)
//     <Header />           — global actions strip (64px, sticky top)
//     <main>{children}</main>
//   </AppShellV2>
//
// Pure layout — no app data wiring yet. Drop screens into the {children}
// slot as we port them one by one.

import { useState } from 'react';
import Sidebar from './Sidebar';
import Header from './Header';

export default function AppShellV2({ children, language = 'en', staffName = '', activeTab = 'home', onNavigate, onExitV2 }) {
    const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer
    const [collapsed, setCollapsed] = useState(false);     // desktop rail mode

    return (
        <div className="min-h-screen bg-dd-bg text-dd-text font-sans">
            {/* Mobile drawer scrim */}
            {sidebarOpen && (
                <div
                    className="fixed inset-0 bg-black/40 z-30 md:hidden"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            <Sidebar
                language={language}
                activeTab={activeTab}
                onNavigate={(tab) => { setSidebarOpen(false); onNavigate?.(tab); }}
                open={sidebarOpen}
                collapsed={collapsed}
                onToggleCollapse={() => setCollapsed(c => !c)}
            />

            <div className={`transition-all duration-200 ${collapsed ? 'md:pl-[72px]' : 'md:pl-[260px]'}`}>
                <Header
                    language={language}
                    staffName={staffName}
                    onMenuClick={() => setSidebarOpen(true)}
                    onExitV2={onExitV2}
                />
                <main className="px-4 sm:px-6 lg:px-8 py-6">
                    <div className="max-w-[1440px] mx-auto">
                        {children}
                    </div>
                </main>
            </div>
        </div>
    );
}
