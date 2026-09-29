import { getSettings, getScreens, esc, download, toast, rulesText, screenName } from './lib/common.js';
import { matchFields, confidenceLabel, risksFor } from './lib/compare.js';
import { matchWithAI } from './lib/ai.js';
import { exportWorkbook } from './lib/excel.js';
import { exportWordDoc } from './lib/word.js';

const $ = (id) => document.getElementById(id);
const settings = await getSettings();
let screens = await getScreens();
let { mapping } = await chrome.storage.local.get('mapping');

if (screens.length < 2) {
  document.querySelector('main').innerHTML = '<div class="card empty">Scan at least two screens in the SpecSnap side panel first (for example the old and the new version of the same form).</div>';
  throw new Error('need two screens');
}

const opts = screens.map((s) => `<option value="${s.id}">${esc(screenName(s))} (${s.fields.length} fields)</option>`).join('');
$('src').innerHTML = opts;
$('tgt').innerHTML = opts;
if (mapping && screens.some((s) => s.id === mapping.sourceId) && screens.some((s) => s.id === mapping.targetId)) {
  $('src').value = mapping.sourceId;
  $('tgt').value = mapping.targetId;
} else {
  $('src').value = screens[0].id;
  $('tgt').value = screens[1].id;
  mapping = null;
}

const A = () => screens.find((s) => s.id === $('src').value);
const B = () => screens.find((s) => s.id === $('tgt').value);
const save = () => chrome.storage.local.set({ mapping });

function autoMatch() {
  const a = A();
  const b = B();
  if (a.id === b.id) { mapping = null; render(); return; }
  mapping = {
    sourceId: a.id,
    targetId: b.id,
    createdAt: new Date().toISOString(),
    rows: matchFields(a.fields, b.fields).map((m) => ({ ...m, confidence: m.b >= 0 ? confidenceLabel(m.score) : '', note: '' })),
  };
  save();
  render();
}

