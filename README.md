# Surgery Network Finder

**Pincode + surgery + insurer → ranked hospitals → the doctors who operate there.**

A static site. No backend, no API key, no database call at request time. The inventory is a set of
JSON files refreshed from a Google Sheet once a day; the browser does the rest.

```
pincode  ──►  hospitals matching surgery + insurer  ──►  doctors at the chosen hospital
```

---

## About the data

`data/` holds a point-in-time snapshot of an Indian cashless-surgery provider network: 650 active
hospitals with coordinates, insurer panels and admission volumes, and 3,583 doctors with their
specialities and OPD timings. It is generated from a source spreadsheet by the tools in `tools/`,
never hand-edited.

**Only the fields this UI renders are written out.** The importers deliberately drop hospital and
escalation email addresses, internal record identifiers, upstream system IDs and the operational
workflow dates that exist on the source rows. If you point these tools at your own sheet, that
exclusion list is in `tools/config.json` and applies the same way.

Two things this snapshot is not:

- **Not authoritative for cashless eligibility.** Insurer panels change without notice and the desk
  at the hospital is the only reliable answer. The UI says so on every page.
- **Not a live feed.** The header shows the generation date; `data/meta.json` carries the timestamp
  and a data-quality report.

Prefer to run it without this dataset? `npm run sample` swaps in a synthetic 159-hospital network
with the same taxonomy and the same search behaviour, and invented names.

---

**Deployment, refreshing the data, and the API option: see [DEPLOY.md](DEPLOY.md).**

## Quick start

```bash
npm run serve      # http://localhost:8080
```

No install step — there are no dependencies. To rebuild the data from a sheet, see **Refreshing the
inventory** below; for a synthetic network, `npm run sample` first.

---

## How it works

**The data is built, not queried.** Three JSON files plus a sharded pincode index:

```
data/
├── hospitals.json      650 active hospitals   (545 KB)
├── doctors.json      3,583 active doctors     (804 KB)
├── meta.json           counts, speciality and insurer lists, data-quality report
└── pincodes/
    ├── 110.json        one shard per 3-digit prefix (~2 KB each, 405 files)
    └── …
```

A search downloads **one 2 KB pincode shard** and the hospital file. Doctors load only when a
hospital is opened. Nothing is fetched at page load except `meta.json`.

**Ranking is banded, not sorted.** Every result falls into a distance band, and the bands are fine
near the user and coarse far away — 20 / 35 / 50 / 100 / 150 / 250 / 350 / 500 / 650 / 800 / 1,000 /
1,250 / 1,500 / beyond. The difference between 8 km and 18 km changes what you do; the difference
between 1,100 km and 1,300 km does not.

**Inside a band, hospitals are ordered by volume and reputation rather than distance:**

```
score = log₁₀(1 + admissions) + 0.5 · log₁₀(1 + reviews) · (rating / 5)
```

A hospital doing 400 surgeries a year at 8 km is a better answer than one doing 12 at 3 km. Sorting
purely by distance looks correct and quietly sends people to the wrong place. Both logs are damping
terms — without them a hospital with 5,000 reviews buries a good one with 200.

**The band is the unit of ordering, and the sort only works inside it.** Four orders are offered —
Recommended · Distance · Rating · Most reviewed — and none of them can move a hospital past a band
boundary. This is the part that is easy to get wrong: a global sort by rating puts a 4.9 in
Vizianagaram above a 4.6 in Noida for someone searching from Rajasthan, which is a worse answer
however good that hospital is. **Distance decides the shortlist; the sort decides within it.**

Rating ties break on review count, then distance, so a 5.0 from two people cannot outrank a 4.6 from
three thousand. Hospitals with no rating sink rather than float — unrated is unknown, not bad, but it
does not belong at the top.

**Nothing nearby is an answer, not an error.** Pincode 333515 (Jhunjhunu) has no knee-replacement
hospital within 50 km; the nearest is 110 km away in Gurgaon. The page says exactly that above the
results rather than showing an empty screen. Because the bands run to the whole country, no special
case is needed — the ladder just starts further down.

**Distance** uses an equirectangular approximation rather than haversine. At these ranges the error
is far below the ~3.5 km uncertainty already baked into a pincode centroid, and it is much cheaper
across 650 rows.

---

## Refreshing the inventory

Three ways, all producing byte-identical output.

### 1. Manual — CSV drop *(no auth, works today)*

1. In the sheet: **File → Download → Comma-separated values**, once per tab
2. Save as `incoming/Bot_Hosp.csv` and `incoming/Bot_Doc.csv`
3. `npm run import`

