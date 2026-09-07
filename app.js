/* ============================================================================
   Surgery Network Finder

   pincode + speciality + insurer  →  ranked hospitals  →  doctors at that hospital

   Everything runs in the browser against static JSON. No API, no key, no backend.
   ========================================================================== */
'use strict';

const DATA = 'data';
const MAX_OPTIONS = 60;

/* Distance bands, in km. Inside each band hospitals are ordered by `score`
   (volume + reputation), not by distance — a busy hospital 8 km away is a
   better answer for surgery than a quiet one 3 km away. Past the last band
   we fall back to pure distance, because at that range proximity is the
   only thing the user still cares about. */
/* Distance bands, in km, covering the whole country. Fine near the user and
   coarse far away, because the difference between 8 km and 18 km changes what
   you do and the difference between 1,100 km and 1,300 km does not.

   These are the unit of ordering: bands always appear nearest-first, and the
   chosen sort only reorders hospitals *inside* a band. Sorting purely by rating
   across the whole list puts a 4.9 in Vizianagaram above a 4.6 in Noida for
   someone searching from Rajasthan, which is a worse answer however good the
   hospital is. Distance sets the shortlist; the sort picks within it. */
const BANDS = [
  20, 35, 50, 100, 150, 250, 350, 500, 650, 800, 1000, 1250, 1500, Infinity,
].map((max, i, a) => ({
  max,
  label:
    i === 0 ? `Within ${max} km`
      : max === Infinity ? `${a[i - 1].toLocaleString('en-IN')} km and beyond`
        : `${a[i - 1].toLocaleString('en-IN')} – ${max.toLocaleString('en-IN')} km`,
}));

/* Past this, the result is a journey rather than a trip, and the page says so
   before the user reads a single hospital name. */
const NEAR = 50;
const MAX_RESULTS = 24;

/* Sort orders. `recommended` is null because it isn't a comparator — it's the
   distance-banded ranking, which needs the whole list, not a pairwise rule.

   Rating and reviews both fall back to the other, then to distance. A 5.0 from
   two people should not outrank a 4.6 from three thousand, and without the
   tiebreak that is exactly what happens. Nulls sink rather than float: a hospital
   with no rating is unknown, not bad, but it does not belong at the top. */
const SORTS = {
  recommended: { label: 'Recommended', fn: null },
  distance: { label: 'Distance', fn: (a, b) => a.km - b.km },
  rating: {
    label: 'Rating',
    fn: (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || (b.reviews ?? 0) - (a.reviews ?? 0) || a.km - b.km,
  },
  reviews: {
    label: 'Most reviewed',
    fn: (a, b) => (b.reviews ?? -1) - (a.reviews ?? -1) || (b.rating ?? 0) - (a.rating ?? 0) || a.km - b.km,
  },
};

const state = {
  meta: null,
  hospitals: null,
  doctors: null,
  surgeries: null,
  surgery: null,
  insurer: null,
  pin: null,
  pool: [],        // every match anywhere, with km, nearest first
  results: [],     // what is currently on screen
  matchedTotal: 0,
  sort: 'recommended',
  hospital: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── boot ─────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  try {
    [state.meta, state.surgeries] = await Promise.all([
      getJSON(`${DATA}/meta.json`),
      getJSON(`${DATA}/surgeries.json`),
    ]);
  } catch (err) {
    document.querySelector('.panel').innerHTML =
      `<div class="empty"><strong>Could not load the inventory.</strong>
       <p>${esc(err.message)}</p>
       <p>If you opened this file straight from disk, serve the folder over HTTP instead —
       browsers block <code>fetch</code> on <code>file://</code>. Try
       <code>npx serve .</code> or <code>python3 -m http.server</code>.</p></div>`;
    return;
  }

  const m = state.meta;
  $('dataline').innerHTML =
    `${m.hospitalCount.toLocaleString('en-IN')} hospitals · ${m.doctorCount.toLocaleString('en-IN')} doctors<br>` +
    `updated ${new Date(m.generatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;

  // The distance caveat lives in the site footer now — no need to say it twice.
  $('foot').innerHTML =
    `${state.surgeries.length} surgeries · ${m.insurers.length} insurers · ${m.cityCount} cities`;

  if (m.source === 'sample') {
    const b = $('sampleBanner');
    b.hidden = false;
    b.innerHTML = '<strong>Demo data.</strong> Hospital names, doctors and coordinates on this build are invented — the search behaviour is real.';
  }

  const byName = new Map(state.surgeries.map((x) => [x.name, x]));
  combobox('surgery', state.surgeries.map((x) => x.name), () => {
    const s = byName.get(state.surgery);
    $('surgeryHint').textContent = s
      ? `${s.departments.join(', ')}${s.secondary.length ? ` (also searched under ${s.secondary.join(', ')})` : ''}`
      : `${state.surgeries.length} surgeries and treatments.`;
    refreshButton();
  });
  combobox('insurer', m.insurers, () => refreshButton());

  $('pincodeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    state.pin = null;
    $('pincodeHint').classList.remove('err');
    $('pincodeHint').textContent = 'Six digits. Used only to measure distance.';
    refreshButton();
  });

  $('searchBtn').addEventListener('click', runSearch);
  document.querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => show(b.dataset.go === 'search' ? 'searchView' : 'resultsView'))
  );

  $('surgeryHint').textContent = `${state.surgeries.length} surgeries and treatments.`;
}

const cache = new Map();
async function getJSON(url) {
  if (cache.has(url)) return cache.get(url);
  const p = fetch(url, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} while loading ${url}`);
    return r.json();
  });
  cache.set(url, p);
  return p;
}

