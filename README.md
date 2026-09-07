# Surgery Network Finder

**Find a hospital that will do your surgery cashless, near you, on your insurance — and see which doctors there actually perform it.**

🔗 **[Try the prototype →](https://raopunit95.github.io/surgery-network-finder/)**

```
pincode  ──►  hospitals matching surgery + insurer  ──►  doctors at the chosen hospital
```

648 hospitals · 3,547 doctors · 218 surgeries · 144 cities · 36 insurers

> ### 🏥 This shipped
>
> The approach proven here now runs in production at MediBuddy as the
> **[Cashless Hospital Finder](https://www.medibuddy.in/surgery-care/find-hospitals)**, where it
> generates **~50 leads a day, converting to ~30 surgeries and ₹21 lakh of booked value per month.**
>
> This repository is the prototype that came first — built to prove the distance ranking and the
> condition-to-speciality matching before committing an engineering sprint to them. It runs on a
> point-in-time snapshot of the network and is not the production system.

---

## The problem

Someone has been told they need a knee replacement. They have health insurance. They want to know
one thing: *where can I have this done, near me, without paying upfront?*

Every part of that is hard to answer today. Insurer network lists are PDFs organised by city, not
by procedure. Hospital directories list "Orthopaedics", not "knee replacement". And nothing tells
you whether the hospital that comes up actually has a surgeon who does it.

The gap is a vocabulary problem as much as a data one. **A patient types "Piles". The hospital
network calls it "General Surgery".** Nothing bridges the two, so the patient searches for their
condition and finds nothing.

## What it does

1. **Enter a pincode.** Six digits. Used only to measure distance — nothing is stored or sent.
2. **Pick a surgery.** 218 of them, by the name a patient would use: *Cataract*, *Piles*, *IVF*,
   *Gallbladder Stone Removal*.
3. **Optionally pick an insurer.** 36 of them.
4. **Get hospitals**, grouped by how far they are, ranked within each group, each card showing
   distance, rating, admission volume and **which speciality matched your search**.
5. **Open one** to see the doctors there who handle that specific procedure — with qualifications,
   experience and OPD hours — separated from the rest of the roster.

---

## Three decisions that shaped it

### 1. Distance sets the shortlist; the sort works inside it

Results fall into distance bands — 20 / 35 / 50 / 100 / 150 / 250 km and outwards. Bands are always
nearest-first, and **no sort can move a hospital past a band boundary.**

This wasn't the first design. Sorting the whole list by rating put a 4.9 in Vizianagaram above a
4.6 in Noida for someone searching from Rajasthan — technically correct, useless as an answer. So
sorting was confined to work *within* a band.

Inside a band, the default order is volume and reputation rather than raw proximity, because for
surgery a busy hospital 8 km away beats a quiet one 3 km away:

```
score = log₁₀(1 + admissions)  +  0.5 · log₁₀(1 + reviews) · (rating / 5)
```

Log-damped, so a hospital with 5,000 reviews doesn't bury a good one with 200. Rating ties break on
review count, then distance. Unrated hospitals sink rather than float — unknown isn't bad, but it
doesn't belong at the top.

The list caps at 24, filled band by band from nearest outward, so everything hidden is further away
than everything shown.

### 2. The department is a filing category, not a matching key

Bridging *Piles* to *General Surgery* needs an intermediary, and the obvious one is the department:

```
surgery  ──►  department  ──►  hospital speciality  ──►  hospital  ──►  doctor
```

That works for departments mapping to a single speciality. It breaks badly for catch-alls.
`Aesthetic` covers Plastic Surgery, Dermatology, Cosmetology *and* Hair Transplant — so routing
through it matched **Rhinoplasty to hair clinics** and **Botox to surgical wards**. `General
Medicine` spans eight specialities, so *Dengue* returned surgical hospitals.

The fix was to let a surgery override the department and name the specialities it actually needs.
45 of the 218 do. The rest use the department route, which is correct for them.

Two safeguards keep this honest rather than hopeful:

- The build **warns on any surgery matching more than three specialities** through its department —
  that's where silent over-matching hides.
- Every result card **shows which speciality matched.** If *Rhinoplasty* says it matched on
  *Hair Transplant*, the mapping is wrong and anyone can see it. Hidden, that stays a wrong answer
  nobody notices.

### 3. "Nothing nearby" is an answer, not an error

Pincode 333515 is Jhunjhunu, Rajasthan. The nearest hospital doing knee replacements is **109.5 km
away, in Gurgaon.**

Showing an empty screen would be wrong — those hospitals exist and the patient may well travel.
Silently listing something 110 km away as if it were around the corner would be worse. So the page
widens the search and says so, with the real distance, before the reader sees a single hospital
name.

---

## How it's built

**Vanilla JavaScript. No framework, no dependencies, no build step.** Under 1,000 lines of
application code; `git push` is the deployment.

### The data is built, not queried

There is no API and no database. A pipeline reads the source inventory, cleans it, resolves the
whole taxonomy, and writes flat JSON that ships with the page. The browser does all filtering,
ranking and distance maths locally.

Nothing loads that the current screen doesn't need:

| Fetched | When | Size |
|---|---|---|
| `meta.json` + `surgeries.json` | page load | ~5 KB |
| one pincode shard | on search | ~1 KB |
| `hospitals.json` — the search index | on search | ~30 KB |
| one detail shard — address, map link, doctors | on opening a hospital | ~3 KB |

The full journey costs about **38 KB over the wire.** Getting there meant treating the hospital
index as a columnar table rather than a list of objects, dictionary-encoding the fields that repeat,
storing each hospital's 36-insurer panel as a bitmask, and moving address and roster out of the
search payload into per-hospital shards — they're only read on the detail screen.

### Distance

An equirectangular approximation rather than haversine. The error is far below the ~3.5 km
uncertainty already baked into any pincode centroid, and it's much cheaper across hundreds of rows.

### Pincode coordinates needed cleaning first

Built from India Post's 160,092 post offices across 19,441 pincodes. Averaging the offices in a
pincode naively gave a p90 spread of 117 km and a p99 of 1,119 km — a pincode straddling two
districts drags its centre into a field between them.

Taking the median, rejecting offices more than 50 km out, then re-taking the median dropped 10,964
outliers across 22% of pincodes and left a residual error of 3.5 km median, 17.5 km p90.

### It checks its own work

The failure this system is prone to doesn't look like an error. It looks like *"no hospitals near
you"* — indistinguishable from a genuine coverage gap. So the tooling is built to make silence
audible:

- A health check reports what needs a human: unmapped insurer spellings, hospitals with blank
  fields that make them unfindable, surgeries that resolve to nothing.
- A speciality the source introduces that no rule covers is **reported, not guessed at.** The
  builder will restate a mapping that already exists — stripping a provider brand, folding
  "Surgical X" into "Medical X" — but anything requiring judgement is written to a review file and
  left inactive, so the site can never claim a mapping the source doesn't state.
- 41 unit tests cover the mapper, most of them asserting what it must *refuse* to do.
- An end-to-end suite drives a real browser through five searches and the Jhunjhunu case, and
  **fails on a zero-result search.**

---

## About the data

`data/` holds a point-in-time snapshot of an Indian cashless-surgery provider network — active
hospitals with coordinates, insurer panels and admission volumes, and their doctors with
specialities and OPD timings. It's generated by the build tools and never hand-edited.

Only the fields the interface renders are written out. Email addresses, internal record identifiers
and upstream system IDs present on the source rows are dropped at build time and the raw export is
never committed.

**This is not authoritative for cashless eligibility.** Insurer panels change without notice, and
the desk at the hospital is the only reliable answer. The interface says so on every screen.
It is also not a live feed — the header carries the date the snapshot was generated.

---

## Repository map

| Path | What it is |
|---|---|
| `index.html` · `app.js` · `style.css` | the entire site |
| `data/` | generated JSON — the search index, detail shards, pincode shards |
| `data/taxonomy.json` | the resolved mapping, spelled out, so a wrong result is traceable |
| `incoming/*.tsv` | the two mapping sheets: surgery → department, speciality → department |
| `tools/` | the build pipeline, the mapping engine, the health check, the tests |
| `DEPLOY.md` | deployment and data-refresh notes |

## Running it locally

```
npm run serve
```

Open <http://localhost:8080>. Nothing to install. Opening `index.html` directly off disk won't
work — browsers block `fetch` on `file://`.

To see it without the real network, `npm run sample` swaps in an invented one on the same taxonomy.

## Known limits

- Insurer panels and doctor rosters are exactly as accurate as the source export, and no more.
- 37 surgeries under Gynaecology and Oncology still match more than three specialities through their
  department. Left deliberately — a cancer patient plausibly wants any oncology unit — but unreviewed.
- A handful of hospitals have blank insurer or speciality fields at source and are correspondingly
  hard or impossible to surface. The health check names them rather than hiding them.

---

Built by **[Punit Yadav](https://github.com/raopunit95)** · Senior Manager – Product, MediBuddy

Production version: **[medibuddy.in/surgery-care/find-hospitals](https://www.medibuddy.in/surgery-care/find-hospitals)** · Portfolio: **[raopunit95/punit-yadav](https://github.com/raopunit95/punit-yadav)**
