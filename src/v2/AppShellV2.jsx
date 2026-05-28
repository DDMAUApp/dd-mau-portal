// V2 design system — shell.
//
// Architecture:
//   <AppShellV2>
//     <Sidebar />            — desktop only (md+). Mobile uses bottom nav.
//     <Header />             — global actions strip (sticky top, slim on mobile)
//     <main>{children}</main>
//     <MobileBottomNav />    — mobile only (<md). 5-tab fixed bottom bar.
//   </AppShellV2>
//
// Mobile UX rationale:
//   - Restaurant staff use this app one-handed during a rush. Bottom nav
//     keeps primary destinations within thumb reach. Hamburger drawers
//     require two taps and pull focus away from work.
//   - Header on mobile drops the search bar + location pill (those go in
//     the More drawer) so the productive area starts higher up.
//   - main content gets pb-bottom-nav so the last row clears the fixed
//     bottom nav AND the iPhone home indicator.

import { useState } from 'react';
import Sidebar from './Sidebar';
import Header from './Header';
import MobileBottomNav from './MobileBottomNav';
import NotificationsDrawer from './NotificationsDrawer';
import { AppDataProvider } from './AppDataContext';

export default function AppShellV2({
    children,
    language = 'en',
    staffName = '',
    storeLocation = 'webster',
    activeTab = 'home',
    onNavigate,
    hasOpsAccess = true,
    hasRecipesAccess = true,
    hasOnboardingAccess = false,
    isAdmin = false,
    isManager = false,
    hiddenPages = [],
    staffList = [],
    setStaffList,
    onLogout,
    onForceRefresh,
    onLanguageToggle,
    onLocationChange,
    onBellClick,
}) {
    const [sidebarOpen, setSidebarOpen] = useState(false); // mobile "More" drawer
    const [collapsed, setCollapsed] = useState(false);     // desktop rail mode
    const [notifOpen, setNotifOpen] = useState(false);     // cross-app notifications drawer

    return (
        <AppDataProvider staffName={staffName} storeLocation={storeLocation}>
        {/* 2026-05-27 — Phase 2 redesign. The flat bg-dd-sage backdrop
            became a soft sage-to-bone gradient — the canvas that the
            Liquid-Glass surfaces (Header, Sidebar, page cards) sit on
            top of. Subtle enough not to distract during a rush, but
            enough texture that the frosted glass surfaces have
            something to refract against.
            On dark mode (prefers-color-scheme: dark) the body bg in
            index.css overrides to #0a0a0a so this gradient is hidden
            and the whole app reads as the chat-style near-black. */}
        {/* 2026-05-27 Batch A — the inline `style={background: ...}`
            gradient moved into `.ddmau-app-backdrop` in index.css.
            The new rule is a refined Apple-style three-stop gradient
            with a soft radial top-light. JSX stays clean and the
            backdrop can be tuned in CSS without touching this file
            again. */}
        <div className="ddmau-app-backdrop min-h-screen text-dd-text font-sans">
            {/* Mobile drawer scrim — only opens when "More" is tapped */}
            {sidebarOpen && (
                <div
                    className="fixed inset-0 bg-black/40 z-30 md:hidden"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            <Sidebar
                language={language}
                staffName={staffName}
                storeLocation={storeLocation}
                activeTab={activeTab}
                onNavigate={(tab) => { setSidebarOpen(false); onNavigate?.(tab); }}
                open={sidebarOpen}
                collapsed={collapsed}
                onToggleCollapse={() => setCollapsed(c => !c)}
                isAdmin={isAdmin}
                isManager={isManager}
                hasOpsAccess={hasOpsAccess}
                hasRecipesAccess={hasRecipesAccess}
                hasOnboardingAccess={hasOnboardingAccess}
                hiddenPages={hiddenPages}
                onLogout={() => { setSidebarOpen(false); onLogout?.(); }}
                onForceRefresh={() => { setSidebarOpen(false); onForceRefresh?.(); }}
                onLanguageToggle={() => onLanguageToggle?.()}
            />

            <div className={`transition-all duration-200 ${collapsed ? 'md:pl-[72px]' : 'md:pl-[260px]'}`}>
                <Header
                    language={language}
                    staffName={staffName}
                    storeLocation={storeLocation}
                    staffList={staffList}
                    setStaffList={setStaffList}
                    onMenuClick={() => setSidebarOpen(true)}
                    onLanguageToggle={onLanguageToggle}
                    onLogout={onLogout}
                    onLocationChange={onLocationChange}
                    /* Prefer the local drawer; fall back to parent's
                       onBellClick (Schedule jump) only if no drawer wanted. */
                    onBellClick={() => setNotifOpen(true)}
                    /* activeTab + onNavigate let Header swap the mobile
                       location-toggle for a back arrow when the user
                       is on the chat tab (2026-05-27). */
                    activeTab={activeTab}
                    onNavigate={onNavigate}
                />
                {/* Mobile gets pb-bottom-nav so the bottom tab bar doesn't cover
                    the last row of content. Desktop has no bottom bar so the
                    extra padding is dropped via md:pb-6. Vertical padding on
                    mobile is tightened from py-6 → py-3 so productive content
                    starts higher on small screens. */}
                <main className="px-4 sm:px-6 lg:px-8 py-3 md:py-6 pb-bottom-nav md:pb-6">
                    <div className="max-w-[1440px] mx-auto">
                        {children}
                    </div>
                </main>
            </div>

            {/* Cross-app notifications drawer — opens via the header bell.
                Subscribes to /notifications where forStaff == staffName.
                staffList + setStaffList passed through so the drawer's
                "🔄 Refresh" button can call enableFcmPush to mint a
                fresh FCM token directly from the bell menu. */}
            <NotificationsDrawer
                open={notifOpen}
                onClose={() => setNotifOpen(false)}
                staffName={staffName}
                language={language}
                onNavigate={(tab) => onNavigate?.(tab)}
                staffList={staffList}
                setStaffList={setStaffList}
            />

            {/* Mobile bottom nav — fixed, hidden on md+ */}
            <MobileBottomNav
                language={language}
                activeTab={activeTab}
                onNavigate={(tab) => onNavigate?.(tab)}
                onMoreClick={() => setSidebarOpen(true)}
                storeLocation={storeLocation}
                staffName={staffName}
                hasOpsAccess={hasOpsAccess}
                hasRecipesAccess={hasRecipesAccess}
                hiddenPages={hiddenPages}
            />
        </div>
        </AppDataProvider>
    );
}
