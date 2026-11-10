// CSV / JSON / XLSX (minimal OOXML writer) / printable HTML (browser "Save as PDF" - handles Arabic shaping natively).
import { zipSync, strToU8 } from 'fflate';

export const MAX_EXPORT_ROWS = 50000;
const cellText = (v) => (v == null ? '' : v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlSafe = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const safeName = (n) => String(n).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'export';

export function toCSV(columns, rows) {
  const guard = (s) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s); // neutralise spreadsheet formula injection
  const q = (v) => `"${guard(cellText(v)).replace(/"/g, '""')}"`;
  return `\uFEFF${[columns.map((c) => q(c.label ?? c.key)).join(','), ...rows.map((r) => columns.map((c) => q(r[c.key])).join(','))].join('\r\n')}\r\n`;
}
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
export function toXLSX(columns, rows, { sheet = 'NABD', rtl = false } = {}) {
  const cell = (v, r, c) => {
    const ref = `${colName(c)}${r}`;
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(xmlSafe(cellText(v)))}</t></is></c>`;
  };
  const head = `<row r="1">${columns.map((c, i) => cell(c.label ?? c.key, 1, i)).join('')}</row>`;
  const body = rows.map((row, ri) => `<row r="${ri + 2}">${columns.map((c, ci) => cell(row[c.key], ri + 2, ci)).join('')}</row>`).join('');
  const cols = `<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 22}" customWidth="1"/>`).join('')}</cols>`;
  const files = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheet.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"${rtl ? ' rightToLeft="1"' : ''}/></sheetViews>${cols}<sheetData>${head}${body}</sheetData></worksheet>`),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}
export function toHTML(title, columns, rows, lang = 'ar') {
  const rtl = lang === 'ar';
  return `<!doctype html><html lang="${lang}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="/css/print.css"></head><body>
<header><h1>${esc(title)}</h1><p>${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${rows.length} rows</p><button id="p">${rtl ? 'طباعة / حفظ PDF' : 'Print / Save as PDF'}</button></header>
<table><thead><tr>${columns.map((c) => `<th>${esc(c.label ?? c.key)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td>${esc(cellText(r[c.key]))}</td>`).join('')}</tr>`).join('')}</tbody></table><script src="/js/print.js"></script></body></html>`;
}
export function sendExport(res, { format = 'csv', name, columns, rows, lang = 'ar', title }) {
  const base = safeName(name); const fmt = ['csv', 'json', 'xlsx', 'html', 'pdf'].includes(format) ? format : 'csv';
  if (fmt === 'json') { res.type('application/json').attachment(`${base}.json`).send(JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c) => [c.key, r[c.key]]))), null, 2)); }
  else if (fmt === 'xlsx') { res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(`${base}.xlsx`).send(toXLSX(columns, rows, { sheet: title ?? name, rtl: lang === 'ar' })); }
  else if (fmt === 'html' || fmt === 'pdf') { res.type('html').send(toHTML(title ?? name, columns, rows, lang)); }
  else { res.type('text/csv; charset=utf-8').attachment(`${base}.csv`).send(toCSV(columns, rows)); }
}
