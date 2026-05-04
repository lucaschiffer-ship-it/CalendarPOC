# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install   # install dependencies (Electron + Puppeteer, ~150 packages)
npm start     # launch the Electron app
```

No test runner or linter is configured.

## Architecture

Single-window Electron app that uses Puppeteer (its own Chromium, separate from Electron's) to scrape `spaces.kisd.de` and display the authenticated user's selected courses as a list or weekly calendar.

### IPC flow

1. `renderer/index.html` + `renderer/renderer.js` — UI. Three bridge methods on `window.kisd`:
   - `scrape({username, password})` — triggers scraping, returns `{ ok, courses }`
   - `onMfaRequired(cb)` — registers a callback for when MFA is needed mid-scrape
   - `submitMfaCode(code)` — sends the user-entered OTP back to the main process
2. `preload.js` — exposes the three `window.kisd` methods via `contextBridge`.
3. `main.js` — `ipcMain.handle('scrape', ...)` creates a `requestMfaCode` callback (pauses via `ipcMain.once('mfa-submit', ...)` and sends `'mfa-required'` to the renderer), then calls `scrapeKISD(username, password, requestMfaCode)`.
4. `scraper.js` — the Puppeteer scraper; accepts a third `requestMfaCode` parameter.

### Scraper login flow

The site uses **SAML SSO via TH Köln** (`login.th-koeln.de`). Student accounts cannot use the local WordPress login.

1. Navigate to `spaces.kisd.de/public/` → click `#saml-login-link` (TH Login button)
2. Fill `Ecom_User_ID` / `Ecom_Password` on `login.th-koeln.de` IdP page; press Enter
3. MFA: the IdP redirects to `mfa.th-koeln.de/osp/…`. The OTP field is `#nffc` (type=password). **Critical**: the page auto-submits `document.IDPLogin.submit()` on load with empty `nffc`, consuming an OTP attempt. This is blocked via `evaluateOnNewDocument` which patches `HTMLFormElement.prototype.submit` to no-op when `nffc` is empty.
4. After OTP: SAML chains through `login.th-koeln.de/nidp/saml2/sso?sid=0` (auto-submit assertion page) back to `spaces.kisd.de`. Use hop-loop with `waitForNavigation` rather than a single await — there are 3–4 redirects.
5. Prime the `course-selection` WordPress subsite by navigating to `spaces.kisd.de/course-selection/` before hitting the filtered URL. WordPress multisite uses per-subsite session cookies; skipping this step leaves the course-selection subsite unauthenticated.
6. Final target: `https://spaces.kisd.de/course-selection/?semester=2026-1&mycourses=on` — the `mycourses=on` parameter is server-side filtered; only the logged-in user's enrolled courses are returned.

### Scraper data extraction

Courses are server-rendered `article.card.course` elements. The page also fires a POST to `admin-ajax.php` (`action=credit_points`) — this is unrelated to the course list and returns 400 when unauthenticated; ignore it.

- Title: `h1[title]` attribute (textContent includes icon noise)
- Course type: `.info-chip-course_type .value`
- Lecturers: `.avatar-name` elements — deduplicate, they repeat in dropdown markup
- Timeframe / Meeting Times / Location / Description: `.info-label` text matched against sibling `.info-content`
- Course URL: `data-post-url` attribute on the article

### Renderer — two views

**List view** (`#course-list`): card grid, one card per course.

**Calendar view** (`#cal-view`): weekly timetable with week navigation.

- `parseMeetingTimes(str)` parses `"Tue 13:00 — 16:00 · Thu 13:00 — 16:00"` into `[{day, startMin, endMin}]`. "Daily" expands to Mon–Fri (indices 0–4).
- `parseTimeframe(str)` parses `"21.04.2026 — 19.06.2026"` into `{start: Date, end: Date}`.
- Courses without parseable meeting times are rendered as cards in `#missing-section` below the grid, with a "+ Add meeting times" prompt.
- Clicking any calendar event block or missing-section card opens an edit modal.

### Course overrides

User edits are stored in `localStorage` under key `'kisd-overrides'` as a JSON object keyed by course title (first 80 chars). `getEffectiveCourse(course)` merges the stored override onto the scraped data before rendering. Overrides survive refresh but are cleared on page reload (Electron restart).

Override shape:
```json
{
  "Course Title…": {
    "title": "…",
    "description": "…",
    "startDate": "2026-04-21",
    "endDate":   "2026-06-19",
    "sessions":  [{ "day": "Mon", "start": "09:00", "end": "13:00" }]
  }
}
```

### Security model

`contextIsolation: true`, `nodeIntegration: false`. Credentials live only in JS variables in the renderer (`_username`, `_password`) and are never written to disk. MFA codes pass through IPC as plain strings and are not retained.