function render() {
  const a = A();
  const b = B();
  if (!mapping || a.id === b.id) {
    $('rows').innerHTML = `<tr><td colspan="4" class="empty">${a.id === b.id ? 'Choose two different screens.' : 'Click “Match again”.'}</td></tr>`;
    $('stats').innerHTML = '';
    $('new-card').classList.add('hidden');
    return;
  }
  const used = new Set(mapping.rows.filter((r) => r.b >= 0).map((r) => r.b));
  let ok = 0; let check = 0; let gaps = 0;
  $('rows').innerHTML = mapping.rows.map((m, k) => {
    const fa = a.fields[m.a];
    const fb = m.b >= 0 ? b.fields[m.b] : null;
    const risks = risksFor(fa, fb);
    const status = !fb ? ['gap', 'Gap: no target'] : risks.length ? ['check', 'Check'] : ['ok', 'Matched'];
    if (!fb) gaps++; else if (risks.length) check++; else ok++;
    const options = [`<option value="-1">— No match (gap) —</option>`].concat(b.fields.map((f, j) =>
      `<option value="${j}" ${j === m.b ? 'selected' : ''}>${esc(f.label)}${used.has(j) && j !== m.b ? ' (used)' : ''}</option>`)).join('');
    return `<tr>
      <td class="src"><div class="fl">${esc(fa.label)}</div><div class="fm">${esc(fa.type)}${fa.required ? ' · required' : ''}${rulesText(fa) ? ` · ${esc(rulesText(fa))}` : ''}</div></td>
      <td class="tgt"><select data-k="${k}">${options}</select>${fb ? `<div class="fm">${esc(fb.type)}${fb.required ? ' · required' : ''}${rulesText(fb) ? ` · ${esc(rulesText(fb))}` : ''}</div>` : ''}
        <input type="text" data-note="${k}" value="${esc(m.note || '')}" placeholder="Note"></td>
      <td class="conf">${fb ? `<span class="conf-${m.confidence}">${m.confidence}</span>${m.source === 'ai' ? '<div class="src-ai">AI</div>' : m.source === 'manual' ? '<div class="fm">set by you</div>' : ''}` : ''}</td>
      <td class="risk"><span class="status ${status[0]}">${status[1]}</span>${risks.length ? `<ul class="risks">${risks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</td>
    </tr>`;
  }).join('');
  const fresh = b.fields.map((f, j) => ({ f, j })).filter(({ j }) => !used.has(j));
  $('new-card').classList.toggle('hidden', !fresh.length);
  $('new-list').innerHTML = fresh.map(({ f }) => `<span class="status new" style="margin:0 6px 6px 0">${esc(f.label)}${f.required ? ' · required' : ''}</span>`).join('');
  $('stats').innerHTML = `<span class="stat"><b>${ok}</b>matched</span><span class="stat"><b>${check}</b>to check</span><span class="stat"><b>${gaps}</b>gaps</span><span class="stat"><b>${fresh.length}</b>new in target</span>`;
}

$('rows').addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-k]');
  if (!sel) return;
  const k = Number(sel.dataset.k);
  const j = Number(sel.value);
  if (j >= 0) {
    const other = mapping.rows.findIndex((r, i) => i !== k && r.b === j);
    if (other >= 0) {
      mapping.rows[other] = { ...mapping.rows[other], b: -1, confidence: '', source: 'manual' };
      toast(`Removed that target from “${A().fields[mapping.rows[other].a].label}”`);
    }
  }
  mapping.rows[k] = { ...mapping.rows[k], b: j, confidence: j >= 0 ? 'High' : '', source: 'manual' };
  save();
  render();
});

$('rows').addEventListener('input', (e) => {
  const k = e.target.dataset.note;
  if (k === undefined) return;
  mapping.rows[Number(k)].note = e.target.value;
  save();
});

$('src').addEventListener('change', autoMatch);
$('tgt').addEventListener('change', autoMatch);
$('rematch').addEventListener('click', () => {
  if (mapping && mapping.rows.some((r) => r.source === 'manual' || r.note) && !confirm('Match again? Your manual changes and notes will be replaced.')) return;
  autoMatch();
});

$('ai').addEventListener('click', async () => {
  $('ai-error').classList.add('hidden');
  if (!settings.apiKey) {
    $('ai-error').innerHTML = 'AI needs a Claude API key. <a href="options.html" target="_blank">Add one in Settings</a>, then reload this page.';
    $('ai-error').classList.remove('hidden');
    return;
  }
  if (!mapping) autoMatch();
  const btn = $('ai');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Matching…';
  try {
    const res = await matchWithAI(A(), B(), settings);
    const taken = new Set();
    const rows = mapping.rows.map((r) => {
      if (r.source === 'manual') { if (r.b >= 0) taken.add(r.b); return r; }
      return null;
    });
    res.forEach((m) => {
      const k = mapping.rows.findIndex((r) => r.a === m.source);
      if (k < 0 || rows[k]) return;
      const b = m.target !== null && m.target < B().fields.length && !taken.has(m.target) ? m.target : -1;
      if (b >= 0) taken.add(b);
      rows[k] = { a: m.source, b, score: 0, confidence: b >= 0 ? m.confidence : '', note: m.note || mapping.rows[k].note || '', source: 'ai' };
    });
    mapping.rows = mapping.rows.map((r, k) => rows[k] || r);
    save();
    render();
    toast('Matches updated by AI. Your manual choices were kept.');
  } catch (e) {
    $('ai-error').textContent = `AI couldn't match the fields: ${e.message}`;
    $('ai-error').classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Improve matches with AI';
  }
});

$('export').addEventListener('click', async () => {
  screens = await getScreens();
  const blob = await exportWorkbook({
    screens,
    mapping,
    loadShot: async (s) => (await chrome.storage.local.get(`shot:${s.id}`))[`shot:${s.id}`] || null,
  });
  download(`SpecSnap mapping ${new Date().toISOString().slice(0, 10)}.xlsx`, blob);
});

$('export-word').addEventListener('click', async () => {
  screens = await getScreens();
  const blob = await exportWordDoc({
    screens: [A(), B()],
    mapping,
    loadShot: async (s) => (await chrome.storage.local.get(`shot:${s.id}`))[`shot:${s.id}`] || null,
  });
  download(`SpecSnap mapping ${new Date().toISOString().slice(0, 10)}.docx`, blob);
});

if (!mapping) autoMatch(); else render();
