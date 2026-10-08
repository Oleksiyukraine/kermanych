// The scripts the session browser injects into pages (docs/specs/2026-10-05-embedded-browser.md),
// as source strings so a probe can run them exactly as they ship. Pure: no electron import.
//
// Every script runs in the page's main world (CDP Runtime.evaluate without a context, Electron
// executeJavaScript), so the snapshot's ref registry is visible to the element tools and the
// picker sees the frameworks' dev-build back-pointers. Same-origin iframes are part of the page
// for all of them: their documents are reachable through `contentDocument`, so lookups descend
// into them and geometry is translated into the top viewport (what CDP input and screenshots
// use). Elements of another frame are instances of that frame's realm, hence localName checks
// and the element's own window (`ownerDocument.defaultView`) instead of `instanceof` and the
// top window's globals.

export const TEXT_LIMIT = 20_000;

// What the agent pastes into the next snapshot is gone: a ref no longer in the registry, its
// element detached or its frame navigated away.
const STALE_REF = 'the page changed since the last browser_snapshot — take a new snapshot and use its refs';

// The helpers every element script shares, as one expression evaluating to an object (`k` in
// the scripts below).
//
// Refs: the snapshot fills `window.__kermanychRefs` (ref → WeakRef of the element, a fresh Map
// per snapshot, a non-enumerable property so page code iterating window does not trip on it)
// instead of marking elements with attributes, so the page's DOM, its MutationObservers and
// the picker's outerHTML never see the agent's bookkeeping. A ref that does not resolve to a
// connected element of a live document is stale.
//
// Geometry: `box` gives an element's border box and its visible part in the top viewport's CSS
// pixels — each frame up the chain adds its content-box origin (border + padding past its
// border box) and clips to its viewport. `deepHit` is elementFromPoint for a top-viewport
// point, descending through open shadow roots and same-origin frames, so a hit test sees what
// a real click there would reach. `hitPoint` scrolls the element into view and returns a point
// whose hit is the element itself (or inside it, or its <label>), trying the centre, its line
// boxes' centres and four inset corners before naming what covers it.
export const PAGE_LIB = String.raw`(() => {
  const frameDoc = (frame) => { try { return frame.contentDocument; } catch { return null; } };
  const deepAll = (root, sel, out = []) => {
    for (const el of root.querySelectorAll(sel)) out.push(el);
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepAll(el.shadowRoot, sel, out);
    return out;
  };
  const deepOne = (root, sel) => {
    const hit = root.querySelector(sel);
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { const inner = deepOne(el.shadowRoot, sel); if (inner) return inner; }
    }
    return null;
  };
  // The document and its same-origin frame documents, depth-first.
  const docs = (doc = document, out = []) => {
    out.push(doc);
    for (const f of deepAll(doc, 'iframe, frame')) { const d = frameDoc(f); if (d) docs(d, out); }
    return out;
  };
  // Matches inside an element: its light DOM and shadow tree, not the element itself.
  const inside = (el, sel) => [...deepAll(el, sel), ...(el.shadowRoot ? deepAll(el.shadowRoot, sel) : [])];
  const find = (ref) => {
    if (/^e\d+$/.test(ref)) {
      const reg = window.__kermanychRefs;
      const el = reg && reg.get(ref) ? reg.get(ref).deref() : undefined;
      if (!el || !el.isConnected || !el.ownerDocument.defaultView) throw new Error('No element with ref ' + ref + ': ${STALE_REF}');
      return el;
    }
    try { document.querySelector(ref); } catch {
      throw new Error('"' + ref + '" is neither a ref from browser_snapshot nor a valid CSS selector');
    }
    for (const doc of docs()) { const el = deepOne(doc, ref); if (el) return el; }
    throw new Error('No element matches the selector ' + ref);
  };
  const contentOffset = (frame) => {
    const r = frame.getBoundingClientRect();
    const cs = frame.ownerDocument.defaultView.getComputedStyle(frame);
    return { x: r.left + frame.clientLeft + parseFloat(cs.paddingLeft), y: r.top + frame.clientTop + parseFloat(cs.paddingTop) };
  };
  // The frame elements between the element's window and ours, innermost first.
  const frames = (el) => {
    const out = [];
    for (let w = el.ownerDocument.defaultView; w && w !== window && w.frameElement; w = w.frameElement.ownerDocument.defaultView) out.push(w.frameElement);
    return out;
  };
  const frameOffset = (el) => {
    let x = 0, y = 0;
    for (const f of frames(el)) { const o = contentOffset(f); x += o.x; y += o.y; }
    return { x, y };
  };
  const clipTo = (r, w) => ({ left: Math.max(r.left, 0), top: Math.max(r.top, 0), right: Math.min(r.right, w.innerWidth), bottom: Math.min(r.bottom, w.innerHeight) });
  const box = (el) => {
    const b = el.getBoundingClientRect();
    let rect = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    let vis = clipTo(rect, el.ownerDocument.defaultView);
    let x = 0, y = 0;
    for (const f of frames(el)) {
      const o = contentOffset(f);
      x += o.x; y += o.y;
      vis = clipTo({ left: vis.left + o.x, top: vis.top + o.y, right: vis.right + o.x, bottom: vis.bottom + o.y }, f.ownerDocument.defaultView);
    }
    rect = { left: rect.left + x, top: rect.top + y, right: rect.right + x, bottom: rect.bottom + y };
    return { rect, offset: { x, y }, visible: vis.right > vis.left && vis.bottom > vis.top ? vis : null };
  };
  const deepHit = (x, y) => {
    let doc = document, ox = 0, oy = 0, hit = null;
    for (;;) {
      let h = doc.elementFromPoint(x - ox, y - oy);
      while (h && h.shadowRoot) {
        const inner = h.shadowRoot.elementFromPoint(x - ox, y - oy);
        if (!inner || inner === h) break;
        h = inner;
      }
      if (!h) return hit;
      hit = h;
      const d = h.localName === 'iframe' || h.localName === 'frame' ? frameDoc(h) : null;
      if (!d) return hit;
      const o = contentOffset(h);
      ox += o.x; oy += o.y; doc = d;
    }
  };
  // Whether node is target or inside it in the composed tree, across shadow and frame borders.
  const within = (node, target) => {
    for (let n = node; n; n = n.parentNode || n.host || (n.defaultView && n.defaultView.frameElement) || null) {
      if (n === target) return true;
    }
    return false;
  };
  const tagOf = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('') : '';
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return el.localName + (el.id ? '#' + el.id : '') + cls + (text ? ' ' + JSON.stringify(text.length > 40 ? text.slice(0, 39) + '…' : text) : '');
  };
  const hitPoint = (el, ref) => {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const { visible: v, offset } = box(el);
    if (!v) throw new Error('"' + ref + '" is not visible on the page (zero size, hidden or scrolled out of reach)');
    const w = v.right - v.left, h = v.bottom - v.top;
    const points = [[v.left + w / 2, v.top + h / 2]];
    // A link wrapped over two lines has its bounding box centre between them.
    for (const r of Array.from(el.getClientRects()).slice(0, 4)) {
      const x = (r.left + r.right) / 2 + offset.x, y = (r.top + r.bottom) / 2 + offset.y;
      if (x > v.left && x < v.right && y > v.top && y < v.bottom) points.push([x, y]);
    }
    for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) points.push([v.left + w * fx, v.top + h * fy]);
    // A styled checkbox is often an invisible <input> under its <label>: the label takes the click.
    const labels = el.labels ? Array.from(el.labels) : [];
    let first = null;
    for (const [x, y] of points) {
      const hit = deepHit(x, y);
      if (hit && (within(hit, el) || labels.some((l) => within(hit, l)))) return { x, y };
      if (!first) first = { hit, x, y };
    }
    if (!first.hit) throw new Error('"' + ref + '" is not visible on the page (zero size, hidden or scrolled out of reach)');
    throw new Error('"' + ref + '" is covered by <' + tagOf(first.hit) + '> at (' + Math.round(first.x) + ', ' + Math.round(first.y) + ') — close or scroll away the overlay, or click that element instead');
  };
  return { frameDoc, deepAll, inside, docs, find, contentOffset, frameOffset, box, deepHit, within, tagOf, hitPoint };
})()`;

