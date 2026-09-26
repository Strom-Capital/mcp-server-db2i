/**
 * XLSX export writer.
 *
 * Writes the smallest workbook Excel, LibreOffice and Numbers open: one sheet,
 * a styles part, and the package relationships. The sheet is streamed into a
 * zip entry with fflate as rows arrive, so memory stays flat however many rows
 * there are. The small parts are added at the end, when the row count for the
 * autofilter range is known.
 *
 * Cells hold values, never formulas. Text is written inline (`inlineStr`), so
 * there is no shared-strings table to build in memory, and text that starts
 * with `=` stays text. Numbers, dates, times and timestamps keep their types.
 */

import { Zip, ZipDeflate } from 'fflate';
import type { ExportColumn, ExportWriter } from './writer.js';
import { FileSink } from './writer.js';

/** Excel's limit on rows in one sheet, the header included. */
export const XLSX_MAX_ROWS = 1_048_576;

/** Excel's limit on characters in one cell. */
export const XLSX_MAX_CELL_CHARS = 32_767;

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Style indexes in styles.xml cellXfs. */
const STYLE_HEADER = 1;
const STYLE_DATE = 2;
const STYLE_TIMESTAMP = 3;
const STYLE_TIME = 4;

// XML 1.0 does not allow C0 control characters other than tab, CR and LF,
// or the non-characters U+FFFE and U+FFFF.
// eslint-disable-next-line no-control-regex
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_TEXT = /^(\d{2}):(\d{2}):(\d{2})$/;
const TIMESTAMP_TEXT = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;

/** Days between Excel's day zero (1899-12-30) and the Unix epoch. */
const EXCEL_EPOCH_DAYS = 25_569;

export function escapeXml(text: string): string {
  return text
    .replace(XML_ILLEGAL, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Column letters for a zero-based index: 0 is A, 25 is Z, 26 is AA. */
export function columnLetters(index: number): string {
  let letters = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function dayNumber(year: number, month: number, day: number): number | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }
  // Date.UTC works in whole UTC days, so no time zone can shift the result
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return undefined;
  }
  return utc / 86_400_000 + EXCEL_EPOCH_DAYS;
}

function dayFraction(hours: number, minutes: number, seconds: number, fraction = 0): number | undefined {
  if (hours > 24 || minutes > 59 || seconds > 59) {
    return undefined;
  }
  return (hours * 3600 + minutes * 60 + seconds + fraction) / 86_400;
}

/**
 * The Excel serial number for normalized date, time or timestamp text, or
 * undefined when the text is in another format and should stay text.
 * Dates before 1900-03-01 fall in Excel's 1900 leap-year quirk and stay text.
 */
export function excelSerial(text: string, kind: 'date' | 'time' | 'timestamp'): number | undefined {
  if (kind === 'time') {
    const match = TIME_TEXT.exec(text);
    return match ? dayFraction(Number(match[1]), Number(match[2]), Number(match[3])) : undefined;
  }
  const match = (kind === 'date' ? DATE_TEXT : TIMESTAMP_TEXT).exec(text);
  if (!match) {
    return undefined;
  }
  const day = dayNumber(Number(match[1]), Number(match[2]), Number(match[3]));
  if (day === undefined || day < 61) {
    return undefined;
  }
  if (kind === 'date') {
    return day;
  }
  const fraction = match[7] ? Number(`0.${match[7]}`) : 0;
  const time = dayFraction(Number(match[4]), Number(match[5]), Number(match[6]), fraction);
  return time === undefined ? undefined : day + time;
}

/** Leading or trailing whitespace, which a reader drops unless told to keep it. */
const EDGE_SPACE = /^\s|\s$/;

