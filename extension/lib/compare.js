// Matching fields between two screens (e.g. legacy system → new system)
// and flagging data-migration risks.

// Words that mean the same thing in business systems
const SYNONYMS = [
  ['vendor', 'supplier', 'provider'],
  ['customer', 'client', 'account'],
  ['phone', 'telephone', 'tel', 'mobile', 'cell'],
  ['email', 'e mail', 'mail'],
  ['zip', 'postal', 'postcode'],
  ['tax', 'tin', 'ein', 'vat'],
  ['id', 'no', 'number', 'num', 'code', '#'],
  ['name', 'title'],
  ['bank', 'banking'],
  ['account', 'acct', 'acc'],
  ['iban', 'bank account'],
  ['payment', 'pay'],
  ['term', 'terms'],
  ['country', 'nation'],
  ['state', 'province', 'region'],
  ['city', 'town'],
  ['address', 'addr', 'street'],
  ['company', 'organisation', 'organization', 'business', 'firm'],
  ['remarks', 'notes', 'comments', 'comment', 'note', 'memo', 'description'],
  ['start', 'begin', 'from'],
  ['end', 'finish', 'to', 'until'],
  ['date', 'dt', 'day'],
  ['amount', 'amt', 'value', 'total'],
  ['currency', 'ccy', 'cur'],
  ['contact', 'person', 'representative'],
  ['confirm', 'agree', 'accept', 'acknowledge'],
];
const CANON = new Map();
SYNONYMS.forEach((group) => group.forEach((w) => CANON.set(w, group[0])));
const STOP = new Set(['the', 'of', 'a', 'an', 'and', 'or', 'for', 'in', 'is', 'are', 'your', 'please', 'enter', 'select', 'i']);

function tokens(s) {
  const t = String(s || '')
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/e-mail/g, 'email')
    .replace(/[^a-z0-9一-鿿]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOP.has(w))
    .map((w) => CANON.get(w) || w.replace(/s$/, ''));
  return new Set(t.map((w) => CANON.get(w) || w));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  a.forEach((w) => { if (b.has(w)) inter++; });
  return inter / (a.size + b.size - inter);
}

const TYPE_FAMILY = {
  Text: 'text', 'Multi-line text': 'text', 'Rich text': 'text', 'Text with suggestions': 'text', Email: 'text', Phone: 'text', URL: 'text', Password: 'text',
  Number: 'number', Slider: 'number', Amount: 'number',
  Date: 'date', 'Date & time': 'date', Time: 'date', Month: 'date', Week: 'date',
  Dropdown: 'choice', 'Radio buttons': 'choice', List: 'choice', 'Multi-select': 'multi', 'Checkbox group': 'multi',
  Checkbox: 'bool', Toggle: 'bool', 'Yes/No': 'bool',
  'Status / category': 'choice',
  'File upload': 'file',
};
export const family = (t) => TYPE_FAMILY[t] || 'text';

export function similarity(a, b) {
  const label = jaccard(tokens(a.label), tokens(b.label));
  const name = jaccard(tokens(a.name || a.domId), tokens(b.name || b.domId));
  let score = Math.max(label, name * 0.9);
  if (label > 0 && name > 0) score = Math.min(1, score + 0.1);
  const fa = family(a.type);
  const fb = family(b.type);
  if (fa === fb) score += 0.1;
  else if (!((fa === 'text' && fb === 'choice') || (fa === 'choice' && fb === 'text'))) score -= 0.15;
  // Email vs phone vs URL are different data even though both are text
  const SPECIFIC = new Set(['Email', 'Phone', 'URL', 'Password']);
  if (a.type !== b.type && (SPECIFIC.has(a.type) || SPECIFIC.has(b.type)) && fa === fb) score -= 0.25;
  return Math.max(0, Math.min(1, score));
}

export function confidenceLabel(score) {
  if (score >= 0.8) return 'High';
  if (score >= 0.55) return 'Medium';
  return 'Low';
}

// Greedy best-first matching. Returns [{a, b, score}] with b = -1 for gaps.
export function matchFields(A, B, threshold = 0.4) {
  const pairs = [];
  A.forEach((fa, i) => B.forEach((fb, j) => {
    const s = similarity(fa, fb);
    if (s >= threshold) pairs.push({ a: i, b: j, score: s });
  }));
  pairs.sort((x, y) => y.score - x.score);
  const usedA = new Set();
  const usedB = new Set();
  const result = A.map((_, i) => ({ a: i, b: -1, score: 0, source: 'auto' }));
  for (const p of pairs) {
    if (usedA.has(p.a) || usedB.has(p.b)) continue;
    usedA.add(p.a);
    usedB.add(p.b);
    result[p.a] = { a: p.a, b: p.b, score: p.score, source: 'auto' };
  }
  return result;
}

// Business-readable risks for one mapping row
export function risksFor(fa, fb) {
  const r = [];
  if (!fb) {
    r.push('No field in the target screen: decide whether the data is dropped, moved elsewhere or needs a new field.');
    return r;
  }
  const la = Number(fa.maxLength) || 0;
  const lb = Number(fb.maxLength) || 0;
  if (fb.required && !fa.required) r.push('Required in target but optional in source: existing records may be empty and fail to load.');
  if (la && lb && la > lb) r.push(`Target allows ${lb} characters, source allows ${la}: longer values would be cut off.`);
  if (!la && lb) r.push(`Target limits this to ${lb} characters; source has no limit. Check the longest existing values.`);
  const fa2 = family(fa.type);
  const fb2 = family(fb.type);
  if (fa2 !== fb2) {
    if (fa2 === 'text' && fb2 === 'choice') r.push('Free text in source becomes a fixed list in target: existing values need to be mapped to the new options.');
    else if (fa2 === 'choice' && fb2 === 'text') r.push('Fixed list in source becomes free text in target: consider keeping a list to protect data quality.');
    else r.push(`Different field type (${fa.type} → ${fb.type}): values need converting.`);
  }
  if (fa2 === 'choice' && fb2 === 'choice' && fa.options && fb.options && fa.options.length && fb.options.length) {
    const tb = new Set(fb.options.map((o) => o.toLowerCase().trim()));
    const missing = fa.options.filter((o) => !tb.has(o.toLowerCase().trim()));
    if (missing.length) r.push(`Options not in target: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}. Map them to new values.`);
  }
  return r;
}
