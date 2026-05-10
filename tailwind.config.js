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
      },
      fontFamily: {
        // System-first stack with Inter as the preferred face if the
        // browser has it. No external font fetch (keeps PWA install snappy).
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'sans-serif'],
      },
      borderRadius: {
        'xl2': '14px',
      },
      boxShadow: {
        'card':     '0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06)',
        'card-hov': '0 4px 12px rgba(15, 23, 42, 0.08), 0 2px 4px rgba(15, 23, 42, 0.04)',
      },
    }
  },
  plugins: [],
}
