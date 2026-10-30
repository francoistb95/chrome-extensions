'use strict';

const $ = id => document.getElementById(id);
const input = $('url');
let saved = '';

function show(msg, kind) {
  $('status').textContent = msg;
  $('status').dataset.kind = kind || '';
}

function hostOf(u) { try { return new URL(u).host; } catch (e) { return u; } }
function patternFor(u) { return new URL(u).origin + '/*'; }

function render() {
  $('mode').textContent = saved
    ? 'The button on LinkedIn sends the followers to ' + hostOf(saved) + '.'
    : 'No webhook set: the button on LinkedIn downloads a CSV.';
  $('test').disabled = !saved && !input.value.trim();
  $('remove').disabled = !saved;
}

// https only, except a local server for testing.
function validate(raw) {
  let u;
  try { u = new URL(raw.trim()); } catch (e) { return { error: 'This is not a valid URL.' }; }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    return { error: 'Use an https:// address (http:// is only accepted for localhost).' };
  }
  return { url: u.href };
}

async function dropPermission(oldUrl, newUrl) {
  if (!oldUrl) return;
  try {
    const before = patternFor(oldUrl);
    if (!newUrl || before !== patternFor(newUrl)) await chrome.permissions.remove({ origins: [before] });
  } catch (e) { /* nothing to remove */ }
}

// Returns true when the URL is saved. chrome.permissions.request needs the
// click's user gesture, so it is the first thing awaited.
async function save() {
  const raw = input.value.trim();
  if (!raw) { await removeWebhook(); return false; }
  const v = validate(raw);
  if (v.error) { show(v.error, 'error'); return false; }

  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [patternFor(v.url)] });
  } catch (e) {
    show('Chrome refused the permission: ' + e.message, 'error');
    return false;
  }
  if (!granted) {
    show('Not saved: Chrome needs your OK to send data to ' + hostOf(v.url) + '.', 'error');
    return false;
  }

  const previous = saved;
  await chrome.storage.sync.set({ webhookUrl: v.url });
  await dropPermission(previous, v.url);
  saved = v.url;
  input.value = v.url;
  render();
  show('Saved. The button on LinkedIn now sends to ' + hostOf(v.url) + '.', 'ok');
  return true;
}

async function removeWebhook() {
  const previous = saved;
  await chrome.storage.sync.set({ webhookUrl: '' });
  await dropPermission(previous, null);
  saved = '';
  input.value = '';
  render();
  show('Webhook removed: the button downloads a CSV again.', 'ok');
}

async function sendTest() {
  // An edited URL is saved first, inside the same click.
  if (input.value.trim() !== saved) {
    if (!(await save())) return;
  }
  show('Sending one test row…');
  const sample = [{
    profile_url: 'https://www.linkedin.com/in/test-profile/',
    following_date: new Date().toISOString().slice(0, 7),
    name: 'Test Follower',
    headline: 'Sent from the extension settings'
  }];
  let res;
  try { res = await chrome.runtime.sendMessage({ type: 'lfe-post', body: sample }); }
  catch (e) { res = { ok: false, status: 0, error: e.message }; }
  if (res && res.ok) {
    show('Test row delivered to ' + hostOf(saved) + ' (HTTP ' + res.status + ').', 'ok');
  } else {
    const why = !res ? 'no answer'
      : res.error ? res.error
      : 'HTTP ' + res.status + (res.body ? ': ' + String(res.body).slice(0, 120) : '');
    show('Test failed: ' + why, 'error');
  }
}

$('save').addEventListener('click', save);
$('test').addEventListener('click', sendTest);
$('remove').addEventListener('click', removeWebhook);
input.addEventListener('input', render);
input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });

chrome.storage.sync.get({ webhookUrl: '' }).then(v => {
  saved = v.webhookUrl || '';
  input.value = saved;
  render();
});
