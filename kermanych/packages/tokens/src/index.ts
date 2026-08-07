export const tokens = {
  color: {
    canvas: "#12110f", bg: "#1b1a19", surface: "#232120", surface2: "#2b2927",
    line: "#3a3735", lineStrong: "#4a4644", text: "#f3f2f2", muted: "#8f8b88",
    accent: "#ff563c", diff: "#3fb950",
  },
  font: { ui: "'Archivo', -apple-system, sans-serif", mono: "'JetBrains Mono', monospace" },
  rule: { thin: "1px", strong: "2px" },
} as const;
export type Tokens = typeof tokens;
