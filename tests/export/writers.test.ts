import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { CsvWriter, csvField, guardFormula } from '../../src/export/csv.js';
import { XlsxWriter, columnLetters, excelSerial, xlsxCell } from '../../src/export/xlsx.js';
import type { ExportColumn } from '../../src/export/writer.js';

const columns: ExportColumn[] = [
  { name: 'ORDERNO', kind: 'int', masked: false },
  { name: 'NOTE', kind: 'string', masked: false },
  { name: 'AMOUNT', kind: 'decimal', masked: false },
  { name: 'CREATED', kind: 'timestamp', masked: false },
  { name: 'EMAIL', kind: 'string', masked: true },
];

const rows: unknown[][] = [
  [1001, 'Rush, "fragile"', -12.5, '2026-09-26 17:30:05.500000', '****'],
  [1002, '=HYPERLINK("http://example.com")', '12345678901234567890.12', null, null],
];

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'db2i-export-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('CSV', () => {
  it('guards text that starts a formula, and leaves numbers alone', () => {
    expect(guardFormula('=1+1')).toBe("'=1+1");
    expect(guardFormula('+358 40 123')).toBe("'+358 40 123");
    expect(guardFormula('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(guardFormula('＝1')).toBe("'＝1");
    expect(guardFormula('plain')).toBe('plain');
    expect(csvField(-12.5, { name: 'A', kind: 'decimal', masked: false })).toBe('-12.5');
    expect(csvField('-12.50', { name: 'A', kind: 'decimal', masked: false })).toBe('-12.50');
    expect(csvField('-12.50', { name: 'A', kind: 'string', masked: false })).toBe("'-12.50");
  });

  it('writes a BOM, a header, quoted fields and CRLF line ends', async () => {
    const path = join(dir, 'out.csv');
    const writer = new CsvWriter(path);
    await writer.writeHeader(columns);
    await writer.writeRows(rows);
    await writer.finish();

    const text = await readFile(path, 'utf8');
    expect(text.startsWith('﻿ORDERNO,NOTE,AMOUNT,CREATED,EMAIL\r\n')).toBe(true);
    expect(text).toContain('1001,"Rush, ""fragile""",-12.5,2026-09-26 17:30:05.500000,****\r\n');
    expect(text).toContain(`1002,"'=HYPERLINK(""http://example.com"")",12345678901234567890.12,,\r\n`);
    expect(writer.bytes).toBe(Buffer.byteLength(text, 'utf8'));
  });

  it('refuses to overwrite an existing file', async () => {
    const path = join(dir, 'taken.csv');
    await writeFile(path, 'x');
    const writer = new CsvWriter(path);
    await expect(writer.writeHeader(columns)).rejects.toThrow(/EEXIST/);
    await writer.abort();
  });
});

describe('XLSX cells', () => {
  it('names columns like Excel', () => {
    expect(columnLetters(0)).toBe('A');
    expect(columnLetters(25)).toBe('Z');
    expect(columnLetters(26)).toBe('AA');
    expect(columnLetters(701)).toBe('ZZ');
    expect(columnLetters(702)).toBe('AAA');
  });

  it('turns dates, times and timestamps into Excel serial numbers', () => {
    expect(excelSerial('1970-01-01', 'date')).toBe(25569);
    expect(excelSerial('2026-09-26', 'date')).toBe(46291);
    expect(excelSerial('12:00:00', 'time')).toBe(0.5);
    expect(excelSerial('2026-09-26 18:00:00.000000', 'timestamp')).toBe(46291.75);
    expect(excelSerial('2026-02-30', 'date')).toBeUndefined();
    expect(excelSerial('1900-01-15', 'date')).toBeUndefined();
    expect(excelSerial('09/26/26', 'date')).toBeUndefined();
  });

  it('keeps numbers typed, wide decimals and masked values as text, and skips nulls', () => {
    expect(xlsxCell(-12.5, { name: 'A', kind: 'decimal', masked: false }, 'C2')).toBe('<c r="C2"><v>-12.5</v></c>');
    expect(xlsxCell('12345678901234567890.12', { name: 'A', kind: 'decimal', masked: false }, 'C3')).toContain(
      't="inlineStr"'
    );
    expect(xlsxCell(5550100, { name: 'A', kind: 'int', masked: true }, 'A2')).toContain('t="inlineStr"');
    expect(xlsxCell(null, { name: 'A', kind: 'string', masked: false }, 'A2')).toBe('');
    expect(xlsxCell('2026-09-26', { name: 'A', kind: 'date', masked: false }, 'D2')).toBe(
      '<c r="D2" s="2"><v>46291</v></c>'
    );
  });

  it('writes formula-looking text as text, escapes XML, and drops illegal characters', () => {
    const cell = xlsxCell('=1+1 <b>&\u0001', { name: 'A', kind: 'string', masked: false }, 'B2');
    expect(cell).toBe('<c r="B2" t="inlineStr"><is><t>=1+1 &lt;b&gt;&amp;</t></is></c>');
    expect(cell).not.toContain('<f>');
  });

  it('keeps leading and trailing spaces with xml:space, and only then', () => {
    const column: ExportColumn = { name: 'A', kind: 'string', masked: false };
    expect(xlsxCell('  indented', column, 'A2')).toContain('<t xml:space="preserve">  indented</t>');
    expect(xlsxCell('plain text', column, 'A2')).toContain('<t>plain text</t>');
  });

  it('cuts text at the Excel cell limit', () => {
    const cell = xlsxCell('x'.repeat(40_000), { name: 'A', kind: 'string', masked: false }, 'A2');
    expect(/<t>(x*)<\/t>/.exec(cell)?.[1].length).toBe(32_767);
  });
});

