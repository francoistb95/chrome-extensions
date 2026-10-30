# Followers Exporter for LinkedIn Pages

A small Chrome extension for LinkedIn Page admins. On your Page's
**Analytics > Followers** view, it reads your most recent followers (name,
headline, profile URL, month they followed) and:

- **downloads them as a CSV**, or
- **sends them to your own webhook** (n8n, Make, Zapier, a Clay webhook
  table...), so you can enrich them, push them to your CRM, alert your sales
  team, and so on.

You pick how many: the last 10, 100, 200, 500, 1,000 or 5,000 followers.

## Install (5 minutes)

The extension is not on the Chrome Web Store: you load it yourself. Works in
Google Chrome, Microsoft Edge, Brave and Arc.

1. Download the `linkedin-followers-exporter` zip from the
   [latest release](https://github.com/francoistb95/chrome-extensions/releases/latest),
   unzip it and move the folder somewhere it will stay (for example
   Documents). Chrome reads the extension from this folder every time it
   starts, so don't delete it.
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave:
   `brave://extensions`, Arc: `arc://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder, the one that
   contains `manifest.json`.
5. The card **Followers Exporter for LinkedIn Pages** appears. Done.

## Use it

1. Open your LinkedIn Page as an admin, then **Analytics > Followers**
   (`https://www.linkedin.com/company/<your-page>/admin/analytics/followers/`).
2. Next to **All followers** you get a **Last 200** picker, a button, and a
   settings icon.
3. Pick a number and click the button. The extension opens the followers list,
   scrolls to load them (a bar shows progress), then downloads the CSV or
   sends them to your webhook. A line next to the button tells you what
   happened and how far back it went.

Keep the tab open and in front while it loads: Chrome slows down background
tabs. Large numbers take a few minutes.

## Send to your own webhook

1. Click the settings icon next to the button (or the extension's icon in the
   toolbar).
2. Paste your webhook URL and click **Save**. Chrome asks you to allow the
   extension to reach that one address: accept.
3. Click **Send a test row** to check your webhook receives it.

From then on, the button on LinkedIn reads **Send to webhook**. Click
**Remove webhook** to go back to CSV downloads.

Your webhook receives one POST with a JSON array, newest follower first:

```json
[
  {
    "profile_url": "https://www.linkedin.com/in/someone/",
    "following_date": "2026-10",
    "name": "Someone",
    "headline": "Security Engineer at Example"
  }
]
```

`following_date` is a month (`YYYY-MM`): LinkedIn does not show the exact day.

**Optional:** if your webhook answers with JSON like `{"new": 37, "known": 163}`
(for example after checking which followers you already have), those counts
are shown next to the button. A good pattern for a weekly routine: push the
last 200 every week, and let your workflow skip the people it has already
seen.

## Troubleshooting

| You see | What to do |
|---|---|
| "Manifest file is missing or unreadable" when loading | Select the folder that contains `manifest.json`, not its parent |
| Nothing appears next to "All followers" | Check you are on **Analytics > Followers** as a Page admin, then reload the page |
| Could not find the "Show all followers" button | LinkedIn may have changed its page. Reload and try again |
| Read 0 followers | LinkedIn changed its layout. Open the console (Cmd + Option + J on Mac, Ctrl + Shift + J on Windows) and run `__lfeDiag()` to see what the extension found |
| The webhook did not answer / timed out | Check the URL in the settings and that your workflow is active, then try again |
| Chrome is not allowed to reach this address | Open the settings and click **Save** again, then accept Chrome's prompt |
| The list ended at N | LinkedIn has no more followers to show |

## Privacy

The extension stores only your webhook URL (in Chrome's sync storage). Follower
data goes only to your computer (CSV) or to the webhook you set. Nothing is
sent anywhere else.

Not affiliated with or endorsed by LinkedIn. Use it in line with LinkedIn's
terms, and only on Pages you administer.

## Files

| File | Role |
|---|---|
| `manifest.json` | Extension definition: the LinkedIn page it runs on, its permissions |
| `content.js` | The controls on LinkedIn, reading the followers list, CSV export |
| `background.js` | Sends the followers to your webhook (a script inside LinkedIn's page cannot call other sites directly) |
| `content.css` | Styling of the controls, protected against LinkedIn's own styles |
| `options.html`, `options.js` | The settings page (webhook URL) |