`incoming/*.csv` and `*.xlsx` are git-ignored — the raw exports carry columns the app doesn't use.
The `.tsv` mapping and override files in the same folder **are** committed; they're configuration,
not data.

### 2. Automated — Google Sheets API

```bash
cp .env.example .env      # add GOOGLE_SERVICE_ACCOUNT_JSON
npm run sync
```

Create a service account in Google Cloud, download the JSON key, and share the spreadsheet with its
`client_email` as **Viewer**. Zero npm dependencies — the JWT is signed with `node:crypto`.

### 3. Scheduled — GitHub Actions

`.github/workflows/refresh.yml` runs `npm run sync` at 02:00 IST daily, commits `data/` only if
something changed, and can be triggered by hand from the Actions tab. Add the key as a repository
secret named `GOOGLE_SERVICE_ACCOUNT_JSON`.

*Using n8n instead?* Point a Schedule node at a Google Sheets node → Code node running the same
mapping → GitHub node committing the three files. The logic lives in `tools/lib.mjs` and is
portable.

### Nothing publishes unless it validates

Every path runs the same checks before writing, and **writes nothing at all if any fail**:

| Check | Threshold |
|---|---|
| Hospitals | ≥ 10 |
| Doctors | ≥ 10 |
| Hospitals missing usable coordinates | ≤ 10% |
| Doctors pointing at an unknown `Hospital_Code` | ≤ 15% |

Tune them in `tools/config.json`. Writes go to `.tmp` and are renamed, so a crash mid-write can't
leave a half-written file the page will try to parse. A bad edit at 6pm should not take down search.

---

### Correcting a row without editing the sheet

`incoming/Hosp_Overrides.tsv` patches individual cells at build time. Every refresh reapplies it, so
a fix survives the next sync — which a hand-edit of `data/hospitals.json` does not.

```
Hospital_Code	Field	Value
496	Short_Ins	New India,National insurance,Oriental insurance,Acko,…
```

`Field` is the sheet's column name (`Short_Ins`, `Speciality`); `Value` replaces the cell verbatim
and is then canonicalised like any other. A code that no longer appears among active rows is
**warned about, not silently ignored** — that's how a stale correction announces itself.

Five eye hospitals shipped with a `Short_Ins` cell where the whole insurer list had been pasted
without separators. It exceeded the 60-character artefact threshold, so it was dropped and those
hospitals matched *no* insurer filter at all. The override file is what fixed them.

If you already have built JSON but not the source CSVs, `npm run overrides` applies the same
patches to `data/hospitals.json` directly.

---

## The three data problems this repo solves

### Patients search for a surgery; hospitals are listed by speciality

Nobody types "Proctology". They type **Piles**. The hospital sheet has never heard of Piles — it
lists `General Surgery`. Two vocabularies that were maintained by different teams and never agreed,
and no amount of string matching bridges them.

The **department** is the intermediary, and it takes three hops:

```
  Piles ──► Proctology ──► General Surgery ──► hospitals listing "General Surgery"
  surgery    department      secondary dept        what the sheet actually says
 (SubDept_Map)             (departments.json)        (Dept_Map, inverted)
```

| File | Direction | Rows |
|---|---|---|
| `incoming/SubDept_Map.tsv` | surgery → department | 218 |
| `incoming/Dept_Map.tsv` | hospital speciality → department | 57 |
| `tools/departments.json` | department → secondary department | 7 |

Only 13 of the 24 departments matched a hospital speciality verbatim. **Proctology and Transplant
Surgery matched nothing at all** — no active hospital lists either, so without the secondary hop
`Piles` returns an empty screen while a dozen hospitals down the road do the procedure weekly.
Secondaries resolve transitively and are cycle-safe.

`build-surgeries.mjs` precomputes all of it into `data/surgeries.json`, so the browser does one
dictionary lookup per search instead of walking three tables. It also **reports what fell through**:

```
surgeries                     218
resolve to ≥1 live speciality 218 / 218
  · 3 live specialities no surgery points at: Radiology, Interventional Radiology, Ayurveda
```

A surgery resolving to zero specialities is a silent outage — it looks like "no hospitals near you"
rather than like a bug. That line is the tripwire, and `npm test` fails on it.

### Insurer names — 70 spellings, 36 insurers

The sheet contains `Star` and `Star Health Insurance`, `Acko` and `Acko General Insurance`,
`HDFC Ergo` and `HDFC Ergo health Insurance`. Without a mapping, a user selecting "Star" misses
every hospital that wrote the longer form.

