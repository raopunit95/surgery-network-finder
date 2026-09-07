# Deploying and refreshing

The repo is already live at https://raopunit95.github.io/surgery-network-finder/ with Pages
serving `main` at the root. This is the operational runbook, not a first-time setup guide.

---

## Refreshing the inventory

The normal route. Both tabs come from one workbook.

```
cp ~/Downloads/Inventory.xlsx incoming/Inventory.xlsx
npm run refresh:dry
npm run refresh
npm test
git add data incoming/SubDept_Map.tsv incoming/Dept_Map.tsv
git commit -m "Refresh inventory"
git push
```

`refresh:dry` runs the entire pipeline and writes nothing, so you see the counts and the mapping
report before anything in `data/` changes. `refresh` writes, then runs `check`.

**The raw workbook stays on your disk.** `incoming/*.xlsx` and `incoming/*.csv` are gitignored
because those rows carry hospital and escalation email addresses, internal record identifiers and
upstream system IDs. Only the generated `data/` is pushed. Do not remove those ignore rules.

Read the report before you push. It tells you three things:

- **auto-mapped** — a speciality `Dept_Map.tsv` does not list, settled by restating a rule you
  already wrote. Confirm once and add the line.
- **could not be settled** — not mapped, and hospitals listing only that speciality are
  unreachable. Suggestions with confidence scores are in `incoming/Dept_Map.suggested.tsv`; move
  the lines you agree with into `Dept_Map.tsv` and refresh again.
- **blank Short_Ins** — those hospitals disappear the moment a user picks an insurer. The usual
  cause is the whole insurer list pasted into one cell without commas, which then reads as a single
  400-character insurer name and is dropped. Fix it in the source, not in a side file.

### Nothing publishes unless it validates

Row-count floors, a coordinate-coverage floor and an orphan-doctor ceiling are checked before
anything is written, and `data/` is left untouched on failure. Thresholds are in
`tools/config.json`. `npm run check` exits 1 only on genuinely search-breaking problems, so it can
gate a deploy without failing on every rough edge.

### If you change CSS or JS

Bump the query string in `index.html`:

```html
<link rel="stylesheet" href="style.css?v=5">
<script src="app.js?v=5"></script>
```

Both are currently `v=5`. GitHub Pages caches aggressively and a stale `style.css` has already
cost one round of debugging that looked like a code bug.

---

## Refreshing from the Google Sheets API

```
npm run refresh:sheet
```

Auth, in order of preference:

1. `GOOGLE_SERVICE_ACCOUNT_JSON` — the whole service-account key as one env var. Share the sheet
   with the key's `client_email` as Viewer. Required for a private sheet.
2. `SHEET_CSV_HOSP` / `SHEET_CSV_DOC` — "publish to web" CSV URLs. Only for a sheet you are happy
   to have publicly readable.

See `.env.example`. JWT signing uses `node:crypto`; there is still nothing to install.

This path used to be a separate script that re-implemented the whole pipeline and quietly omitted
Rating and Reviews — so a Sheets refresh published a network with no ratings and the rating sort
silently did nothing. All four sources now go through one builder, which is why that cannot recur.

---

## The scheduled workflow

`.github/workflows/refresh.yml` runs the Sheets refresh nightly and commits `data/` if it changed.

**It is currently disabled.** It needs `GOOGLE_SERVICE_ACCOUNT_JSON` in the repo secrets and will
send a failure email every night without it. Add the secret first, then enable the workflow in the
Actions tab.

---

## Running it without the real network

```
npm run sample
```

Generates a synthetic ~159-hospital network on the real speciality taxonomy, with invented hospital
names, doctors and coordinates. The header shows a "Demo data" banner. The pincodes are genuine, so
the sample build exercises the same shard lookup and the same ranking the real one does — a made-up
pincode would leave the entire distance path untested by the only build most people can run.

---

## `publish:safe`, if you want it

Every doctor in the source is currently published by name, with qualification, hospital and weekly
OPD hours. A `publish:safe` mode would keep hospitals real and render doctors as
`Ophthalmologist · 21 yrs · Visiting Consultant`. About ten minutes of work in `tools/lib.mjs`,
where the doctor record is built. Not implemented.

---

## Checklist before a push

```
npm run refresh        # or refresh:sheet
npm test               # fails on a zero-result search
git status             # nothing from incoming/ should be staged
```

`git status` matters: if a `.xlsx` or `.csv` ever shows up as staged, the ignore rules have been
edited and the raw export is about to be published.

---

## If it ever needs a real API

Not needed today, and worth writing down only so the decision is on record. The blocker would be
inventory size or a wish to stop shipping the network as a static file — neither of which applies
yet. Shape: hospitals and doctors behind a small read-only endpoint (Cloudflare Workers, since
Pages cannot run server code), the taxonomy resolved server-side, and one constant changed in
`app.js` — `const DATA = 'data'` becomes the API origin. Roughly a day's work. Note that CORS would
not protect it; it is a browser convention, not access control, so it would need a real auth story
before it held anything the static build does not already publish.