// Scrolls the element into view and returns the top-viewport CSS point a click or hover goes
// to (actions multiply it by the view's scale); throws when the element is hidden or covered.
export function clickPointScript(ref: string): string {
  return `((k, ref) => k.hitPoint(k.find(ref), ref))(${PAGE_LIB}, ${JSON.stringify(ref)})`;
}

// The element's border box in top-viewport CSS pixels after scrolling it into view, with the
// scroll offset, viewport size and device pixel ratio the screenshot clip needs.
export function elementBoxScript(ref: string): string {
  return String.raw`((k, ref) => {
  const el = k.find(ref);
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const { rect } = k.box(el);
  if (rect.right <= rect.left || rect.bottom <= rect.top) throw new Error('"' + ref + '" has no size on the page (hidden or empty)');
  return { ...rect, scrollX, scrollY, innerWidth, innerHeight, dpr: devicePixelRatio };
})(${PAGE_LIB}, ${JSON.stringify(ref)})`;
}

// Focuses the text field (or the first one inside the element: refs often land on a wrapper)
// and selects its content when it is to be replaced, else puts the caret at the end. Returns
// 'ok' or 'not-editable:<what it is>'. Focusing an element of a same-origin frame focuses that
// frame too, so CDP Input.insertText lands there.
export function focusFieldScript(ref: string, clear: boolean): string {
  return String.raw`((k, ref, clear) => {
  const NOT_TEXT = ['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color', 'hidden'];
  const isField = (e) => e.localName === 'textarea' || (e.localName === 'input' && !NOT_TEXT.includes(e.type)) || e.isContentEditable;
  let el = k.find(ref);
  if (!isField(el)) {
    const inner = k.inside(el, 'input, textarea, [contenteditable]:not([contenteditable="false"])').find(isField);
    if (!inner) return 'not-editable:' + (el.localName === 'input' ? 'input type=' + el.type : el.localName);
    el = inner;
  }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  el.focus();
  if (el.localName === 'input' || el.localName === 'textarea') {
    if (clear) el.select();
    else { try { el.setSelectionRange(el.value.length, el.value.length); } catch {} }
  } else {
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    if (!clear) range.collapse(false);
    const sel = el.ownerDocument.defaultView.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return 'ok';
})(${PAGE_LIB}, ${JSON.stringify(ref)}, ${clear})`;
}

