// PageShell — Apple-HIG-aligned page-header primitive (Batch B,
// 2026-05-27). Additive: pages that adopt this get a uniform title +
// subtitle + actions strip with the new typography + spacing tokens.
// Pages that don't adopt it keep working exactly as before.
//
// Three exports:
//   <PageHeader title subtitle actions icon /> — the strip itself
//   <PageShell title subtitle actions icon>{body}</PageShell> — strip
//     + body wrapper (sets the standard vertical rhythm)
//   <SectionHeader title subtitle action /> — secondary section title
//     for use INSIDE a page (smaller scale than the top PageHeader)
//
// Design choices:
//   • Title uses .text-title-1 (28px, -0.02em, 800) — Apple's "Large
//     Title" rendered in our Inter face. Big and confident; sets the
//     page's visual anchor.
//   • Optional icon disc sits to the left of the title in a glass-tinted
//     square (matches the tile-icon pattern in MobileHome). Drop the
//     `icon` prop and the title takes the full leading position.
//   • Actions float to the right and wrap to a second row on phone
//     widths so a long title + many actions don't overflow horizontally.
//   • Subtitle uses .text-footnote-md (13px) in dd-text-2 — the calm
//     muted line under the title that gives context without competing.

import { useMemo } from 'react';

/**
 * Page-header strip. Use as the first child of a page body.
 *
 * @param {object} props
 * @param {string} props.title - The page title (rendered at .text-title-1).
 * @param {string} [props.subtitle] - Optional one-line description.
 * @param {React.ReactNode} [props.actions] - Buttons / pills / toggles
 *   anchored to the right side of the header. Wraps below the title on
 *   narrow screens.
 * @param {React.ComponentType} [props.icon] - Lucide component (NOT a
 *   string). Rendered inside a glass disc to the left of the title.
 * @param {string} [props.iconTint] - "green" (default) | "neutral" |
 *   "amber" | "danger" — tints the icon disc background.
 */
export function PageHeader({ title, subtitle, actions, icon: Icon, iconTint = 'green' }) {
    const tintCls = useMemo(() => {
        switch (iconTint) {
            case 'amber':   return 'bg-amber-50 text-amber-700 border-amber-200';
            case 'danger':  return 'bg-red-50 text-red-700 border-red-200';
            case 'neutral': return 'bg-white/60 text-dd-text-2 border-glass-border-light';
            case 'green':
            default:        return 'bg-dd-green-50 text-dd-green-700 border-dd-green/20';
        }
    }, [iconTint]);
    return (
        <header className="glass-page-header">
            <div className="min-w-0 flex items-center gap-3">
                {Icon && (
                    <div className={`shrink-0 w-11 h-11 rounded-glass-lg border flex items-center justify-center backdrop-blur-glass-subtle ${tintCls}`}>
                        <Icon size={22} strokeWidth={2.25} aria-hidden="true" />
                    </div>
                )}
                <div className="min-w-0">
                    <h1 className="glass-page-header__title text-title-1">
                        {title}
                    </h1>
                    {subtitle && (
                        <p className="glass-page-header__subtitle">
                            {subtitle}
                        </p>
                    )}
                </div>
            </div>
            {actions && (
                <div className="glass-page-header__actions">{actions}</div>
            )}
        </header>
    );
}

/**
 * Convenience wrapper. Renders <PageHeader> on top and lays out the
 * page body underneath with the standard vertical rhythm.
 *
 * Use when a page wants both the header + the standard body container
 * in one component. Otherwise import <PageHeader> directly and lay
 * out the body manually.
 */
export default function PageShell({ title, subtitle, actions, icon, iconTint, children }) {
    return (
        <div className="space-y-5">
            <PageHeader
                title={title}
                subtitle={subtitle}
                actions={actions}
                icon={icon}
                iconTint={iconTint}
            />
            {children}
        </div>
    );
}

/**
 * Secondary section title — for h2-style headings INSIDE a page body.
 * Visually quieter than <PageHeader> so the page's primary title still
 * dominates. Mirrors HomeV2's existing SectionHeader pattern but
 * exported here so any page can use it.
 */
export function SectionHeader({ title, subtitle, action }) {
    return (
        <div className="flex items-end justify-between mb-3 gap-2">
            <div className="min-w-0">
                <h2 className="text-title-3 text-dd-text">{title}</h2>
                {subtitle && <p className="text-caption-md text-dd-text-2 mt-0.5">{subtitle}</p>}
            </div>
            {action && <div className="shrink-0">{action}</div>}
        </div>
    );
}
