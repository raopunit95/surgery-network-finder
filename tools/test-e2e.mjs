#!/usr/bin/env node
/**
 * End-to-end smoke test: serves the repo, drives the real page in Chromium, and
 * walks pincode → surgery → insurer → results → hospital detail → doctors.
 *
 *   node tools/test-e2e.mjs            # against whatever is in data/
 *   node tools/test-e2e.mjs --surgery "Cataract Surgery" --pin 110001
 *
 * Fails loudly on a zero-result search, because the failure mode this repo is
 * most exposed to is a taxonomy edit that quietly makes a surgery unreachable.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, unpackHospitals, detailShard } from './lib.mjs';

// Playwright is a dev-only dependency and this repo ships with none installed.
// Resolve it from wherever it lives (local node_modules or a global install)
// rather than making `npm install` a precondition for running the app.
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  const globalRequire = createRequire(`${process.env.HOME}/.npm-global/lib/node_modules/`);
  try { ({ chromium } = globalRequire('playwright')); }
  catch {
    console.error('\n✗ playwright not found. Install it first:\n    npm i -D playwright && npx playwright install chromium\n');
    process.exit(1);
  }
}

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = join(ROOT, url === '/' ? 'index.html' : url.replace(/^\/+/, ''));
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('nope'); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

// Decoded with the tools' own unpacker. app.js necessarily carries a second copy
// of that logic — it has no imports — so a card's insurer count is compared
// against this below. That is the only check that the two decoders agree, and a
// disagreement would silently mis-filter every insurer search.
const H = unpackHospitals(JSON.parse(readFileSync(join(ROOT, 'data', 'hospitals.json'), 'utf8')));
const S = JSON.parse(readFileSync(join(ROOT, 'data', 'surgeries.json'), 'utf8'));
const byHospitalCode = new Map(H.map((h) => [h.code, h]));

/** What the shard on disk holds for one hospital — the same file the page fetches. */
const detailFor = (code) => {
  const file = join(ROOT, 'data', 'detail', `${detailShard(code)}.json`);
  const shard = JSON.parse(readFileSync(file, 'utf8'));
  return shard.byHospital[code] ?? { addr: '', map: '', doctors: [] };
};

// Fixed smoke cases, chosen to exercise each resolution path rather than whichever
// surgery happens to have the widest coverage. Piles and Hernia go through a
// secondary department; IVF goes through a multi-department speciality; Cataract
// and Knee-Replacement resolve directly. Any name absent from the data is skipped
// with a warning rather than failing — the sample build has a different taxonomy.
const CASES = ['Piles', 'Hernia', 'IVF', 'Cataract', 'Knee-Replacement'];
const RANGE = 60;

const byName = new Map(S.map((x) => [x.name.toLowerCase(), x]));
const byNameMap = byName;

// Derive each case's pincode from the data rather than hard-coding a city: pick the
// pincode of the highest-scoring hospital that actually offers the surgery. That
// keeps the fixed pin from turning a coverage gap in the sample build into a false
// failure, while a genuine regression — the page showing zero where the data says
// there is one right there — still fails.
const pinFor = (surgery) => {
  const sp = new Set(surgery.specialities);
  return H.filter((h) => h.pincode && h.lat !== null && h.specialities.some((x) => sp.has(x)))
    .sort((a, b) => b.score - a.score)[0]?.pincode;
};

const only = arg('surgery');
const cases = (only ? [only] : CASES).map((name) => {
  const s = byName.get(name.toLowerCase());
  return { surgery: name, pin: arg('pin') || (s && pinFor(s)) };
});

const fail = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };
const ok = (m) => console.log(`✓ ${m}`);

