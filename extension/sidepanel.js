import { ALL_SITES, DECISIONS, getSettings, getScreens, saveScreens, esc, fmtDate, download, toast, rulesText, screenName } from './lib/common.js';
import { scanPage, highlightField } from './lib/scanner.js';
import { describeFields } from './lib/ai.js';
import { exportWorkbook } from './lib/excel.js';
import { exportWordDoc } from './lib/word.js';

const app = document.getElementById('app');
const state = { view: 'home', screens: [], screenId: null, open: new Set(), filter: '', access: false, settings: {}, busy: false };

const isScannable = (tab) => !!tab && /^(https?|file):/.test(tab.url || '');
const samePage = (a, b) => { try { const x = new URL(a); const y = new URL(b); return x.origin + x.pathname === y.origin + y.pathname; } catch (_) { return a === b; } };
const current = () => state.screens.find((s) => s.id === state.screenId);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureAccess() {
  if (state.access) return true;
  let ok = false;
  try { ok = await chrome.permissions.request(ALL_SITES); } catch (_) { ok = false; }
  state.access = ok;
  renderAccess();
  if (!ok) toast('SpecSnap needs website access to read the fields on a page.', 4000);
  return ok;
}

// ---------------- render ----------------

function renderAccess() {
  const box = document.getElementById('access');
  box.classList.toggle('hidden', state.access);
  if (!state.access) {
    box.innerHTML = `<b>Allow SpecSnap on the websites you document</b>
      <p>SpecSnap needs website access to read field labels, types and options, and to take a screenshot of each screen. It only reads a page when you click Scan. Everything stays in your browser.</p>
      <button class="primary" data-action="allow">Allow website access</button>`;
  }
}

function render() {
  renderAccess();
  if (state.view === 'screen' && current()) return renderScreen();
  state.view = 'home';
  renderHome();
}

function renderHome() {
  const n = state.screens.length;
  app.innerHTML = `
    <section class="card">
      <h2>Document a screen</h2>
      <p>Open any screen of the system you are analysing and scan it: forms, list pages and read-only detail pages. SpecSnap lists every field with its type, required rule, options, limits and example values.</p>
      <button class="primary big" data-action="scan">⌖ Scan this page</button>
    </section>
    ${n ? `
      <ul class="screens">
        ${state.screens.map((s) => {
          const req = s.fields.filter((f) => f.required).length;
          const described = s.fields.filter((f) => f.notes && f.notes.description).length;
          let where = s.url;
          try { const u = new URL(s.url); where = u.host + u.pathname; } catch (_) { /* keep */ }
          return `<li><button data-action="open" data-id="${s.id}">
            <span class="sname">${esc(screenName(s))}</span>
            <span class="smeta">${s.fields.length} fields · ${req} required${described ? ` · ${described} described` : ''} · ${esc(fmtDate(s.scannedAt))}</span>
            <span class="smeta">${esc(where)}</span>
          </button></li>`;
        }).join('')}
      </ul>
      <section class="card">
        <div class="stack">
          <div class="row">
            <button class="primary" data-action="export">⬇ Excel</button>
            <button class="primary" data-action="export-word">⬇ Word spec</button>
          </div>
          <button data-action="compare" ${n < 2 ? 'disabled title="Scan at least two screens first"' : ''}>⇄ Compare two screens (old vs new)</button>
          <button class="link" data-action="clear-all" style="align-self:flex-start">Delete all screens</button>
        </div>
      </section>`
    : `<section class="card"><h2>How it works</h2>
        <p style="margin:0">1. Open a screen and click <b>Scan this page</b>.<br>2. Add descriptions, decisions (keep / change / remove) and mapping notes.<br>3. Scan the matching screen in the new system and <b>compare</b> them.<br>4. Export to <b>Excel</b> (field inventory, mapping with risks) or a <b>Word</b> field specification with screenshots.</p>
      </section>`}`;
}

