// The session browser (docs/specs/2026-10-05-embedded-browser.md): one Electron WebContentsView
// per agent session, shared by the operator (the renderer's Браузер tab positions it over a
// placeholder through the `kermanych:browser:*` IPC below) and the session's agent (the api's
// MCP endpoint calls the BrowserHost methods, handed to it through `bootstrap({ browser })`).
//
// Views are never detached once created. The one the operator looks at sits at the bounds the
// renderer reports; every other one is *parked* with exactly one pixel inside the window's
// bottom-right corner — probed on Electron 43, a detached view does not lay out (CDP clicks
// miss) and cannot be captured, a `setVisible(false)` one captures only at random, a view fully
// outside the window times out, and a one-pixel-inside view renders and captures reliably. So
// the agent can drive a session the operator is not looking at and still take screenshots.
//
// Input goes through CDP on the view's `webContents.debugger` (real trusted events, so
// frameworks react as to a user); the snapshot, element lookup and the picker are injected
// scripts, exported as source strings so a probe can run them as they ship.
import { ipcMain, session, WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import type { BrowserConsoleEntry, BrowserHost, BrowserPageInfo, BrowserTarget } from '@kermanych/api';

// Size of a view the agent created before the operator ever showed it (the agent's viewport).
const DEFAULT_SIZE = { width: 1280, height: 800 };
const CONSOLE_LIMIT = 200;
// How long a navigation (or a click/key that started one) may take before the tool returns
// anyway; the page keeps loading and the agent sees `loading` in the next snapshot.
const SETTLE_MS = 15_000;
// A CDP command that has not answered by then is reported instead of hanging the agent's turn.
const CDP_TIMEOUT_MS = 15_000;
const TEXT_LIMIT = 20_000;

// Shared by click and type: a snapshot ref (`e12`, looked up by the attribute the snapshot
// set) or else a CSS selector; both searched through open shadow roots. A miss throws the
// message the agent gets.
const FIND_FN = String.raw`function (ref) {
  const deep = (root, sel) => {
    const hit = root.querySelector(sel);
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { const inner = deep(el.shadowRoot, sel); if (inner) return inner; }
    }
    return null;
  };
  if (/^e\d+$/.test(ref)) {
    const el = deep(document, '[data-kermanych-ref="' + ref + '"]');
    if (!el) throw new Error('No element with ref ' + ref + ': the page changed since the last browser_snapshot — take a new snapshot and use its refs');
    return el;
  }
  try { document.querySelector(ref); } catch {
    throw new Error('"' + ref + '" is neither a ref from browser_snapshot nor a valid CSS selector');
  }
  const el = deep(document, ref);
  if (!el) throw new Error('No element matches the selector ' + ref);
  return el;
}`;

// Scrolls the element to the centre and returns the viewport point to click: the centre of the
// element's visible part, or `{ hidden: true }`.
export function clickPointScript(ref: string): string {
  return `((find, ref) => {
  const el = find(ref);
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth);
  const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
  if (right <= left || bottom <= top) return { hidden: true };
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
})(${FIND_FN}, ${JSON.stringify(ref)})`;
}

// Focuses the text field (or the first one inside the element: refs often land on a wrapper)
// and selects its content when it is to be replaced, else puts the caret at the end. Returns
// 'ok' or 'not-editable:<tag>'.
export function focusFieldScript(ref: string, clear: boolean): string {
  return `((find, ref, clear) => {
  let el = find(ref);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) {
    const inner = el.querySelector('input, textarea, [contenteditable]:not([contenteditable="false"])');
    if (!inner) return 'not-editable:' + el.localName;
    el = inner;
  }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (clear) el.select();
    else { try { el.setSelectionRange(el.value.length, el.value.length); } catch {} }
  } else {
    const range = document.createRange();
    range.selectNodeContents(el);
    if (!clear) range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return 'ok';
})(${FIND_FN}, ${JSON.stringify(ref)}, ${clear})`;
}

// The agent's view of the page: an indented outline of the rendered DOM (the whole document,
// not only the viewport — click scrolls its target into view). Interactive elements get
// `data-kermanych-ref="eN"` and a `[eN]` tag in the outline; headings, landmarks, lists and
// text give the context. Walks the composed tree (open shadow roots, slots).
export const SNAPSHOT_SCRIPT = String.raw`(() => {
  const LIMIT = ${TEXT_LIMIT};
  const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=textbox], [role=combobox], [contenteditable]:not([contenteditable="false"]), [onclick]';
  const CONTEXT = INTERACTIVE + ', h1, h2, h3, h4, h5, h6, [role=heading], img[alt], iframe';
  const SKIP = { script: true, style: true, noscript: true, template: true, head: true, meta: true, link: true, svg: true, 'kermanych-picker': true };
  const CONTAINERS = { nav: 'navigation', main: 'main', header: 'header', footer: 'footer', aside: 'aside', form: 'form', dialog: 'dialog', ul: 'list', ol: 'list', li: 'listitem', table: 'table', tr: 'row', fieldset: 'group', details: 'details' };
  const ROLE_CONTAINERS = { navigation: true, main: true, banner: true, contentinfo: true, complementary: true, form: true, dialog: true, alertdialog: true, list: true, listitem: true, listbox: true, menu: true, menubar: true, tablist: true, tabpanel: true, table: true, row: true, grid: true, group: true, region: true, alert: true, status: true, toolbar: true, tree: true };

  const deepAll = (root, sel, out) => {
    for (const el of root.querySelectorAll(sel)) out.push(el);
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepAll(el.shadowRoot, sel, out);
    return out;
  };
  for (const old of deepAll(document, '[data-kermanych-ref]', [])) old.removeAttribute('data-kermanych-ref');

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
    const st = getComputedStyle(el);
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
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      if (t.trim()) return t;
    }
    if (el.labels && el.labels.length) {
      const t = Array.from(el.labels).map((l) => l.innerText).join(' ');
      if (t.trim()) return t;
    }
    if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type)) return el.value;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
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
    el.setAttribute('data-kermanych-ref', ref);
    let line = kindOf(el);
    const name = clip(nameOf(el), 100);
    if (name) line += ' ' + JSON.stringify(name);
    line += ' [' + ref + ']';
    if (el.localName === 'a') {
      const href = el.getAttribute('href');
      if (href && !href.startsWith('javascript:')) line += ' -> ' + clip(href, 120);
    }
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) line += ' checked'; }
      else if (el.type === 'password') { if (el.value) line += ' value=(' + el.value.length + ' chars hidden)'; }
      else if (!['button', 'submit', 'reset', 'image', 'file'].includes(el.type) && el.value) line += ' value=' + JSON.stringify(clip(el.value, 100));
      if (el.placeholder) line += ' placeholder=' + JSON.stringify(clip(el.placeholder, 60));
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value) line += ' value=' + JSON.stringify(clip(el.value, 200));
      if (el.placeholder) line += ' placeholder=' + JSON.stringify(clip(el.placeholder, 60));
    } else if (el instanceof HTMLSelectElement) {
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
    if (el === document.activeElement) line += ' focused';
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
    if (el.localName === 'iframe') {
      push(depth, 'iframe ' + JSON.stringify(clip(el.getAttribute('src') || '', 120)) + ' (contents not included)');
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
  return { text, refs: n };
})()`;

// The operator's «Вказати»: runs in the page's MAIN world (Electron executeJavaScript), because
// only there are the frameworks' dev-build back-pointers visible (Vue `__vueParentComponent`,
// React `__reactFiber$…`, Svelte `__svelte_meta`). An overlay in a closed shadow root follows
// the hovered element; the click is swallowed (capture phase, before the page's handlers) and
// resolves the element's description, Esc or `window.__kermanychPick.cancel()` resolves null.
// `clip` is the page-coordinate rectangle for the CDP screenshot, taken by main after the
// overlay is gone (two animation frames later, so the crop does not show it).
export const PICKER_SCRIPT = String.raw`new Promise((resolve) => {
  if (window.__kermanychPick) window.__kermanychPick.cancel();
  const host = document.createElement('kermanych-picker');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<style>' +
    '.box { position: fixed; display: none; pointer-events: none; box-sizing: border-box; border: 2px solid #4f7cff; background: rgba(79, 124, 255, 0.15); }' +
    '.label { position: fixed; display: none; pointer-events: none; font: 11px/1.5 ui-monospace, Menlo, monospace; color: #fff; background: #1f2937; padding: 1px 6px; border-radius: 3px; white-space: nowrap; }' +
    '</style><div class="box"></div><div class="label"></div>';
  const box = root.querySelector('.box');
  const label = root.querySelector('.label');
  document.documentElement.appendChild(host);
  let current = null;

  const paint = () => {
    if (!current || !current.isConnected) { box.style.display = 'none'; label.style.display = 'none'; return; }
    const r = current.getBoundingClientRect();
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
    return t instanceof Element && t !== host ? t : null;
  };
  const onMove = (e) => { const t = targetOf(e); if (t && t !== current) { current = t; paint(); } };
  const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const onClick = (e) => { swallow(e); finish(targetOf(e) || current); };
  const onKey = (e) => { if (e.key === 'Escape') { swallow(e); finish(null); } };
  const onScroll = () => paint();
  const SWALLOWED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick', 'contextmenu'];

  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
  const selectorOf = (el) => {
    if (el.id && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
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
      // The snapshot's own markers are not the page's markup.
      node.removeAttribute('data-kermanych-ref');
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
    const cs = getComputedStyle(el);
    const parent = el.parentElement ? getComputedStyle(el.parentElement).display : '';
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
    const r = el.getBoundingClientRect();
    const pad = 8;
    const x0 = Math.max(0, r.left - pad), y0 = Math.max(0, r.top - pad);
    const x1 = Math.min(innerWidth, r.right + pad), y1 = Math.min(innerHeight, r.bottom + pad);
    const out = {
      selector: selectorOf(el),
      tag: el.localName,
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      html: htmlOf(el),
      styles: stylesOf(el),
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      clip: x1 > x0 && y1 > y0 ? { x: x0 + scrollX, y: y0 + scrollY, width: x1 - x0, height: y1 - y0 } : null,
    };
    const source = sourceOf(el);
    if (source) out.source = source;
    return out;
  };

  let done = false;
  const finish = (el) => {
    if (done) return;
    done = true;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    for (const type of SWALLOWED) window.removeEventListener(type, swallow, true);
    host.remove();
    delete window.__kermanychPick;
    if (!el) { resolve(null); return; }
    const result = describe(el);
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(result)));
  };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  for (const type of SWALLOWED) window.addEventListener(type, swallow, true);
  window.__kermanychPick = { cancel: () => finish(null) };
})`;

interface PickResult extends Omit<KermanychBrowserPick, 'url' | 'screenshot'> {
  clip: { x: number; y: number; width: number; height: number } | null;
}

// CDP `Input.dispatchKeyEvent` fields for one key combination (`Enter`, `Shift+Tab`, `Meta+a`).
export interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
  modifiers: number; // CDP bits: Alt 1, Control 2, Meta 4, Shift 8
  text?: string;
  // macOS editing commands: Chromium does not map Cmd shortcuts of synthetic key events itself.
  commands?: string[];
}

