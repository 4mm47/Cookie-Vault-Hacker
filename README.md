# 🍪 Cookie Vault Hacker — Session Inspector & Exporter

**Read-only cookie inspector for Chrome (Manifest V3).**
Review, filter and export the cookies of the current site — or of your whole browser
profile — as Netscape, JSON, CSV, Cookie-header or JavaScript.

Originally by **[@4mm47](https://github.com/4mm47)** · v2.0.0

---

## What this is (and what it is not)

Cookie Vault is a **developer, QA and security-review tool**, in the same category as
Cookie-Editor or EditThisCookie. It shows you the cookies your browser already holds,
explains their flags, and writes them to a file or the clipboard when you ask it to.

| | |
|---|---|
| ✅ **Read-only** | It never creates, edits or deletes cookies, and never replays them for you. |
| ✅ **Local-only** | No server, no analytics, no `fetch`, no telemetry. Nothing leaves the browser unless *you* save or copy it. |
| ✅ **Transparent** | Every exported file carries a banner saying what it is, when it was made and that the values are live credentials. |
| ❌ **Not a remote stealer** | There is no upload path, no callback URL and no background exfiltration anywhere in the codebase. |
| ❌ **Not an automation tool** | It will not sign you in anywhere or replay a session for you. |

> Treat every export like a password. A cookies file can impersonate a signed-in
> session, so store it securely and delete it when you are finished. If you only need
> to review or share cookie *metadata*, tick **Hide cookie values**.

---

## What changed in v2.0.0

The previous revision could not run at all, and its own documentation described
behaviour the code never had. Everything below is fixed and covered by tests:

| # | Was broken | Now |
|---|------------|-----|
| 1 | `manifest.json` contained `//` comments → **invalid JSON**, so Chrome refused to load the extension | Valid strict JSON, verified by the test suite |
| 2 | `"default_icon": "🍪"` — an emoji is not a file path | Real PNG icons (16/32/48/128) rendered by `tools/generate-icons.ps1` |
| 3 | The popup checked `response.success`/`response.message` while the background returned a bare string, so **every success was reported as a failure** | One documented `{ok: true, …}` / `{ok: false, error: {code, message}}` envelope, with tests locking the contract |
| 4 | `content.js` shipped but was never registered in the manifest | Dead file removed |
| 5 | Status text was written into the popup with `innerHTML` — and cookie values are attacker-controlled input | The DOM is built only with `createElement`/`textContent`; a test fails the build if markup APIs reappear |
| 6 | A fictional `Name="x"; Value="y"` "format" that no tool can import | A real Netscape cookie jar (7 TAB-separated fields, `#HttpOnly_` prefix) that curl, wget and yt-dlp actually accept |
| 7 | Every export overwrote the same `cookies.txt` | Filenames carry scope, format and a local timestamp: `cookies_example.com_netscape_20260924-153000.txt` |
| 8 | Expired cookies, duplicate names and values containing tabs/newlines silently corrupted the output | Expired cookies are excluded by default, values are sanitised per format, filenames are slugged against path traversal |
| 9 | No stats, search, filters, redaction, dark mode or keyboard support | Everything described in *The popup* below |
| 10 | The README advertised a "deep session intrusion tool" with session-replay payloads | Documentation matches the code, including an honest limitations list |

---

## The popup

```
┌────────────────────────────────────────────────────┐
│ 🍪 Cookie Vault                 [ read-only ]      │
│ Session inspector · v2.0.0                         │
├────────────────────────────────────────────────────┤
│ ⭐ shop.example.com     Cart - Example shop        │
├────────────────────────────────────────────────────┤
│ 1. CHOOSE WHAT TO READ                             │
│   ◉ This tab       cookies sent to this exact URL  │
│   ○ Whole site     + sub- and parent-domain cookies│
│   ○ Everything     every cookie in the profile ⚠   │
├────────────────────────────────────────────────────┤
│ 2. CHOOSE THE OUTPUT                               │
│   Format  [ Netscape cookies.txt (curl/wget) ▾ ]   │
│   ☑ Hide cookie values   ☐ Include expired         │
│   ☐ Ask where to save                              │
├────────────────────────────────────────────────────┤
│ [ Rescan ]  [ Download file ]  [ Copy ]            │
├────────────────────────────────────────────────────┤
│ SUMMARY — This tab only: shop.example.com          │
│   5 cookies │ 2 session  │ 3 persistent            │
│   2 secure  │ 1 HttpOnly │ 2 expiring ≤7d          │
│   2 domains · 91 B of cookie data · 1 partitioned  │
├────────────────────────────────────────────────────┤
│ COOKIES    [ filter…                    ]          │
│ (All) (Session) (Persistent) (Secure) (HttpOnly)…  │
│ Showing 5 of 5 cookies                             │
│ ┌────────────────┬──────────┬─────────┬──────────┐ │
│ │ Cookie         │ Value    │ Flags   │ Expires  │ │
│ │ sessionid      │ ••••• (… │ Secure H│ 23 h     │ │
│ │ theme          │ ••••     │ host    │ session  │ │
│ └────────────────┴──────────┴─────────┴──────────┘ │
│  ↳ click a row to reveal the value, its domain,    │
│    path, size and per-cookie copy buttons          │
├────────────────────────────────────────────────────┤
│ OUTPUT PREVIEW  [Copy again] [Hide]                │
├────────────────────────────────────────────────────┤
│        Privacy & responsible use                   │
└────────────────────────────────────────────────────┘
```

Highlights:

- **Scans on open** — the popup reads the current tab immediately, so there is no empty state to fight with.
- **Three scopes** — the exact URL, the whole site (sub-domains *and* parent domains), or a full profile audit (which the UI warns about).
- **Value masking by default** — the table shows `•••••• (43 chars)`; values appear only when you expand a row.
- **Live search + filter chips** — All / Session / Persistent / Secure / HttpOnly / Expiring ≤7d.
- **Statistics** — totals plus session vs persistent, `Secure`, `HttpOnly`, `SameSite=None`, CHIPS-partitioned counts, payload size, domain count and the largest cookie.
- **One-click audit export** — "Hide cookie values" produces a file that is safe to attach to a ticket or share with a colleague.
- **Preferences remembered** — scope, format and options persist in `chrome.storage.local`.
- **Accessible** — `role="radiogroup"`, a polite `aria-live` status region, focusable rows with `aria-expanded`, keyboard-toggleable rows, and light/dark themes via `prefers-color-scheme`.

---

## Export formats

| Format | Extension | Use it for |
|--------|-----------|------------|
| **Netscape cookies.txt** | `.txt` | `curl -b`, `wget --load-cookies`, `yt-dlp --cookies` and most HTTP clients. Seven TAB-separated fields; HttpOnly cookies use the `#HttpOnly_` domain prefix curl understands. |
| **JSON** | `.json` | Structured audit records: metadata, summary and normalised cookie objects (API-only fields such as `storeId` are stripped). |
| **CSV** | `.csv` | Spreadsheet review (RFC 4180 escaping, one row per cookie). |
| **Cookie header** | `.txt` | A single pasteable `name=value; …` line for DevTools or `curl -H "Cookie: …"`. |
| **JavaScript** | `.js` | `document.cookie` assignments for local testing. HttpOnly cookies are emitted as comments, because JavaScript genuinely cannot set them. |

Every export begins with a banner naming the generator, version, timestamp, scope,
source URL, record count and a warning that the values are live credentials.

---

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and select this folder.
4. Pin the 🍪 icon to the toolbar.

Requires Chrome 105+ (Manifest V3 is required; the `:has()` styling needs 105).

```bash
git clone https://github.com/xyphoscyber/Cookie-Vault-Hacker.git
cd Cookie-Vault-Hacker
```

## Usage

1. Open the website you want to inspect and make sure you are signed in.
2. Click the 🍪 toolbar icon — the popup scans the tab immediately.
3. Pick a scope (and optionally *Hide cookie values*).
4. Choose a format, then **Download file** or **Copy**.
5. Review the preview, then delete the export when you no longer need it.

The **Rescan** button re-reads the cookies without exporting, which is handy after
signing in or out in another tab.

## Permissions and why they are needed

| Permission | Why |
|------------|-----|
| `cookies` | To read the cookies shown in the popup. Nothing else is done with them. |
| `tabs` | To know which site the popup was opened on. |
| `downloads` | To save the export you asked for. |
| `storage` | To remember your scope/format/option choices. |
| `clipboardWrite` | For the **Copy** buttons. |
| `host_permissions` (`http://*/*`, `https://*/*`) | Cookie access is scoped to web origins; browser-internal pages are excluded on purpose. |

No `webRequest`, no `scripting`, no remote code, no content scripts.

## Architecture

```
Request ─► popup.js (UI only)
             │  chrome.runtime.sendMessage({type, …})
             ▼
        background.js (service worker)
             ├─ resolveContext()   which tab, is it inspectable?
             ├─ collectCookies()   chrome.cookies.getAll (read-only)
             ├─ prepareForExport() drop expired, optionally redact values
             ├─ build*()           netscape | json | csv | header | jssnippet
             └─ {ok:true|false, …}  single response envelope
             ▼
        popup.js renders stats/table, then downloads or copies the payload
```

The download mechanism is size-aware: short payloads are written by the browser from a
self-contained `data:` URL (which stays valid even if the popup closes while the "save
as" dialog is open), while payloads over 512 KB switch to an object URL so that no one
hits a URL length limit.

## Tests

Zero dependencies — plain Node:

```bash
node tests/run-tests.js
```

60 checks covering:

- **manifest** — strict JSON, real icon files, permission set, no content scripts, PNG signature.
- **static guards** — the popup must not use markup-injection APIs, the background must not use the network, and the popup markup must contain no inline scripts, inline handlers or `javascript:` URLs.
- **format builders** — Netscape field counts and `#HttpOnly_` prefixes, values containing tabs and newlines, JSON metadata, CSV escaping, single-line Cookie headers, HttpOnly handling in JS snippets, filename slugging against path traversal.
- **message routing** — the `{ok, …}` envelope, coded errors (`NO_TAB`, `UNSUPPORTED_URL`, `READ_FAILED`, `NO_COOKIES`, `BAD_REQUEST`), unknown types left unanswered, the async reply channel kept open, and every message type the popup sends answered by the worker.
- **popup logic** — filter/search behaviour, data-URL vs blob-URL download choice, preview truncation, preference normalisation, error hints.
- **popup end to end** — `popup.js` actually runs against `popup.html` inside a small DOM double (`tests/dom-stub.js`): start-up rendering, stat cards, row expansion, per-cookie copy, download and clipboard calls, live search, empty states, an unreachable worker, persisted preferences and the help panel.

## Regenerating the icons

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\generate-icons.ps1
```

Renders `icons/icon16|32|48|128.png` with System.Drawing, so the binaries stay
reproducible instead of being unexplained blobs.

## Folder structure

```
.
├── manifest.json               # MV3 definition, permissions, icons
├── background.js               # service worker: reading, scoping, formatting, messaging
├── popup.html / popup.css      # popup markup and styles (light + dark)
├── popup.js                    # popup controller (rendering, downloads, clipboard)
├── icons/                      # generated PNG app icons
├── tools/generate-icons.ps1    # icon generator
└── tests/
    ├── run-tests.js            # the suite (node tests/run-tests.js)
    └── dom-stub.js             # minimal DOM double used by the end-to-end tests
```

## Limitations (read these)

- A cookie export is a **bearer credential**: storing it in plain text, emailing it or
  committing it to a repository is equivalent to handing over your logged-in session.
- `HttpOnly` cookies can be exported but **cannot** be recreated from JavaScript. That is
  a browser security feature, not a bug in this tool.
- Browser pages (`chrome://`, `edge://`, the Web Store, extension pages) expose no
  cookies; the popup says so instead of failing silently.
- Reading is capped at 5,000 cookies per request, and the table renders up to 300 rows at
  a time (use the filter to reach the rest) so the popup stays responsive.
- Scope "Whole site" matches the host plus its parent and sub-domains. It does **not**
  guess registrable domains from a public-suffix list, so unrelated domains that merely
  look similar are never included.
- Partitioned (CHIPS) cookies are listed and exported with their partition noted, but
  most client tools ignore partitioning when importing a cookie jar.

## Responsible use

- Only inspect cookies for accounts, sites and systems you own or have **explicit written
  authorisation** to test.
- Never use an export to access, intercept or impersonate someone else's session.
- Unauthorised access to computer systems and data is illegal in most jurisdictions,
  including under the Computer Fraud and Abuse Act (CFAA) and equivalent laws worldwide.
- Exports are produced locally, at your request, and are your responsibility: store them
  securely and delete them when you are done.

This software is provided **"as is"**, without warranty of any kind. The author accepts no
liability for misuse, damage, data loss or legal consequences arising from its use.