function inlineString(ref: string, text: string, style?: number): string {
  const clipped = text.length > XLSX_MAX_CELL_CHARS ? text.slice(0, XLSX_MAX_CELL_CHARS) : text;
  const styleAttr = style ? ` s="${style}"` : '';
  // Excel and openpyxl add xml:space only when it matters; the schema has no
  // attribute on <t>, so plain text stays schema-valid without it.
  const space = EDGE_SPACE.test(clipped) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t${space}>${escapeXml(clipped)}</t></is></c>`;
}

/**
 * One cell as sheet XML. Null has no cell at all.
 *
 * @param numberStyle - Style for a numeric value, such as a decimal format with the column's scale
 */
export function xlsxCell(value: unknown, column: ExportColumn, ref: string, numberStyle?: number): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (column.masked) {
    return inlineString(ref, String(value));
  }
  switch (column.kind) {
    case 'int':
    case 'bigint':
    case 'decimal':
    case 'float':
      if (typeof value === 'number' && Number.isFinite(value)) {
        const style = numberStyle ? ` s="${numberStyle}"` : '';
        return `<c r="${ref}"${style}><v>${value}</v></c>`;
      }
      // Wider than a double holds exactly, so it stays exact text
      return inlineString(ref, String(value));
    case 'date':
    case 'time':
    case 'timestamp': {
      const serial = typeof value === 'string' ? excelSerial(value, column.kind) : undefined;
      if (serial === undefined) {
        return inlineString(ref, String(value));
      }
      const style = column.kind === 'date' ? STYLE_DATE : column.kind === 'time' ? STYLE_TIME : STYLE_TIMESTAMP;
      return `<c r="${ref}" s="${style}"><v>${serial}</v></c>`;
    }
    default:
      return inlineString(ref, typeof value === 'string' ? value : String(value));
  }
}

const CONTENT_TYPES =
  `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

const ROOT_RELS =
  `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
  '</Relationships>';

const WORKBOOK_RELS =
  `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/>` +
  '</Relationships>';

/** Cell styles before the decimal formats: default, header, date, timestamp, time. */
const FIXED_STYLE_COUNT = 5;

/** Most decimal places a format shows. Db2 allows up to 63. */
const MAX_FORMAT_SCALE = 15;

/**
 * Number format for a decimal scale: `#,##0.00` for scale 2. The thousands
 * separator and decimal point follow the reader's locale.
 */
export function decimalFormat(scale: number): string {
  return `#,##0.${'0'.repeat(scale)}`;
}

/**
 * styles.xml with a format for each decimal scale the sheet uses. The scale
 * with index i gets cell style FIXED_STYLE_COUNT + i.
 */
function stylesXml(scales: readonly number[]): string {
  const decimalFormats = scales
    .map((scale, index) => `<numFmt numFmtId="${167 + index}" formatCode="${decimalFormat(scale)}"/>`)
    .join('');
  const decimalStyles = scales
    .map((_scale, index) => `<xf numFmtId="${167 + index}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`)
    .join('');
  return (
    `${XML_DECL}<styleSheet xmlns="${NS_MAIN}">` +
    `<numFmts count="${3 + scales.length}">` +
    '<numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/>' +
    '<numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/>' +
    '<numFmt numFmtId="166" formatCode="hh:mm:ss"/>' +
    decimalFormats +
    '</numFmts>' +
    '<fonts count="2">' +
    '<font><sz val="10"/><name val="Arial"/><family val="2"/></font>' +
    '<font><b/><sz val="10"/><name val="Arial"/><family val="2"/></font>' +
    '</fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${FIXED_STYLE_COUNT + scales.length}">` +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    decimalStyles +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  );
}

function workbookXml(sheetName: string, filterRef: string | undefined): string {
  const defined = filterRef
    ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${escapeXml(sheetName)}'!${filterRef}</definedName></definedNames>`
    : '';
  return (
    `${XML_DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
    defined +
    '</workbook>'
  );
}

/** A column width in characters from the header, between 8 and 50. */
function widthFor(name: string): number {
  return Math.min(50, Math.max(8, name.length + 2));
}

export class XlsxWriter implements ExportWriter {
  private readonly sink: FileSink;
  private readonly zip: Zip;
  private readonly sheet: ZipDeflate;
  private readonly sheetName: string;
  private columns: readonly ExportColumn[] = [];
  /** Decimal scales with a number format, in style order. */
  private scales: number[] = [];
  /** Style for numeric values per column, from its scale. */
  private numberStyles: Array<number | undefined> = [];
  private rowNumber = 0;
  private written: Promise<void> = Promise.resolve();
  private zipError: Error | undefined;
  private ended: Promise<void>;
  rawBytes = 0;

  constructor(path: string, sheetName = 'Export') {
    this.sink = new FileSink(path);
    this.sheetName = sheetName.replace(/[\\/?*[\]:']/g, ' ').slice(0, 31) || 'Export';
    let resolveEnd: () => void = () => undefined;
    this.ended = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });
    this.zip = new Zip((error, chunk, final) => {
      if (error) {
        this.zipError = error;
        resolveEnd();
        return;
      }
      // fflate calls back synchronously; chain the writes to keep their order
      this.written = this.written.then(() => this.sink.write(chunk));
      if (final) {
        resolveEnd();
      }
    });
    this.sheet = new ZipDeflate('xl/worksheets/sheet1.xml', { level: 6 });
    this.zip.add(this.sheet);
  }

  get bytes(): number {
    return this.sink.bytes;
  }

  private push(xml: string, final = false): void {
    const data = Buffer.from(xml, 'utf8');
    this.rawBytes += data.byteLength;
    this.sheet.push(data, final);
    if (this.zipError) {
      throw this.zipError;
    }
  }

  private async flush(): Promise<void> {
    await this.written;
    if (this.zipError) {
      throw this.zipError;
    }
  }

  async writeHeader(columns: readonly ExportColumn[]): Promise<void> {
    this.columns = columns;
    // A decimal with digits after the point shows them all, so 72.5 in a DECIMAL(9,2) reads 72.50
    this.numberStyles = columns.map((column) => {
      if (column.kind !== 'decimal' || column.masked || !column.scale || column.scale < 1) {
        return undefined;
      }
      const scale = Math.min(column.scale, MAX_FORMAT_SCALE);
      let index = this.scales.indexOf(scale);
      if (index < 0) {
        index = this.scales.push(scale) - 1;
      }
      return FIXED_STYLE_COUNT + index;
    });
    const cols = columns
      .map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${widthFor(column.name)}" customWidth="1"/>`)
      .join('');
    this.rowNumber = 1;
    const header = columns
      .map((column, index) => inlineString(`${columnLetters(index)}1`, column.name, STYLE_HEADER))
      .join('');
    this.push(
      `${XML_DECL}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
        '<sheetViews><sheetView workbookViewId="0">' +
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
        '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
        '</sheetView></sheetViews>' +
        '<sheetFormatPr defaultRowHeight="13"/>' +
        (cols ? `<cols>${cols}</cols>` : '') +
        `<sheetData><row r="1">${header}</row>`
    );
    await this.flush();
  }

  async writeRows(rows: readonly unknown[][]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const parts: string[] = [];
    for (const row of rows) {
      this.rowNumber += 1;
      if (this.rowNumber > XLSX_MAX_ROWS) {
        throw new Error(`An XLSX sheet holds at most ${XLSX_MAX_ROWS - 1} data rows`);
      }
      const r = this.rowNumber;
      const cells = this.columns
        .map((column, index) => xlsxCell(row[index], column, `${columnLetters(index)}${r}`, this.numberStyles[index]))
        .join('');
      parts.push(`<row r="${r}">${cells}</row>`);
    }
    this.push(parts.join(''));
    await this.flush();
  }

  async finish(): Promise<void> {
    const lastColumn = columnLetters(Math.max(0, this.columns.length - 1));
    const filterRef = this.columns.length > 0 ? `$A$1:$${lastColumn}$${Math.max(1, this.rowNumber)}` : undefined;
    const autoFilter = filterRef ? `<autoFilter ref="A1:${lastColumn}${Math.max(1, this.rowNumber)}"/>` : '';
    this.push(`</sheetData>${autoFilter}</worksheet>`, true);

    const addPart = (name: string, xml: string): void => {
      const part = new ZipDeflate(name, { level: 6 });
      this.zip.add(part);
      part.push(Buffer.from(xml, 'utf8'), true);
    };
    addPart('[Content_Types].xml', CONTENT_TYPES);
    addPart('_rels/.rels', ROOT_RELS);
    addPart('xl/workbook.xml', workbookXml(this.sheetName, filterRef));
    addPart('xl/_rels/workbook.xml.rels', WORKBOOK_RELS);
    addPart('xl/styles.xml', stylesXml(this.scales));
    this.zip.end();

    await this.ended;
    await this.flush();
    await this.sink.end();
  }

  async abort(): Promise<void> {
    this.zip.terminate();
    await this.written.catch(() => undefined);
    await this.sink.destroy();
  }
}
