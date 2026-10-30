/* ============================================================
   Followers Exporter for LinkedIn Pages  ·  v1.0.0

   Reads the most recent followers of a LinkedIn Page you administer,
   from Analytics > Followers, then either sends them to your own
   webhook (n8n, Make, Zapier, Clay...) or downloads them as a CSV.

   Nothing is stored, and nothing leaves your browser except the one
   request to the webhook URL you set in the extension's settings.
   ============================================================ */
(function () {
  'use strict';

  const VERSION = (() => {
    try { return chrome.runtime.getManifest().version; } catch (e) { return 'unknown'; }
  })();
  window.__lfeVersion = VERSION;

  /* ---------- configuration ----------------------------------- */
  // 10 is a quick test, 200 a weekly routine, the larger sizes catch up
  // after missed weeks or pull a whole history once.
  const COUNTS = [10, 100, 200, 500, 1000, 5000];
  const DEFAULT_COUNT = 200;

  const SCROLL_PAUSE_MS = 700;
  const STALL_ROUNDS = 8;
  const RESET_AFTER_MS = 15000;
  // Chrome throttles timers in background tabs, which stalls the scrolling.
  const FOREGROUND_HINT_FROM = 1000;

  /* ---------- months ------------------------------------------ */
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];

  // A French LinkedIn UI stamps rows "août 2026". Recognise both, report English.
  const MONTH_FR = {
    'janvier':'January','février':'February','fevrier':'February','mars':'March',
    'avril':'April','mai':'May','juin':'June','juillet':'July','août':'August',
    'aout':'August','septembre':'September','octobre':'October',
    'novembre':'November','décembre':'December','decembre':'December'
  };
  // Longest first: alternation is first-match-wins.
  const MONTH_WORDS = MONTHS.concat(Object.keys(MONTH_FR)).sort((a, b) => b.length - a.length);
  const M = '(' + MONTH_WORDS.join('|') + ')\\s+(\\d{4})';

  // Any month reference. No leading \b: months sit flush against neighbouring
  // text in concatenated textContent ("...Role 0August 2026").
  const MONTH_RE = new RegExp(M + '(?!\\d)', 'i');

  // The accessibility string LinkedIn puts on each row. This is the follow
  // date stated outright, so it beats guessing at the first month-like text,
  // which picks up any month mentioned inside a headline.
  const FOLLOWED_RE = new RegExp('followed your page in\\s+' + M, 'i');

  // A field that is only a date, with nothing else in it.
  const DATE_ONLY_RE = new RegExp('^(?:followed your page in\\s+)?' + M + '$', 'i');

  function monthToEnglish(w) {
    const lower = String(w || '').toLowerCase();
    return MONTHS.find(m => m.toLowerCase() === lower) || MONTH_FR[lower] || w;
  }
  function monthIndex(englishName) {
    return MONTHS.indexOf(englishName) + 1;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fmt = n => Number(n).toLocaleString('en-US');

  /* ---------- finding things on the page ---------------------- */
  // Prefer visible labels over class names: LinkedIn renames classes far more
  // often than it renames its own UI text.
  function byText(selector, re, root) {
    return Array.from((root || document).querySelectorAll(selector))
      .find(el => re.test((el.innerText || '').trim()));
  }

  function findFollowersCard() {
    return Array.from(document.querySelectorAll('h2, h3'))
      .find(h => /^all followers/i.test((h.innerText || '').trim())) || null;
  }

  // The messaging bubble is also a [role="dialog"] full of profile links.
  // Accepting it means scraping chat threads and never opening the real list.
  const CHAT_SEL = '[class*="msg-overlay"], [class*="msg-convo"], [class*="msg-form"]';

  function isFollowersList(el) {
    if (!el) return false;
    const cls = (el.className || '').toString();
    if (/org-view-page-followers-modal/.test(cls)) return true;
    if (/msg-overlay|msg-convo|messaging/i.test(cls)) return false;
    if (el.closest && el.closest(CHAT_SEL)) return false;
    if (el.querySelector && el.querySelector(CHAT_SEL)) return false;
    const links = el.querySelectorAll('a[href^="/in/"], a[href*="linkedin.com/in/"]').length;
    return links >= 3 && MONTH_RE.test(el.textContent || '');
  }

  function findModal() {
    return document.querySelector('.org-view-page-followers-modal')
        || Array.from(document.querySelectorAll('[role="dialog"], .artdeco-modal'))
             .find(isFollowersList)
        || null;
  }

  function findScroller(modal) {
    let best = null;
    modal.querySelectorAll('*').forEach(el => {
      if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 100) {
        if (!best || el.scrollHeight > best.scrollHeight) best = el;
      }
    });
    return best;
  }

  /* ---------- extraction -------------------------------------- */
  // LinkedIn injects screen-reader-only "Nth degree connection" text and a
  // "· 2nd" suffix beside names.
  const stripDeg = s => String(s || '')
    .replace(/(1st|2nd|3rd)\+?\s*degree connection/gi, '')
    .replace(/\s*·\s*(1st|2nd|3rd)\+?\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Text that is never a name or a headline.
  const NOISE_RE = /^(premium|verified|verified profile|profile|open to work|status is (online|offline|reachable)|·|•|,|\.|\|)$/i;

  function slugOf(a) {
    const p = (a.getAttribute('href') || '')
      .replace(/^https?:\/\/[^/]+/, '').split('?')[0].replace(/\/$/, '');
    return p.startsWith('/in/') ? p.slice(4) : '';
  }

  function distinctPeople(node) {
    const s = new Set();
    node.querySelectorAll('a[href^="/in/"], a[href*="linkedin.com/in/"]')
      .forEach(a => { const g = slugOf(a); if (g) s.add(g); });
    return s.size;
  }

  // Discrete leaf elements, not split innerText. A row is one big anchor, so
  // reading the anchor's own text returns the whole row glued together. Leaves
  // keep the fields apart whatever the layout does.
  function leafTexts(box) {
    const out = [];
    box.querySelectorAll('*').forEach(el => {
      if (el.children.length === 0) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) out.push(t);
      }
    });
    if (!out.length) {
      const t = (box.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    }
    return out;
  }

  // `known` (slug -> row) lets a long capture parse only the rows it has not
  // seen yet. Re-reading 5,000 rows on every scroll is quadratic and would
  // crawl. A row still missing its date is read again in case it rendered late.
  function extract(modal, known) {
    if (!modal) return [];
    const out = [], seen = new Set();

    modal.querySelectorAll('a[href^="/in/"], a[href*="linkedin.com/in/"]').forEach(a => {
      const slug = slugOf(a);
      if (!slug || seen.has(slug)) return;
      const prior = known && known.get(slug);
      if (prior && prior.followedMonth) { seen.add(slug); return; }

      // The row is usually the anchor itself. Start there, then climb only if
      // the stamp lives on an ancestor.
      let box = null, loose = null;
      if (MONTH_RE.test(a.textContent || '')) { box = a; loose = a; }

      if (!box) {
        let node = a;
        for (let i = 0; i < 8 && node; i++) {
          node = node.parentElement;
          if (!node) break;
          if (!MONTH_RE.test(node.textContent || '')) continue;
          if (!loose) loose = node;
          if (distinctPeople(node) > 1) break;
          box = node;
          break;
        }
      }

      const exact = !!box;
      box = box || loose;
      if (!box) return;

      const pieces = leafTexts(box).map(stripDeg).filter(Boolean);

      // Follow date: the stated one first, a date-only field second. Never a
      // month merely mentioned inside a headline.
      let stamp = null;
      const declared = (box.textContent || '').match(FOLLOWED_RE);
      if (declared) {
        stamp = { month: monthToEnglish(declared[1]), year: declared[2] };
      } else {
        const dateField = pieces.find(t => DATE_ONLY_RE.test(t));
        const m = dateField && dateField.match(DATE_ONLY_RE);
        if (m) stamp = { month: monthToEnglish(m[1]), year: m[2] };
      }

      // Name and headline are the first two fields that are not dates,
      // degree markers or badges, in document order.
      const isField = t =>
        t && !DATE_ONLY_RE.test(t) && !FOLLOWED_RE.test(t) &&
        !NOISE_RE.test(t) && !/^·?\s*(1st|2nd|3rd)\+?$/.test(t);
      const fields = pieces.filter(isField);

      const name = fields[0] || '';
      const headline = fields.find(t => t !== name) || '';

      seen.add(slug);
      out.push({
        slug: slug,
        name: name,
        profileUrl: 'https://www.linkedin.com/in/' + slug + '/',
        // On the fallback path the container covers several people, so its
        // headline and date are not reliably this person's. Withhold both
        // rather than attribute someone else's.
        headline: exact ? headline : '',
        followedMonth: exact && stamp ? stamp.month + ' ' + stamp.year : '',
        followedYear: exact && stamp ? Number(stamp.year) : null,
        followedMonthIndex: exact && stamp ? monthIndex(stamp.month) : null
      });
    });

    return out;
  }


  /* ---------- payload ----------------------------------------- */
  // "2026-08": LinkedIn only gives the month of the follow.
  function followingDate(row) {
    if (!row.followedYear || !row.followedMonthIndex) return '';
    return row.followedYear + '-' + String(row.followedMonthIndex).padStart(2, '0');
  }

  const payloadFor = row => ({
    profile_url: row.profileUrl,
    following_date: followingDate(row),
    name: row.name,
    headline: row.headline
  });

  /* ---------- settings ---------------------------------------- */
  // The webhook URL is set on the extension's settings page and kept in
  // chrome.storage. Empty means "download a CSV instead".
  function getWebhookUrl() {
    return new Promise(resolve => {
      try {
        chrome.storage.sync.get({ webhookUrl: '' }, v => resolve((v && v.webhookUrl) || ''));
      } catch (e) { resolve(''); }
    });
  }

  function openSettings() {
    try { chrome.runtime.sendMessage({ type: 'lfe-open-options' }); } catch (e) {}
  }

  /* ---------- webhook ----------------------------------------- */
  // Holding a port stops MV3 retiring the service worker mid-request.
  function openKeepalive() {
    try {
      const port = chrome.runtime.connect({ name: 'lfe-keepalive' });
      port.onMessage.addListener(() => {});
      port.onDisconnect.addListener(() => {});
      return port;
    } catch (e) { return null; }
  }

  // One request for the whole capture. The background worker reads the URL
  // from the settings itself, so the page never decides where data goes.
  // No automatic retry: if the reply is lost, the webhook may already have
  // the data, and a blind resend would deliver it twice.
  function postToWebhook(body) {
    const keepalive = openKeepalive();
    return new Promise(resolve => {
      let settled = false;
      const done = r => {
        if (settled) return;
        settled = true;
        if (keepalive) { try { keepalive.disconnect(); } catch (e) {} }
        resolve(r);
      };
      const timer = setTimeout(
        () => done({ ok: false, status: 0, error: 'no reply from the extension worker' }), 70000);
      try {
        chrome.runtime.sendMessage({ type: 'lfe-post', body: body }, res => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            done({ ok: false, status: 0, error: chrome.runtime.lastError.message });
          } else {
            done(res || { ok: false, status: 0, error: 'no response' });
          }
        });
      } catch (e) {
        clearTimeout(timer);
        done({ ok: false, status: 0, error: String((e && e.message) || e) });
      }
    });
  }

  // Server error pages are HTML. Show the human part, not the doctype.
  function summarizeBody(body) {
    const t = String(body || '');
    const pre = t.match(/<pre>([\s\S]*?)<\/pre>/i);
    if (pre) return pre[1].trim().slice(0, 80);
    const title = t.match(/<title>([\s\S]*?)<\/title>/i);
    if (title) return title[1].trim().slice(0, 80);
    return t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function failureText(res) {
    // A settings problem, not a webhook problem: the request was never sent.
    if (res.setup) return res.error + '.';
    if (!res.status) return 'The webhook did not answer: ' + (res.error || 'network error') + '.';
    let msg = 'The webhook answered ' + res.status;
    const detail = res.body ? summarizeBody(res.body) : '';
    if (detail) msg += ': ' + detail;
    if (res.status === 404) msg += '. Check the URL in the settings, and that your workflow is active.';
    return msg + (/[.?]$/.test(msg) ? '' : '.');
  }

  // Optional. If your webhook answers JSON with numeric "new" and "known"
  // fields (for example after deduplicating), the counts are shown.
  function parseSummary(body) {
    try {
      const j = JSON.parse(body || '');
      return j && typeof j.new === 'number' ? j : null;
    } catch (e) { return null; }
  }

  /* ---------- CSV --------------------------------------------- */
  const csvCell = s => '"' + String(s == null ? '' : s)
    .replace(/"/g, '""').replace(/\r?\n/g, ' ').trim() + '"';

  const toCsv = rows => ['Name,Profile URL,Headline,Followed']
    .concat(rows.map(r => [r.name, r.profileUrl, r.headline, r.followedMonth]
      .map(csvCell).join(',')))
    .join('\n');

  function stampNow() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           '-' + p(d.getHours()) + p(d.getMinutes());
  }

  // The BOM makes Excel read accented names as UTF-8.
  function download(text, filename) {
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  /* ---------- the run ----------------------------------------- */
  async function openListIfNeeded(report) {
    const already = findModal();
    if (already && isFollowersList(already)) return already;

    report('Opening list…', 0.02);
    const trigger = byText('button, a', /show all followers/i);
    if (!trigger) throw new Error('Could not find the "Show all followers" button.');
    trigger.click();

    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const m = findModal();
      if (m && isFollowersList(m)) return m;
    }
    throw new Error('The followers list did not open in time.');
  }

  async function capture(target, report) {
    const modal = await openListIfNeeded(report);

    const peopleTab = byText('button', /^people$/i, modal);
    if (peopleTab && !/true/i.test(peopleTab.getAttribute('aria-pressed') || '')) {
      peopleTab.click();
      await sleep(600);
    }

    const scroller = findScroller(modal);
    if (!scroller) throw new Error('Could not find the scrollable list.');

    // Accumulated across rounds, in list order (a Map keeps first insertion
    // order). Rows survive even if LinkedIn ever recycles old DOM nodes.
    const found = new Map();
    const harvest = () => extract(modal, found).forEach(r => found.set(r.slug, r));
    harvest();

    // LinkedIn loads roughly 10 to 20 rows per scroll. Leave plenty of room.
    const maxRounds = Math.ceil(target / 4) + 60;
    let flat = 0, rounds = 0;

    while (found.size < target && rounds++ < maxRounds) {
      const before = found.size;
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(SCROLL_PAUSE_MS);
      harvest();
      report('Loading ' + fmt(Math.min(found.size, target)) + ' / ' + fmt(target),
             0.05 + 0.8 * Math.min(1, found.size / target));
      if (found.size > before) { flat = 0; continue; }

      // Some lists stop auto-loading and show a button instead.
      const more = byText('button', /^(show|load|see) more|^(voir|afficher) plus/i, modal);
      if (more && !more.disabled) { more.click(); flat = 0; continue; }
      if (++flat >= STALL_ROUNDS) break;
    }

    const rows = Array.from(found.values());
    if (!rows.length) throw new Error(diagnose());
    return { rows: rows.slice(0, target), hitEnd: rows.length < target };
  }

  // The list runs newest first, so the last dated row is how far back this
  // push reaches. That is what tells someone whether a bigger size was needed.
  function oldestMonth(rows) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].followedMonth) return rows[i].followedMonth;
    }
    return '';
  }

  /* ---------- diagnostics ------------------------------------- */
  function diagnose() {
    const m = findModal();
    if (!m) return 'The followers list did not open.';
    const links = m.querySelectorAll('a[href^="/in/"], a[href*="linkedin.com/in/"]').length;
    const cls = (m.className || '').toString().slice(0, 50) || '(no class)';
    return 'Read 0 followers. Matched element: ' + cls +
           '. Profile links visible: ' + links +
           '. Month stamps found: ' + (MONTH_RE.test(m.textContent || '') ? 'yes' : 'no') +
           '. Run __lfeDiag() in the console for detail.';
  }

  // Structure only, no personal detail, so the output is safe to paste.
  window.__lfeDiag = function () {
    const m = findModal();
    if (!m) { console.log('[followers-exporter] list not open'); return; }
    const a = m.querySelector('a[href^="/in/"], a[href*="linkedin.com/in/"]');
    if (!a) { console.log('[followers-exporter] no profile links in the list'); return; }
    const chain = [];
    let node = a;
    for (let i = 0; i < 6; i++) {
      node = node.parentElement;
      if (!node) break;
      chain.push({
        level: i, tag: node.tagName,
        cls: (node.className || '').toString().slice(0, 60),
        people: distinctPeople(node),
        hasMonth: MONTH_RE.test(node.textContent || '')
      });
    }
    const rows = extract(m);
    const info = {
      version: VERSION,
      modalClass: (m.className || '').toString().slice(0, 80),
      totalLinks: m.querySelectorAll('a[href^="/in/"], a[href*="linkedin.com/in/"]').length,
      parsed: rows.length,
      anchorIsRow: MONTH_RE.test(a.textContent || ''),
      anchorLeafCount: leafTexts(a).length,
      followedStringPresent: FOLLOWED_RE.test(m.textContent || ''),
      sampleFieldShape: leafTexts(a).map(t => stripDeg(t).length),
      samplePayloadKeys: rows[0] ? Object.keys(payloadFor(rows[0])) : null,
      ancestors: chain
    };
    console.log('[followers-exporter] diagnostics\n' + JSON.stringify(info, null, 2));
    return info;
  };


  /* ---------- controls ---------------------------------------- */
  // Built with DOM calls rather than innerHTML, so a Trusted Types policy on
  // the page cannot block them.
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function svg(paths) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    paths.forEach(d => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      s.appendChild(path);
    });
    return s;
  }

  // Simple line icons (Feather-style geometry).
  const ICON_SEND = ['M22 2 11 13', 'M22 2 15 22 11 13 2 9 22 2z'];
  const ICON_DOWNLOAD = ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'];
  const ICON_SETTINGS = [
    'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'
  ];
  const ICON_CHEVRON = ['M6 9l6 6 6-6'];

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function mountControls() {
    if (document.querySelector('.lfe-wrap')) return;
    const heading = findFollowersCard();
    if (!heading) return;

    const wrap = el('span', 'lfe-wrap');
    const controls = el('span', 'lfe-controls');

    // How many of the most recent followers to read. A span, not a label:
    // LinkedIn styles bare labels, which knocks the pill out of line.
    const picker = el('span', 'lfe-picker');
    picker.title = 'How many of the most recent followers to read';
    const valueText = el('span', 'lfe-picker-value', fmt(DEFAULT_COUNT));
    const select = el('select', 'lfe-select');
    select.setAttribute('aria-label', 'Number of most recent followers to export');
    COUNTS.forEach(n => {
      const o = el('option', null, 'Last ' + fmt(n));
      o.value = String(n);
      if (n === DEFAULT_COUNT) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener('change', () => { valueText.textContent = fmt(select.value); });
    const chevron = el('span', 'lfe-chevron');
    chevron.appendChild(svg(ICON_CHEVRON));
    picker.append(el('span', 'lfe-picker-prefix', 'Last'), valueText, select, chevron);

    const btn = el('button', 'lfe-btn');
    btn.type = 'button';
    btn.dataset.state = 'idle';
    const icon = el('span', 'lfe-icon');
    const label = el('span', 'lfe-label');
    btn.append(icon, label);

    const gear = el('button', 'lfe-gear');
    gear.type = 'button';
    gear.title = 'Settings: where to send the followers';
    gear.setAttribute('aria-label', 'Open settings');
    gear.appendChild(svg(ICON_SETTINGS));
    gear.addEventListener('click', openSettings);

    const note = el('span', 'lfe-note');
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');

    let running = false, resetTimer = null, webhookUrl = '';

    // The button says what it will do: send to the webhook, or download a CSV.
    function idleLabel() { return webhookUrl ? 'Send to webhook' : 'Download CSV'; }
    function showMode() {
      icon.textContent = '';
      icon.appendChild(svg(webhookUrl ? ICON_SEND : ICON_DOWNLOAD));
      btn.title = (webhookUrl
        ? 'Read the most recent followers and send them to ' + safeHost(webhookUrl)
        : 'Read the most recent followers and download them as a CSV. Add a webhook in the settings to send them instead') +
        '  (v' + VERSION + ')';
      if (!running && btn.dataset.state === 'idle') label.textContent = idleLabel();
    }
    function safeHost(u) { try { return new URL(u).host; } catch (e) { return 'your webhook'; } }

    function setState(state, text, progress) {
      btn.dataset.state = state;
      label.textContent = text;
      if (progress == null) btn.style.removeProperty('--lfe-progress');
      else btn.style.setProperty('--lfe-progress', String(progress));
    }
    function lock(on) {
      running = on;
      btn.disabled = on;
      select.disabled = on;
      picker.classList.toggle('lfe-disabled', on);
    }
    // Plain text with bold runs: **like this**. textContent only, never HTML.
    function setNote(text) {
      note.textContent = '';
      String(text).split('**').forEach((part, i) => {
        if (!part) return;
        note.appendChild(i % 2 ? el('strong', null, part) : document.createTextNode(part));
      });
    }

    getWebhookUrl().then(u => { webhookUrl = u; showMode(); });
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.webhookUrl) {
          webhookUrl = changes.webhookUrl.newValue || '';
          showMode();
        }
      });
    } catch (e) { /* storage unavailable: CSV mode */ }

    btn.addEventListener('click', async () => {
      if (running) return;
      const target = Number(select.value) || DEFAULT_COUNT;
      webhookUrl = await getWebhookUrl();
      showMode();
      clearTimeout(resetTimer);
      lock(true);
      setNote(target >= FOREGROUND_HINT_FROM
        ? 'Keep this tab open and in front while it loads: Chrome slows down background tabs.'
        : '');
      setState('busy', 'Loading 0 / ' + fmt(target), 0.02);
      const t0 = Date.now();

      try {
        const { rows, hitEnd } = await capture(target, (text, p) => setState('busy', text, p));

        const oldest = oldestMonth(rows);
        const reach = oldest ? ' Oldest follower: ' + oldest + '.' : '';
        const ended = hitEnd ? ' The list ended at ' + fmt(rows.length) + '.' : '';
        const secs = () => ' ' + Math.round((Date.now() - t0) / 1000) + 's.';
        window.__lfeLast = { at: new Date().toISOString(), count: rows.length, followers: rows };

        if (!webhookUrl) {
          const file = 'linkedin-followers-' + stampNow() + '.csv';
          download(toCsv(rows), file);
          setState('done', 'Saved ' + fmt(rows.length));
          setNote(fmt(rows.length) + ' followers saved to **' + file + '**.' + reach + ended + secs());
          return;
        }

        setState('busy', 'Sending ' + fmt(rows.length) + '…', 0.92);
        const res = await postToWebhook(rows.map(payloadFor));
        window.__lfeLast.response = { status: res.status, error: res.ok ? null : (res.error || summarizeBody(res.body)) };
        if (!res.ok) throw new Error(failureText(res));

        const summary = parseSummary(res.body);
        if (summary) {
          setState('done', summary.new ? 'Sent · ' + fmt(summary.new) + ' new' : 'Nothing new');
          setNote(fmt(rows.length) + ' sent: **' + fmt(summary.new) + ' new**' +
                  (typeof summary.known === 'number' ? ', ' + fmt(summary.known) + ' already known' : '') +
                  '.' + reach + ended + secs());
        } else {
          setState('done', 'Sent ' + fmt(rows.length));
          setNote('**' + fmt(rows.length) + ' followers** sent to ' + safeHost(webhookUrl) +
                  ' (HTTP ' + res.status + ').' + reach + ended + secs());
        }
      } catch (err) {
        setState('error', 'Failed');
        setNote(err.message + ' (v' + VERSION + ')');
        console.error('[followers-exporter] Export failed:', err);
      } finally {
        lock(false);
        // The button settles back; the result line stays as a record of the run.
        resetTimer = setTimeout(() => {
          if (!running) setState('idle', idleLabel());
        }, RESET_AFTER_MS);
      }
    });

    setState('idle', idleLabel());
    controls.append(picker, btn, gear);
    wrap.append(controls, note);
    heading.appendChild(wrap);
  }

  const observer = new MutationObserver(() => mountControls());
  observer.observe(document.body, { childList: true, subtree: true });
  mountControls();

  console.log('[followers-exporter] v' + VERSION + ' ready.');
})();
