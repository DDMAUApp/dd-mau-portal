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
        }
      }
    }
  },
  plugins: [],
}
