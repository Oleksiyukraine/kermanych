// A standalone HTML document to PDF bytes, through Chromium's own print pipeline. The
// register export is prose in any script — Ukrainian first — and Chromium lays it out with
// the system's fonts, which no JavaScript PDF writer does without shipping a font file.
//
// The document is loaded from a temp file (a data: URL of a large Cyrillic register runs
// into Chromium's URL length limit) into a hidden window with JavaScript OFF: the HTML is
// built by the renderer from register rows, and nothing in it has any business running.
import { BrowserWindow } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Page numbers in the bottom margin the document's own `@page` rule leaves free.
const FOOTER =
  '<div style="width:100%;padding:0 10mm;font:7pt -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#6b6b76;text-align:right">' +
  '<span class="pageNumber"></span> / <span class="totalPages"></span></div>';

export async function htmlToPdf(html: string): Promise<Uint8Array> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kermanych-pdf-'));
  const file = path.join(dir, 'export.html');
  const win = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true },
  });
  try {
    await writeFile(file, html, 'utf8');
    await win.loadFile(file);
    return await win.webContents.printToPDF({
      printBackground: true,
      // The document's `@page { size: A4 landscape; margin: … }` is the layout of record, so
      // the browser print fallback and this path produce the same pages.
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: FOOTER,
    });
  } finally {
    win.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}
