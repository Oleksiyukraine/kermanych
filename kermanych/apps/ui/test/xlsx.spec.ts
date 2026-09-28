import { describe, it, expect } from 'vitest';
import { crc32 } from 'node:zlib';
import { columnName, sheetName, xlsxWorkbook } from '../src/lib/xlsx';

// The workbook is a hand-written ZIP of hand-written XML, so the failure modes are the silent
// ones: a CRC or an offset off by one is a file Excel «repairs» into nothing, and one
// unescaped `<` in a risk statement is a file that does not open at all.

// Walks the local headers of a STORE archive. Deliberately not the writer's own logic: the
// CRC is checked against node's zlib, and names/sizes are read back from the bytes.
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, string>();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    expect(view.getUint16(at + 8, true)).toBe(0); // STORE
    const crc = view.getUint32(at + 14, true);
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const data = bytes.subarray(at + 30 + nameLen + extraLen, at + 30 + nameLen + extraLen + size);
    expect(crc32(data), name).toBe(crc);
    out.set(name, new TextDecoder().decode(data));
    at += 30 + nameLen + extraLen + size;
  }
  // What follows the entries is the central directory, and the end record points back at it.
  expect(view.getUint32(at, true)).toBe(0x02014b50);
  const eocd = bytes.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  expect(view.getUint16(eocd + 10, true)).toBe(out.size);
  expect(view.getUint32(eocd + 16, true)).toBe(at);
  expect(eocd - at).toBe(view.getUint32(eocd + 12, true));
  return out;
}

describe('columnName', () => {
  it('rolls over from Z to AA and from AZ to BA', () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
});

describe('sheetName', () => {
  it('drops the characters Excel refuses and keeps it within 31 chars', () => {
    expect(sheetName('Q3 [draft]: risks/issues?')).toBe('Q3  draft   risks issues');
    expect(sheetName('Реєстр ризиків воркспейсу з дуже довгою назвою')).toHaveLength(31);
    expect(sheetName(' / ')).toBe('Sheet1');
  });
});

describe('xlsxWorkbook', () => {
  const files = unzip(
    xlsxWorkbook({
      name: "Owner's register",
      columns: [
        { label: 'ID', width: 8 },
        { label: 'Причина', width: 30 },
        { label: 'P', width: 6 },
        { label: 'EMV', width: 10 },
      ],
      rows: [
        ['R-001', 'API <v2> & "legacy"\u0007 client', 4, undefined],
        ['R-002', '=HYPERLINK("http://x")', 2.5, Number.NaN],
      ],
    }),
  );
  const sheet = files.get('xl/worksheets/sheet1.xml')!;

  it('packs every part the content types declare', () => {
    expect([...files.keys()].sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
  });

  it('writes the header row bold and the rows under it', () => {
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">ID</t></is></c>');
    expect(sheet).toContain('<c r="B1" s="1" t="inlineStr"><is><t xml:space="preserve">Причина</t></is></c>');
    expect(sheet).toContain('<row r="3">');
  });

  it('escapes markup and strips characters XML cannot carry', () => {
    expect(sheet).toContain('API &lt;v2&gt; &amp; &quot;legacy&quot; client');
    expect(sheet).not.toContain('\u0007');
  });

  it('keeps numbers numeric and leaves empty and non-finite cells out', () => {
    expect(sheet).toContain('<c r="C2"><v>4</v></c>');
    expect(sheet).toContain('<c r="C3"><v>2.5</v></c>');
    expect(sheet).not.toContain('r="D2"');
    expect(sheet).not.toContain('r="D3"');
  });

  it('stores a formula-looking value as text, never as a formula', () => {
    expect(sheet).toContain('t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;http://x&quot;)</t>');
    expect(sheet).not.toContain('<f>');
  });

  it('points the filter at the header and the rows, quoting the sheet name', () => {
    expect(sheet).toContain('<autoFilter ref="A1:D3"/>');
    expect(files.get('xl/workbook.xml')).toContain("'Owner''s register'!$A$1:$D$3");
  });
});
