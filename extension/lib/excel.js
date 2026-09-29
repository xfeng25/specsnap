// Excel export for SpecSnap: Field Inventory, Field Mapping, Screens, Actions, Summary.
import { rulesText, screenName, fmtDate } from './common.js';
import { risksFor } from './compare.js';

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF134E4A' } };
const NOTE_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
const BORDER = { style: 'thin', color: { argb: 'FFD0D4DC' } };
const KIND = { input: 'Input field', column: 'Table column', display: 'Displayed value' };
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

function header(ws, cols, noteCols = []) {
  const row = ws.addRow(cols.map((c) => c[0]));
  row.eachCell((c, i) => {
    c.fill = noteCols.includes(i - 1) ? NOTE_FILL : HEADER_FILL;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.alignment = { vertical: 'middle', wrapText: true };
    c.border = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
  });
  row.height = 22;
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c[1]; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

function body(ws, from) {
  for (let r = from; r <= ws.rowCount; r++) {
    ws.getRow(r).eachCell({ includeEmpty: true }, (c) => {
      c.alignment = { vertical: 'top', wrapText: true };
      c.border = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
    });
  }
}

function imageSize(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
    img.onerror = () => resolve({ w: 16, h: 10 });
    img.src = src;
  });
}

function inventory(wb, screens) {
  const ws = wb.addWorksheet('Field Inventory');
  const cols = [
    ['Screen', 22], ['Section', 20], ['Field', 26], ['Kind', 13], ['Technical name', 18], ['Type', 14], ['Required', 9], ['Read-only', 9],
    ['Rules (length, format)', 24], ['Options / values', 32], ['Example / current value', 22], ['Help text', 24],
    ['Business description', 40], ['Decision', 11], ['Mapping / target field', 26], ['Notes', 30],
  ];
  header(ws, cols, [12, 13, 14, 15]);
  for (const s of screens) {
    for (const f of s.fields) {
      const row = ws.addRow([
        screenName(s), f.section, f.label, KIND[f.kind || 'input'], f.name || f.domId, f.type, f.required ? 'Yes' : '', f.readonly || f.disabled ? 'Yes' : '',
        rulesText(f), (f.options || []).join('\n'), f.kind === 'column' ? (f.samples || []).join(', ') : f.value, f.help,
        (f.notes && f.notes.description) || '', (f.notes && f.notes.decision) || '', (f.notes && f.notes.mapping) || '', (f.notes && f.notes.comment) || '',
      ]);
      if (f.required) row.getCell(7).fill = fill('FFFDE8D7');
    }
  }
  body(ws, 2);
  if (ws.rowCount > 1) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
}

function mappingSheet(wb, screens, mapping) {
  const A = screens.find((s) => s.id === mapping.sourceId);
  const B = screens.find((s) => s.id === mapping.targetId);
  if (!A || !B) return;
  const ws = wb.addWorksheet('Field Mapping');
  const cols = [
    ['Source field', 26], ['Source type', 13], ['Source required', 9], ['Source rules', 18],
    ['Target field', 26], ['Target type', 13], ['Target required', 9], ['Target rules', 18],
    ['Status', 16], ['Confidence', 11], ['Risks to check', 50], ['Notes', 30],
  ];
  const title = ws.addRow([`Mapping: ${screenName(A)}  →  ${screenName(B)}`]);
  title.font = { bold: true, size: 13 };
  ws.addRow([]);
  const hr = ws.addRow(cols.map((c) => c[0]));
  hr.eachCell((c) => { c.fill = HEADER_FILL; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.alignment = { wrapText: true, vertical: 'middle' }; });
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c[1]; });
  ws.views = [{ state: 'frozen', ySplit: 3 }];
  const from = ws.rowCount + 1;
  const usedB = new Set();
  for (const m of mapping.rows) {
    const fa = A.fields[m.a];
    if (!fa) continue;
    const fb = m.b >= 0 ? B.fields[m.b] : null;
    if (fb) usedB.add(m.b);
    const risks = risksFor(fa, fb);
    const status = !fb ? 'Gap: no target' : risks.length ? 'Matched, check' : 'Matched';
    const row = ws.addRow([
      fa.label, fa.type, fa.required ? 'Yes' : '', rulesText(fa),
      fb ? fb.label : '', fb ? fb.type : '', fb && fb.required ? 'Yes' : '', fb ? rulesText(fb) : '',
      status, fb ? m.confidence : '', risks.map((x) => `• ${x}`).join('\n'), m.note || '',
    ]);
    row.getCell(9).fill = fill(!fb ? 'FFFBD9D7' : risks.length ? 'FFFFEFC7' : 'FFD9F2E0');
  }
  B.fields.forEach((fb, j) => {
    if (usedB.has(j)) return;
    const row = ws.addRow(['', '', '', '', fb.label, fb.type, fb.required ? 'Yes' : '', rulesText(fb), 'New in target', '',
      fb.required ? '• Required in target with no source field: needs a default value or a data owner to fill it.' : '• New field: decide who provides this data.', '']);
    row.getCell(9).fill = fill('FFE3E8FF');
  });
  body(ws, from);
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: cols.length } };
}

