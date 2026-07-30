// ── AdminHub ──────────────────────────────────────────────────────
// 2026-07-29 — Andrew: "lets make each tab more of a button so we can
// fit 3-4 buttons per row. organize the buttons into categories so
// make navigating easier." The admin page's long stack of collapsible
// section rows is now a hub: category groups, each a 3-per-row (4 on
// sm+) grid of compact glass tiles. Tapping a tile tells AdminPanel
// to show ONLY that tool full-width (activeTool state up there); this
// file is purely presentational — which tools exist, their badges,
// permission gating, and what a tap does all stay in AdminPanel.
//
// Tile anatomy mirrors the iOS-Settings model already used by
// glass-section-head: identity lives in the tinted .glass-icon-tile
// squircle (44px — also satisfies the minimum touch target on its
// own; the whole tile is ~90px tall anyway), label under it.

/**
 * Sticky header row shown above an opened tool: [← back] [emoji + name].
 * -mx-4 bleeds it across AdminPanel's p-4 gutter so the frosted strip
 * spans the full viewport width while content stays aligned.
 */
export function AdminToolHeader({ emoji, tint, label, backLabel, onBack }) {
    return (
        <div className="sticky top-0 z-30 -mx-4 px-4 py-2 mb-3"
            style={{
                // Frosted strip so tool content scrolling under it stays
                // readable — same material recipe as .glass-section-head.
                backgroundColor: 'rgba(248, 250, 252, 0.82)',
                backdropFilter: 'blur(16px) saturate(160%)',
                WebkitBackdropFilter: 'blur(16px) saturate(160%)',
                borderBottom: '1px solid rgba(15, 23, 42, 0.08)',
            }}>
            <div className="flex items-center gap-3 min-w-0">
                <button type="button" onClick={onBack}
                    className="glass-button-apple shrink-0 px-3 py-2.5 text-sm font-bold min-h-[44px]">
                    ← {backLabel}
                </button>
                <span className={`glass-icon-tile ${tint || 'tint-slate'}`} aria-hidden="true">{emoji}</span>
                <h2 className="font-bold text-[15px] text-dd-text truncate">{label}</h2>
            </div>
        </div>
    );
}

/**
 * The hub itself. `groups` = [{ id, emoji, title, tools }] where each
 * tool = { id, emoji, tint, label, badge?, onOpen }. Rendering order is
 * the array order — AdminPanel owns the category taxonomy.
 */
export default function AdminHub({ groups }) {
    return (
        <div className="space-y-5">
            {groups.map(group => (
                group.tools.length > 0 && (
                    <section key={group.id}>
                        <h3 className="flex items-center gap-2 px-1 mb-2 font-bold text-[13px] text-dd-text-2 uppercase tracking-wide">
                            <span aria-hidden="true">{group.emoji}</span>
                            {group.title}
                        </h3>
                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                            {group.tools.map(tool => (
                                <button key={tool.id} type="button" onClick={tool.onOpen}
                                    className="glass-card relative flex flex-col items-center justify-center gap-1.5 px-1 pt-3 pb-2.5 min-h-[88px] text-center transition-transform duration-glass-fast ease-glass-out hover:bg-white/85 active:scale-[0.96]">
                                    <span className={`glass-icon-tile ${tool.tint || 'tint-slate'}`} aria-hidden="true">{tool.emoji}</span>
                                    <span className="text-[11px] font-bold text-dd-text leading-tight">{tool.label}</span>
                                    {/* Count badge — only when the parent already has the
                                        number in state (no subscriptions exist just for
                                        badges; see AdminPanel's hub wiring). */}
                                    {(tool.badge || 0) > 0 && (
                                        <span className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center shadow"
                                            aria-label={`${tool.badge}`}>
                                            {tool.badge > 99 ? '99+' : tool.badge}
                                        </span>
                                    )}
                                </button>
                            ))}
                        </div>
                    </section>
                )
            ))}
        </div>
    );
}
