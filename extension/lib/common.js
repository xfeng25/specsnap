// Shared helpers for SpecSnap pages.

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DECISIONS = ['', 'Keep', 'Change', 'Remove', 'New'];
export const LANGUAGES = {
  en: { label: 'English', prompt: 'English' },
  'zh-Hans': { label: '简体中文', prompt: 'Simplified Chinese' },
  'zh-Hant': { label: '繁體中文', prompt: 'Traditional Chinese' },
};
export const ALL_SITES = { origins: ['<all_urls>'] };

export async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return { apiKey: '', model: DEFAULT_MODEL, language: 'en', ...settings };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  await chrome.storage.local.set({ settings: { ...cur, ...patch } });
}

export async function getScreens() {
  const { screens = [] } = await chrome.storage.local.get('screens');
  return screens;
}

export async function saveScreens(screens) {
  await chrome.storage.local.set({ screens });
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function toast(msg, ms = 2400) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// "Max 40 chars · 2–10 · pattern [A-Z]+" style summary of the input rules
export function rulesText(f) {
  const parts = [];
  if (f.maxLength) parts.push(`max ${f.maxLength} chars`);
  if (f.minLength) parts.push(`min ${f.minLength} chars`);
  if (f.min || f.max) parts.push(`range ${f.min || '…'}–${f.max || '…'}`);
  if (f.pattern) parts.push(`pattern ${f.pattern}`);
  if (f.placeholder) parts.push(`e.g. “${f.placeholder}”`);
  return parts.join(' · ');
}

export function screenName(s) {
  return s.name || s.title || s.url;
}