const NAMED_KEYS: Record<string, [key: string, code: string, keyCode: number, text?: string]> = {
  enter: ['Enter', 'Enter', 13, '\r'],
  tab: ['Tab', 'Tab', 9],
  backspace: ['Backspace', 'Backspace', 8],
  delete: ['Delete', 'Delete', 46],
  escape: ['Escape', 'Escape', 27],
  esc: ['Escape', 'Escape', 27],
  space: [' ', 'Space', 32, ' '],
  ' ': [' ', 'Space', 32, ' '],
  arrowup: ['ArrowUp', 'ArrowUp', 38],
  arrowdown: ['ArrowDown', 'ArrowDown', 40],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37],
  arrowright: ['ArrowRight', 'ArrowRight', 39],
  home: ['Home', 'Home', 36],
  end: ['End', 'End', 35],
  pageup: ['PageUp', 'PageUp', 33],
  pagedown: ['PageDown', 'PageDown', 34],
  insert: ['Insert', 'Insert', 45],
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`f${i}`] = [`F${i}`, `F${i}`, 111 + i];

const PUNCTUATION: Record<string, [code: string, keyCode: number]> = {
  '-': ['Minus', 189], '=': ['Equal', 187], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191],
  ';': ['Semicolon', 186], "'": ['Quote', 222], '[': ['BracketLeft', 219], ']': ['BracketRight', 221],
  '\\': ['Backslash', 220], '`': ['Backquote', 192],
};

