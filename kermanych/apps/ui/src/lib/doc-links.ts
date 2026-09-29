// Documentation links on the Project Documentation screen: a pasted URL becomes a stored
// http(s) link, and a stored link becomes what the screen draws — a provider badge, a host,
// and the URL its iframe loads.
//
// The iframe URL is not always the pasted one. The page a person copies from their address
// bar (a Google Doc's /edit, a YouTube /watch, a Figma /design) is usually the one its host
// refuses to have framed or renders as a full editor; each provider publishes a separate
// embed form for exactly this, and that form is what the preview loads. «Open in browser»
// always opens the stored URL, never the embed form.

export type DocLinkProvider =
  | 'google-docs'
  | 'google-sheets'
  | 'google-slides'
  | 'google-drawings'
  | 'google-forms'
  | 'google-drive'
  | 'figma'
  | 'youtube'
  | 'loom'
  | 'miro'
  | 'notion'
  | 'claude'
  | 'github'
  | 'web';

export type DocLinkView = {
  provider: DocLinkProvider;
  // Brand name for a known provider, the bare host otherwise.
  label: string;
  host: string;
  embedUrl: string;
};

const MAX_URL = 2048; // mirrors the workspace_doc_links.url check

// What the person typed → the URL to store, or null when it cannot be a web link. A bare
// «docs.google.com/…» gets https:// (people paste without the scheme); any other scheme —
// javascript:, file:, data:, mailto: — is refused rather than guessed at, because the value
// ends up in an iframe src and in the OS «open» call.
export function parseDocLinkUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  let candidate = s;
  if (!/^https?:\/\//i.test(s)) {
    // `host:port/…` looks like a scheme to the regex below, so a scheme is only a scheme when
    // it is not followed by digits.
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return null;
    candidate = `https://${s}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname !== 'localhost' && !url.hostname.includes('.')) return null;
  return url.href.length <= MAX_URL ? url.href : null;
}

const GOOGLE_EDITORS: Record<string, { provider: DocLinkProvider; label: string }> = {
  document: { provider: 'google-docs', label: 'Google Docs' },
  spreadsheets: { provider: 'google-sheets', label: 'Google Sheets' },
  presentation: { provider: 'google-slides', label: 'Google Slides' },
  drawings: { provider: 'google-drawings', label: 'Google Drawings' },
};

export function describeDocLink(stored: string): DocLinkView {
  let url: URL;
  try {
    url = new URL(stored);
  } catch {
    return { provider: 'web', label: stored, host: stored, embedUrl: stored };
  }
  const host = url.hostname.replace(/^www\./, '');
  const path = url.pathname;
  const view = (provider: DocLinkProvider, label: string, embedUrl = stored): DocLinkView => ({ provider, label, host, embedUrl });

  if (host === 'docs.google.com') {
    const forms = /^\/forms\/(?:u\/\d+\/)?d\/(e\/)?([\w-]+)/.exec(path);
    if (forms) {
      const embed = new URL(stored);
      embed.searchParams.set('embedded', 'true');
      return view('google-forms', 'Google Forms', embed.href);
    }
    const m = /^\/(document|spreadsheets|presentation|drawings)\/(?:u\/\d+\/)?d\/(e\/)?([\w-]+)/.exec(path);
    const editor = m ? GOOGLE_EDITORS[m[1]!] : undefined;
    if (m && editor) {
      // A «Publish to the web» URL (/d/e/…) is already an embeddable page; an editor URL
      // (/edit, /view, /copy…) is swapped for /preview, the read-only frameable view. The
      // fragment is kept: it carries a sheet's #gid and a doc's #heading anchor.
      if (m[2]) return view(editor.provider, editor.label);
      return view(editor.provider, editor.label, `https://docs.google.com/${m[1]}/d/${m[3]}/preview${url.hash}`);
    }
  }
  if (host === 'drive.google.com') {
    const file = /^\/file\/(?:u\/\d+\/)?d\/([\w-]+)/.exec(path);
    if (file) return view('google-drive', 'Google Drive', `https://drive.google.com/file/d/${file[1]}/preview`);
    const folder = /^\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)/.exec(path);
    if (folder) return view('google-drive', 'Google Drive', `https://drive.google.com/embeddedfolderview?id=${folder[1]}#list`);
    return view('google-drive', 'Google Drive');
  }
  if (host === 'figma.com' && /^\/(file|design|proto|board|slides|deck)\//.test(path)) {
    return view('figma', 'Figma', `https://www.figma.com/embed?embed_host=kermanych&url=${encodeURIComponent(stored)}`);
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') {
    const id =
      host === 'youtu.be'
        ? path.slice(1).split('/')[0]
        : (url.searchParams.get('v') ?? /^\/(?:shorts|embed|live)\/([\w-]+)/.exec(path)?.[1]);
    return view('youtube', 'YouTube', id ? `https://www.youtube.com/embed/${id}` : stored);
  }
  if (host === 'loom.com') {
    const id = /^\/(?:share|embed)\/([\w-]+)/.exec(path)?.[1];
    return view('loom', 'Loom', id ? `https://www.loom.com/embed/${id}` : stored);
  }
  if (host === 'miro.com') {
    const id = /^\/app\/(?:board|live-embed)\/([^/]+)/.exec(path)?.[1];
    return view('miro', 'Miro', id ? `https://miro.com/app/live-embed/${id}/` : stored);
  }
  if (host === 'claude.ai' || host === 'claude.site') {
    // claude.ai answers `frame-ancestors 'self'`; a published artifact's embed form lives on
    // claude.site.
    const id = /^\/public\/artifacts\/([\w-]+)/.exec(path)?.[1];
    return view('claude', 'Claude', id ? `https://claude.site/public/artifacts/${id}/embed` : stored);
  }
  if (host === 'notion.so' || host.endsWith('.notion.site')) return view('notion', 'Notion');
  if (host === 'github.com' || host === 'gist.github.com') return view('github', 'GitHub');
  return view('web', host);
}