`tools/insurers.json` is an explicit alias table — 36 canonical names, every known variant listed.
It also drops three data-entry artefacts (`A`, `A.A`, `RI`) and one cell where an entire list was
pasted without separators. Any spelling not in the table is **kept and reported**, so the map can be
extended rather than silently swallowing data:

```
  3 insurer spellings are not in tools/insurers.json (kept as-is):
    12×  Bharti AXA Life
```

A curated table beats a clever regex here. Generic suffix-stripping split `Care Health` from `Care`
and `New India` from `New India Assurance` — worse than doing nothing.

### Pincode coordinates — the public file needs cleaning

India Post publishes 160,092 post offices across 19,441 pincodes. Several offices share a pincode
and some coordinates are wrong. Take a naive average per pincode and the spread between offices in
the *same* pincode is:

| Percentile | Spread |
|---|---|
| Median | 9.5 km |
| p90 | **117 km** |
| p99 | **1,119 km** |

A pincode whose centre is 1,100 km wide will confidently route someone to another state.

`tools/build-pincodes.mjs` takes the **median** per pincode, drops any office more than 50 km from
it, and re-medians. That removed **10,964 outlier offices across 22% of pincodes** and brought the
residual to **3.5 km median / 17.5 km p90** — fine for "which hospitals are near me", and not
precise enough for anything street-level. If exact distance ever matters, geocode the address, not
the pincode.

```bash
node tools/build-pincodes.mjs path/to/pincodes.csv
```

---

## Adapting it to a different sheet

`tools/config.json` maps fields to column names, with aliases. Nothing else needs editing:

```json
"name": ["Hospital_Name_Long", "Hospital_Name", "Name"],
"lat":  ["latitude_hospital", "Latitude"]
```

A missing column warns rather than crashes — except `Hospital_Code`, which is the join key and is
fatal. `Status` must equal `Active` (configurable) or the row is skipped; `Speciality` and
`Short_Ins` are comma-separated on the hospital tab and single-valued on the doctor tab.

---

## Layout

```
├── index.html                  three views: search · results · hospital detail
├── style.css                   design tokens, light + dark, no framework
├── app.js                      combobox, ranking, sorting, rendering
├── data/                       generated — see the warning at the top
│   └── surgeries.json          218 surgeries → hospital speciality strings
├── incoming/                   raw CSV drops (git-ignored) + the mapping sheets
│   ├── Dept_Map.tsv            hospital speciality → department      (committed)
│   ├── SubDept_Map.tsv         surgery → department, 218 rows        (committed)
│   └── Hosp_Overrides.tsv      per-cell corrections                  (committed)
├── tools/
│   ├── config.json             column mapping + validation thresholds
│   ├── departments.json        department → secondary department
│   ├── build-surgeries.mjs     the two mapping sheets → data/surgeries.json
│   ├── insurers.json           70 spellings → 36 canonical names
│   ├── lib.mjs                 shared normalise · validate · atomic write
│   ├── sync.mjs                Google Sheets API → data/
│   ├── import-csv.mjs          local CSV → data/
│   ├── apply-overrides.mjs     patch built JSON when the CSVs aren't to hand
│   ├── build-pincodes.mjs      India Post CSV → sharded pincode index
│   ├── make-sample-data.mjs    synthetic inventory for public builds
│   ├── test-overrides.mjs      unit test for the override path
│   └── test-e2e.mjs            Chromium walk-through of a real search
└── .github/workflows/refresh.yml
```

The app has no dependencies and no build step. Playwright is needed only for `npm test`.

```bash
npm test                                     # override unit test + full E2E walk
node tools/test-e2e.mjs --surgery Piles --pin 110001
```

The E2E test **fails on a zero-result search**, which is the regression this repo is most exposed
to: a one-line taxonomy edit can make a surgery unreachable without breaking anything visibly.

---

## Known limits

- **Pincode-centre distance**, not door-to-door. Treat anything under ~4 km as "very close".
- **Results are capped at 24**, filled band by band from nearest outward — so everything hidden is
  further away than everything shown, under every sort. The count reads `24 of 140`, so the size of
  what's being left out is never a surprise.
- **A hospital can be panelled for a speciality with no doctor listed** — the roster and the panel
  are maintained separately upstream. The UI says so plainly instead of showing an empty screen.
- **Insurer lists are what the sheet says**, and cashless eligibility is confirmed at the hospital.
- **Data is as fresh as the last sync.** The header shows the date; `meta.json` has the timestamp.
- **No availability or slots.** That data doesn't exist upstream.
