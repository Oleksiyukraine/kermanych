// An agent's text as the phone shows it: plain text with its line breaks, fenced code blocks in
// monospace. Rendered through Vue's text interpolation only — never `v-html` — so nothing an agent
// writes can become markup on the phone that controls the computer.

export type TextPart = { kind: "text"; text: string } | { kind: "code"; lang: string; text: string };

/** Splits on ``` fences. An unclosed fence (a reply still streaming) runs to the end as code. */
export function splitFences(source: string): TextPart[] {
  const parts: TextPart[] = [];
  const lines = source.split("\n");
  let buf: string[] = [];
  let code: { lang: string } | undefined;
  const flush = () => {
    const text = buf.join("\n");
    if (code) parts.push({ kind: "code", lang: code.lang, text });
    else if (text.trim()) parts.push({ kind: "text", text: text.replace(/^\n+|\n+$/g, "") });
    buf = [];
  };
  for (const line of lines) {
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      flush();
      code = code ? undefined : { lang: fence[1].trim() };
      continue;
    }
    buf.push(line);
  }
  flush();
  return parts;
}

/** Only an inline picture the api itself built (`data:image/*;base64,…`) is shown. */
export function isInlineImage(src: string): boolean {
  return /^data:image\/(png|jpe?g|gif|webp|heic|heif);base64,/i.test(src);
}
