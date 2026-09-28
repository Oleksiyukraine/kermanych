// apps/ui/src/lib/export-file.ts
// Getting an export out of the app and onto the operator's disk. One path for every format:
// the bytes become a Blob and an <a download> click hands them to the browser — which, in
// the desktop build, is Electron's download handler and its native Save dialog.
//
// A PDF needs bytes first. The desktop build has them from main (Chromium's printToPDF over
// the same HTML, src-electron/print-pdf.ts). A plain browser tab has no API that renders
// HTML to a PDF file, so there the document opens in the print dialog, where «Save as PDF»
// is the destination — the same pages, one click further away.
import type { WorkspaceRisk } from '@kermanych/cloud';
import {
  riskExportFileName,
  riskRegisterHtml,
  riskRegisterSheet,
  type RiskExportContext,
  type RiskExportFormat,
} from './risk-export';
import { XLSX_MIME, xlsxWorkbook } from './xlsx';

export const PDF_MIME = 'application/pdf';

export function saveFile(fileName: string, data: BlobPart, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoked late, not on the next line: the download reads the URL asynchronously, and
  // Electron's Save dialog holds it for as long as the operator takes to pick a folder.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Answers where the document went: a file handed to the Save dialog, or the print dialog
// (a plain browser tab), because the two ask different things of the operator next.
export async function savePdf(fileName: string, html: string): Promise<'file' | 'print'> {
  const printToPdf = window.kermanych?.printToPdf;
  if (!printToPdf) {
    await printInFrame(html);
    return 'print';
  }
  const bytes = await printToPdf(html);
  // Copied into a fresh ArrayBuffer-backed view: what arrives over IPC may be a view onto a
  // larger shared buffer, and a Blob built from that would carry its neighbours too.
  saveFile(fileName, new Uint8Array(bytes), PDF_MIME);
  return 'file';
}

export type SavedExport = { fileName: string; via: 'file' | 'print' };

// The risk register as a file, in the format asked for — the ONE call behind both the Risk
// Registry's Export dialog and the Менеджмент assistant's `risk.export`, so a file asked for
// in the chat is the file the button makes.
export async function saveRiskRegister(
  rows: readonly WorkspaceRisk[],
  ctx: RiskExportContext,
  format: RiskExportFormat,
): Promise<SavedExport> {
  const fileName = riskExportFileName(ctx, format);
  if (format === 'pdf') return { fileName, via: await savePdf(fileName, riskRegisterHtml(rows, ctx)) };
  saveFile(fileName, xlsxWorkbook(riskRegisterSheet(rows, ctx)), XLSX_MIME);
  return { fileName, via: 'file' };
}

// A hidden iframe rather than a new window: no popup blocker, no stray tab left behind, and
// the app's own stylesheet cannot reach into the document. The file name the dialog offers is
// the document's <title>.
//
// Resolved as soon as the document is ready and print() runs on the next task, so the caller
// can close its own dialog first: Chromium blocks inside print() until the print dialog is
// dismissed. The frame goes on `afterprint`, not when print() returns — Firefox returns at
// once with its preview still reading the frame.
function printInFrame(html: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  frame.onload = () => {
    const win = frame.contentWindow;
    resolve();
    if (!win) {
      frame.remove();
      return;
    }
    win.addEventListener('afterprint', () => frame.remove(), { once: true });
    setTimeout(() => {
      win.focus();
      win.print();
    }, 0);
  };
  frame.srcdoc = html;
  document.body.append(frame);
  return promise;
}