// Chooses options of a native <select> the way a user's pick ends up: each value matches an
// option's value, else its visible label (whitespace-collapsed, case-insensitive); the options
// become selected and `input` + `change` bubble from the select, which is what Vue's v-model,
// React's onChange and plain listeners react to. Returns the chosen labels.
export function selectScript(ref: string, values: string[]): string {
  return String.raw`((k, ref, values) => {
  let el = k.find(ref);
  if (el.localName !== 'select') {
    const inner = k.inside(el, 'select');
    if (inner.length !== 1) {
      throw new Error('"' + ref + '" is a <' + el.localName + '>, not a <select>' + (inner.length ? ' (it holds ' + inner.length + ' of them — pass the ref of one)' : '') + '; a custom dropdown opens with browser_click, then click its option from a new snapshot');
    }
    el = inner[0];
  }
  if (el.disabled) throw new Error('"' + ref + '" is disabled');
  if (!values.length && !el.multiple) throw new Error('"' + ref + '" needs one value to select');
  if (values.length > 1 && !el.multiple) throw new Error('"' + ref + '" allows one option only; pass a single value');
  const options = Array.from(el.options);
  const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const labelOf = (o) => (o.label || o.text).replace(/\s+/g, ' ').trim();
  const chosen = values.map((value) => {
    const opt = options.find((o) => o.value === value) || options.find((o) => norm(labelOf(o)) === norm(value));
    if (!opt) {
      const known = options.slice(0, 20).map((o) => JSON.stringify(labelOf(o))).join(', ');
      throw new Error('"' + ref + '" has no option ' + JSON.stringify(value) + ' — its options: ' + (known || '(none)') + (options.length > 20 ? ', … (' + options.length + ' in all)' : ''));
    }
    if (opt.disabled) throw new Error('Option ' + JSON.stringify(labelOf(opt)) + ' of "' + ref + '" is disabled');
    return opt;
  });
  el.focus();
  if (el.multiple) for (const o of options) o.selected = chosen.includes(o);
  else chosen[0].selected = true;
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return chosen.map(labelOf);
})(${PAGE_LIB}, ${JSON.stringify(ref)}, ${JSON.stringify(values)})`;
}

