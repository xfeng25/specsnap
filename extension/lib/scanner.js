// These functions are injected into the page with chrome.scripting.executeScript,
// so each one must be completely self-contained (no outside variables).

// Reads every form field on the page and returns a structured description.
export function scanPage() {
  const clean = (s, n = 160) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  };
  const stripMarks = (s) => clean(s).replace(/\s*[:：]\s*$/, '').replace(/\s*\*\s*$/, '').replace(/^\*\s*/, '').trim();
  const humanize = (s) => clean(String(s).replace(/[_\-.[\]]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));
  const textOf = (el) => (el ? el.innerText || el.textContent || '' : '');
  const byIds = (ids) => ids.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(' ');
  const SENSITIVE = /pass(word)?|pwd|ssn|social.?sec|card.?num|cc-|cvv|cvc|iban|account.?(no|num)|bank.?acc|secret|token|\bpin\b/i;

  function isVisible(el) {
    if (el.type === 'hidden') return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) return true;
    // custom-styled checkboxes/radios are often 0×0 but have a visible label
    const lab = el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
    return !!(lab && lab.getBoundingClientRect().width > 0);
  }

  function rawLabel(el) {
    const aria = el.getAttribute('aria-label');
    if (clean(aria)) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by && clean(byIds(by))) return byIds(by);
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && clean(textOf(l))) return textOf(l);
    }
    const wrap = el.closest('label');
    if (wrap) {
      const copy = wrap.cloneNode(true);
      copy.querySelectorAll('select, textarea, option, input').forEach((n) => n.remove());
      if (clean(copy.textContent)) return copy.textContent;
    }
    // legacy table layouts: <td>Label</td><td><input></td>
    const cell = el.closest('td, th');
    if (cell) {
      let prev = cell.previousElementSibling;
      while (prev && !clean(textOf(prev))) prev = prev.previousElementSibling;
      if (prev && clean(textOf(prev)).length < 60) return textOf(prev);
    }
    // text right before the field in the same container
    const prevEl = el.previousElementSibling;
    if (prevEl && /^(LABEL|SPAN|B|STRONG|DIV|P)$/.test(prevEl.tagName) && clean(textOf(prevEl)) && clean(textOf(prevEl)).length < 60 && !prevEl.querySelector('input,select,textarea')) {
      return textOf(prevEl);
    }
    if (el.placeholder) return el.placeholder;
    if (el.title) return el.title;
    if (el.name) return humanize(el.name);
    if (el.id) return humanize(el.id);
    return '';
  }

  // Nearest heading/legend that comes before the field inside one of its ancestors
  function sectionOf(el) {
    const fs = el.closest('fieldset');
    if (fs) {
      const lg = fs.querySelector(':scope > legend');
      if (lg && clean(textOf(lg))) return clean(textOf(lg), 80);
    }
    let node = el.parentElement;
    while (node && node !== document.body) {
      const region = node.getAttribute && (node.getAttribute('aria-label') || (node.getAttribute('aria-labelledby') && byIds(node.getAttribute('aria-labelledby'))));
      if (region && /^(SECTION|FORM|FIELDSET)$/.test(node.tagName) || (node.getAttribute && /region|group/.test(node.getAttribute('role') || '') && region)) return clean(region, 80);
      const heads = Array.from(node.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,[role=heading]'));
      const before = heads.filter((h) => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && !h.contains(el));
      if (before.length) return clean(textOf(before[before.length - 1]), 80);
      node = node.parentElement;
    }
    return '';
  }

  function selectorOf(el) {
    if (el.id) {
      const sel = `#${CSS.escape(el.id)}`;
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (_) { /* ignore */ }
    }
    if (el.name) {
      const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (_) { /* ignore */ }
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 8) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
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

  const fields = [];
  const groups = new Map(); // radio/checkbox groups by form+name
  let hiddenCount = 0;

  const controls = Array.from(document.querySelectorAll(
    'input, select, textarea, [contenteditable="true"], [contenteditable=""], [role=textbox], [role=combobox], [role=checkbox], [role=switch], [role=radiogroup], [role=listbox], [role=spinbutton]'
  ));

  for (const el of controls) {
    const tag = el.tagName;
    const type = tag === 'INPUT' ? (el.type || 'text').toLowerCase() : '';
    if (tag === 'INPUT' && ['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
    // ARIA wrappers around a native control: the native control is used instead
    if (!/^(INPUT|SELECT|TEXTAREA)$/.test(tag) && el.querySelector('input:not([type=hidden]), select, textarea')) continue;
    if (tag !== 'INPUT' && el.closest('[role=radiogroup]') && el.getAttribute('role') !== 'radiogroup') continue;
    if (!isVisible(el)) { hiddenCount++; continue; }

    const label = stripMarks(rawLabel(el));
    const rawReq = clean(rawLabel(el));
    const required = !!(el.required || el.getAttribute('aria-required') === 'true' || /\*\s*[:：]?\s*$/.test(rawReq) || /^\*/.test(rawReq));
    const help = clean([el.getAttribute('aria-describedby') ? byIds(el.getAttribute('aria-describedby')) : '', el.title && el.title !== label ? el.title : ''].filter(Boolean).join(' '), 200);

    // Radio buttons and same-name checkboxes become one field with options
    if ((type === 'radio' || type === 'checkbox') && el.name) {
      const key = `${type}|${el.form ? Array.from(document.forms).indexOf(el.form) : -1}|${el.name}`;
      const sameName = document.querySelectorAll(`input[type=${type}][name="${CSS.escape(el.name)}"]`).length;
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
            label: stripMarks(groupLabel) || humanize(el.name),
            section: sectionOf(el),
            type: type === 'radio' ? 'Radio buttons' : 'Checkbox group',
            required: false,
            readonly: false,
            disabled: el.disabled,
            options: [],
            value: '',
            name: el.name,
            domId: '',
            maxLength: '', minLength: '', min: '', max: '', pattern: '', placeholder: '',
            help,
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
      options = Array.from(el.options)
        .map((o) => clean(o.text, 80))
        .filter((t, i) => t && !(i === 0 && /^(-+|select|choose|please|--|请选择|請選擇)/i.test(t)));
      value = Array.from(el.selectedOptions).map((o) => clean(o.text, 80)).filter((t) => !/^(-+|select|choose|please|请选择)/i.test(t)).join(', ');
    } else if (tag === 'TEXTAREA') {
      kind = 'Multi-line text';
      value = el.value;
    } else if (tag === 'INPUT') {
      if (type === 'checkbox') value = el.checked ? 'checked' : 'unchecked';
      else value = el.value;
      const list = el.getAttribute('list');
      if (list && document.getElementById(list)) {
        options = Array.from(document.getElementById(list).options).map((o) => clean(o.value || o.text, 80)).filter(Boolean);
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
      optionCount: options.length,
      value: clean(value, 120),
      help,
      name: el.name || '',
      domId: el.id || '',
      selector: selectorOf(el),
    });
  }

  // Buttons and links that act on the form
  const actions = [];
  const seen = new Set();
  document.querySelectorAll('button, input[type=submit], input[type=button], input[type=reset], [role=button]').forEach((b) => {
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
  if (!el) return false;
  let target = el;
  if (target.getBoundingClientRect().width === 0) target = el.closest('label, td, div') || el;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  document.getElementById('__specsnap_hl')?.remove();
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