async function screensSheet(wb, screens, loadShot) {
  const ws = wb.addWorksheet('Screens');
  const cols = [['Screen', 26], ['URL', 34], ['Scanned', 18], ['Fields', 8], ['Required', 9], ['Screenshot', 100]];
  header(ws, cols);
  for (const s of screens) {
    const row = ws.addRow([screenName(s), s.url, fmtDate(s.scannedAt), s.fields.length, s.fields.filter((f) => f.required).length, '']);
    row.alignment = { vertical: 'top', wrapText: true };
    const src = loadShot ? await loadShot(s) : null;
    if (!src) continue;
    const d = await imageSize(src);
    const w = 700;
    const h = Math.round((d.h / d.w) * w);
    const id = wb.addImage({ base64: src, extension: /^data:image\/png/.test(src) ? 'png' : 'jpeg' });
    ws.addImage(id, { tl: { col: 5.05, row: row.number - 1 + 0.1 }, ext: { width: w, height: h } });
    row.height = Math.round(h * 0.75) + 10;
  }
  body(ws, 2);
}

function actionsSheet(wb, screens) {
  const rows = screens.flatMap((s) => (s.actions || []).map((a) => [screenName(s), a.label, a.kind]));
  if (!rows.length) return;
  const ws = wb.addWorksheet('Buttons & Actions');
  header(ws, [['Screen', 26], ['Button', 30], ['Kind', 16]]);
  rows.forEach((r) => ws.addRow(r));
  body(ws, 2);
}

function summarySheet(wb, screens) {
  const ws = wb.addWorksheet('Summary');
  ws.getColumn(1).width = 34; ws.getColumn(2).width = 12; ws.getColumn(3).width = 12; ws.getColumn(4).width = 14; ws.getColumn(5).width = 14;
  ws.addRow(['Screen field inventory']).font = { bold: true, size: 16 };
  ws.addRow([`Created with SpecSnap · ${fmtDate(new Date().toISOString())}`]).font = { color: { argb: 'FF6B6B78' } };
  ws.addRow([]);
  const hr = ws.addRow(['Screen', 'Fields', 'Required', 'Dropdowns / lists', 'Described']);
  hr.eachCell((c) => { c.fill = HEADER_FILL; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
  const from = ws.rowCount + 1;
  for (const s of screens) {
    ws.addRow([
      screenName(s), s.fields.length, s.fields.filter((f) => f.required).length,
      s.fields.filter((f) => (f.options || []).length).length,
      s.fields.filter((f) => f.notes && f.notes.description).length,
    ]);
  }
  const to = ws.rowCount;
  const total = ws.addRow(['Total', { formula: `SUM(B${from}:B${to})` }, { formula: `SUM(C${from}:C${to})` }, { formula: `SUM(D${from}:D${to})` }, { formula: `SUM(E${from}:E${to})` }]);
  total.font = { bold: true };
  body(ws, from);
}

export async function exportWorkbook({ screens, mapping, loadShot }) {
  const wb = new globalThis.ExcelJS.Workbook();
  wb.creator = 'SpecSnap';
  wb.created = new Date();
  summarySheet(wb, screens);
  inventory(wb, screens);
  if (mapping) mappingSheet(wb, screens, mapping);
  await screensSheet(wb, screens, loadShot);
  actionsSheet(wb, screens);
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