// The <input type=file> to set files on, as a remote object (evaluated with returnByValue
// false): the element itself, the control of a <label>, or the one file input inside the
// element. Styled upload buttons hide the real input, which the snapshot then does not list,
// so a miss suggests a CSS selector (lookups by selector ignore visibility).
export function fileInputScript(ref: string, count: number): string {
  return String.raw`((k, ref, count) => {
  let el = k.find(ref);
  const isFile = (e) => e && e.localName === 'input' && e.type === 'file';
  if (!isFile(el)) {
    const inner = isFile(el.control) ? [el.control] : k.inside(el, 'input[type=file]');
    if (inner.length !== 1) {
      const all = k.docs().reduce((n, d) => n + k.deepAll(d, 'input[type=file]').length, 0);
      throw new Error('"' + ref + '" is a <' + el.localName + '>' + (inner.length ? ' holding ' + inner.length + ' file inputs' : ' with no file input in it') + '; the page has ' + all + ' file input(s) in all' + (all ? ' — pass a CSS selector such as input[type=file] (hidden inputs are not in the snapshot)' : ''));
    }
    el = inner[0];
  }
  if (el.disabled) throw new Error('The file input "' + ref + '" is disabled');
  if (count > 1 && !el.multiple) throw new Error('The file input "' + ref + '" takes one file (no multiple attribute); pass a single path');
  return el;
})(${PAGE_LIB}, ${JSON.stringify(ref)}, ${count})`;
}

// One poll of browser_wait: whether `text` is in the rendered text of the page (top document
// and same-origin frames, whitespace-collapsed) and/or `selector` matches a shown element (one
// holding `text` when both are given) — `{ present }`, which the caller compares with `gone`;
// `{ invalid: true }` for a selector that does not parse.
export function waitScript(opts: { text?: string; selector?: string }): string {
  return String.raw`((k, text, selector) => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ');
  const want = text === undefined ? undefined : norm(text).trim();
  const shown = (el) => {
    if (!el.checkVisibility({ visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };
  if (selector !== undefined) {
    try { document.querySelector(selector); } catch { return { invalid: true }; }
    const present = k.docs().some((d) => k.deepAll(d, selector).some((el) => shown(el) && (want === undefined || norm(el.innerText).includes(want))));
    return { present };
  }
  return { present: k.docs().some((d) => d.body && norm(d.body.innerText).includes(want)) };
})(${PAGE_LIB}, ${JSON.stringify(opts.text)}, ${JSON.stringify(opts.selector)})`;
}

// What the page shows, for a browser_wait timeout: the agent sees why its text never came.
export const PAGE_HINT_SCRIPT = String.raw`({ title: document.title, text: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 200) })`;

// Resolves after the page painted twice: the frame the input's handlers scheduled has run.
export const ANIMATION_FRAMES_SCRIPT = '(() => { const { promise, resolve } = Promise.withResolvers(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); return promise; })()';

