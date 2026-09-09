// Typed mirror of src/tokens.css. The CSS custom properties are the runtime
// contract; this object exists for code that has to reason about a token value
// outside a stylesheet (canvas painting, generated SVG, docs). Keep both files
// in step — a value edited in one and not the other is a silent divergence.

/** Themes the token sheet ships. `dark` is the default `:root` set; `matrix`
 *  is the black + murky-green film palette entered through the digital-rain
 *  reveal (apps/ui/src/lib/matrix-rain.ts). */
export type KTheme = 'dark' | 'light' | 'matrix';

export const color = {
  dark: {
    canvas: "#050505", bg: "#141414", surface: "#1c1c1c", surface2: "#2b2b2b",
    line: "rgba(255,255,255,.08)", lineStrong: "rgba(255,255,255,.14)",
    text: "#ededed", muted: "#8a8a8a", faint: "#6b6b6b", onAccent: "#0a0a0a",
    accent: "#ff563c", accentHover: "#ff6a52",
    success: "#28c840", warning: "#febc2e", danger: "#ff5f57",
    diff: "#28c840", diffAdd: "#28c840", diffDel: "#ff5f57",
  },
  // Retuned for a light substrate, not inverted: see the rationale in tokens.css.
  light: {
    canvas: "#f6f6f7", bg: "#fbfbfc", surface: "#ffffff", surface2: "#ebebec",
    line: "rgba(0,0,0,.12)", lineStrong: "rgba(0,0,0,.18)",
    text: "#141416", muted: "#63636a", faint: "#8b8b93", onAccent: "#ffffff",
    accent: "#c8351b", accentHover: "#a82a13",
    success: "#0f7a24", warning: "#8a5d00", danger: "#c0271f",
    diff: "#0f7a24", diffAdd: "#0f7a24", diffDel: "#c0271f",
  },
  // MATRIX — black substrate, desaturated ("dirty") green foreground, one muted
  // forest-green accent (also the settled colour of the entry rain). Toned down
  // from a neon first cut that read as acid green; greens stay above the AA bar
  // the other themes hold on their darkest surface.
  matrix: {
    canvas: "#060a07", bg: "#0b120d", surface: "#111a13", surface2: "#1a271c",
    line: "rgba(110,170,130,.12)", lineStrong: "rgba(110,170,130,.20)",
    text: "#a6d0b0", muted: "#6f9a7c", faint: "#4c6d57", onAccent: "#07130c",
    accent: "#4f9d69", accentHover: "#5cae77",
    success: "#57a56f", warning: "#b8a24a", danger: "#df6a62",
    diff: "#57a56f", diffAdd: "#57a56f", diffDel: "#df6a62",
  },
} as const satisfies Record<KTheme, Record<string, string>>;

export const shadow = {
  dark: {
    pop: "0 2px 8px rgba(0,0,0,.35)",
    toast: "0 12px 32px rgba(0,0,0,.5)",
    modal: "0 24px 64px rgba(0,0,0,.6)",
  },
  light: {
    pop: "0 2px 8px rgba(0,0,0,.10)",
    toast: "0 12px 32px rgba(0,0,0,.14)",
    modal: "0 24px 64px rgba(0,0,0,.18)",
  },
  matrix: {
    pop: "0 2px 8px rgba(0,20,0,.5)",
    toast: "0 12px 32px rgba(0,25,0,.55)",
    modal: "0 24px 64px rgba(0,30,0,.6)",
  },
} as const satisfies Record<KTheme, Record<string, string>>;

export const tokens = {
  color,
  shadow,
  font: { ui: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", mono: "'JetBrains Mono', monospace" },
  fontSize: { xs: "11px", sm: "12px", base: "13px", md: "15px", lg: "18px" },
  fontWeight: { regular: 400, medium: 500, semibold: 600 },
  // Deliberately not the fontSize scale: a mark fills its box, a letter does not,
  // so every step sits above the type size it pairs with. See tokens.css.
  iconSize: { xs: "12px", sm: "14px", md: "16px", lg: "18px", xl: "20px" },
  radius: { sm: "6px", base: "8px", lg: "12px", pill: "999px" },
  space: { 1: "4px", 2: "8px", 3: "12px", 4: "16px", 5: "20px", 6: "24px", 7: "32px" },
  rule: { thin: "1px", strong: "2px" },
} as const;
export type Tokens = typeof tokens;
