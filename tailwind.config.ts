import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: "color-mix(in srgb, var(--color-bg-primary, #0f0f10) calc(<alpha-value> * 100%), transparent)",
          secondary: "color-mix(in srgb, var(--color-bg-secondary, #161617) calc(<alpha-value> * 100%), transparent)",
          tertiary: "color-mix(in srgb, var(--color-bg-tertiary, #1c1c1e) calc(<alpha-value> * 100%), transparent)",
          elevated: "color-mix(in srgb, var(--color-bg-elevated, #232326) calc(<alpha-value> * 100%), transparent)",
          hover: "color-mix(in srgb, var(--color-bg-hover, #2a2a2e) calc(<alpha-value> * 100%), transparent)",
          border: "color-mix(in srgb, var(--color-bg-border, #2a2a2e) calc(<alpha-value> * 100%), transparent)",
        },
        line: {
          soft: "color-mix(in srgb, var(--color-line-soft, #1f1f22) calc(<alpha-value> * 100%), transparent)",
          strong: "color-mix(in srgb, var(--color-line-strong, #353539) calc(<alpha-value> * 100%), transparent)",
        },
        text: {
          primary: "color-mix(in srgb, var(--color-text-primary, #ededee) calc(<alpha-value> * 100%), transparent)",
          secondary: "color-mix(in srgb, var(--color-text-secondary, #b9b9bd) calc(<alpha-value> * 100%), transparent)",
          muted: "color-mix(in srgb, var(--color-text-muted, #a0a0aa) calc(<alpha-value> * 100%), transparent)",
          faint: "color-mix(in srgb, var(--color-text-faint, #a0a0aa) calc(<alpha-value> * 100%), transparent)",
        },
        decorative: "color-mix(in srgb, var(--color-decorative, #5e5e66) calc(<alpha-value> * 100%), transparent)",
        "control-border": "color-mix(in srgb, var(--color-control-border, #8a8a91) calc(<alpha-value> * 100%), transparent)",
        "focus-ring": "color-mix(in srgb, var(--color-focus-ring, #8db7ed) calc(<alpha-value> * 100%), transparent)",
        "on-accent": "color-mix(in srgb, var(--color-on-accent, #0f0f10) calc(<alpha-value> * 100%), transparent)",
        accent: {
          green: "color-mix(in srgb, var(--color-accent-green, #6fb89a) calc(<alpha-value> * 100%), transparent)",
          amber: "color-mix(in srgb, var(--color-accent-amber, #d4b25c) calc(<alpha-value> * 100%), transparent)",
          blue: "color-mix(in srgb, var(--color-accent-blue, #6b9ed9) calc(<alpha-value> * 100%), transparent)",
          red: "color-mix(in srgb, var(--color-accent-red, #d96565) calc(<alpha-value> * 100%), transparent)",
          purple: "color-mix(in srgb, var(--color-accent-purple, #a89ad9) calc(<alpha-value> * 100%), transparent)",
          soft: "color-mix(in srgb, var(--color-accent-soft, rgba(111,184,154,0.14)) calc(<alpha-value> * 100%), transparent)",
          line: "color-mix(in srgb, var(--color-accent-line, rgba(111,184,154,0.32)) calc(<alpha-value> * 100%), transparent)",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "Cascadia Code",
          "Fira Code",
          "Consolas",
          "monospace",
        ],
      },
      fontSize: {
        ui: ["var(--text-ui, 13px)", { lineHeight: "var(--leading-ui, 20px)" }],
        meta: ["var(--text-meta, 12px)", { lineHeight: "var(--leading-meta, 16px)" }],
        // Transcript prose — assistant turns render as a document, not a chip.
        body: ["var(--text-body, 15px)", { lineHeight: "var(--leading-body, 24px)" }],
        composer: ["var(--text-composer, 15px)", { lineHeight: "var(--leading-composer, 22px)" }],
        code: ["var(--text-code, 13px)", { lineHeight: "var(--leading-code, 20px)" }],
        "heading-1": [
          "var(--text-heading-1, 18px)",
          { lineHeight: "var(--leading-heading-1, 26px)" },
        ],
        "heading-2": [
          "var(--text-heading-2, 16px)",
          { lineHeight: "var(--leading-heading-2, 24px)" },
        ],
        "heading-3": [
          "var(--text-heading-3, 15px)",
          { lineHeight: "var(--leading-heading-3, 22px)" },
        ],
        // Composer chips & pickers.
        chip: ["var(--text-chip, 12px)", { lineHeight: "var(--leading-chip, 18px)" }],
      },
      spacing: {
        turn: "var(--space-turn, 24px)",
        "control-gap": "var(--space-control-gap, 8px)",
      },
      maxWidth: {
        chat: "var(--measure-chat, 680px)",
        composer: "var(--measure-composer, 680px)",
      },
    },
  },
  plugins: [],
} satisfies Config;
