import { LANGUAGES, DEFAULT_MODEL, ALL_SITES, getSettings, saveSettings, toast } from './lib/common.js';
import { testConnection } from './lib/ai.js';

const $ = (id) => document.getElementById(id);
const s = await getSettings();
$('language').innerHTML = Object.entries(LANGUAGES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
$('apiKey').value = s.apiKey;
$('model').value = s.model || DEFAULT_MODEL;
$('language').value = s.language;
const read = () => ({ apiKey: $('apiKey').value.trim(), model: $('model').value.trim() || DEFAULT_MODEL, language: $('language').value });
$('save').addEventListener('click', async () => { await saveSettings(read()); toast('Settings saved'); });
$('test').addEventListener('click', async () => {
  const cfg = read();
  if (!cfg.apiKey) { $('test-result').textContent = 'Enter a key first.'; return; }
  $('test-result').innerHTML = '<span class="spinner"></span>Testing…';
  try { await testConnection(cfg); await saveSettings(cfg); $('test-result').innerHTML = '<span style="color:var(--ok)">✓ Connected. Settings saved.</span>'; }
  catch (e) { $('test-result').innerHTML = `<span style="color:var(--danger)">✗ ${e.message.replace(/</g, '&lt;')}</span>`; }
});
async function renderAccess() {
  const on = await chrome.permissions.contains(ALL_SITES);
  $('access-state').innerHTML = on ? '<span style="color:var(--ok)">✓ Allowed on websites</span>' : '<span class="muted">Not allowed yet</span>';
  $('access-btn').textContent = on ? 'Remove access' : 'Allow website access';
  $('access-btn').className = on ? 'danger' : 'primary';
  $('access-btn').onclick = async () => { if (on) await chrome.permissions.remove(ALL_SITES); else await chrome.permissions.request(ALL_SITES); renderAccess(); };
}
renderAccess();
