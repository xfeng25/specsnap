// Optional AI features (Claude API with the user's own key).
import { LANGUAGES, rulesText } from './common.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

async function callClaude(settings, system, text, maxTokens) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: settings.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: [{ type: 'text', text }] }] }),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch (_) { /* ignore */ }
    if (res.status === 401) msg = 'Your API key was rejected. Check it in Settings.';
    throw new Error(msg);
  }
  const data = await res.json();
  const out = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const s = out.indexOf('{');
  const e = out.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('The AI response was not in the expected format. Try again.');
  return JSON.parse(out.slice(s, e + 1));
}

const fieldLine = (f, i) => `${i}. "${f.label}" | type: ${f.type}${f.required ? ' | required' : ''}${f.readonly ? ' | read-only' : ''}${f.section ? ` | section: ${f.section}` : ''}${f.name ? ` | name: ${f.name}` : ''}${f.options && f.options.length ? ` | options: ${f.options.slice(0, 15).join(' / ')}` : ''}${rulesText(f) ? ` | rules: ${rulesText(f)}` : ''}`;

const DESCRIBE_PROMPT = `You are a senior business analyst documenting an existing business system screen for a requirements / data dictionary document.
For every field, write a short business description (one sentence: what the field captures and why it matters to the process). Base it on the label, type, options, section and screen; do not invent business rules that are not implied.
Then list up to 5 short "questions" a BA should confirm with the business or IT about this screen (e.g. missing validation, unclear ownership, fields with no length limit that feed other systems, optional fields that look mandatory for the process).
Respond with only JSON: {"fields": [{"index": number, "description": string}], "questions": string[]}`;

export async function describeFields(screen, settings) {
  const lang = (LANGUAGES[settings.language] || LANGUAGES.en).prompt;
  const text = `Screen: ${screen.name || screen.title}\nURL: ${screen.url}\n\nFields:\n${screen.fields.map(fieldLine).join('\n')}\n\nWrite descriptions and questions in ${lang}. Keep field names in their original language.`;
  const r = await callClaude(settings, DESCRIBE_PROMPT, text, 4000);
  return {
    descriptions: (r.fields || []).filter((x) => Number.isInteger(x.index)).map((x) => ({ index: x.index, description: String(x.description || '').trim() })),
    questions: (r.questions || []).map(String).slice(0, 5),
  };
}

const MATCH_PROMPT = `You are a data migration analyst mapping fields from a SOURCE screen (usually the legacy system) to a TARGET screen (usually the new system).
For each source field, pick the target field that holds the same business data, or null if none does. Use meaning, not just wording (e.g. "Supplier Name" = "Vendor name", "Tax No." = "Tax ID"). Each target field can be used at most once.
Give a confidence of "High", "Medium" or "Low" and a short note when the match needs attention (format change, list values, split/merged fields).
Respond with only JSON: {"matches": [{"source": number, "target": number|null, "confidence": "High"|"Medium"|"Low", "note": string}]}`;

export async function matchWithAI(A, B, settings) {
  const lang = (LANGUAGES[settings.language] || LANGUAGES.en).prompt;
  const text = `SOURCE screen: ${A.name || A.title}\n${A.fields.map(fieldLine).join('\n')}\n\nTARGET screen: ${B.name || B.title}\n${B.fields.map(fieldLine).join('\n')}\n\nWrite notes in ${lang}.`;
  const r = await callClaude(settings, MATCH_PROMPT, text, 4000);
  return (r.matches || []).filter((m) => Number.isInteger(m.source)).map((m) => ({
    source: m.source,
    target: Number.isInteger(m.target) ? m.target : null,
    confidence: ['High', 'Medium', 'Low'].includes(m.confidence) ? m.confidence : 'Medium',
    note: String(m.note || '').trim(),
  }));
}

export async function testConnection(settings) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: settings.model, max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] }),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch (_) { /* ignore */ }
    throw new Error(res.status === 401 ? 'Your API key was rejected.' : msg);
  }
  return true;
}
