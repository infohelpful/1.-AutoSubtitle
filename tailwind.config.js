/** @type {import('tailwindcss').Config} */
export default {
  corePlugins: {
    // Avoid resetting global Electron app styles; utilities still apply.
    preflight: false
  },
  content: ['./src/renderer/index.html', './src/renderer/**/*.{js,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'Segoe UI', 'sans-serif']
      },
      colors: {
        vrew: {
          bg: '#141518',
          panel: '#1e2128',
          border: '#2d323c',
          accent: '#3b82f6',
          accentHover: '#2563eb',
          text: '#e8eaed',
          muted: '#9ca3af'
        }
      }
    }
  },
  plugins: []
}