function fieldCard(s, f, i) {
  const open = state.open.has(f.id);
  const notes = f.notes || {};
  const chips = [
    f.kind === 'column' ? '<span class="chip kind">Table column</span>' : f.kind === 'display' ? '<span class="chip kind">Display</span>' : '',
    `<span class="chip">${esc(f.type)}</span>`,
    f.required ? '<span class="chip req">Required</span>' : '',
    (f.readonly || f.disabled) && (!f.kind || f.kind === 'input') ? '<span class="chip ro">Read-only</span>' : '',
    notes.decision ? `<span class="chip dec">${esc(notes.decision)}</span>` : '',
  ].join('');
  const meta = [
    f.name || f.domId ? `name: ${f.name || f.domId}` : '',
    rulesText(f),
    f.options && f.options.length ? `${f.kind === 'column' ? 'values' : 'options'}: ${f.options.slice(0, 5).join(', ')}${f.options.length > 5 ? ` +${f.options.length - 5} more` : ''}` : '',
    f.kind === 'column' && !(f.options && f.options.length) && f.samples && f.samples.length ? `e.g. ${f.samples.slice(0, 3).join(', ')}` : '',
    f.kind === 'display' && f.value ? `value: ${f.value}` : '',
  ].filter(Boolean).map(esc).join(' · ');
  return `
    <div class="f ${open ? 'open' : ''}" data-fid="${f.id}">
      <div class="top">
        <span class="label">${esc(f.label)}</span>
        <button class="icon-btn" data-action="locate" data-i="${i}" title="Show on page">◎</button>
        <button class="icon-btn" data-action="toggle" data-fid="${f.id}" title="Add notes">${open ? '▴' : '✎'}</button>
      </div>
      <div class="chips">${chips}</div>
      ${meta ? `<div class="meta">${meta}</div>` : ''}
      ${!open && notes.description ? `<div class="desc">${esc(notes.description)}</div>` : ''}
      ${open ? `
        <div class="edit">
          <label class="field"><span>Business description</span><textarea data-note="description" data-i="${i}" rows="2" placeholder="What this field captures and why it matters">${esc(notes.description || '')}</textarea></label>
          <div class="row">
            <label class="field" style="flex:0 0 110px"><span>Decision</span><select data-note="decision" data-i="${i}">${DECISIONS.map((d) => `<option value="${d}" ${d === (notes.decision || '') ? 'selected' : ''}>${d || '—'}</option>`).join('')}</select></label>
            <label class="field"><span>Mapping / target field</span><input type="text" data-note="mapping" data-i="${i}" value="${esc(notes.mapping || '')}" placeholder="e.g. SAP LFA1-NAME1"></label>
          </div>
          <label class="field"><span>Notes</span><textarea data-note="comment" data-i="${i}" rows="2" placeholder="Open questions, rules, owners">${esc(notes.comment || '')}</textarea></label>
        </div>` : ''}
    </div>`;
}

