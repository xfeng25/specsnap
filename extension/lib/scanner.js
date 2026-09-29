// These functions are injected into the page with chrome.scripting.executeScript,
// so each one must be completely self-contained (no outside variables).

// Reads a screen and returns:
//  - input fields (forms)
//  - table columns (list pages), with sample values
//  - displayed values (read-only detail pages: "Label: value")
export function scanPage() {
  const clean = (s, n = 160) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  };
  const stripMarks = (s) => clean(s).replace(/\s*[:：]\s*$/, '').replace(/\s*\*\s*$/, '').replace(/^\*\s*/, '').trim();
  const humanize = (s) => clean(String(s).replace(/[_\-.[\]]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));
  const textOf = (el) => (el ? el.innerText || el.textContent || '' : '');
  const SENSITIVE = /pass(word)?|pwd|ssn|social.?sec|card.?num|cc-|cvv|cvc|iban|account.?(no|num)|bank.?acc|secret|token|\bpin\b/i;
  const CONTROL = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea, [contenteditable="true"], [role=textbox], [role=combobox], [role=checkbox], [role=switch], [role=radiogroup], [role=listbox], [role=spinbutton]';

  // Every element, including inside open shadow roots (web components, Salesforce Lightning)
  const all = [];
  (function collect(root) {
    for (const el of root.querySelectorAll('*')) {
      all.push(el);
      if (el.shadowRoot) collect(el.shadowRoot);
    }
  })(document);
  const deep = (sel) => all.filter((e) => e.matches(sel));
  const rootOf = (el) => (el.getRootNode && el.getRootNode()) || document;
  const byId = (el, id) => (rootOf(el).getElementById ? rootOf(el).getElementById(id) : null) || document.getElementById(id);
  const byIds = (el, ids) => ids.split(/\s+/).map((id) => textOf(byId(el, id))).join(' ');
  const hasControl = (el) => !!(el && (el.matches(CONTROL) || el.querySelector(CONTROL)));

  function isVisible(el) {
    if (el.type === 'hidden') return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) return true;
    let lab = el.closest('label');
    if (!lab && el.id) { try { lab = rootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`); } catch (_) { lab = null; } }
    return !!(lab && lab.getBoundingClientRect().width > 0);
  }

  function inferType(values) {
    const v = values.map((x) => clean(x, 80)).filter(Boolean);
    if (!v.length) return 'Text';
    const share = (re) => v.filter((x) => re.test(x)).length / v.length;
    if (share(/^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2,8} \d{4}|\d{4}年\d{1,2}月\d{1,2}日)( \d{1,2}:\d{2}.*)?$/) >= 0.7) return 'Date';
    if (share(/^([$€£¥]|USD|EUR|CNY|RMB|GBP|JPY)\s?-?[\d,]+(\.\d+)?$|^-?[\d,]+\.\d{2}\s?(USD|EUR|CNY|RMB|GBP|JPY)?$/) >= 0.7) return 'Amount';
    if (share(/^-?[\d,]+(\.\d+)?%?$/) >= 0.7) return 'Number';
    if (share(/^[^\s@]+@[^\s@]+\.[^\s@]+$/) >= 0.7) return 'Email';
    if (share(/^https?:\/\//) >= 0.7) return 'URL';
    if (share(/^(yes|no|true|false|y|n|是|否|✓|✔|✗)$/i) >= 0.7) return 'Yes/No';
    return 'Text';
  }

  function rawLabel(el) {
    const aria = el.getAttribute('aria-label');
    if (clean(aria)) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by && clean(byIds(el, by))) return byIds(el, by);
    if (el.id) {
      let l = null;
      try { l = rootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`); } catch (_) { l = null; }
      if (l && clean(textOf(l))) return textOf(l);
    }
    const wrap = el.closest('label');
    if (wrap) {
      const copy = wrap.cloneNode(true);
      copy.querySelectorAll('select, textarea, option, input').forEach((n) => n.remove());
      if (clean(copy.textContent)) return copy.textContent;
    }
    const cell = el.closest('td, th');
    if (cell) {
      let prev = cell.previousElementSibling;
      while (prev && !clean(textOf(prev))) prev = prev.previousElementSibling;
      if (prev && clean(textOf(prev)).length < 60) return textOf(prev);
    }
    const prevEl = el.previousElementSibling;
    if (prevEl && /^(LABEL|SPAN|B|STRONG|DIV|P)$/.test(prevEl.tagName) && clean(textOf(prevEl)) && clean(textOf(prevEl)).length < 60 && !hasControl(prevEl)) {
      return textOf(prevEl);
    }
    if (el.placeholder) return el.placeholder;
    if (el.title) return el.title;
    if (el.name) return humanize(el.name);
    if (el.id) return humanize(el.id);
    return '';
  }

  function sectionOf(el) {
    const fs = el.closest('fieldset');
    if (fs) {
      const lg = fs.querySelector(':scope > legend');
      if (lg && clean(textOf(lg))) return clean(textOf(lg), 80);
    }
    let node = el.parentElement || (rootOf(el).host);
    let hops = 0;
    while (node && node !== document.body && hops < 40) {
      hops++;
      const label = node.getAttribute && (node.getAttribute('aria-label') || (node.getAttribute('aria-labelledby') && byIds(node, node.getAttribute('aria-labelledby'))));
      if (label && (/^(SECTION|FORM|FIELDSET)$/.test(node.tagName) || /region|group/.test(node.getAttribute('role') || ''))) return clean(label, 80);
      const heads = Array.from(node.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,[role=heading]'));
      const before = heads.filter((h) => (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && !h.contains(el));
      if (before.length) return clean(textOf(before[before.length - 1]), 80);
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
    }
    return '';
  }

  function selectorOf(el) {
    const root = rootOf(el);
    if (el.id) {
      const sel = `#${CSS.escape(el.id)}`;
      try { if (root.querySelectorAll(sel).length === 1 && root === document) return sel; } catch (_) { /* ignore */ }
    }
    if (el.name && root === document) {
      const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (_) { /* ignore */ }
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 10) {
      let part = node.tagName.toLowerCase();
      if (node.id && rootOf(node) === document) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      const same = node.parentElement ? Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName) : [];
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  const INPUT_TYPES = {
    text: 'Text', search: 'Text', email: 'Email', tel: 'Phone', url: 'URL', number: 'Number', password: 'Password',
    date: 'Date', 'datetime-local': 'Date & time', time: 'Time', month: 'Month', week: 'Week', color: 'Color',
    range: 'Slider', file: 'File upload', checkbox: 'Checkbox', radio: 'Radio buttons',
  };

  const blank = { maxLength: '', minLength: '', min: '', max: '', pattern: '', placeholder: '', help: '', name: '', domId: '', samples: [] };
  const fields = [];
  const groups = new Map();
  let hiddenCount = 0;

  // ---------- 1. input fields ----------
  for (const el of deep('input, select, textarea, [contenteditable="true"], [contenteditable=""], [role=textbox], [role=combobox], [role=checkbox], [role=switch], [role=radiogroup], [role=listbox], [role=spinbutton]')) {
    const tag = el.tagName;
    const type = tag === 'INPUT' ? (el.type || 'text').toLowerCase() : '';
    if (tag === 'INPUT' && ['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
    if (!/^(INPUT|SELECT|TEXTAREA)$/.test(tag) && el.querySelector('input:not([type=hidden]), select, textarea')) continue;
    if (tag !== 'INPUT' && el.closest('[role=radiogroup]') && el.getAttribute('role') !== 'radiogroup') continue;
    if (!isVisible(el)) { hiddenCount++; continue; }

    const label = stripMarks(rawLabel(el));
    const rawReq = clean(rawLabel(el));
    const required = !!(el.required || el.getAttribute('aria-required') === 'true' || /\*\s*[:：]?\s*$/.test(rawReq) || /^\*/.test(rawReq));
    const help = clean([el.getAttribute('aria-describedby') ? byIds(el, el.getAttribute('aria-describedby')) : '', el.title && el.title !== label ? el.title : ''].filter(Boolean).join(' '), 200);

    if ((type === 'radio' || type === 'checkbox') && el.name) {
      const key = `${type}|${el.form ? Array.from(document.forms).indexOf(el.form) : -1}|${el.name}`;
      let sameName = 1;
      try { sameName = rootOf(el).querySelectorAll(`input[type=${type}][name="${CSS.escape(el.name)}"]`).length; } catch (_) { /* ignore */ }
      if (type === 'radio' || sameName > 1) {
        let g = groups.get(key);
        if (!g) {
          const container = el.closest('fieldset, [role=radiogroup], [role=group]');
          let groupLabel = '';
          if (container) {
            const lg = container.querySelector('legend');
            groupLabel = lg ? textOf(lg) : container.getAttribute('aria-label') || '';
          }
          if (!clean(groupLabel)) {
            const cell = el.closest('td');
            const prev = cell && cell.previousElementSibling;
            groupLabel = prev ? textOf(prev) : '';
          }
          g = {
            ...blank,
            kind: 'input',
            label: stripMarks(groupLabel) || humanize(el.name),
            section: sectionOf(el),
            type: type === 'radio' ? 'Radio buttons' : 'Checkbox group',
            required: false, readonly: false, disabled: el.disabled,
            options: [], value: '', name: el.name, help,
            selector: `input[type=${type}][name="${CSS.escape(el.name)}"]`,
          };
          groups.set(key, g);
          fields.push(g);
        }
        g.options.push(label || el.value);
        if (el.required) g.required = true;
        if (el.checked) g.value = g.value ? `${g.value}, ${label || el.value}` : (label || el.value);
        continue;
      }
    }

    let kind = INPUT_TYPES[type] || '';
    let options = [];
    let value = '';
    if (tag === 'SELECT') {
      kind = el.multiple ? 'Multi-select' : 'Dropdown';
      options = Array.from(el.options).map((o) => clean(o.text, 80))
        .filter((t, i) => t && !(i === 0 && /^(-+|select|choose|please|--|请选择|請選擇)/i.test(t)));
      value = Array.from(el.selectedOptions).map((o) => clean(o.text, 80)).filter((t) => !/^(-+|select|choose|please|请选择)/i.test(t)).join(', ');
    } else if (tag === 'TEXTAREA') {
      kind = 'Multi-line text';
      value = el.value;
    } else if (tag === 'INPUT') {
      value = type === 'checkbox' ? (el.checked ? 'checked' : 'unchecked') : el.value;
      const list = el.getAttribute('list');
      const dl = list && byId(el, list);
      if (dl) {
        options = Array.from(dl.options).map((o) => clean(o.value || o.text, 80)).filter(Boolean);
        kind = 'Text with suggestions';
      }
    } else {
      const role = el.getAttribute('role');
      kind = { combobox: 'Dropdown', listbox: 'List', checkbox: 'Checkbox', switch: 'Toggle', spinbutton: 'Number', radiogroup: 'Radio buttons' }[role] || 'Rich text';
      value = role === 'checkbox' || role === 'switch' ? (el.getAttribute('aria-checked') === 'true' ? 'checked' : 'unchecked') : clean(textOf(el), 80);
      if (role === 'radiogroup') options = Array.from(el.querySelectorAll('[role=radio]')).map((r) => clean(r.getAttribute('aria-label') || textOf(r), 60));
    }
    const hint = `${el.name || ''} ${el.id || ''} ${el.autocomplete || ''} ${label}`;
    if (type === 'password' || SENSITIVE.test(hint)) value = value ? '(hidden)' : '';

    fields.push({
      ...blank,
      kind: 'input',
      label: label || '(no label)',
      section: sectionOf(el),
      type: kind || 'Text',
      required,
      readonly: !!(el.readOnly || el.getAttribute('aria-readonly') === 'true'),
      disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      maxLength: el.maxLength > 0 ? el.maxLength : (el.getAttribute('maxlength') || ''),
      minLength: el.minLength > 0 ? el.minLength : '',
      min: el.min || '',
      max: el.max || '',
      pattern: el.pattern || '',
      placeholder: el.placeholder || '',
      options: options.slice(0, 80),
      value: clean(value, 120),
      help,
      name: el.name || '',
      domId: el.id || '',
      selector: selectorOf(el),
    });
  }

  // ---------- 2. table columns (list pages) ----------
  const columnTables = new Set();
  for (const t of deep('table, [role=grid], [role=table], [role=treegrid]')) {
    if (!isVisible(t) || t.parentElement && t.parentElement.closest('table, [role=grid], [role=table]') && columnTables.has(t.parentElement.closest('table, [role=grid], [role=table]'))) continue;
    let headers = [];
    let rows = [];
    if (t.tagName === 'TABLE') {
      const headRow = t.tHead ? t.tHead.rows[t.tHead.rows.length - 1] : Array.from(t.rows).find((r) => r.cells.length && Array.from(r.cells).every((c) => c.tagName === 'TH'));
      if (!headRow) continue;
      headers = Array.from(headRow.cells);
      rows = Array.from(t.tBodies.length ? t.tBodies : [t]).flatMap((b) => Array.from(b.rows)).filter((r) => r !== headRow && Array.from(r.cells).some((c) => c.tagName === 'TD'));
    } else {
      headers = Array.from(t.querySelectorAll('[role=columnheader]'));
      rows = Array.from(t.querySelectorAll('[role=row]')).filter((r) => r.querySelector('[role=gridcell], [role=cell]'));
    }
    headers = headers.filter((h) => isVisible(h));
    if (headers.length < 2) continue;
    const withControls = rows.filter((r) => hasControl(r)).length;
    if (rows.length && withControls / rows.length > 0.5 && rows.every((r) => r.querySelectorAll(CONTROL).length > 1)) continue; // editable grid: its inputs are listed already
    columnTables.add(t);
    const caption = (t.caption && textOf(t.caption)) || t.getAttribute('aria-label') || (t.getAttribute('aria-labelledby') && byIds(t, t.getAttribute('aria-labelledby'))) || sectionOf(t);
    const section = `Table: ${clean(caption, 70) || 'List'}`;
    const cellsOf = (r) => (r.cells ? Array.from(r.cells) : Array.from(r.querySelectorAll('[role=gridcell], [role=cell], [role=rowheader]')));
    headers.forEach((h, i) => {
      const label = stripMarks(textOf(h));
      if (!label || /^(actions?|操作|select all|#)$/i.test(label)) return;
      const samples = rows.slice(0, 30).map((r) => clean(textOf(cellsOf(r)[i]), 80)).filter(Boolean);
      const distinct = Array.from(new Set(samples));
      let type = inferType(samples);
      let options = [];
      if (type === 'Text' && samples.length >= 4 && distinct.length <= 6 && distinct.length < samples.length && distinct.every((d) => d.length <= 30)) {
        type = 'Status / category';
        options = distinct;
      }
      fields.push({
        ...blank,
        kind: 'column',
        label,
        section,
        type,
        required: false, readonly: true, disabled: false,
        options,
        value: '',
        samples: distinct.slice(0, 5),
        selector: selectorOf(h),
      });
    });
  }

  // ---------- 3. displayed values (read-only details: "Label: value") ----------
  const seenPairs = new Set();
  const pairs = [];
  const addPair = (labelEl, valueEl) => {
    if (!labelEl || !valueEl || !isVisible(labelEl)) return;
    if (hasControl(valueEl) || hasControl(labelEl)) return;
    const label = stripMarks(textOf(labelEl));
    const value = clean(textOf(valueEl), 200);
    if (!label || label.length > 50 || /^\d+$/.test(label)) return;
    const key = `${label}|${value}`;
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    pairs.push({
      ...blank,
      kind: 'display',
      label,
      section: sectionOf(labelEl),
      type: inferType([value]),
      required: false, readonly: true, disabled: false,
      options: [],
      value: SENSITIVE.test(label) ? (value ? '(hidden)' : '') : value,
      samples: [],
      selector: selectorOf(valueEl),
    });
  };
  // <dl><dt>Label</dt><dd>Value</dd></dl>
  for (const dt of deep('dt')) {
    let dd = dt.nextElementSibling;
    while (dd && dd.tagName !== 'DD' && dd.tagName !== 'DT') dd = dd.nextElementSibling;
    if (dd && dd.tagName === 'DD') addPair(dt, dd);
  }
  // key/value table rows: <tr><th>Label</th><td>Value</td></tr>
  for (const tr of deep('tr')) {
    const table = tr.closest('table');
    if (table && columnTables.has(table)) continue;
    const cells = Array.from(tr.cells || []);
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const a = cells[i];
      const b = cells[i + 1];
      const at = clean(textOf(a));
      if (a.tagName === 'TH' || /[:：]$/.test(at)) addPair(a, b);
    }
  }
  // generic "Label:" followed by a value element (also Salesforce-style *label / *static classes)
  for (const el of all) {
    if (!/^(SPAN|DIV|LABEL|B|STRONG|P|TD|DT|H5|H6)$/.test(el.tagName) || el.childElementCount > 2) continue;
    const t = clean(textOf(el));
    if (!t || t.length > 45) continue;
    const cls = typeof el.className === 'string' ? el.className : '';
    if (!(/[:：]$/.test(t) || /(^|[\s_-])(label|field-label|form-element__label|key)([\s_-]|$)/i.test(cls))) continue;
    if (el.tagName === 'LABEL' && (el.htmlFor || el.querySelector('input,select,textarea'))) continue;
    const next = el.nextElementSibling;
    if (!next || next.childElementCount > 4) continue;
    const v = clean(textOf(next));
    if (!v || v.length > 200) continue;
    addPair(el, next);
  }
  fields.push(...pairs.slice(0, 200));

  // ---------- buttons ----------
  const actions = [];
  const seen = new Set();
  deep('button, input[type=submit], input[type=button], input[type=reset], [role=button]').forEach((b) => {
    if (!isVisible(b)) return;
    const text = clean(b.getAttribute('aria-label') || textOf(b) || b.value || b.title, 60);
    if (!text || seen.has(text)) return;
    seen.add(text);
    const t = (b.getAttribute('type') || '').toLowerCase();
    actions.push({ label: text, kind: t === 'submit' ? 'Submit button' : t === 'reset' ? 'Reset button' : 'Button' });
  });

  return {
    title: document.title || location.hostname,
    url: location.href,
    isTop: window === window.top,
    fields,
    actions: actions.slice(0, 60),
    hiddenCount,
  };
}

// Scrolls to a field and draws a temporary outline around it.
export function highlightField(selector, label) {
  let el = null;
  try { el = document.querySelector(selector); } catch (_) { el = null; }
  if (!el) {
    // look inside open shadow roots too
    const stack = [document];
    while (!el && stack.length) {
      const root = stack.pop();
      try { el = root.querySelector(selector); } catch (_) { el = null; }
      if (!el) root.querySelectorAll('*').forEach((n) => { if (n.shadowRoot) stack.push(n.shadowRoot); });
    }
  }
  if (!el) return false;
  let target = el;
  if (target.getBoundingClientRect().width === 0) target = el.closest('label, td, div') || el;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const old = document.getElementById('__specsnap_hl');
  if (old) old.remove();
  const box = document.createElement('div');
  box.id = '__specsnap_hl';
  const place = () => {
    const r = target.getBoundingClientRect();
    Object.assign(box.style, {
      position: 'fixed', left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px`,
      border: '3px solid #0f766e', borderRadius: '8px', background: 'rgba(15,118,110,0.12)', zIndex: 2147483647,
      pointerEvents: 'none', boxShadow: '0 0 0 4px rgba(15,118,110,0.25)', transition: 'opacity .4s',
    });
  };
  const tag = document.createElement('div');
  tag.textContent = label || '';
  Object.assign(tag.style, {
    position: 'absolute', left: '-3px', top: '-26px', background: '#0f766e', color: '#fff', font: '600 12px system-ui, sans-serif',
    padding: '3px 8px', borderRadius: '6px', whiteSpace: 'nowrap',
  });
  box.appendChild(tag);
  document.documentElement.appendChild(box);
  place();
  const iv = setInterval(place, 50);
  setTimeout(() => { box.style.opacity = '0'; }, 2200);
  setTimeout(() => { clearInterval(iv); box.remove(); }, 2700);
  return true;
}
