# Deploying and refreshing

How the site gets published, how the inventory gets refreshed, and how the taxonomy fits together.

---

## 1. Where the data lives, and why it ships with the repo

This is a static site. **Any data the page can render, a visitor can download** — that is true of
every static site, and no amount of obfuscation changes it. So the choice is not "public or secret",
it is what ships.

| Approach | What one request gets | Effort to take the lot |
|---|---|---|
| Static JSON *(this repo)* | The whole snapshot, 1.3 MB | One click |
| API returning top-10 | 10 rows | ~2,000 scripted calls across every city × surgery |
| API + rate limit | 10 rows | Days, and it shows up in the logs |
| API behind a login | Nothing | They need an account |
| Synthetic data (`npm run sample`) | 10 invented rows | Nothing real exists to take |

An API is a genuine improvement on bulk download, and section 4 sketches one. It is not secrecy: a
public API is reconstructable given patience, which is exactly how provider networks get mapped in
this industry. Choose it for the architecture, not for the privacy.

**What is already excluded.** The importers write only the fields the UI renders. Hospital and
escalation email addresses, internal record identifiers, upstream system IDs and the operational
workflow dates on the source rows never reach `data/`. That list lives in `tools/config.json`.

**Running it without this dataset.** `npm run sample` generates a synthetic 159-hospital network
using the real taxonomy — same 48 specialities, same 36 insurers, same search behaviour, invented
names and coordinates. Everything worth reading in this codebase behaves identically on it.

---

## 2. Pushing this as a new repository

### Step 1 — know which build is loaded

```bash
cd ~/Downloads/surgery-network-finder
node -e "const m=require('./data/meta.json');console.log(m.source, m.hospitalCount+' hospitals')"
```

`sheet-csv 650 hospitals` is the imported network. `sample 159 hospitals` is the synthetic one from
`npm run sample`. Check this before every push — the two are interchangeable on disk and the page
looks nearly identical, so it is easy to publish the one you did not mean to.

### Step 2 — initialise git

```bash
git init -b main
git add .
git status
```

Read that `git status` list. Confirm `incoming/*.csv` is **not** in it — those are your raw exports
with hospital emails and internal IDs, and `.gitignore` should be excluding them. If you see them,
stop and fix `.gitignore` first.

### Step 3 — first commit

```bash
git -c user.name="Punit Yadav" -c user.email="puneetyadav95@gmail.com" \
  commit -m "Surgery Network Finder: pincode + surgery + insurer hospital search

- Static site, no backend: sharded pincode index, precomputed surgery resolution
- 218 surgeries resolved through 30 departments with secondary-department fallback
- 70 insurer spellings canonicalised to 36
- 14-tier distance banding; sort by rating or reviews operates within a band, never across"
```

### Step 4 — create the repo on GitHub

With the GitHub CLI:

```bash
gh repo create surgery-network-finder --public --source=. --remote=origin --push
```

Swap `--public` for `--private` if the repo should not be world-readable. Note that GitHub Pages on
a private repo requires Enterprise — on Free and Team, a private repo simply has no published site.

Without `gh` — create it at <https://github.com/new> (name `surgery-network-finder`, **do not** add
a README), then:

```bash
git remote add origin https://github.com/raopunit95/surgery-network-finder.git
git push -u origin main
```

### Step 5 — turn on Pages

Settings → Pages → Source: **Deploy from a branch** → `main` → `/ (root)` → Save.
Live in about a minute at `https://raopunit95.github.io/surgery-network-finder/`.

Two things to do before you walk away from it:

**Add `.nojekyll`.** Pages runs Jekyll by default, which skips files and folders whose names begin
with an underscore. Nothing here starts with one today, but one future filename would break the
build with no error you'd notice. The empty file turns Jekyll off and the deploy gets faster.

```bash
touch .nojekyll && git add .nojekyll && git commit -m "Disable Jekyll on Pages" && git push
```

**Disable the scheduled refresh until you've added the secret.** `.github/workflows/refresh.yml`
runs daily and needs `GOOGLE_SERVICE_ACCOUNT_JSON`. Without it the job fails every night and GitHub
emails you about it every night.

```bash
gh workflow disable "Refresh inventory"
```

Re-enable it with `gh workflow enable "Refresh inventory"` once the secret is set — or leave it off
permanently if you're refreshing by CSV drop.

### Step 5b — verify it's actually live

A Pages URL returns the page long before it returns the data, and a missing `data/` folder looks
like "no hospitals near you" rather than an error. Check all three:

```bash
URL=https://raopunit95.github.io/surgery-network-finder
curl -sI $URL/ | head -1
curl -s $URL/data/meta.json | head -c 120
curl -sI $URL/data/pincodes/110.json | head -1
```

