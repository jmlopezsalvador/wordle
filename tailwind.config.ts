import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        background: "#f8fafc",
        card: "#ffffff",
        accent: "#0ea5e9",
        ink: "#0f172a",
        muted: "#64748b"
      }
    }
  },
  plugins: []
};

export default config;