const known = new Set(S.map((x) => x.name.toLowerCase()));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' })
  .catch(() => chromium.launch());
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const pick = async (input, list, value) => {
  await page.fill(input, value);
  await page.waitForSelector(`${list} li`, { timeout: 5000 });
  // Click the exact match if the list offers one, else the first suggestion.
  const items = await page.$$(`${list} li`);
  for (const it of items) {
    if (((await it.textContent()) || '').trim().toLowerCase() === value.toLowerCase()) { await it.click(); return; }
  }
  await items[0].click();
};

await page.goto(base, { waitUntil: 'networkidle' });
ok(`page loads — ${await page.title()} · ${H.length} hospitals, ${S.length} surgeries`);

let ran = 0;
for (const c of cases) {
  if (!known.has(c.surgery.toLowerCase())) {
    console.log(`· skipped ${c.surgery} — not in this build's taxonomy`);
    continue;
  }
  if (!c.pin) fail(`${c.surgery} resolves to no hospital anywhere — the taxonomy is broken`);
  ran++;
  console.log(`\n── ${c.surgery} @ ${c.pin}`);

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.fill('#pincodeInput', c.pin);
  await pick('#surgeryInput', '#surgeryList', c.surgery);

  const hint = (await page.textContent('#surgeryHint'))?.trim();
  if (hint) console.log(`   resolves via: ${hint}`);

  await page.waitForSelector('#searchBtn:not([disabled])', { timeout: 5000 });
  await page.click('#searchBtn');
  await page.waitForSelector('#resultsView.is-active', { timeout: 10000 });

  const cards = await page.$$('#resultsBody [data-code]');
  if (!cards.length) fail(`zero hospitals for ${c.surgery} near ${c.pin} — a taxonomy or data regression`);
  const unfilteredTotal = Number(((await page.textContent('.sort-count')) || '').match(/of\s+([\d,]+)/)?.[1].replace(/,/g, '')) || cards.length;
  ok(`${cards.length} of ${unfilteredTotal} hospitals · ${(await page.textContent('#resultsSub'))?.trim()}`);

  // Every card must say which department matched, and it must be one the surgery
  // actually targets — this is the check that catches an over-broad mapping.
  const targeted = new Set(byNameMap.get(c.surgery.toLowerCase())?.specialities || []);
  const chips = await page.$$eval('#resultsBody .card-hit span', (els) => els.map((e) => e.textContent.trim()));
  if (!chips.length) fail(`no matched-speciality chip on any card for ${c.surgery}`);
  const stray = [...new Set(chips)].filter((x) => !targeted.has(x));
  if (stray.length) fail(`${c.surgery} matched on specialities it does not target: ${stray.join(', ')}`);
  ok(`matched via ${[...new Set(chips)].join(', ')}`);

  // The page decoded the insurer bitmask itself. If its decoder and the tools'
  // disagree by even one bit, every insurer filter is quietly wrong — so compare.
  const shown = await page.$$eval('#resultsBody [data-code]', (els) => els.map((el) => ({
    code: el.dataset.code,
    insurers: Number((el.querySelector('.card-meta')?.textContent.match(/(\d+)\s*insurers/) || [])[1]),
    specialities: Number((el.querySelector('.card-meta')?.textContent.match(/(\d+)\s*specialities/) || [])[1]),
  })));
  for (const s of shown) {
    const h = byHospitalCode.get(s.code);
    if (!h) fail(`the page rendered hospital ${s.code}, which is not in hospitals.json`);
    if (s.insurers !== h.insurers.length) {
      fail(`insurer bitmask decoded differently: the page says ${s.insurers} for ${s.code}, the tools say ${h.insurers.length}`);
    }
    if (Number.isFinite(s.specialities) && s.specialities !== h.specialities.length) {
      fail(`speciality dictionary decoded differently for ${s.code}: page ${s.specialities}, tools ${h.specialities.length}`);
    }
  }
  ok(`compact format decodes identically in the browser (${shown.length} cards checked)`);

  const openedCode = await cards[0].getAttribute('data-code');
  await cards[0].click();
  await page.waitForSelector('#detailView.is-active', { timeout: 10000 });
  const name = (await page.textContent('#detailName'))?.trim();
  await page.waitForFunction(
    () => !/loading/i.test(document.querySelector('#detailBody')?.textContent || ''),
    null, { timeout: 10000 },
  ).catch(() => {});
  const detail = (await page.textContent('#detailBody'))?.trim() || '';
  if (!detail) fail(`hospital detail rendered empty for ${name}`);

  // The address, map link and doctor roster live in the detail shard now, not in
  // hospitals.json. If the shard rule in app.js drifts from the one in lib.mjs,
  // search keeps working perfectly and every hospital page fails to load its
  // detail — so compare the rendered page against the shard file on disk.
  const expected = detailFor(openedCode);
  const addr = (await page.textContent('#detailAddr'))?.trim() || '';
  if (expected.addr && addr !== expected.addr) {
    fail(`detail shard did not reach the page for ${openedCode}:\n    page  "${addr}"\n    shard "${expected.addr}"`);
  }
  const shownDoctors = (await page.$$('#detailBody .doc')).length;
  if (shownDoctors !== expected.doctors.length) {
    fail(`${openedCode} lists ${expected.doctors.length} doctors in its shard but the page rendered ${shownDoctors}`);
  }
  ok(`detail opens — ${name} · shard gave ${shownDoctors} doctor${shownDoctors === 1 ? '' : 's'} and the address`);
  console.log(`   ${detail.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' · ').slice(0, 120)}`);

  // Every view carries the profile link.
  const footHref = await page.getAttribute('.sitefoot a', 'href');
  if (!footHref) fail('no profile link in the footer on the detail view');

  await page.click('[data-go="results"]');
  await page.waitForSelector('#resultsView.is-active');

  // Sort reorders inside each distance band; bands stay nearest-first.
  await sortAndCheck('distance', 'km', 'asc');
  const byRating = await sortAndCheck('rating', 'rating', 'desc');
  await sortAndCheck('reviews', 'reviews', 'desc');
  ok(`sorts within ${byRating.length} distance band${byRating.length === 1 ? '' : 's'}: distance, rating, reviews`);

  await page.click('[data-sort="recommended"]');
  await page.waitForFunction(() => document.querySelector('.band'));

  // Insurer filter must narrow, never widen.
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.fill('#pincodeInput', c.pin);
  await pick('#surgeryInput', '#surgeryList', c.surgery);
  await pick('#insurerInput', '#insurerList', 'Star Health');
  await page.click('#searchBtn');
  await page.waitForSelector('#resultsView.is-active');
  // Compare the "N of M" total, not the card count: the cap is 24, so both sides
  // read 24 whether the filter did anything or not and the check proves nothing.
  const matchedTotal = async () =>
    Number(((await page.textContent('.sort-count').catch(() => '')) || '').match(/of\s+([\d,]+)/)?.[1].replace(/,/g, ''))
    || (await page.$$('#resultsBody [data-code]')).length;
  const filtered = await matchedTotal();
  const widened = await page.locator('.notice').count() > 0;
  if (filtered > unfilteredTotal) {
    fail(`insurer filter widened the network: ${unfilteredTotal} → ${filtered} hospitals for ${c.surgery}`);
  }
  ok(`Star Health narrows the network ${unfilteredTotal} → ${filtered}${widened ? ' (radius widened to fill the page)' : ''}`);
}