// The agent's view of the page: an indented outline of the rendered DOM (the whole document,
// not only the viewport — click scrolls its target into view). Interactive elements get a
// `[eN]` tag in the outline and an entry in the page's ref registry (PAGE_LIB); headings,
// landmarks, lists and text give the context. Walks the composed tree (open shadow roots,
// slots) and same-origin iframes (under an `iframe "src":` line); a cross-origin iframe is
// named only. Native selects read `combobox`/`listbox … options=…`, and a footer tells the
// agent they take browser_select (clicking an option of a native select does nothing).
export const SNAPSHOT_SCRIPT = String.raw`(() => {
  const LIMIT = ${TEXT_LIMIT};
  const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=textbox], [role=combobox], [contenteditable]:not([contenteditable="false"]), [onclick]';
  const CONTEXT = INTERACTIVE + ', h1, h2, h3, h4, h5, h6, [role=heading], img[alt], iframe';
  const SKIP = { script: true, style: true, noscript: true, template: true, head: true, meta: true, link: true, svg: true, 'kermanych-picker': true };
  const CONTAINERS = { nav: 'navigation', main: 'main', header: 'header', footer: 'footer', aside: 'aside', form: 'form', dialog: 'dialog', ul: 'list', ol: 'list', li: 'listitem', table: 'table', tr: 'row', fieldset: 'group', details: 'details' };
  const ROLE_CONTAINERS = { navigation: true, main: true, banner: true, contentinfo: true, complementary: true, form: true, dialog: true, alertdialog: true, list: true, listitem: true, listbox: true, menu: true, menubar: true, tablist: true, tabpanel: true, table: true, row: true, grid: true, group: true, region: true, alert: true, status: true, toolbar: true, tree: true };

  const refs = new Map();
  Object.defineProperty(window, '__kermanychRefs', { value: refs, configurable: true, writable: true, enumerable: false });
  let selects = 0;

  const lines = [];
  let size = 0, truncated = false, n = 0;
  const clip = (s, max) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  };
  const push = (depth, line) => {
    if (truncated) return;
    const full = '  '.repeat(depth) + '- ' + line;
    if (size + full.length + 1 > LIMIT) { truncated = true; return; }
    lines.push(full);
    size += full.length + 1;
  };
  const shown = (el) => {
    const st = el.ownerDocument.defaultView.getComputedStyle(el);
    if (st.display === 'none') return false;
    if (st.display === 'contents') return true;
    if (st.visibility === 'hidden' || st.visibility === 'collapse') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.innerText || '').join(' ');
      if (t.trim()) return t;
    }
    if (el.labels && el.labels.length) {
      const t = Array.from(el.labels).map((l) => l.innerText).join(' ');
      if (t.trim()) return t;
    }
    if (el.localName === 'input' && ['button', 'submit', 'reset'].includes(el.type)) return el.value;
    if (!['input', 'textarea', 'select'].includes(el.localName)) {
      const t = el.innerText;
      if (t && t.trim()) return t;
    }
    return el.getAttribute('title') || el.getAttribute('alt') || el.querySelector('img[alt]')?.getAttribute('alt') || '';
  };
  const kindOf = (el) => {
    const role = el.getAttribute('role');
    if (role) return role;
    switch (el.localName) {
      case 'a': return 'link';
      case 'button': return 'button';
      case 'select': return el.multiple ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox[multiline]';
      case 'summary': return 'summary';
      case 'input': {
        const t = el.type || 'text';
        if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
        if (t === 'checkbox' || t === 'radio') return t;
        if (t === 'range') return 'slider';
        if (t === 'file') return 'file-input';
        return t === 'text' ? 'textbox' : 'textbox[' + t + ']';
      }
    }
    return el.isContentEditable ? 'textbox[contenteditable]' : 'clickable';
  };
  const describe = (el) => {
    const ref = 'e' + (++n);
    refs.set(ref, new WeakRef(el));
    let line = kindOf(el);
    const name = clip(nameOf(el), 100);
    if (name) line += ' ' + JSON.stringify(name);
    line += ' [' + ref + ']';
    if (el.localName === 'a') {
      const href = el.getAttribute('href');
      if (href && !href.startsWith('javascript:')) line += ' -> ' + clip(href, 120);
    }
    if (el.localName === 'input') {
      if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) line += ' checked'; }
      else if (el.type === 'password') { if (el.value) line += ' value=(' + el.value.length + ' chars hidden)'; }
      else if (!['button', 'submit', 'reset', 'image', 'file'].includes(el.type) && el.value) line += ' value=' + JSON.stringify(clip(el.value, 100));
      if (el.placeholder) line += ' placeholder=' + JSON.stringify(clip(el.placeholder, 60));
    } else if (el.localName === 'textarea') {
      if (el.value) line += ' value=' + JSON.stringify(clip(el.value, 200));
      if (el.placeholder) line += ' placeholder=' + JSON.stringify(clip(el.placeholder, 60));
    } else if (el.localName === 'select') {
      selects++;
      const picked = Array.from(el.selectedOptions).map((o) => clip(o.text, 40));
      if (picked.length) line += ' value=' + JSON.stringify(picked.join(', '));
      const opts = Array.from(el.options).slice(0, 15).map((o) => clip(o.text, 30));
      line += ' options=' + JSON.stringify(opts.join(' | ') + (el.options.length > 15 ? ' | …' : ''));
    } else if (el.isContentEditable && el.innerText.trim() && name !== clip(el.innerText, 100)) {
      line += ' value=' + JSON.stringify(clip(el.innerText, 200));
    }
    for (const state of ['checked', 'selected', 'expanded', 'pressed']) {
      const v = el.getAttribute('aria-' + state);
      if (v === 'true') line += ' ' + state;
      else if (v === 'false' && state === 'expanded') line += ' collapsed';
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' disabled';
    if (el.required) line += ' required';
    if (el === el.getRootNode().activeElement) line += ' focused';
    return line;
  };
  const children = (el) => {
    if (el.shadowRoot) return el.shadowRoot.childNodes;
    if (el.localName === 'slot') {
      const assigned = el.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return el.childNodes;
  };
  const walkChildren = (el, depth) => {
    for (const child of children(el)) {
      if (truncated) return;
      if (child.nodeType === Node.TEXT_NODE) {
        const t = clip(child.textContent, 500);
        if (t) push(depth, 'text: ' + t);
      } else if (child.nodeType === Node.ELEMENT_NODE) walk(child, depth);
    }
  };
  const walk = (el, depth) => {
    if (truncated || SKIP[el.localName] || el.getAttribute('aria-hidden') === 'true' || !shown(el)) return;
    if (el.matches(INTERACTIVE)) {
      push(depth, describe(el));
      // A clickable card or tab can hold its own buttons (close, menu): list them under it.
      if (el.querySelector(INTERACTIVE) || el.shadowRoot) walkChildren(el, depth + 1);
      return;
    }
    const heading = /^h([1-6])$/.exec(el.localName);
    if (heading || el.getAttribute('role') === 'heading') {
      const level = heading ? heading[1] : el.getAttribute('aria-level') || '?';
      const t = clip(el.innerText, 200);
      if (t) push(depth, 'heading[' + level + '] ' + JSON.stringify(t));
      if (el.querySelector(INTERACTIVE)) walkChildren(el, depth + 1);
      return;
    }
    if (el.localName === 'img') {
      const alt = clip(el.getAttribute('alt'), 100);
      if (alt) push(depth, 'img ' + JSON.stringify(alt));
      return;
    }
    if (el.localName === 'iframe' || el.localName === 'frame') {
      const src = JSON.stringify(clip(el.getAttribute('src') || (el.hasAttribute('srcdoc') ? 'about:srcdoc' : ''), 120));
      let doc = null;
      try { doc = el.contentDocument; } catch {}
      if (!doc) { push(depth, el.localName + ' ' + src + ' (cross-origin, contents not included)'); return; }
      const mark = lines.length;
      push(depth, el.localName + ' ' + src + ':');
      if (doc.body) walk(doc.body, depth + 1);
      if (lines.length === mark + 1) {
        const empty = lines[mark].slice(0, -1) + ' (empty)';
        size += empty.length - lines[mark].length;
        lines[mark] = empty;
      }
      return;
    }
    const role = el.getAttribute('role');
    const label = role && ROLE_CONTAINERS[role] ? role : CONTAINERS[el.localName];
    // Short text-only blocks read as one line instead of a line per inline fragment; a list or
    // table keeps a line per item.
    if (!el.shadowRoot && !el.querySelector(CONTEXT) && !(label && el.children.length > 1)) {
      const t = clip(el.innerText, 301);
      if (!t) return;
      if (t.length <= 300) { push(depth, (label ? label + ': ' : 'text: ') + t); return; }
    }
    if (!label) { walkChildren(el, depth); return; }
    const mark = lines.length;
    const aria = el.getAttribute('aria-label');
    push(depth, label + (aria ? ' ' + JSON.stringify(clip(aria, 80)) : '') + ':');
    walkChildren(el, depth + 1);
    // Drop a container label nothing ended up under.
    if (lines.length === mark + 1) { size -= lines[mark].length + 1; lines.pop(); }
  };
  if (document.body) walk(document.body, 0);
  let text = lines.join('\n');
  if (truncated) text += '\n… (outline truncated at ' + LIMIT + ' characters; use browser_evaluate to inspect the rest)';
  if (selects) text += '\n(Elements with options=… are native <select>s: choose with browser_select; clicking or typing into their options does not work.)';
  return { text, refs: n };
})()`;