const MAC_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' };

export function parseKey(combo: string, platform: NodeJS.Platform = process.platform): KeySpec {
  const m = /^((?:(?:Meta|Cmd|Command|Control|Ctrl|ControlOrMeta|Alt|Option|Shift)\+)*)(.+)$/i.exec(combo.trim());
  if (!m || !m[2]) throw new Error(`Empty key "${combo}"`);
  let modifiers = 0;
  for (const raw of m[1]!.split('+').filter(Boolean)) {
    const mod = raw.toLowerCase();
    if (mod === 'alt' || mod === 'option') modifiers |= 1;
    else if (mod === 'control' || mod === 'ctrl') modifiers |= 2;
    else if (mod === 'meta' || mod === 'cmd' || mod === 'command') modifiers |= 4;
    else if (mod === 'shift') modifiers |= 8;
    else modifiers |= platform === 'darwin' ? 4 : 2; // ControlOrMeta
  }
  const name = m[2];
  // A modified key is a shortcut, not typing: it must not insert its character.
  const typing = (modifiers & 7) === 0;
  const named = NAMED_KEYS[name.toLowerCase()];
  let spec: KeySpec;
  if (named) {
    const [key, code, keyCode, text] = named;
    spec = { key, code, keyCode, modifiers, ...(text && (typing || key === 'Enter') ? { text } : {}) };
  } else if ([...name].length === 1) {
    const shifted = (modifiers & 8) !== 0;
    let key = name, code = '', keyCode = 0;
    if (/^[a-z]$/i.test(name)) {
      key = shifted ? name.toUpperCase() : name;
      code = `Key${name.toUpperCase()}`;
      keyCode = name.toUpperCase().charCodeAt(0);
    } else if (/^[0-9]$/.test(name)) {
      code = `Digit${name}`;
      keyCode = name.charCodeAt(0);
    } else if (PUNCTUATION[name]) {
      [code, keyCode] = PUNCTUATION[name];
    }
    spec = { key, code, keyCode, modifiers, ...(typing ? { text: key } : {}) };
    const command = MAC_COMMANDS[name.toLowerCase()];
    if (platform === 'darwin' && command && (modifiers & 7) === 4) {
      spec.commands = [command === 'undo' && shifted ? 'redo' : command];
    }
  } else {
    throw new Error(`Unknown key "${name}" — use a KeyboardEvent.key name (Enter, Escape, Tab, ArrowDown, PageDown, F5, …) or a single character, optionally with Meta+/Control+/Alt+/Shift+`);
  }
  return spec;
}