You want `200` twice and a JSON snippet in between. A `404` on the shard means `data/pincodes/`
didn't get committed — check `git ls-files data/pincodes | wc -l` (should be 405).

Then set the About panel: description, that URL as the website, and topics
`healthcare` `product-management` `javascript` `static-site` `data-pipeline`.

### Step 6 — link it from your portfolio

In `raopunit95/punit-yadav`, add it to `README.md` under the case studies, and to `profile.json`
under `projects`.

---

## 3. Refreshing the data from the Google Sheet

**Is a sheet the right source?** For this, yes. The network team already maintains it, they
understand it, and it has no deployment process. Moving them off it to "do it properly" would mean
their data stops being current, which is worse. Read from where the data already lives.

What matters is that **the sheet is the source and the JSON is a build artefact** — never edit
`data/*.json` by hand.

### Manual (works today, no setup)

```bash
# 1. In the sheet: File → Download → Comma-separated values (.csv), once per tab
# 2. Move them in:
mv ~/Downloads/*Bot_Hosp*.csv incoming/Bot_Hosp.csv
mv ~/Downloads/*Bot_Doc*.csv  incoming/Bot_Doc.csv

# 3. Look before you write
npm run import:dry

# 4. Write
npm run import

# 5. Rebuild the surgery resolver (needed whenever hospital specialities change)
node tools/build-surgeries.mjs

# 6. Prove a search still returns something before you ship it
npm test

# 7. Ship
git add data/ && git commit -m "Refresh inventory $(date +%F)" && git push
```

`npm run import:dry` prints kept/dropped counts and any insurer spelling it did not recognise.
**Read that output.** If hospitals suddenly drop from 650 to 300, something upstream broke and you
want to know before you commit it.

### Automated (service account)

One-time:

1. Google Cloud Console → **IAM → Service Accounts → Create**
2. **Keys → Add key → JSON**, download it
3. Open the sheet → **Share** → add the key's `client_email` as **Viewer**
4. `cp .env.example .env` and paste the whole JSON on one line as `GOOGLE_SERVICE_ACCOUNT_JSON`

Then, any time:

```bash
npm run sync:dry     # fetch and validate, write nothing
npm run sync         # write
```

### Scheduled (GitHub Actions, daily)

Settings → Secrets and variables → Actions → **New repository secret**
Name `GOOGLE_SERVICE_ACCOUNT_JSON`, value the same one-line JSON.

`.github/workflows/refresh.yml` then runs at 02:00 IST, commits `data/` only if something changed,
and has a **Run workflow** button for manual triggering.

**Nothing publishes unless it validates.** Row-count floors, a coordinate-coverage floor, an
orphan-doctor ceiling. Fail any and the job writes nothing and exits non-zero — yesterday's good
data stays live rather than being replaced by a broken export.

---

## 4. The API architecture, if you build it

Your instinct is right for an internal tool. Three pieces:

```
┌─ raopunit95/surgery-network-inventory  (PRIVATE) ─────────────┐
│   incoming/Bot_Hosp.csv       ← you upload CSVs here          │
│   incoming/Bot_Doc.csv                                        │
│   incoming/SubDept_Map.tsv                                    │
│   → GitHub Action runs the same tools/ pipeline               │
│   → pushes built JSON to Cloudflare KV                        │
└───────────────────────────────────────────────────────────────┘
                              │
┌─ Cloudflare Worker (the API) ─────────────────────────────────┐
│   GET /api/surgeries                → the 218 names           │
│   GET /api/insurers                 → the 36 names            │
│   GET /api/search?pin&surgery&ins   → top 10 hospitals ONLY   │
│   GET /api/doctors?hospital&surgery → doctors at that one     │
│   rate limited · CORS locked to your Pages origin             │
└───────────────────────────────────────────────────────────────┘
                              │
┌─ raopunit95/surgery-network-finder  (PUBLIC) ─────────────────┐
│   index.html · style.css · app.js · tools/                    │
│   no data/ at all — fetches the API                           │
└───────────────────────────────────────────────────────────────┘
```

**Why Cloudflare Workers:** GitHub Pages cannot run server code, so the API has to live somewhere
else. Workers' free tier is 100,000 requests/day with KV storage included, deploys from the CLI in
one command, and runs at the edge so latency stays low. Vercel or Netlify Functions work equally
well.

**What changes in this repo:** one constant. `const DATA = 'data'` becomes
`const API = 'https://your-worker.workers.dev/api'`, and the four `getJSON` calls point at endpoints
instead of files. The ranking, banding and resolution logic is unchanged — it just runs server-side.

**Be honest with yourself about the limits.** CORS does not protect an API; it is a browser
convention and `curl` ignores it entirely. Rate limiting by IP is defeated by a proxy pool. What you
actually get is: no one-click bulk download, per-request logging, and the option to add auth later.
That is worth having. It is not the same as private.