describe('XLSX file', () => {
  it('writes a workbook with typed cells, a frozen bold header and an autofilter', async () => {
    const path = join(dir, 'out.xlsx');
    const writer = new XlsxWriter(path, 'Orders');
    await writer.writeHeader(columns);
    await writer.writeRows(rows);
    await writer.finish();

    const files = unzipSync(new Uint8Array(await readFile(path)));
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<row r="1"><c r="A1" s="1" t="inlineStr"><is><t>ORDERNO</t>');
    expect(sheet).toContain('<c r="A2"><v>1001</v></c>');
    // 17:30:05.5 is 63005.5 seconds into the day
    expect(sheet).toContain(`<c r="D2" s="3"><v>${46291 + 63005.5 / 86400}</v></c>`);
    expect(sheet).toContain('<autoFilter ref="A1:E3"/>');
    expect(sheet).not.toContain('<f>');
    expect(strFromU8(files['xl/workbook.xml'])).toContain(`'Orders'!$A$1:$E$3`);
    expect(strFromU8(files['xl/styles.xml'])).toContain('<name val="Arial"/>');
    expect(writer.bytes).toBeGreaterThan(0);
    expect(writer.rawBytes).toBe(Buffer.byteLength(sheet, 'utf8'));
  });

  it('shows every digit of a decimal scale with a number format, and leaves scale 0 and masked columns alone', async () => {
    const path = join(dir, 'decimals.xlsx');
    const writer = new XlsxWriter(path);
    await writer.writeHeader([
      { name: 'AMOUNT', kind: 'decimal', masked: false, scale: 2 },
      { name: 'QTY', kind: 'decimal', masked: false, scale: 3 },
      { name: 'PRICE', kind: 'decimal', masked: false, scale: 2 },
      { name: 'ORDDATE', kind: 'decimal', masked: false, scale: 0 },
      { name: 'SECRET', kind: 'decimal', masked: true, scale: 2 },
    ]);
    await writer.writeRows([[72.5, 3, 9.99, 20260926, '****']]);
    await writer.finish();

    const files = unzipSync(new Uint8Array(await readFile(path)));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
    const styles = strFromU8(files['xl/styles.xml']);
    expect(styles).toContain('<numFmt numFmtId="167" formatCode="#,##0.00"/>');
    expect(styles).toContain('<numFmt numFmtId="168" formatCode="#,##0.000"/>');
    expect(styles).toContain('<cellXfs count="7">');
    expect(sheet).toContain('<c r="A2" s="5"><v>72.5</v></c>');
    expect(sheet).toContain('<c r="B2" s="6"><v>3</v></c>');
    // Same scale, same style
    expect(sheet).toContain('<c r="C2" s="5"><v>9.99</v></c>');
    expect(sheet).toContain('<c r="D2"><v>20260926</v></c>');
    expect(sheet).toContain('<c r="E2" t="inlineStr">');
  });

  it('writes a valid empty workbook when there are no rows', async () => {
    const path = join(dir, 'empty.xlsx');
    const writer = new XlsxWriter(path);
    await writer.writeHeader(columns);
    await writer.finish();

    const sheet = strFromU8(unzipSync(new Uint8Array(await readFile(path)))['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('<autoFilter ref="A1:E1"/>');
  });
});