/* A pincode with no hospital inside RANGE must widen rather than show nothing.
   333515 (Jhunjhunu) is the real case that exposed this: the nearest
   knee-replacement hospital is 110 km away in Gurgaon. */
if (!only) {
  const far = { surgery: 'Knee-Replacement', pin: '333515' };
  if (known.has(far.surgery.toLowerCase())) {
    console.log(`\n── ${far.surgery} @ ${far.pin} (out-of-range fallback)`);
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.fill('#pincodeInput', far.pin);
    await pick('#surgeryInput', '#surgeryList', far.surgery);
    await page.click('#searchBtn');
    await page.waitForSelector('#resultsView.is-active', { timeout: 10000 });

    const n = (await page.$$('#resultsBody [data-code]')).length;
    if (!n) fail(`${far.pin} still shows nothing — the out-of-range fallback did not fire`);

    const notice = (await page.textContent('.notice').catch(() => null))?.trim();
    if (!notice) fail('widened the search but did not say so — silently showing hospitals 110 km away is worse than an empty screen');
    if (!/\d+\s*km/.test(notice)) fail(`notice does not state the actual distance: ${notice}`);

    const nearest = parseFloat((await page.textContent('.card-dist')).replace(/[^0-9.]/g, ''));
    if (!(nearest > RANGE)) fail(`fallback fired but the nearest card is ${nearest} km — inside range, so it should not have`);
    ok(`${n} hospitals, nearest ${nearest} km, notice shown`);
    console.log(`   "${notice.replace(/\s+/g, ' ').slice(0, 110)}…"`);
  }
}