**Effort:** roughly a day for a working version. Worth doing if this becomes a real internal tool.
Not worth doing for a portfolio piece — synthetic data gets you the same demo for zero infrastructure
and zero monthly cost.

---

## 5. The surgery mapping (already built)

Your instinct here was right and it fixed a real bug.

Users do not know they need "Proctology". They know they have piles. So step 2 now searches
**218 surgery names**, and each resolves to the hospital speciality strings the sheet actually uses.
Your mapping sheet is what makes that possible — it is the intermediary between two vocabularies
that never agreed:

```
Piles     → Proctology     → + General Surgery → ["General Surgery", "AyurVaid General Surgery"]
IVF       → Fertility      → + Gynaecology     → ["IVF & Gynec", "OBG", "Fetal Medicine", …]
Cataract  → Ophthalmology                      → ["Ophthalmology"]
```

Three files, each with one job:

| File | Direction | Rows | Who owns it |
|---|---|---|---|
| `incoming/SubDept_Map.tsv` | surgery → department | 218 | you |
| `incoming/Dept_Map.tsv` | hospital speciality → department | 57 | you (44) + me (13) |
| `tools/departments.json` | department → **secondary** department | 7 | you (4) + me (3) |

**Why your mapping sheet mattered.** Before it, I was matching department names against the 48
speciality strings in `Bot_Hosp` and only **13 of 24 matched exactly**. Your sheet resolves the
other eleven properly — `Orthopaedic` → `Ortho Surgery`, `Gynaecology` → `OBG` / `IVF & Gynec` /
`Fetal Medicine`, `Dental` → `Dentistry`, `Aesthetic` → `Plastic Surgery` / `Dermataology` /
`Hair Transplant` / `Medical Cosmetology`, and so on. Guessing at those would have been wrong in
ways nobody would have noticed.

I appended **13 rows** to `Dept_Map.tsv` for live specialities your 44 rows did not cover
(`AyurVaid ENT`, `Fetal Medicine`, `Radiation Oncology`, `Pediatric Neurology → Pediatrics|Neurology`,
`IVF & Gynec → Fertility|Gynaecology`, and similar). A cell can name two departments separated by
`|`. Those 13 are worth a skim.

**The secondary column.** `Proctology` and `Transplant Surgery` match *no* active hospital, so
without a secondary hop `Piles` and `Kidney Transplant` return an empty screen while hospitals down
the road do them weekly. `tools/departments.json` holds **your four** (Laparoscopy, Proctology,
General Medicine → General Surgery; Fertility → Gynaecology) and **three I added** because they
resolve to nothing otherwise:

| Department | Secondary | Why |
|---|---|---|
| Gastrointestinal | General Surgery | GI surgery is done by general surgeons at most panel hospitals |
| Transplant Surgery | General Surgery | no hospital lists it; kidney/liver may also warrant Urology / Nephrology |
| Neurology | Neurosurgery | only `Pediatric Neurology` exists hospital-side |

They sit under `_provenance.addedByAnalysis` in the file, separate from yours. **Please check those
three** — they are clinical judgements and yours to make, not mine.

### Where it stands

```
speciality→department rules   68
departments                   30
surgeries                     218
resolve to ≥1 live speciality 218 / 218
  · 3 live specialities no surgery points at: Radiology, Interventional Radiology, Ayurveda
```

All 218 resolve. The three unused specialities are diagnostics and Ayurveda — nothing in the surgery
list points at them, which is expected rather than broken.

To change any of it, edit `incoming/SubDept_Map.tsv`, `incoming/Dept_Map.tsv` or
`tools/departments.json`, then:

```bash
node tools/build-surgeries.mjs   # reports anything resolving to nothing
npm test                         # fails on a zero-result search
```

A surgery that resolves to nothing is a silent outage — it reads as "no hospitals near you", not as
a bug. Both commands are the tripwire; run them after every mapping edit.

---

## 6. Correcting a row without touching the sheet

The five eye hospitals you fixed are in `incoming/Hosp_Overrides.tsv`:

```
Hospital_Code	Field	Value
496	Short_Ins	New India,National insurance,Oriental insurance,Acko,…
```

Every import and sync reapplies it, so the correction **survives the next refresh** — which editing
`data/hospitals.json` by hand does not. `Field` is the sheet column name; `Value` replaces the cell
and is canonicalised like any other. A code that stops appearing among active rows is warned about
rather than silently ignored.

Worth knowing what was actually wrong: on 496 and 575 the whole insurer list had been pasted into
one cell without separators. It ran past the 60-character artefact threshold, so it was dropped
entirely and **those two hospitals matched no insurer filter at all** — invisible to anyone
searching with insurance selected. They now carry 34 insurers each.

```bash
# after editing the override file
npm run import          # or npm run sync
# if you have the built JSON but not the CSVs to hand:
npm run overrides
```
