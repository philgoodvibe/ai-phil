/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        sage: {
          coral: "#e74c3c",
          blue: "#3498db",
          navy: "#1d3855",
          gold: "#fdd043",
          beige: "#fad7a0",
          orange: "#f58659",
          teal: "#7aa5a5",
          medium: "#4682b5",
        },
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
};
