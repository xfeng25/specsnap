// Word export: a field specification document that can be pasted into any
// requirements document (BRD / FRD / functional spec).
import { rulesText, screenName, fmtDate } from './common.js';
import { risksFor } from './compare.js';

const KIND = { input: 'Input field', column: 'Table column', display: 'Displayed value' };

function dataUrlToBytes(src) {
  const b64 = src.split(',')[1] || '';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function imageSize(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
    img.onerror = () => resolve({ w: 16, h: 10 });
    img.src = src;
  });
}

export async function exportWordDoc({ screens, mapping, loadShot }) {
  const D = globalThis.docx;
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ImageRun, ShadingType, AlignmentType, PageOrientation } = D;

  const p = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text: String(text ?? ''), size: opts.size || 18, bold: opts.bold, color: opts.color })], spacing: { after: opts.after ?? 40 } });
  const multi = (text, opts = {}) => String(text ?? '').split('\n').map((line) => p(line, { ...opts, after: 0 }));
  const cell = (content, opts = {}) => new TableCell({
    children: Array.isArray(content) ? content : multi(content, opts),
    shading: opts.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: opts.fill } : undefined,
    columnSpan: opts.span,
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
  });
  const headRow = (labels, widths = []) => new TableRow({ tableHeader: true, children: labels.map((l, i) => cell(l, { bold: true, color: 'FFFFFF', fill: '134E4A', width: widths[i] })) });
  const SPEC_W = [4, 16, 10, 5, 25, 20, 20];

  const children = [
    new Paragraph({ text: 'Field Specification', heading: HeadingLevel.TITLE }),
    p(`${screens.length} screen${screens.length === 1 ? '' : 's'} · generated with SpecSnap on ${fmtDate(new Date().toISOString())}`, { color: '6B6B78', after: 200 }),
  ];

  for (const [n, s] of screens.entries()) {
    children.push(new Paragraph({ text: `${n + 1}. ${screenName(s)}`, heading: HeadingLevel.HEADING_1, pageBreakBefore: n > 0 }));
    children.push(p(s.url, { color: '6B6B78' }));
    const counts = ['input', 'column', 'display'].map((k) => [k, s.fields.filter((f) => (f.kind || 'input') === k).length]).filter(([, c]) => c);
    children.push(p(`${counts.map(([k, c]) => `${c} ${KIND[k].toLowerCase()}${c === 1 ? '' : 's'}`).join(' · ')} · ${s.fields.filter((f) => f.required).length} required`, { after: 120 }));

    const src = loadShot ? await loadShot(s) : null;
    if (src) {
      const d = await imageSize(src);
      // fit inside the landscape page: max 640 wide, 360 high
      const scale = Math.min(640 / d.w, 360 / d.h);
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 160 },
        children: [new ImageRun({ data: dataUrlToBytes(src), type: /^data:image\/png/.test(src) ? 'png' : 'jpg', transformation: { width: Math.round(d.w * scale), height: Math.round(d.h * scale) } })],
      }));
    }

    const rows = [headRow(['#', 'Field', 'Type', 'Req.', 'Rules / options / example', 'Description', 'Decision & notes'], SPEC_W)];
    let lastSection = null;
    s.fields.forEach((f, i) => {
      if ((f.section || '') !== lastSection) {
        lastSection = f.section || '';
        if (lastSection) rows.push(new TableRow({ children: [cell(lastSection, { bold: true, span: 7, fill: 'E6F4F2' })] }));
      }
      const notes = f.notes || {};
      const detail = [
        (f.kind && f.kind !== 'input') ? KIND[f.kind] : '',
        rulesText(f),
        f.options && f.options.length ? `${f.kind === 'column' ? 'Values' : 'Options'}: ${f.options.slice(0, 20).join(', ')}${f.options.length > 20 ? '…' : ''}` : '',
        f.kind === 'column' && f.samples && f.samples.length && !(f.options && f.options.length) ? `e.g. ${f.samples.slice(0, 3).join(', ')}` : '',
        f.kind === 'display' && f.value ? `e.g. ${f.value}` : '',
        f.readonly && (!f.kind || f.kind === 'input') ? 'Read-only' : '',
        f.help ? `Help: ${f.help}` : '',
      ].filter(Boolean).join('\n');
      const decision = [notes.decision, notes.mapping ? `→ ${notes.mapping}` : '', notes.comment].filter(Boolean).join('\n');
      rows.push(new TableRow({
        children: [
          cell(String(i + 1), { width: SPEC_W[0] }),
          cell(f.label, { bold: true, width: SPEC_W[1] }),
          cell(f.type, { width: SPEC_W[2] }),
          cell(f.required ? 'Yes' : '', { width: SPEC_W[3] }),
          cell(detail, { width: SPEC_W[4] }),
          cell(notes.description || '', { width: SPEC_W[5] }),
          cell(decision, { width: SPEC_W[6] }),
        ],
      }));
    });
    children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));

    if (s.aiQuestions && s.aiQuestions.length) {
      children.push(new Paragraph({ text: 'Open questions', heading: HeadingLevel.HEADING_2, spacing: { before: 200 } }));
      s.aiQuestions.forEach((q) => children.push(new Paragraph({ text: q, bullet: { level: 0 } })));
    }
  }

  if (mapping) {
    const A = screens.find((s) => s.id === mapping.sourceId);
    const B = screens.find((s) => s.id === mapping.targetId);
    if (A && B) {
      children.push(new Paragraph({ text: `Field mapping: ${screenName(A)} → ${screenName(B)}`, heading: HeadingLevel.HEADING_1, pageBreakBefore: true }));
      const rows = [headRow(['Source field', 'Target field', 'Status', 'Risks to check', 'Notes'], [18, 18, 10, 36, 18])];
      const used = new Set();
      for (const m of mapping.rows) {
        const fa = A.fields[m.a];
        if (!fa) continue;
        const fb = m.b >= 0 ? B.fields[m.b] : null;
        if (fb) used.add(m.b);
        const risks = risksFor(fa, fb);
        const status = !fb ? 'Gap' : risks.length ? 'Check' : 'Matched';
        rows.push(new TableRow({ children: [
          cell(`${fa.label}\n${fa.type}${fa.required ? ', required' : ''}`),
          cell(fb ? `${fb.label}\n${fb.type}${fb.required ? ', required' : ''}` : '—'),
          cell(status, { bold: true, fill: !fb ? 'FBD9D7' : risks.length ? 'FFEFC7' : 'D9F2E0' }),
          cell(risks.map((r) => `• ${r}`).join('\n')),
          cell(m.note || ''),
        ] }));
      }
      B.fields.forEach((fb, j) => {
        if (used.has(j)) return;
        rows.push(new TableRow({ children: [
          cell('—'), cell(`${fb.label}\n${fb.type}${fb.required ? ', required' : ''}`), cell('New in target', { bold: true, fill: 'E3E8FF' }),
          cell(fb.required ? '• Required with no source field: needs a default value or a data owner.' : '• New field: decide who provides this data.'), cell(''),
        ] }));
      });
      children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    }
  }

  const doc = new Document({
    creator: 'SpecSnap',
    title: 'Field Specification',
    styles: { default: { document: { run: { font: 'Calibri' } } } },
    sections: [{ properties: { page: { size: { orientation: PageOrientation.LANDSCAPE }, margin: { top: 900, bottom: 900, left: 900, right: 900 } } }, children }],
  });
  return Packer.toBlob(doc);
}