function renderScreen() {
  const s = current();
  const q = state.filter.toLowerCase();
  const shown = s.fields.map((f, i) => ({ f, i })).filter(({ f }) => !q || `${f.label} ${f.section} ${f.type} ${f.name}`.toLowerCase().includes(q));
  const sections = [];
  const bySection = new Map();
  shown.forEach((x) => {
    const key = x.f.section || '';
    if (!bySection.has(key)) { bySection.set(key, []); sections.push(key); }
    bySection.get(key).push(x);
  });
  const req = s.fields.filter((f) => f.required).length;
  const lists = s.fields.filter((f) => f.options && f.options.length).length;
  const nIn = s.fields.filter((f) => !f.kind || f.kind === 'input').length;
  const nCol = s.fields.filter((f) => f.kind === 'column').length;
  const nDis = s.fields.filter((f) => f.kind === 'display').length;
  app.innerHTML = `
    <button class="link back" data-action="home">← All screens</button>
    <section class="card screen-head">
      <input type="text" id="screen-name" value="${esc(screenName(s))}" aria-label="Screen name">
      <div class="url">${esc(s.url)}</div>
      <div class="stats">${nIn ? `<span><b>${nIn}</b> input fields</span>` : ''}${nCol ? `<span><b>${nCol}</b> table columns</span>` : ''}${nDis ? `<span><b>${nDis}</b> displayed values</span>` : ''}<span><b>${req}</b> required</span><span><b>${lists}</b> with options</span>${s.hiddenCount ? `<span>${s.hiddenCount} hidden fields skipped</span>` : ''}</div>
      <div class="tools">
        <button data-action="rescan">↻ Rescan</button>
        <button data-action="ai-describe">✨ Describe with AI</button>
        <button data-action="delete-screen" class="danger">Delete</button>
      </div>
      ${s.aiQuestions && s.aiQuestions.length ? `<div class="callout warn" style="margin-top:10px"><b>Questions to confirm</b><ul>${s.aiQuestions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    </section>
    <input type="text" id="filter" placeholder="Filter fields…" value="${esc(state.filter)}">
    ${sections.map((sec) => `
      ${sec ? `<div class="section-title">${esc(sec)}</div>` : ''}
      <div class="fields">${bySection.get(sec).map(({ f, i }) => fieldCard(s, f, i)).join('')}</div>`).join('') || '<p class="muted">No fields match.</p>'}
    ${s.actions && s.actions.length ? `<div class="section-title">Buttons on this screen</div><div class="card small">${s.actions.map((a) => esc(a.label)).join(' · ')}</div>` : ''}`;
}

// ---------------- scanning ----------------

async function scanActiveTab(existing) {
  const tab = await activeTab();
  if (!isScannable(tab)) { toast('Open the web page you want to document first.'); return null; }
  const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: scanPage });
  const top = results.find((r) => r.frameId === 0) || results[0];
  if (!top || !top.result) throw new Error('Could not read this page.');
  const fields = [];
  let hidden = 0;
  const actions = [];
  for (const r of results) {
    if (!r.result) continue;
    hidden += r.result.hiddenCount || 0;
    r.result.fields.forEach((f) => fields.push({ ...f, frameId: r.frameId }));
    r.result.actions.forEach((a) => { if (!actions.some((x) => x.label === a.label)) actions.push(a); });
  }
  let shot = null;
  try { shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 }); } catch (_) { shot = null; }

  const id = existing ? existing.id : 's' + Date.now().toString(36);
  // keep notes from a previous scan when the same field is found again
  const oldNotes = new Map();
  if (existing) existing.fields.forEach((f) => { if (f.notes) oldNotes.set(`${f.label}|${f.type}`, f.notes); });
  const screen = {
    id,
    name: existing ? existing.name : '',
    title: top.result.title,
    url: top.result.url,
    scannedAt: new Date().toISOString(),
    hiddenCount: hidden,
    actions,
    aiQuestions: existing ? existing.aiQuestions : [],
    fields: fields.map((f, i) => ({ ...f, id: `${id}f${i}`, notes: oldNotes.get(`${f.label}|${f.type}`) || {} })),
  };
  await chrome.storage.local.set({ [`shot:${id}`]: shot });
  return screen;
}

async function saveScreen(screen) {
  const i = state.screens.findIndex((s) => s.id === screen.id);
  if (i >= 0) state.screens[i] = screen; else state.screens.push(screen);
  await saveScreens(state.screens);
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveScreens(state.screens), 400);
}

// ---------------- actions ----------------

const actions = {
  async allow() { if (await ensureAccess()) toast('Website access allowed'); },

  async scan() {
    if (!(await ensureAccess())) return;
    const tab = await activeTab();
    const same = tab && state.screens.find((s) => samePage(s.url, tab.url));
    let existing = null;
    if (same && confirm(`You already scanned “${screenName(same)}”.\n\nOK = update that screen (your notes are kept)\nCancel = add it as a new screen`)) existing = same;
    const btn = app.querySelector('[data-action="scan"]');
    if (btn) btn.innerHTML = '<span class="spinner"></span>Scanning…';
    try {
      const screen = await scanActiveTab(existing);
      if (!screen) return;
      await saveScreen(screen);
      state.view = 'screen';
      state.screenId = screen.id;
      state.open.clear();
      state.filter = '';
      render();
      toast(screen.fields.length ? `Found ${screen.fields.length} fields` : 'No form fields found on this page');
    } finally {
      if (btn && btn.isConnected) btn.textContent = '⌖ Scan this page';
    }
  },

  async rescan() {
    if (!(await ensureAccess())) return;
    const s = current();
    const tab = await activeTab();
    if (!tab || !samePage(s.url, tab.url)) {
      if (!confirm('The current tab is a different page than this screen. Rescan the current tab into this screen anyway?')) return;
    }
    const screen = await scanActiveTab(s);
    if (!screen) return;
    await saveScreen(screen);
    render();
    toast(`Rescanned: ${screen.fields.length} fields`);
  },

  open(el) { state.view = 'screen'; state.screenId = el.dataset.id; state.open.clear(); state.filter = ''; render(); },
  home() { state.view = 'home'; render(); },

  toggle(el) {
    const id = el.dataset.fid;
    if (state.open.has(id)) state.open.delete(id); else state.open.add(id);
    render();
  },

  async locate(el) {
    const s = current();
    const f = s.fields[Number(el.dataset.i)];
    const tab = await activeTab();
    if (!tab || !samePage(s.url, tab.url)) { toast('Open this screen in the current tab to show the field.'); return; }
    if (!(await ensureAccess())) return;
    try {
      const target = f.frameId ? { tabId: tab.id, frameIds: [f.frameId] } : { tabId: tab.id };
      const [r] = await chrome.scripting.executeScript({ target, func: highlightField, args: [f.selector, f.label] });
      if (!r || !r.result) toast('Field not found. The page may have changed: try Rescan.');
    } catch (_) {
      toast('Field not found. Try Rescan.');
    }
  },

  async 'ai-describe'(el) {
    const s = current();
    if (!state.settings.apiKey) { toast('Add a Claude API key in Settings to use AI.', 3500); return; }
    el.disabled = true;
    el.innerHTML = '<span class="spinner"></span>Writing…';
    try {
      const r = await describeFields(s, state.settings);
      let n = 0;
      r.descriptions.forEach(({ index, description }) => {
        const f = s.fields[index];
        if (f && description && !(f.notes && f.notes.description)) { f.notes = { ...(f.notes || {}), description }; n++; }
      });
      s.aiQuestions = r.questions;
      await saveScreens(state.screens);
      render();
      toast(`Added ${n} descriptions. Existing ones were kept.`);
    } catch (e) {
      toast(`AI error: ${e.message}`, 5000);
      render();
    }
  },

  async 'delete-screen'() {
    const s = current();
    if (!confirm(`Delete “${screenName(s)}” and its notes?`)) return;
    state.screens = state.screens.filter((x) => x.id !== s.id);
    await saveScreens(state.screens);
    await chrome.storage.local.remove(`shot:${s.id}`);
    state.view = 'home';
    render();
  },

  async 'clear-all'() {
    if (!confirm('Delete all scanned screens, notes and the mapping?')) return;
    await chrome.storage.local.remove(['screens', 'mapping', ...state.screens.map((s) => `shot:${s.id}`)]);
    state.screens = [];
    render();
  },

  async compare() { await chrome.tabs.create({ url: chrome.runtime.getURL('compare.html') }); },

  async export(el) {
    el.disabled = true;
    el.innerHTML = '<span class="spinner"></span>Building Excel…';
    try {
      const { mapping } = await chrome.storage.local.get('mapping');
      const blob = await exportWorkbook({
        screens: state.screens,
        mapping: mapping || null,
        loadShot: async (s) => (await chrome.storage.local.get(`shot:${s.id}`))[`shot:${s.id}`] || null,
      });
      download(`SpecSnap field inventory ${new Date().toISOString().slice(0, 10)}.xlsx`, blob);
    } catch (e) {
      toast('Export failed: ' + e.message, 4000);
    } finally {
      el.disabled = false;
      el.textContent = '⬇ Excel';
    }
  },

  async 'export-word'(el) {
    el.disabled = true;
    el.innerHTML = '<span class="spinner"></span>Building…';
    try {
      const { mapping } = await chrome.storage.local.get('mapping');
      const blob = await exportWordDoc({
        screens: state.screens,
        mapping: mapping || null,
        loadShot: async (s) => (await chrome.storage.local.get(`shot:${s.id}`))[`shot:${s.id}`] || null,
      });
      download(`SpecSnap field specification ${new Date().toISOString().slice(0, 10)}.docx`, blob);
    } catch (e) {
      toast('Export failed: ' + e.message, 4000);
    } finally {
      el.disabled = false;
      el.textContent = '⬇ Word spec';
    }
  },
};

// ---------------- events ----------------

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || state.busy) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  state.busy = true;
  try { await fn(el); } catch (err) { toast(err.message, 4000); console.error(err); } finally { state.busy = false; }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  const s = current();
  if (t.id === 'filter') {
    state.filter = t.value;
    const pos = t.selectionStart;
    renderScreen();
    const again = document.getElementById('filter');
    again.focus();
    again.setSelectionRange(pos, pos);
    return;
  }
  if (!s) return;
  if (t.id === 'screen-name') { s.name = t.value; saveSoon(); return; }
  if (t.dataset.note) {
    const f = s.fields[Number(t.dataset.i)];
    f.notes = { ...(f.notes || {}), [t.dataset.note]: t.value };
    saveSoon();
  }
});
document.addEventListener('change', (e) => {
  if (e.target.dataset.note === 'decision') render();
});

document.getElementById('nav-settings').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

chrome.permissions.onAdded.addListener(async () => { state.access = await chrome.permissions.contains(ALL_SITES); render(); });
chrome.permissions.onRemoved.addListener(async () => { state.access = await chrome.permissions.contains(ALL_SITES); render(); });
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) state.settings = await getSettings();
});

state.screens = await getScreens();
state.settings = await getSettings();
state.access = await chrome.permissions.contains(ALL_SITES);
render();
