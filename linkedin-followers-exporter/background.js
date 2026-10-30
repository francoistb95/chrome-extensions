/* Sends the followers to the webhook set in the settings.
   A content script's fetch obeys LinkedIn's CORS rules; the extension's
   worker does not, once the person has allowed the webhook's site. */
'use strict';

// Clicking the toolbar icon opens the settings.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

/* MV3 kills an idle service worker, and any fetch in flight at that moment
   loses its reply. While a port is connected the worker is kept alive, so the
   content script opens one for the duration of a send. */
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'lfe-keepalive') return;
  const beat = setInterval(() => {
    try { port.postMessage({ type: 'lfe-beat' }); } catch (e) { /* closing */ }
  }, 20000);
  port.onDisconnect.addListener(() => clearInterval(beat));
});

function originPattern(url) {
  return new URL(url).origin + '/*';
}

async function post(body) {
  const { webhookUrl } = await chrome.storage.sync.get({ webhookUrl: '' });
  if (!webhookUrl) {
    return { ok: false, status: 0, setup: true, error: 'No webhook URL set: open the extension settings' };
  }

  let pattern;
  try { pattern = originPattern(webhookUrl); }
  catch (e) { return { ok: false, status: 0, setup: true, error: 'The webhook URL in the settings is not valid' }; }

  const allowed = await chrome.permissions.contains({ origins: [pattern] });
  if (!allowed) {
    return { ok: false, status: 0, setup: true,
             error: 'Chrome is not allowed to reach this address yet: open the settings and click Save' };
  }

  // A webhook usually answers fast; a cold workflow can take longer.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: (text || '').slice(0, 4000) };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: (err && err.name === 'AbortError') ? 'timed out after 60s'
                                                : String((err && err.message) || err)
    };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only this extension's own pages and scripts may ask for a send.
  if (!msg || sender.id !== chrome.runtime.id) return;

  if (msg.type === 'lfe-open-options') {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (msg.type === 'lfe-post') {
    post(msg.body).then(sendResponse);
    return true;   // async response
  }
});