// The operator's «Вказати»: runs in the page's MAIN world (Electron executeJavaScript), because
// only there are the frameworks' dev-build back-pointers visible (Vue `__vueParentComponent`,
// React `__reactFiber$…`, Svelte `__svelte_meta`). An overlay in a closed shadow root follows
// the hovered element and carries the how-to banner at the top (so the pane needs no hint row
// of its own and nothing shifts when picking starts); the click is swallowed (capture phase,
// before the page's handlers) and resolves the element's description, Esc or
// `window.__kermanychPick.cancel()` resolves null. Same-origin iframes pick too: the listeners
// go on their windows as well, the overlay and `rect` are in the top viewport, `selector` is
// relative to the frame's document and `frame` names it. `more` is a Shift+click (the operator
// keeps picking). `clip` is the top-page rectangle for the CDP screenshot, taken by main after
// the overlay is gone (two animation frames later, so the crop does not show it).
export const PICKER_SCRIPT = String.raw`(() => {
  const { promise, resolve } = Promise.withResolvers();
  if (window.__kermanychPick) window.__kermanychPick.cancel();
  const k = ${PAGE_LIB};
  const host = document.createElement('kermanych-picker');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<style>' +
    '.box { position: fixed; display: none; pointer-events: none; box-sizing: border-box; border: 2px solid #4f7cff; background: rgba(79, 124, 255, 0.15); }' +
    '.label { position: fixed; display: none; pointer-events: none; font: 11px/1.5 ui-monospace, Menlo, monospace; color: #fff; background: #1f2937; padding: 1px 6px; border-radius: 3px; white-space: nowrap; }' +
    '.hint { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); pointer-events: none; font: 12px/1.5 system-ui, -apple-system, sans-serif; color: #fff; background: rgba(31, 41, 55, 0.92); padding: 4px 12px; border-radius: 6px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); white-space: nowrap; }' +
    '</style><div class="box"></div><div class="label"></div><div class="hint">Клікніть елемент · Shift+клік — ще один · Esc — скасувати</div>';
  const box = root.querySelector('.box');
  const label = root.querySelector('.label');
  document.documentElement.appendChild(host);
  let current = null;
  // Our window and every same-origin frame's, as the page is now.
  const wins = k.docs().map((d) => d.defaultView).filter(Boolean);

  const paint = () => {
    if (!current || !current.isConnected) { box.style.display = 'none'; label.style.display = 'none'; return; }
    const { rect } = k.box(current);
    const r = { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.right - rect.left, height: rect.bottom - rect.top };
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    const cls = typeof current.className === 'string' && current.className.trim() ? '.' + current.className.trim().split(/\s+/)[0] : '';
    label.textContent = current.localName + (current.id ? '#' + current.id : cls) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    label.style.display = 'block';
    const below = r.top < 22;
    label.style.left = Math.max(0, Math.min(r.left, innerWidth - label.offsetWidth)) + 'px';
    label.style.top = (below ? Math.min(r.bottom + 2, innerHeight - 20) : r.top - 20) + 'px';
  };
  const targetOf = (e) => {
    const t = e.composedPath()[0];
    return t && t.nodeType === 1 && t !== host ? t : null;
  };
  const onMove = (e) => { const t = targetOf(e); if (t && t !== current) { current = t; paint(); } };
  const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const onClick = (e) => { swallow(e); finish(targetOf(e) || current, e.shiftKey); };
  const onKey = (e) => { if (e.key === 'Escape') { swallow(e); finish(null); } };
  const onScroll = () => paint();
  const SWALLOWED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick', 'contextmenu'];

  const selectorOf = (el) => {
    const doc = el.ownerDocument;
    const unique = (sel) => { try { return doc.querySelectorAll(sel).length === 1; } catch { return false; } };
    if (el.id && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== doc.documentElement; e = e.parentElement) {
      if (e !== el && e.id && unique('#' + CSS.escape(e.id))) { parts.unshift('#' + CSS.escape(e.id)); break; }
      let part = e.localName;
      const parent = e.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.localName === e.localName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(e) + 1) + ')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ') || el.localName;
  };
  const htmlOf = (el) => {
    const copy = el.cloneNode(true);
    for (const node of [copy, ...copy.querySelectorAll('*')]) {
      for (const attr of Array.from(node.attributes)) {
        if (attr.value.length > 200) node.setAttribute(attr.name, attr.value.slice(0, 200) + '…');
      }
    }
    for (const node of copy.querySelectorAll('script, style')) node.textContent = node.textContent.length > 200 ? '…' : node.textContent;
    const html = copy.outerHTML;
    return html.length > 4096 ? html.slice(0, 4096) + '\n<!-- … truncated, ' + html.length + ' characters in all -->' : html;
  };
  const STYLE_PROPS = ['display', 'position', 'width', 'height', 'box-sizing', 'margin', 'padding', 'border', 'border-radius', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'opacity', 'z-index', 'overflow'];
  const FLEX_PROPS = ['flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'gap'];
  const GRID_PROPS = ['grid-template-columns', 'grid-template-rows', 'align-items', 'justify-items', 'justify-content', 'gap'];
  const ITEM_PROPS = ['flex', 'align-self', 'grid-column', 'grid-row'];
  const DEFAULTS = { position: 'static', 'box-sizing': 'content-box', opacity: '1', overflow: 'visible', 'text-align': 'start', 'flex-direction': 'row', 'flex-wrap': 'nowrap', flex: '0 1 auto', 'grid-column': 'auto', 'grid-row': 'auto' };
  const EMPTY = { '': true, none: true, normal: true, auto: true, '0px': true, 'rgba(0, 0, 0, 0)': true };
  const stylesOf = (el) => {
    const view = el.ownerDocument.defaultView;
    const cs = view.getComputedStyle(el);
    const parent = el.parentElement ? view.getComputedStyle(el.parentElement).display : '';
    const props = [...STYLE_PROPS];
    if (/flex/.test(cs.display)) props.push(...FLEX_PROPS);
    if (/grid/.test(cs.display)) props.push(...GRID_PROPS);
    if (/flex|grid/.test(parent)) props.push(...ITEM_PROPS);
    const out = {};
    for (const p of props) {
      const v = cs.getPropertyValue(p).trim();
      const always = p === 'display' || p === 'width' || p === 'height';
      if (!always && (EMPTY[v] || DEFAULTS[p] === v || (p === 'border' && v.startsWith('0px')))) continue;
      out[p] = v;
    }
    return out;
  };
  const sourceOf = (el) => {
    let found;
    const inspector = el.closest('[data-v-inspector]')?.getAttribute('data-v-inspector');
    if (inspector) {
      const m = /^(.*?):(\d+)(?::\d+)?$/.exec(inspector);
      found = m ? { file: m[1], line: Number(m[2]) } : { file: inspector };
    }
    for (let e = el; e; e = e.parentElement) {
      if (e.__vueParentComponent) {
        for (let c = e.__vueParentComponent; c; c = c.parent) {
          const t = c.type;
          if (t && t.__file) {
            const component = t.__name || t.name;
            if (found) return component ? { ...found, component } : found;
            return component ? { file: t.__file, component } : { file: t.__file };
          }
        }
        break;
      }
      const key = Object.keys(e).find((k) => k.startsWith('__reactFiber$'));
      if (key) {
        let file, line, component;
        for (let f = e[key]; f; f = f.return) {
          if (!file && f._debugSource) { file = f._debugSource.fileName; line = f._debugSource.lineNumber; }
          if (!component && typeof f.type === 'function') component = f.type.displayName || f.type.name;
          if (file && component) break;
        }
        if (file) return { file, line, component };
        break;
      }
      const loc = e.__svelte_meta && e.__svelte_meta.loc;
      if (loc && loc.file) return { file: loc.file, line: loc.line };
    }
    return found;
  };
  const describe = (el) => {
    const { rect } = k.box(el);
    const pad = 8;
    const x0 = Math.max(0, rect.left - pad), y0 = Math.max(0, rect.top - pad);
    const x1 = Math.min(innerWidth, rect.right + pad), y1 = Math.min(innerHeight, rect.bottom + pad);
    const out = {
      selector: selectorOf(el),
      tag: el.localName,
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      html: htmlOf(el),
      styles: stylesOf(el),
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.right - rect.left), height: Math.round(rect.bottom - rect.top) },
      viewport: { width: innerWidth, height: innerHeight },
      scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
      more: false,
      clip: x1 > x0 && y1 > y0 ? { x: x0 + scrollX, y: y0 + scrollY, width: x1 - x0, height: y1 - y0 } : null,
    };
    if (el.ownerDocument !== document) out.frame = el.ownerDocument.URL;
    const source = sourceOf(el);
    if (source) out.source = source;
    return out;
  };

  let done = false;
  const finish = (el, more) => {
    if (done) return;
    done = true;
    for (const w of wins) {
      w.removeEventListener('pointermove', onMove, true);
      w.removeEventListener('click', onClick, true);
      w.removeEventListener('keydown', onKey, true);
      w.removeEventListener('scroll', onScroll, true);
      for (const type of SWALLOWED) w.removeEventListener(type, swallow, true);
    }
    host.remove();
    delete window.__kermanychPick;
    if (!el || !el.isConnected) { resolve(null); return; }
    const result = { ...describe(el), more: Boolean(more) };
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(result)));
  };
  for (const w of wins) {
    w.addEventListener('pointermove', onMove, true);
    w.addEventListener('click', onClick, true);
    w.addEventListener('keydown', onKey, true);
    w.addEventListener('scroll', onScroll, true);
    for (const type of SWALLOWED) w.addEventListener(type, swallow, true);
  }
  window.__kermanychPick = { cancel: () => finish(null) };
  return promise;
})()`;

export interface PickResult extends Omit<KermanychBrowserPick, 'url' | 'screenshot'> {
  clip: { x: number; y: number; width: number; height: number } | null;
}