/* ── combobox ─────────────────────────────────────────────────────────── */

function combobox(key, items, onChange) {
  const input = $(`${key}Input`);
  const list = $(`${key}List`);
  const clear = document.querySelector(`[data-clear="${key}"]`);
  let active = -1;

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };

  const render = (q) => {
    const needle = q.trim().toLowerCase();
    const starts = [], contains = [];
    for (const it of items) {
      const l = it.toLowerCase();
      if (!needle) starts.push(it);
      else if (l.startsWith(needle)) starts.push(it);
      else if (l.includes(needle)) contains.push(it);
    }
    const hits = [...starts, ...contains].slice(0, MAX_OPTIONS);
    if (!hits.length) {
      list.innerHTML = `<li aria-disabled="true"><span class="muted">No match for “${esc(q)}”</span></li>`;
    } else {
      list.innerHTML = hits
        .map((h, i) => `<li role="option" data-v="${esc(h)}" aria-selected="${i === active}">${esc(h)}</li>`)
        .join('');
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  const commit = (v) => {
    state[key] = v;
    input.value = v;
    clear.hidden = false;
    close();
    onChange();
  };

  input.addEventListener('focus', () => render(input.value));
  input.addEventListener('input', () => { state[key] = null; clear.hidden = !input.value; render(input.value); onChange(); });
  input.addEventListener('keydown', (e) => {
    const opts = [...list.querySelectorAll('li[data-v]')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) return render(input.value);
      active = Math.max(0, Math.min(opts.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
      opts.forEach((o, i) => o.setAttribute('aria-selected', i === active));
      opts[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (!list.hidden && opts[active]) { e.preventDefault(); commit(opts[active].dataset.v); }
    } else if (e.key === 'Escape') close();
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-v]');
    if (li) { e.preventDefault(); commit(li.dataset.v); }
  });
  clear.addEventListener('click', () => { state[key] = null; input.value = ''; clear.hidden = true; close(); onChange(); input.focus(); });
  document.addEventListener('click', (e) => { if (!input.parentElement.contains(e.target)) close(); });
}

function refreshButton() {
  const pinOk = /^\d{6}$/.test($('pincodeInput').value);
  const ok = pinOk && !!state.surgery;
  $('searchBtn').disabled = !ok;
  $('searchHint').textContent = ok
    ? ''
    : !pinOk ? 'Enter a six-digit pincode to continue.'
      : 'Pick a surgery to continue.';
}

/* ── geo ──────────────────────────────────────────────────────────────── */

async function lookupPincode(pin) {
  const shard = await getJSON(`${DATA}/pincodes/${pin.slice(0, 3)}.json`).catch(() => null);
  return shard?.[pin] ?? null; // [lat, lon, district, state]
}

// Equirectangular approximation — accurate to well under 1% at these ranges
// and far cheaper than haversine across 650 rows on every keystroke.
function km(aLat, aLon, bLat, bLon) {
  const x = (bLon - aLon) * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
  const y = bLat - aLat;
  return Math.sqrt(x * x + y * y) * 111.32;
}

/* ── search ───────────────────────────────────────────────────────────── */

async function runSearch() {
  const pin = $('pincodeInput').value;
  const btn = $('searchBtn');
  btn.disabled = true;
  btn.textContent = 'Searching…';

  try {
    const [loc, hospitals] = await Promise.all([
      lookupPincode(pin),
      state.hospitals ? Promise.resolve(state.hospitals) : getJSON(`${DATA}/hospitals.json`),
    ]);
    state.hospitals = hospitals;

    if (!loc) {
      $('pincodeHint').classList.add('err');
      $('pincodeHint').textContent = `We don't have coordinates for ${pin}. Check the digits, or try a neighbouring pincode.`;
      $('pincodeInput').focus();
      return;
    }
    state.pin = { code: pin, lat: loc[0], lon: loc[1], district: loc[2], state: loc[3] };

    const surgery = state.surgeries.find((x) => x.name === state.surgery);
    const wanted = new Set(surgery ? surgery.specialities : []);
    state.wanted = wanted;
    const ins = state.insurer;
    const matched = hospitals.filter(
      (h) => h.lat !== null &&
        h.specialities.some((sp) => wanted.has(sp)) &&
        (!ins || h.insurers.includes(ins))
    );

    // Keep every match, not just the ones in range. Sorting by rating has to see
    // the whole pool — re-ordering a pre-truncated twelve would just shuffle the
    // twelve nearest, which is not what "sort by rating" means to anyone.
    state.pool = matched
      .map((h) => ({ ...h, km: km(state.pin.lat, state.pin.lon, h.lat, h.lon) }))
      .sort((a, b) => a.km - b.km);
    state.matchedTotal = matched.length;
    state.sort = 'recommended';

    applySort();
    show('resultsView');
  } catch (err) {
    $('resultsBody').innerHTML = `<div class="empty"><strong>Something went wrong.</strong><p>${esc(err.message)}</p></div>`;
    show('resultsView');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find hospitals';
  }
}

/* Turn the pool into what is on screen. Called on every search and on every sort
   change — no refetch, no recomputed distances.

   Bands are walked nearest-first and filled until the cap is reached, so the list
   is always distance-ordered at the band level whatever the sort. That is the
   whole point: a hospital in the next state should never outrank one an hour away
   because it has more reviews. */
function applySort() {
  const cmp = SORTS[state.sort].fn || ((a, b) => b.score - a.score);
  const out = [];
  let lo = 0;

  for (const band of BANDS) {
    if (out.length >= MAX_RESULTS) break;
    const inBand = state.pool.filter((h) => h.km > lo && h.km <= band.max).sort(cmp);
    for (const h of inBand) {
      if (out.length >= MAX_RESULTS) break;
      out.push({ ...h, band: band.label });
    }
    lo = band.max;
  }

  state.results = out;
  renderResults();
}

function renderResults() {
  const { pin, surgery, insurer, results, matchedTotal, pool } = state;
  const sortBar = $('sortBar');

  $('resultsTitle').textContent = results.length
    ? `${results.length} hospital${results.length === 1 ? '' : 's'} for ${surgery}`
    : `No hospitals for ${surgery}`;
  $('resultsSub').textContent = `${pin.district}, ${pin.state} · ${pin.code}`;
  $('resultsCrit').innerHTML =
    `<span class="chip on">${esc(surgery)}</span>` +
    (insurer ? `<span class="chip on">${esc(insurer)}</span>` : `<span class="chip">Any insurer</span>`) +
    `<span class="chip">${matchedTotal} in network</span>`;

  if (!results.length) {
    sortBar.hidden = true;
    const tips = insurer
      ? [`No hospital listed for ${esc(surgery)} is on the ${esc(insurer)} panel. Clear the insurer — cashless cover is sometimes arranged at the desk.`]
      : [`No hospital in the network is listed for ${esc(surgery)}.`];
    tips.push('Try a related procedure — the same department often covers it under another name.');
    $('resultsBody').innerHTML =
      `<div class="empty"><strong>Nothing in the network matches.</strong>
       <ul>${tips.map((x) => `<li>${x}</li>`).join('')}</ul></div>`;
    return;
  }

  sortBar.hidden = false;
  sortBar.innerHTML =
    `<span class="sort-label">Sort within distance</span>
     <div class="seg" role="group" aria-label="Sort order">` +
    Object.entries(SORTS)
      .map(([k, v]) => `<button type="button" class="seg-btn${k === state.sort ? ' on' : ''}" data-sort="${k}" aria-pressed="${k === state.sort}">${esc(v.label)}</button>`)
      .join('') +
    `</div><span class="sort-count">${results.length} of ${matchedTotal}</span>`;
  sortBar.querySelectorAll('[data-sort]').forEach((b) =>
    b.addEventListener('click', () => {
      if (state.sort === b.dataset.sort) return;
      state.sort = b.dataset.sort;
      applySort();
    })
  );

  const nearest = pool[0];
  const notice = nearest.km > NEAR
    ? `<div class="notice"><strong>Nothing within ${NEAR} km of ${esc(pin.code)}.</strong>
       The nearest is <b>${Math.round(nearest.km)} km</b> away, in ${esc(nearest.city || 'another city')}.
       These are still the closest in the network — worth calling ahead before travelling.</div>`
    : '';

  const groups = [];
  for (const h of results) {
    if (!groups.length || groups[groups.length - 1].label !== h.band) groups.push({ label: h.band, items: [] });
    groups[groups.length - 1].items.push(h);
  }
  const body = groups
    .map((g) => `<div class="band"><span>${esc(g.label)}</span><i></i></div>
       <div class="cards">${g.items.map(hospitalCard).join('')}</div>`)
    .join('');

  const hidden = matchedTotal - results.length;
  const more = hidden > 0
    ? `<p class="foot">${hidden} further ${hidden === 1 ? 'hospital is' : 'hospitals are'} listed for ${esc(surgery)}, all further away. Narrow the search rather than scrolling — nothing past this point is closer.</p>`
    : '';

  $('resultsBody').innerHTML = notice + body + more;
  $('resultsBody').querySelectorAll('[data-code]').forEach((el) =>
    el.addEventListener('click', () => openHospital(el.dataset.code))
  );
}

function hospitalCard(h) {
  const bits = [];
  if (h.rating) bits.push(`<span><span class="rating">★ ${h.rating}</span>${h.reviews ? ` (${h.reviews.toLocaleString('en-IN')})` : ''}</span>`);
  if (h.ipd) bits.push(`<span><b>${h.ipd.toLocaleString('en-IN')}</b> admissions</span>`);
  bits.push(`<span><b>${h.insurers.length}</b> insurers</span>`);
  if (h.specialities.length) bits.push(`<span><b>${h.specialities.length}</b> specialities</span>`);
  return `
  <button class="card" data-code="${esc(h.code)}">
    <div class="card-top">
      <span class="card-name">${esc(h.nameShort || h.name)}</span>
      <span class="card-dist">${h.km < 1 ? '<1' : h.km.toFixed(1)} km</span>
    </div>
    <div class="card-sub">${esc([h.locality, h.city].filter(Boolean).join(', '))}</div>
    <div class="card-meta">${bits.join('')}</div>
    <div class="card-foot">See doctors for ${esc(state.surgery)} →</div>
  </button>`;
}

/* ── hospital detail ──────────────────────────────────────────────────── */

async function openHospital(code) {
  const h = state.results.find((x) => x.code === code)
    || state.pool.find((x) => x.code === code)
    || state.hospitals.find((x) => x.code === code);
  if (!h) return;
  state.hospital = h;

  $('detailName').textContent = h.name;
  $('detailAddr').textContent = h.address || [h.locality, h.city, h.state].filter(Boolean).join(', ');
  $('detailKpis').innerHTML = [
    [`${h.km ? h.km.toFixed(1) : '—'} km`, `from ${state.pin.code}`],
    [h.rating ? `★ ${h.rating}` : '—', h.reviews ? `${h.reviews.toLocaleString('en-IN')} reviews` : 'no reviews'],
    [h.ipd ? h.ipd.toLocaleString('en-IN') : '—', 'admissions'],
    [h.specialities.length, 'specialities'],
    [h.insurers.length, 'insurers'],
  ].map(([b, s]) => `<div class="kpi"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('');

  $('detailBody').innerHTML = `<div class="loading"><div class="spinner"></div>Loading doctors…</div>`;
  show('detailView');
  window.scrollTo({ top: 0, behavior: 'instant' });

  try {
    state.doctors = state.doctors || (await getJSON(`${DATA}/doctors.json`));
  } catch (err) {
    $('detailBody').innerHTML = `<div class="empty"><strong>Could not load doctors.</strong><p>${esc(err.message)}</p></div>`;
    return;
  }

  const all = state.doctors.filter((d) => d.hospitalCode === h.code);
  const forSpec = all.filter((d) => state.wanted.has(d.speciality));
  const others = all.filter((d) => !state.wanted.has(d.speciality));

  let html = '';
  if (forSpec.length) {
    html += `<div class="section-label">${esc(state.surgery)} — ${forSpec.length} doctor${forSpec.length === 1 ? '' : 's'}</div>`;
    html += forSpec.sort(byExperience).map((d) => doctorCard(d, true)).join('');
  } else {
    html += `<div class="empty"><strong>No doctor for ${esc(state.surgery)} is listed at this hospital.</strong>
             <p>The hospital is on the panel for this speciality, so the roster may be incomplete or the doctor may be visiting.
             ${others.length ? 'Other specialities at this hospital are listed below.' : ''}</p></div>`;
  }

  if (others.length) {
    html += `<div class="section-label">Other specialities here — ${others.length} doctor${others.length === 1 ? '' : 's'}</div>`;
    html += others.sort((a, b) => (a.speciality || '').localeCompare(b.speciality || '') || byExperience(a, b))
      .map((d) => doctorCard(d, false)).join('');
  }

  if (h.mapUrl) {
    html += `<p class="foot"><a href="${esc(h.mapUrl)}" target="_blank" rel="noopener">Open in Google Maps →</a></p>`;
  }
  $('detailBody').innerHTML = html;
}

const byExperience = (a, b) => (b.experienceYears ?? -1) - (a.experienceYears ?? -1);

function doctorCard(d, primary) {
  const type = d.type && d.type !== 'NA' ? d.type : '';
  return `
  <div class="doc">
    <div class="doc-top">
      <span class="doc-name">${esc(d.name)}</span>
      <span class="doc-tag${primary ? '' : ' alt'}">${esc(d.speciality || '—')}</span>
      ${d.experienceYears ? `<span class="doc-exp">${d.experienceYears} yrs experience</span>` : ''}
    </div>
    ${d.qualification ? `<div class="doc-qual">${esc(d.qualification)}</div>` : ''}
    ${(d.schedule || type) ? `<div class="doc-sched">${d.schedule ? `🕐 ${esc(d.schedule)}` : ''}${d.schedule && type ? ' · ' : ''}${type ? esc(type) : ''}</div>` : ''}
  </div>`;
}

/* ── view switching ───────────────────────────────────────────────────── */

function show(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.id === id));
  if (id !== 'detailView') window.scrollTo({ top: 0, behavior: 'instant' });
}
