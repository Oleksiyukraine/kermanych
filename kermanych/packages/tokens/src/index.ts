// Typed mirror of src/tokens.css. The CSS custom properties are the runtime
// contract; this object exists for code that has to reason about a token value
// outside a stylesheet (canvas painting, generated SVG, docs). Keep both files
// in step — a value edited in one and not the other is a silent divergence.

/** Themes the token sheet ships. `dark` is the default `:root` set; `matrix`
 *  is the black + murky-green film palette entered through the digital-rain
 *  reveal (apps/ui/src/lib/matrix-rain.ts); `hermes` is the graphite-blue +
 *  cyan palette of Hermes Agent by Nous Research. */
export type KTheme = 'dark' | 'light' | 'matrix' | 'hermes';

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
  // MATRIX — black substrate, near-white green-tinted foreground, one soft
  // grey-green accent (also the settled colour of the entry rain). Toned down
  // twice from a neon first cut; body text is lifted close to white (but never
  // pure white, which glares on this near-black surface).
  matrix: {
    canvas: "#070c08", bg: "#0d150f", surface: "#141e17", surface2: "#1f2d22",
    line: "rgba(150,185,160,.10)", lineStrong: "rgba(150,185,160,.16)",
    text: "#d7e3db", muted: "#9db3a5", faint: "#6b7e73", onAccent: "#08130c",
    accent: "#63a079", accentHover: "#72ad87",
    success: "#63a077", warning: "#b0a565", danger: "#d47a72",
    diff: "#63a077", diffAdd: "#63a077", diffDel: "#d47a72",
  },
  // HERMES — graphite-blue substrate, blue-violet neutrals, one calm cyan accent
  // (the brand's #00f2f2 toned down for small text). See tokens.css.
  hermes: {
    canvas: "#0a0c11", bg: "#10131a", surface: "#161a23", surface2: "#202633",
    line: "rgba(150,165,210,.09)", lineStrong: "rgba(150,165,210,.15)",
    text: "#e6e9f0", muted: "#8d93a8", faint: "#646a80", onAccent: "#04161a",
    accent: "#4fd1e0", accentHover: "#6edbe8",
    success: "#3ecf8e", warning: "#e8c35a", danger: "#f0716b",
    diff: "#3ecf8e", diffAdd: "#3ecf8e", diffDel: "#f0716b",
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
  hermes: {
    pop: "0 2px 8px rgba(2,4,12,.45)",
    toast: "0 12px 32px rgba(2,4,12,.55)",
    modal: "0 24px 64px rgba(2,4,12,.65)",
  },
} as const satisfies Record<KTheme, Record<string, string>>;

// Depth: sheen, raise overlay, card shadows, primary fill, focus glow — the
// `--k-sheen` … `--k-glow-focus` tokens of tokens.css, one set per theme.
export const depth = {
  dark: {
    sheen: "inset 0 1px 0 rgba(255,255,255,.04)",
    gradRaise: "linear-gradient(180deg,rgba(255,255,255,.025),rgba(255,255,255,0) 70%)",
    shadowCard: "0 1px 2px rgba(0,0,0,.25)",
    shadowCardHover: "0 4px 14px rgba(0,0,0,.35)",
    gradAccent: "linear-gradient(180deg,#ff644c,#ff563c)",
    glowFocus: "0 0 0 3px rgba(255,86,60,.18)",
  },
  light: {
    sheen: "inset 0 1px 0 rgba(255,255,255,.8)",
    gradRaise: "linear-gradient(180deg,rgba(255,255,255,.6),rgba(255,255,255,0) 70%)",
    shadowCard: "0 1px 2px rgba(0,0,0,.05)",
    shadowCardHover: "0 4px 14px rgba(0,0,0,.08)",
    gradAccent: "linear-gradient(180deg,#cc452d,#c8351b)",
    glowFocus: "0 0 0 3px rgba(200,53,27,.16)",
  },
  matrix: {
    sheen: "inset 0 1px 0 rgba(180,220,190,.05)",
    gradRaise: "linear-gradient(180deg,rgba(150,200,165,.03),rgba(150,200,165,0) 70%)",
    shadowCard: "0 1px 2px rgba(0,20,0,.35)",
    shadowCardHover: "0 4px 14px rgba(0,25,0,.45)",
    gradAccent: "linear-gradient(180deg,#6fa884,#63a079)",
    glowFocus: "0 0 0 3px rgba(99,160,121,.2)",
  },
  hermes: {
    sheen: "inset 0 1px 0 rgba(170,190,240,.06)",
    gradRaise: "linear-gradient(180deg,rgba(140,170,240,.035),rgba(140,170,240,0) 70%)",
    shadowCard: "0 1px 2px rgba(2,4,12,.35)",
    shadowCardHover: "0 6px 18px rgba(2,4,12,.5)",
    gradAccent: "linear-gradient(180deg,#5dd5e2,#4fd1e0)",
    glowFocus: "0 0 0 3px rgba(79,209,224,.2)",
  },
} as const satisfies Record<KTheme, Record<string, string>>;

export const tokens = {
  color,
  shadow,
  depth,
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
