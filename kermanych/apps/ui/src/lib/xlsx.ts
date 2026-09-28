// apps/ui/src/lib/xlsx.ts
// A one-sheet .xlsx workbook, written by hand. An export needs a header row, typed cells and
// column widths — a small, fixed slice of SpreadsheetML — and every library that writes the
// format is either a megabyte of bundle for features this never uses or the unmaintained
// npm build of SheetJS. The package is a ZIP of six XML parts, stored uncompressed: Excel,
// Numbers, LibreOffice and Google Sheets all open a STORE archive, and the files this writes
// are far too small for deflate to matter.
//
// Pure and DOM-free, so apps/ui/test/xlsx.spec.ts can unzip what it writes and read it back.

export type XlsxCell = string | number | undefined;

export type XlsxColumn = {
  label: string;
  // Excel's own unit: roughly the number of '0' characters that fit.
  width: number;
};

export type XlsxSheet = {
  name: string;
  columns: readonly XlsxColumn[];
  rows: readonly (readonly XlsxCell[])[];
};

// Excel refuses a cell longer than this and «repairs» the whole file to say so.
const MAX_CELL_CHARS = 32_767;

// Code points XML 1.0 has no representation for, even escaped. A pasted log line can carry
// them, and one of them in a single cell makes the whole workbook unreadable.
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

function xml(s: string): string {
  return s
    .replace(XML_INVALID, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// A sheet name is at most 31 characters and may not contain []:*?/\ — Excel rejects the file
// otherwise, and a workspace name is free text.
export function sheetName(raw: string): string {
  const name = raw.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31).trim();
  return name || 'Sheet1';
}

// 0 -> A, 25 -> Z, 26 -> AA.
export function columnName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// Style 1 is the bold header; style 0 (every other cell) wraps and top-aligns, so a
// multi-line response plan stays readable instead of spilling across its neighbours.
function cell(ref: string, value: XlsxCell, style: 0 | 1): string {
  const s = style ? ' s="1"' : '';
  if (value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? `<c r="${ref}"${s}><v>${value}</v></c>` : '';
  if (value === '') return '';
  // Inline strings rather than a shared-string table: one part fewer, and a value that
  // starts with `=` stays text — an inline string is never evaluated as a formula.
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xml(value.slice(0, MAX_CELL_CHARS))}</t></is></c>`;
}

function row(index: number, values: readonly XlsxCell[], style: 0 | 1): string {
  const r = index + 1;
  return `<row r="${r}">${values.map((v, c) => cell(`${columnName(c)}${r}`, v, style)).join('')}</row>`;
}

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function sheetXml(sheet: XlsxSheet): string {
  const lastCol = columnName(Math.max(sheet.columns.length, 1) - 1);
  const range = `A1:${lastCol}${sheet.rows.length + 1}`;
  const cols = sheet.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`)
    .join('');
  const data = [row(0, sheet.columns.map((c) => c.label), 1), ...sheet.rows.map((r, i) => row(i + 1, r, 0))].join('');
  return (
    `${HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    // The header row stays put while the register scrolls under it.
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${data}</sheetData>` +
    `<autoFilter ref="${range}"/>` +
    '</worksheet>'
  );
}

function workbookXml(sheet: XlsxSheet): string {
  const name = sheetName(sheet.name);
  const lastCol = columnName(Math.max(sheet.columns.length, 1) - 1);
  // The filter's defined name is what Excel itself writes beside an autoFilter; without it
  // some versions drop the filter buttons on open.
  const quoted = `'${name.replace(/'/g, "''")}'`;
  return (
    `${HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<sheets><sheet name="${xml(name)}" sheetId="1" r:id="rId1"/></sheets>` +
    `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${xml(
      `${quoted}!$A$1:$${lastCol}$${sheet.rows.length + 1}`,
    )}</definedName></definedNames>` +
    '</workbook>'
  );
}

const STYLES =
  `${HEAD}<styleSheet xmlns="${NS_MAIN}">` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

const CONTENT_TYPES =
  `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

const ROOT_RELS =
  `${HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
  '</Relationships>';

const WORKBOOK_RELS =
  `${HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/>` +
  '</Relationships>';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function xlsxWorkbook(sheet: XlsxSheet): Uint8Array<ArrayBuffer> {
  const utf8 = new TextEncoder();
  return zipStore([
    { name: '[Content_Types].xml', data: utf8.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: utf8.encode(ROOT_RELS) },
    { name: 'xl/workbook.xml', data: utf8.encode(workbookXml(sheet)) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8.encode(WORKBOOK_RELS) },
    { name: 'xl/styles.xml', data: utf8.encode(STYLES) },
    { name: 'xl/worksheets/sheet1.xml', data: utf8.encode(sheetXml(sheet)) },
  ]);
}

// ── ZIP, STORE method only ──────────────────────────────────────────────────────
// PKWARE APPNOTE 4.3: a local header + data per entry, then the central directory, then the
// end-of-central-directory record. No compression, no ZIP64 (an export is kilobytes), and a
// fixed 1980-01-01 timestamp so the same register always zips to the same bytes.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;

function zipStore(files: readonly { name: string; data: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const utf8 = new TextEncoder();
  const entries = files.map((f) => ({ name: utf8.encode(f.name), data: f.data, crc: crc32(f.data) }));
  const localSize = entries.reduce((n, e) => n + 30 + e.name.length + e.data.length, 0);
  const centralSize = entries.reduce((n, e) => n + 46 + e.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (v: number): void => {
    view.setUint16(at, v, true);
    at += 2;
  };
  const u32 = (v: number): void => {
    view.setUint32(at, v, true);
    at += 4;
  };
  const bytes = (b: Uint8Array): void => {
    out.set(b, at);
    at += b.length;
  };

  const offsets: number[] = [];
  for (const e of entries) {
    offsets.push(at);
    u32(0x04034b50);
    u16(20); // version needed: 2.0
    u16(0x0800); // flags: UTF-8 names
    u16(0); // method: STORE
    u16(0); // time
    u16(DOS_DATE_1980_01_01);
    u32(e.crc);
    u32(e.data.length); // compressed size
    u32(e.data.length); // uncompressed size
    u16(e.name.length);
    u16(0); // extra length
    bytes(e.name);
    bytes(e.data);
  }

  const centralAt = at;
  entries.forEach((e, i) => {
    u32(0x02014b50);
    u16(20); // version made by
    u16(20); // version needed
    u16(0x0800);
    u16(0);
    u16(0);
    u16(DOS_DATE_1980_01_01);
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.name.length);
    u16(0); // extra length
    u16(0); // comment length
    u16(0); // disk number
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(offsets[i]!);
    bytes(e.name);
  });

  u32(0x06054b50);
  u16(0); // this disk
  u16(0); // disk with the central directory
  u16(entries.length);
  u16(entries.length);
  u32(centralSize);
  u32(centralAt);
  u16(0); // comment length
  return out;
}