// What may be loaded: the agent or the operator types `localhost:5173` as often as a full URL.
// http(s) and about:blank like every page-initiated navigation; data: too for an explicit load
// (Chromium refuses page-initiated top-level data: navigations on its own).
export function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) throw new Error('No URL to open');
  if (s === 'about:blank') return s;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[\w.-]+:\d+(?:[/?#]|$)/.test(s);
  const full = hasScheme ? s : (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(s) ? 'http://' : 'https://') + s;
  let url: URL;
  try {
    url = new URL(full);
  } catch {
    throw new Error(`Not a URL: ${raw}`);
  }
  if (!['http:', 'https:', 'data:'].includes(url.protocol)) throw new Error(`Only http(s) pages open in the session browser, not ${url.protocol} (${raw})`);
  return url.href;
}

function navigationAllowed(url: string): boolean {
  if (url === 'about:blank') return true;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(message)), ms);
  work.catch(() => {}); // a late rejection after the timeout must not go unhandled
  try {
    return await Promise.race([work, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

interface CdpException {
  text?: string;
  exception?: { description?: string; value?: unknown };
}

function exceptionMessage(details: CdpException): string {
  const ex = details.exception;
  // Our injected scripts throw plain Errors whose message is the whole story.
  if (ex?.description) return ex.description.split('\n')[0]!.replace(/^Error: /, '');
  if (ex && ex.value !== undefined) return `Uncaught ${JSON.stringify(ex.value)}`;
  return details.text ?? 'Uncaught exception';
}

interface CdpRemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

interface SessionView {
  sessionId: string;
  projectId: string;
  view: WebContentsView;
  wc: WebContents;
  // The size it was last shown at; a parked view keeps it so the page does not re-lay out.
  width: number;
  height: number;
  log: BrowserConsoleEntry[];
  // requestId → URL, for naming a failed request (Network.loadingFailed carries no URL).
  requests: Map<string, string>;
  // HTTP status of the last main-frame navigation.
  status?: number | undefined;
  agentAt: number;
  // Resolves the pending pick with null from main's side (cancel, navigation, close).
  endPick?: (() => void) | undefined;
}

export class SessionBrowsers implements BrowserHost {
  private win: BrowserWindow | undefined;
  private readonly views = new Map<string, SessionView>();
  private shown: SessionView | undefined;
  private readonly guardedPartitions = new Set<string>();

  constructor() {
    this.registerIpc();
  }

  // Bind to the app window: views are its child views, and state events go to its renderer.
  attach(win: BrowserWindow): void {
    this.win = win;
    win.on('resize', () => {
      for (const v of this.views.values()) if (v !== this.shown) this.park(v);
    });
    win.on('closed', () => {
      this.win = undefined;
      for (const id of [...this.views.keys()]) this.close(id);
    });
  }

  // ---- BrowserHost (the agent's MCP tools) ----

  async navigate(target: BrowserTarget, url: string): Promise<BrowserPageInfo & { status?: number }> {
    const v = this.ensure(target.sessionId, target.projectId);
    this.touch(v);
    await this.load(v, normalizeUrl(url));
    return { ...this.info(v), ...(v.status ? { status: v.status } : {}) };
  }

  async snapshot(target: BrowserTarget): Promise<BrowserPageInfo & { text: string }> {
    const v = this.page(target);
    this.touch(v);
    const out = await this.run<{ text: string }>(v, SNAPSHOT_SCRIPT);
    return { ...this.info(v), text: out.text || '(the page shows no text and no interactive elements)' };
  }

  async click(target: BrowserTarget, ref: string): Promise<BrowserPageInfo> {
    const v = this.page(target);
    this.touch(v);
    const at = await this.run<{ x: number; y: number } | { hidden: true }>(v, clickPointScript(ref));
    if ('hidden' in at) throw new Error(`"${ref}" is not visible on the page (zero size or scrolled out of reach)`);
    await this.settle(v, async () => {
      const base = { x: at.x, y: at.y, button: 'left', clickCount: 1 };
      await this.cdp(v, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
      await this.cdp(v, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
      await this.cdp(v, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    });
    return this.info(v);
  }

  async type(target: BrowserTarget, ref: string, text: string, opts: { clear: boolean; submit: boolean }): Promise<BrowserPageInfo> {
    const v = this.page(target);
    this.touch(v);
    const focused = await this.run<string>(v, focusFieldScript(ref, opts.clear));
    if (focused !== 'ok') {
      throw new Error(`"${ref}" is a <${focused.slice('not-editable:'.length)}>, not a text field; use browser_click for buttons, checkboxes and selects`);
    }
    await this.settle(v, async () => {
      // insertText replaces the selection the focus script made when clearing.
      if (text) await this.cdp(v, 'Input.insertText', { text });
      else if (opts.clear) await this.key(v, parseKey('Backspace'));
      if (opts.submit) await this.key(v, parseKey('Enter'));
    });
    return this.info(v);
  }

  async press(target: BrowserTarget, key: string): Promise<BrowserPageInfo> {
    const v = this.page(target);
    this.touch(v);
    const spec = parseKey(key);
    await this.settle(v, () => this.key(v, spec));
    return this.info(v);
  }

  async screenshot(target: BrowserTarget): Promise<{ data: string; mimeType: 'image/png' }> {
    const v = this.page(target);
    this.touch(v);
    const { data } = await this.cdp<{ data: string }>(v, 'Page.captureScreenshot', { format: 'png' });
    return { data, mimeType: 'image/png' };
  }

  async console(target: BrowserTarget, opts: { clear: boolean }): Promise<BrowserConsoleEntry[]> {
    const v = this.page(target);
    this.touch(v);
    const entries = [...v.log];
    if (opts.clear) v.log.length = 0;
    return entries;
  }

  async evaluate(target: BrowserTarget, expression: string): Promise<string> {
    const v = this.page(target);
    this.touch(v);
    const res = await this.cdp<{ result: CdpRemoteObject; exceptionDetails?: CdpException }>(v, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: false,
      userGesture: true,
      replMode: true, // top-level await and re-declarable let/const, as in the DevTools console
      objectGroup: 'kermanych-evaluate',
    });
    try {
      if (res.exceptionDetails) throw new Error(exceptionMessage(res.exceptionDetails));
      const json = await this.serialize(v, res.result);
      return json.length > TEXT_LIMIT ? `${json.slice(0, TEXT_LIMIT)}… (truncated, ${json.length} characters in all)` : json;
    } finally {
      void this.cdp(v, 'Runtime.releaseObjectGroup', { objectGroup: 'kermanych-evaluate' }).catch(() => {});
    }
  }

  has(sessionId: string): boolean {
    return this.views.has(sessionId);
  }

  close(sessionId: string): void {
    const v = this.views.get(sessionId);
    if (!v) return;
    this.views.delete(sessionId);
    if (this.shown === v) this.shown = undefined;
    v.endPick?.();
    if (this.win && !this.win.isDestroyed()) this.win.contentView.removeChildView(v.view);
    if (!v.wc.isDestroyed()) {
      if (v.wc.debugger.isAttached()) v.wc.debugger.detach();
      v.wc.close();
    }
  }

  // ---- The renderer's side (Браузер tab) ----

  private show(sessionId: string, projectId: string, bounds: KermanychBrowserBounds): void {
    const v = this.ensure(sessionId, projectId);
    if (this.shown && this.shown !== v) this.park(this.shown);
    this.shown = v;
    v.width = Math.max(1, Math.round(bounds.width));
    v.height = Math.max(1, Math.round(bounds.height));
    v.view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: v.width, height: v.height });
  }

  private hide(): void {
    if (!this.shown) return;
    const v = this.shown;
    this.shown = undefined;
    this.park(v);
  }

  private async pick(sessionId: string): Promise<KermanychBrowserPick | null> {
    const v = this.views.get(sessionId);
    if (!v || !v.wc.getURL()) return null;
    v.endPick?.();
    const wc = v.wc;
    const ended = Promise.withResolvers<null>();
    const onNavigate = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (details.isMainFrame && !details.isSameDocument) ended.resolve(null);
    };
    wc.on('did-start-navigation', onNavigate);
    v.endPick = () => ended.resolve(null);
    wc.focus(); // hover and Esc reach the page only while the view has focus
    let result: PickResult | null;
    try {
      const picking = wc.executeJavaScript(PICKER_SCRIPT, true) as Promise<PickResult | null>;
      picking.catch(() => {});
      result = await Promise.race([picking, ended.promise]);
    } catch {
      result = null;
    } finally {
      if (!wc.isDestroyed()) wc.off('did-start-navigation', onNavigate);
      if (v.endPick) v.endPick = undefined;
    }
    if (!result || wc.isDestroyed()) return null;
    const { clip, ...pick } = result;
    const screenshot = clip ? await this.crop(v, clip) : undefined;
    return { url: wc.getURL(), ...pick, ...(screenshot ? { screenshot } : {}) };
  }

  private async cancelPick(sessionId: string): Promise<void> {
    const v = this.views.get(sessionId);
    if (!v) return;
    v.endPick?.();
    // Takes the overlay and the swallowing listeners off the page.
    await v.wc.executeJavaScript('window.__kermanychPick && window.__kermanychPick.cancel()', true).catch(() => {});
  }

  private async crop(v: SessionView, clip: NonNullable<PickResult['clip']>): Promise<KermanychBrowserPick['screenshot']> {
    try {
      const { data } = await this.cdp<{ data: string }>(v, 'Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
      const dir = path.join(tmpdir(), 'kermanych-browser', v.sessionId.replace(/[^\w.-]/g, '_'));
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `pick-${Date.now()}.png`);
      await writeFile(file, Buffer.from(data, 'base64'));
      return { data, mimeType: 'image/png', path: file };
    } catch {
      // The pick is useful without its picture (the page navigated, the capture timed out).
      return undefined;
    }
  }

  private state(v: SessionView): KermanychBrowserState {
    return {
      sessionId: v.sessionId,
      url: v.wc.getURL(),
      title: v.wc.getTitle(),
      loading: v.wc.isLoading(),
      canGoBack: v.wc.navigationHistory.canGoBack(),
      canGoForward: v.wc.navigationHistory.canGoForward(),
      agentAt: v.agentAt,
    };
  }

  private emit(v: SessionView): void {
    if (!this.win || this.win.isDestroyed() || v.wc.isDestroyed()) return;
    this.win.webContents.send('kermanych:browser:state-changed', this.state(v));
  }

  private registerIpc(): void {
    ipcMain.on('kermanych:browser:show', (_e, sessionId: string, projectId: string, bounds: KermanychBrowserBounds) => {
      this.show(sessionId, projectId, bounds);
    });
    ipcMain.on('kermanych:browser:hide', () => this.hide());
    ipcMain.handle('kermanych:browser:navigate', async (_e, sessionId: string, projectId: string, url: string) => {
      await this.load(this.ensure(sessionId, projectId), normalizeUrl(url));
    });
    ipcMain.on('kermanych:browser:back', (_e, sessionId: string) => this.views.get(sessionId)?.wc.navigationHistory.goBack());
    ipcMain.on('kermanych:browser:forward', (_e, sessionId: string) => this.views.get(sessionId)?.wc.navigationHistory.goForward());
    ipcMain.on('kermanych:browser:reload', (_e, sessionId: string) => this.views.get(sessionId)?.wc.reload());
    ipcMain.on('kermanych:browser:devtools', (_e, sessionId: string) => this.views.get(sessionId)?.wc.openDevTools({ mode: 'detach' }));
    ipcMain.handle('kermanych:browser:pick', (_e, sessionId: string) => this.pick(sessionId));
    ipcMain.on('kermanych:browser:cancel-pick', (_e, sessionId: string) => void this.cancelPick(sessionId));
    ipcMain.handle('kermanych:browser:state', (_e, sessionId: string) => {
      const v = this.views.get(sessionId);
      return v ? this.state(v) : null;
    });
  }

  // ---- Views ----

  private window(): BrowserWindow {
    if (!this.win || this.win.isDestroyed()) throw new Error('The session browser is not available: the Kermanych window is not open');
    return this.win;
  }

  // PARK: all but the top-left pixel past the window's bottom-right corner (see the header).
  private park(v: SessionView): void {
    const [width, height] = this.window().getContentSize() as [number, number];
    v.view.setBounds({ x: width - 1, y: height - 1, width: v.width, height: v.height });
  }

  private ensure(sessionId: string, projectId: string): SessionView {
    const existing = this.views.get(sessionId);
    if (existing) return existing;
    const win = this.window();
    const partition = `persist:kermanych-browser-${projectId}`;
    this.guardPartition(partition);
    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // A parked view must keep running timers and painting for the agent.
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    const v: SessionView = {
      sessionId,
      projectId,
      view,
      wc: view.webContents,
      ...DEFAULT_SIZE,
      log: [],
      requests: new Map(),
      agentAt: 0,
    };
    this.views.set(sessionId, v);
    win.contentView.addChildView(view);
    this.park(v);
    this.wire(v);
    this.attachDebugger(v);
    return v;
  }

  // Once per partition (a project's sessions share one): page permission prompts have nobody
  // to answer them, so everything but clipboard writes and fullscreen is refused.
  private guardPartition(partition: string): void {
    if (this.guardedPartitions.has(partition)) return;
    this.guardedPartitions.add(partition);
    session.fromPartition(partition).setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write' || permission === 'fullscreen');
    });
  }

  private wire(v: SessionView): void {
    const { wc } = v;
    // Popups (target=_blank, window.open) open in the same view: there is one view per session.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void wc.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    const guard = (e: Electron.Event<{ url: string }>) => {
      if (!navigationAllowed(e.url)) e.preventDefault();
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);

    const emit = () => this.emit(v);
    wc.on('did-start-loading', emit);
    wc.on('did-stop-loading', emit);
    wc.on('did-navigate', (_e, _url, httpResponseCode) => {
      v.status = httpResponseCode > 0 ? httpResponseCode : undefined;
      emit();
    });
    wc.on('did-navigate-in-page', emit);
    wc.on('page-title-updated', emit);

    wc.on('console-message', (details) => {
      // Electron's own dev-build security banner, not the page's.
      if (details.sourceId.startsWith('node:electron/')) return;
      this.record(v, {
        level: details.level,
        text: details.message,
        ...(details.sourceId ? { source: `${details.sourceId}:${details.lineNumber}` } : {}),
        at: Date.now(),
      });
    });
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (errorCode === -3) return; // ERR_ABORTED: superseded by another navigation
      this.record(v, { level: 'page', text: `${isMainFrame ? 'Page' : 'Frame'} failed to load: ${errorDescription} (${errorCode})`, source: validatedURL, at: Date.now() });
    });
    wc.debugger.on('message', (_e, method, params) => {
      if (method === 'Network.requestWillBeSent') {
        v.requests.set(params.requestId, params.request.url);
      } else if (method === 'Network.responseReceived') {
        const { status, statusText, url } = params.response as { status: number; statusText: string; url: string };
        if (status >= 400) this.record(v, { level: 'network', text: `HTTP ${status}${statusText ? ` ${statusText}` : ''}`, source: url, at: Date.now() });
      } else if (method === 'Network.loadingFinished') {
        v.requests.delete(params.requestId);
      } else if (method === 'Network.loadingFailed') {
        const url = v.requests.get(params.requestId);
        v.requests.delete(params.requestId);
        if (!params.canceled) this.record(v, { level: 'network', text: `Request failed: ${params.errorText}${params.blockedReason ? ` (${params.blockedReason})` : ''}`, ...(url ? { source: url } : {}), at: Date.now() });
      }
    });
    wc.on('destroyed', () => {
      if (this.views.get(v.sessionId) === v) this.close(v.sessionId);
    });
  }

  private attachDebugger(v: SessionView): void {
    try {
      v.wc.debugger.attach('1.3');
    } catch (err) {
      throw new Error(`Could not attach to the session browser's page: ${(err as Error).message}`);
    }
    v.requests.clear();
    void v.wc.debugger.sendCommand('Network.enable').catch(() => {});
    // The view rarely has OS focus (the operator works in the app, the view may be parked);
    // without this the page sees blur and some inputs ignore synthetic typing.
    void v.wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  }

  private record(v: SessionView, entry: BrowserConsoleEntry): void {
    v.log.push(entry);
    if (v.log.length > CONSOLE_LIMIT) v.log.splice(0, v.log.length - CONSOLE_LIMIT);
  }

  private touch(v: SessionView): void {
    v.agentAt = Date.now();
    this.emit(v);
  }

  private info(v: SessionView): BrowserPageInfo {
    return { url: v.wc.getURL(), title: v.wc.getTitle() };
  }

  // The session's view with a page in it, for every tool but navigate.
  private page(target: BrowserTarget): SessionView {
    const v = this.views.get(target.sessionId);
    if (!v || !v.wc.getURL()) throw new Error('This session has no page open yet — call browser_navigate first');
    return v;
  }

  private async cdp<T = unknown>(v: SessionView, method: string, params?: object): Promise<T> {
    if (v.wc.isDestroyed()) throw new Error('The session browser was closed');
    // DevTools' "detach" or a crashed renderer drops the session; take it back on next use.
    if (!v.wc.debugger.isAttached()) this.attachDebugger(v);
    return withTimeout(
      v.wc.debugger.sendCommand(method, params) as Promise<T>,
      CDP_TIMEOUT_MS,
      `The page did not answer ${method} within ${CDP_TIMEOUT_MS / 1000}s`,
    );
  }

  // An injected script's value; a thrown error becomes the tool's error.
  private async run<T>(v: SessionView, expression: string): Promise<T> {
    const res = await this.cdp<{ result: CdpRemoteObject; exceptionDetails?: CdpException }>(v, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) throw new Error(exceptionMessage(res.exceptionDetails));
    return res.result.value as T;
  }

  // JSON text of an evaluate result; objects JSON cannot express (DOM nodes, functions,
  // cyclic graphs) fall back to the DevTools description (`div#app`, `ƒ foo()`).
  private async serialize(v: SessionView, obj: CdpRemoteObject): Promise<string> {
    if (obj.type === 'undefined') return 'undefined';
    if (obj.unserializableValue) return obj.unserializableValue;
    if (!obj.objectId) return JSON.stringify(obj.value ?? null);
    const res = await this.cdp<{ result: CdpRemoteObject }>(v, 'Runtime.callFunctionOn', {
      objectId: obj.objectId,
      functionDeclaration: 'function () { if (this instanceof Node || typeof this === "function") return undefined; try { return JSON.stringify(this); } catch { return undefined; } }',
      returnByValue: true,
    });
    return typeof res.result.value === 'string' ? res.result.value : (obj.description ?? obj.type);
  }

  private async key(v: SessionView, spec: KeySpec): Promise<void> {
    const base = { modifiers: spec.modifiers, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode };
    await this.cdp(v, 'Input.dispatchKeyEvent', {
      type: spec.text ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {}),
      ...(spec.commands ? { commands: spec.commands } : {}),
    });
    await this.cdp(v, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  private async load(v: SessionView, url: string): Promise<void> {
    v.status = undefined;
    const loading = v.wc.loadURL(url).then(
      () => undefined,
      (err: Error & { code?: string }) => (err.code === 'ERR_ABORTED' ? undefined : err),
    );
    const failure = await Promise.race([loading, sleep(SETTLE_MS).then(() => undefined)]);
    if (failure) throw new Error(`Could not load ${url}: ${failure.code ?? failure.message}`);
  }

  // Run an input action, then give the page a moment; if it started a document navigation,
  // wait (bounded) for that load to finish so the agent's next look sees the new page.
  private async settle(v: SessionView, action: () => Promise<void>): Promise<void> {
    const { wc } = v;
    let navigating = false;
    const onStart = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (details.isMainFrame && !details.isSameDocument) navigating = true;
    };
    wc.on('did-start-navigation', onStart);
    try {
      await action();
      await sleep(300);
      if ((navigating || wc.isLoadingMainFrame()) && wc.isLoading()) {
        const { promise, resolve } = Promise.withResolvers<void>();
        wc.once('did-stop-loading', () => resolve());
        await Promise.race([promise, sleep(SETTLE_MS)]);
      }
    } finally {
      if (!wc.isDestroyed()) wc.off('did-start-navigation', onStart);
    }
  }
}
