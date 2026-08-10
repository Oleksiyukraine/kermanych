import MarkdownIt from 'markdown-it';

// One shared renderer for assistant prose and expanded reasoning.
// html:false escapes any raw HTML in the source, so the rendered output is a
// controlled tag set and is safe to inject via v-html. linkify autolinks bare
// URLs; breaks:true keeps single newlines as line breaks (chat reads better).
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

export function renderMarkdown(src: string): string {
  return md.render(src ?? '');
}

export function renderMarkdownInline(src: string): string {
  return md.renderInline(src ?? '');
}