/* Read the rendered results as bands, in document order. */
async function readGroups() {
  return page.evaluate(() =>
    [...document.querySelectorAll('#resultsBody .cards')].map((c) => ({
      label: (c.previousElementSibling?.textContent || '').trim(),
      cards: [...c.querySelectorAll('[data-code]')].map((el) => {
        const dist = parseFloat((el.querySelector('.card-dist')?.textContent || '').replace(/[^0-9.]/g, ''));
        const metaText = el.querySelector('.rating')?.parentElement?.textContent || '';
        const rating = parseFloat((metaText.match(/★\s*([\d.]+)/) || [])[1]);
        const reviews = parseFloat(((metaText.match(/\(([\d,]+)\)/) || [])[1] || '').replace(/,/g, ''));
        return { km: dist, rating, reviews };
      }),
    })),
  );
}

/* Bands must stay in distance order whatever the sort, and the sort must hold
   INSIDE each band. That split is the whole design: a 4.9 in Vizianagaram must
   not outrank a 4.6 in Noida for someone searching from Rajasthan. */
async function sortAndCheck(key, field, dir) {
  await page.click(`[data-sort="${key}"]`);
  await page.waitForFunction(
    (k) => document.querySelector(`[data-sort="${k}"]`)?.classList.contains('on'),
    key,
  );
  const groups = await readGroups();
  if (!groups.length) fail(`sort by ${key} rendered no bands`);

  let prevMax = -1, checked = 0;
  for (const g of groups) {
    const kms = g.cards.map((c) => c.km).filter(Number.isFinite);
    if (Math.min(...kms) < prevMax - 0.05) {
      fail(`band "${g.label}" starts at ${Math.min(...kms)} km but the previous band reached ${prevMax} km — bands are out of distance order under sort "${key}"`);
    }
    prevMax = Math.max(prevMax, ...kms);

    const vals = g.cards.map((c) => c[field]).filter(Number.isFinite);
    for (let i = 1; i < vals.length; i++) {
      const bad = dir === 'asc' ? vals[i] < vals[i - 1] - 0.05 : vals[i] > vals[i - 1] + 0.001;
      if (bad) fail(`sort by ${key} is out of order inside band "${g.label}": ${vals.join(', ')}`);
      checked++;
    }
  }
  if (!checked) fail(`sort by ${key} had no band with two comparable values — nothing was actually verified`);
  return groups;
}

if (!ran) fail('no test case matched this build’s taxonomy — nothing was actually exercised');
if (errors.length) fail(`${errors.length} console/page error(s):\n    ${errors.slice(0, 5).join('\n    ')}`);
console.log('\n✓ no console or page errors');

await browser.close();
server.close();
console.log(`\nall checks passed — ${ran} case${ran === 1 ? '' : 's'}`);
