# Tests

The app is one HTML file with its logic in a single inline `<script>`. These
tests pull that script out and exercise the real functions — there is no build
step and nothing is duplicated.

## Running them

```
npm test          # syntax, analytics and import — a few seconds, no browser
npm run test:ui   # drives the real UI in Chromium
npm run test:all  # both
```

`npm run test:ui` needs Playwright:

```
npm install
npx playwright install chromium
```

Everything runs automatically on every pull request (`.github/workflows/test.yml`).

## What each file covers

| File | Covers |
|---|---|
| `syntax.test.js` | The inline script parses, and has not been truncated by an edit. A syntax error here means a blank page in production. |
| `analytics.test.js` | Effort weighting, every schedule-health band, history reconstruction, portfolio roll-ups, and the unmeasured-vs-zero distinction. |
| `import.test.js` | Parsing, the preview plan, applying it, idempotent re-import, and every malformed-input path. |
| `ui.test.js` | The flows that have broken before: Process Inbox actually filing, milestone rename/delete/reorder, habit retire and the week pager, exports on all four report tabs, and that review ticks award no XP. |

## Two things to know before editing

**No real data.** `fixtures/sample-import.json` and every name in these tests are
deliberately generic. Business, client and family names do not belong in this
repository.

**Leave margin around health-band boundaries.** A scenario engineered to land
exactly on a boundary — variance of precisely −25, say — passes in the morning
and fails in the evening, because hours of elapsed time move it across. Choose
windows that sit clearly inside the band you are asserting.
