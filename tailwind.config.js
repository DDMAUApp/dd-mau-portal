/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx}",
  ],
  theme: {
    extend: {
      colors: {
        mint: {
          50: '#f0f7f1',
          100: '#d9ecdb',
          200: '#b8dbbe',
          300: '#8ec49a',
          400: '#5fa872',
          500: '#3d8b54',
          600: '#2d7042',
          700: '#255a37',
          800: '#1f472d',
          900: '#1a3b26',
        },
        charcoal: {
          DEFAULT: '#2B2E35',
          light: '#3a3d44',
        },
        // ── v2 design system tokens ────────────────────────────────────
        // Brand-anchored palette derived from PMS 7730 C (primary deep
        // green) + PMS 621 C (light sage accent). Used by the redesigned
        // shell under ?v2=1. Keep `mint` palette intact so the existing
        // app keeps rendering during the migration.
        dd: {
          green:        '#1F7A4D',  // PMS 7730 C — primary CTA, brand
          'green-700':  '#185E3A',  // hover/pressed state
          'green-50':   '#E6F0EA',  // soft success / hover wash
          sage:         '#C9DBC9',  // PMS 621 C — accent
          'sage-50':    '#EEF5EF',  // tint
          charcoal:     '#0F172A',  // sidebar background
          'charcoal-2': '#1E2536',  // sidebar hover/dividers
          bg:           '#F7F8FA',  // page background
          surface:      '#FFFFFF',
          line:         '#E5E7EB',
          text:         '#0F172A',
          'text-2':     '#64748B',
          danger:       '#DC2626',
          warn:         '#F59E0B',
          info:         '#2563EB',
        },
        // ── Glass design system (Phase 1 — 2026-05-27) ─────────────
        // Inspired by Apple's Liquid Glass / iOS materials. Two modes
        // share every token except surface fill:
        //   light glass → translucent white over a soft sage backdrop
        //   dark glass  → solid iOS dark gray over near-black backdrop
        // The chat surface already uses the dark variant via inline
        // hex values; this codifies the same colors as theme tokens
        // so the rest of the app can adopt them progressively. dd-*
        // tokens above are untouched — components opt-in to glass by
        // using the new .glass-* classes declared in index.css.
        glass: {
          'bg-light':       '#F3F5F1',                       // soft sage backdrop
          'bg-dark':        '#0a0a0a',                       // chat-style backdrop
          'surface-light':  'rgba(255, 255, 255, 0.72)',     // light elevated chrome
          'surface-strong': 'rgba(255, 255, 255, 0.88)',     // less translucent variant (inputs, dense content)
          'surface-dark':   '#1c1c1e',                       // dark elevated chrome (matches iOS)
          'surface-dark-2': '#2a2a2c',                       // dark hover state
          'border-light':   'rgba(15, 23, 42, 0.08)',
          'border-dark':    'rgba(255, 255, 255, 0.08)',
          'tint-light':     'rgba(255, 255, 255, 0.40)',     // soft press-state wash on light
          'tint-dark':      'rgba(255, 255, 255, 0.06)',     // soft press-state wash on dark
          scrim:            'rgba(15, 23, 42, 0.42)',        // modal backdrop scrim
        },
      },
      fontFamily: {
        // System-first stack with Inter as the preferred face if the
        // browser has it. No external font fetch (keeps PWA install snappy).
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'sans-serif'],
      },
      borderRadius: {
        'xl2': '14px',
        // Glass radius scale — matches iOS / iPadOS conventions.
        //   sm  → chips, badges
        //   md  → inline pills, tag buttons
        //   lg  → standard cards
        //   xl  → page-level panels
        //   2xl → full-screen sheets / modals
        'glass-sm':  '8px',
        'glass-md':  '12px',
        'glass-lg':  '16px',
        'glass-xl':  '20px',
        'glass-2xl': '28px',
      },
      boxShadow: {
        'card':     '0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06)',
        'card-hov': '0 4px 12px rgba(15, 23, 42, 0.08), 0 2px 4px rgba(15, 23, 42, 0.04)',
        // Glass shadow stack — soft, layered, never heavy. Pair with a
        // hairline border for the full elevated-card effect. Each step
        // ~doubles the spread of the one below; pick the lightest one
        // that reads as elevated against its background.
        'glass-sm':       '0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 1px rgba(15, 23, 42, 0.04)',
        'glass-md':       '0 4px 12px rgba(15, 23, 42, 0.06), 0 1px 3px rgba(15, 23, 42, 0.04)',
        'glass-lg':       '0 8px 24px rgba(15, 23, 42, 0.08), 0 2px 6px rgba(15, 23, 42, 0.06)',
        'glass-floating': '0 12px 32px rgba(15, 23, 42, 0.12), 0 4px 12px rgba(15, 23, 42, 0.08)',
        // Subtle top-light specular for the glassy look. Stack on top
        // of one of the layered shadows above when you want the card
        // to feel like a piece of physical glass catching light.
        'glass-inset':    'inset 0 1px 0 rgba(255, 255, 255, 0.6)',
      },
      backdropBlur: {
        'glass-subtle': '12px',
        'glass-medium': '20px',
        'glass-heavy':  '32px',
      },
      transitionTimingFunction: {
        // iOS-style spring-out. Use for press states and panel
        // transitions; falls back to ease-out elsewhere.
        'glass-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      transitionDuration: {
        'glass-fast':   '120ms',
        'glass-normal': '200ms',
        'glass-slow':   '360ms',
      },
      // 2026-05-24 — slide-up entry for the chat composer attach drawer.
      // Subtle 6px translate so the drawer feels like it rises from the
      // textarea rather than appearing out of nowhere.
      keyframes: {
        'slide-up': {
          '0%':   { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)'   },
        },
      },
      animation: {
        'slide-up': 'slide-up 180ms ease-out',
      },
    }
  },
  plugins: [],
}
