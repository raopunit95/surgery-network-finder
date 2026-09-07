/**
 * Shared normalisation for every data source (workbook, CSV, Google Sheet, sample).
 * Whatever comes in, the same shape goes out — so the app cannot tell them apart.
 *
 * This file owns three things: reading a source into records, canonicalising the
 * values inside them, and writing the compact JSON the browser fetches. The
 * department vocabulary is not here — that is taxonomy.mjs.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTaxonomyConfig, canonSpeciality, canonSpecialityList } from './taxonomy.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CFG = JSON.parse(readFileSync(join(ROOT, 'tools', 'config.json'), 'utf8'));
const INS = JSON.parse(readFileSync(join(ROOT, 'tools', 'insurers.json'), 'utf8'));

loadTaxonomyConfig(ROOT);

export const warn = (...a) => console.warn('  !', ...a);
export const die = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };

/** Hospital detail — the doctor roster, the street address and the map link — is
 *  stored this many hospital codes to a file under data/detail/. Opening one
 *  hospital fetches one shard, about 12 KB, instead of the whole 800 KB roster.
 *
 *  Address and map link live here rather than in hospitals.json because only the
 *  detail view reads them, and together they were 86 KB of a file every search
 *  downloads before showing anything.
 *
 *  app.js recomputes this shard rule, so the two must agree — `npm test` asserts it. */
export const DETAIL_SHARD = 25;

/** Hospital codes in this inventory are integers, and dividing keeps neighbouring
 *  codes in one file — so "hospital 374 is in shard 14" can be checked by hand,
 *  which matters when a shard is missing. A non-numeric code falls back to a
 *  character-sum bucket rather than a single catch-all file, because a catch-all
 *  would put an entire alternative code scheme in one shard and quietly undo the
 *  whole point. */
export const detailShard = (hospitalCode) => {
  const code = String(hospitalCode);
  if (/^\d+$/.test(code)) return String(Math.floor(+code / DETAIL_SHARD));
  let n = 0;
  for (let i = 0; i < code.length; i++) n = (n * 31 + code.charCodeAt(i)) % 32;
  return `x${n}`;
};

/* ── insurer canonicalisation ─────────────────────────────────────────────── */

const insKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const INS_MAP = new Map();
for (const [canonical, variants] of Object.entries(INS)) {
  if (canonical.startsWith('_')) continue;
  // The canonical name is an alias of itself, so canonicalising twice is a no-op.
  // Without this, a cell reading exactly "SBI General" fell through as unmapped,
  // because the alias list only carried "sbi" and the long legal name.
  INS_MAP.set(insKey(canonical), canonical);
  for (const v of variants) INS_MAP.set(insKey(v), canonical);
}
const INS_DROP = new Set(INS._drop.values.map(insKey));

export const unmappedInsurers = new Map();

export function canonInsurer(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > INS._drop.dropLongerThanChars) return null;
  const k = insKey(s);
  if (!k || INS_DROP.has(k)) return null;
  const hit = INS_MAP.get(k);
  if (hit) return hit;
  unmappedInsurers.set(s, (unmappedInsurers.get(s) || 0) + 1);
  return s; // keep it, but report it so the map can be extended
}

/* ── generic helpers ──────────────────────────────────────────────────────── */

export const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
export const cell = (row, i) => (i === undefined ? '' : String(row[i] ?? '').trim());
export const num = (v) => {
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

export function parseCsv(text) {
  const rows = [];
  let row = [], c = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { c += '"'; i++; }
      else if (ch === '"') q = false;
      else c += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(c); c = ''; }
    else if (ch === '\n') { row.push(c); rows.push(row); row = []; c = ''; }
    else if (ch !== '\r') c += ch;
  }
  if (c || row.length) { row.push(c); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

export function readTsv(file) {
  if (!existsSync(file)) die(`missing ${file}`);
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  const head = lines[0].split('\t').map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const c = l.split('\t');
    return Object.fromEntries(head.map((h, i) => [h, (c[i] ?? '').trim()]));
  });
}

function indexHeader(header, columns, label) {
  const lookup = new Map(header.map((h, i) => [norm(h), i]));
  const idx = {};
  for (const [field, aliases] of Object.entries(columns)) {
    const hit = aliases.map(norm).find((a) => lookup.has(a));
    if (hit === undefined) warn(`${label}: no column for "${field}" (tried ${aliases.join(', ')})`);
    else idx[field] = lookup.get(hit);
  }
  return idx;
}

/* ── builders ─────────────────────────────────────────────────────────────── */

/** Bot_Hosp rows → the hospital records the UI renders. The inventory is the only
 *  source: there is no patch layer, so a wrong value gets fixed in the workbook.
 *  What would otherwise fail silently is reported by code in `quality`. */
export function buildHospitals(values) {
  const c = CFG.hospitals;
  const idx = indexHeader(values[0], c.columns, c.tab);
  if (idx.code === undefined) die(`${c.tab}: no Hospital_Code column. Header: ${values[0].slice(0, 8).join(' | ')}`);

  const out = [], dropped = { inactive: 0, noCode: 0, duplicate: 0 };
  let noCoords = 0;
  const blankSpeciality = [], blankInsurer = [];
  const seen = new Set();

  for (const row of values.slice(1)) {
    const code = cell(row, idx.code);
    if (!code) { dropped.noCode++; continue; }
    if (idx.status !== undefined && norm(cell(row, idx.status)) !== norm(c.activeValue)) { dropped.inactive++; continue; }
    if (seen.has(code)) { dropped.duplicate++; continue; }
    seen.add(code);

    const lat = num(cell(row, idx.lat)), lon = num(cell(row, idx.lon));
    const geo = lat !== null && lon !== null && lat >= 6 && lat <= 38 && lon >= 68 && lon <= 98;
    if (!geo) noCoords++;

    const specialities = canonSpecialityList(cell(row, idx.specialities), CFG.listSeparator);
    const insurers = [...new Set(
      cell(row, idx.insurers).split(CFG.listSeparator).map(canonInsurer).filter(Boolean)
    )].sort();
    // Tracked by code, not just counted. A hospital with no insurer can never be
    // found with an insurer selected, and a hospital with no speciality can never
    // be found at all — both are invisible failures unless something names them.
    if (!specialities.length) blankSpeciality.push(code);
    if (!insurers.length) blankInsurer.push(code);

    const name = cell(row, idx.name) || code;
    const rating = num(cell(row, idx.rating));
    const reviews = num(cell(row, idx.reviews));
    const ipd = num(cell(row, idx.ipd)) ?? 0;

    out.push({
      code,
      name,
      nameShort: cell(row, idx.nameShort) || name,
      city: cell(row, idx.city),
      locality: cell(row, idx.locality),
      state: cell(row, idx.state),
      address: cell(row, idx.address),
      pincode: cell(row, idx.pincode).replace(/\D/g, '').slice(0, 6) || null,
      lat: geo ? +lat.toFixed(5) : null,
      lon: geo ? +lon.toFixed(5) : null,
      ipd,
      rating: rating !== null && rating > 0 && rating <= 5 ? +rating.toFixed(1) : null,
      reviews: reviews !== null && reviews >= 0 ? reviews : null,
      // Volume-and-reputation score, log-damped so a 5,000-review hospital
      // doesn't bury a good one with 200. Used to rank within a distance band.
      score: +(Math.log10(1 + ipd) + Math.log10(1 + (reviews || 0)) * 0.5 * ((rating || 3.5) / 5)).toFixed(4),
      specialities,
      insurers,
      mapUrl: cell(row, idx.mapUrl),
    });
  }
  return {
    out, dropped,
    quality: {
      noCoords,
      noSpeciality: blankSpeciality.length,
      noInsurer: blankInsurer.length,
      blankSpecialityCodes: blankSpeciality,
      blankInsurerCodes: blankInsurer,
    },
  };
}

export function buildDoctors(values, hospitalCodes) {
  const c = CFG.doctors;
  const idx = indexHeader(values[0], c.columns, c.tab);
  if (idx.hospitalCode === undefined) die(`${c.tab}: no Hospital_Code column. Header: ${values[0].slice(0, 8).join(' | ')}`);

  const out = [], dropped = { inactive: 0, noHospital: 0, orphan: 0, duplicate: 0 };
  const seen = new Set();

  for (const row of values.slice(1)) {
    const hospitalCode = cell(row, idx.hospitalCode);
    if (!hospitalCode) { dropped.noHospital++; continue; }
    if (idx.status !== undefined && norm(cell(row, idx.status)) !== norm(c.activeValue)) { dropped.inactive++; continue; }
    if (!hospitalCodes.has(hospitalCode)) { dropped.orphan++; continue; }

    const code = cell(row, idx.code) || `${hospitalCode}-${out.length}`;
    if (seen.has(code)) { dropped.duplicate++; continue; }
    seen.add(code);

    // A doctor gets the same canonicalisation as a hospital, so a "NEPHROLOGY"
    // doctor is shown for a surgery that searches "Nephrology". Before this, the
    // hospital matched and its own doctor did not.
    const [speciality = ''] = canonSpeciality(cell(row, idx.speciality));

    out.push({
      code,
      hospitalCode,
      name: cell(row, idx.name) || 'Doctor',
      speciality,
      qualification: cell(row, idx.qualification),
      experienceYears: num(cell(row, idx.experienceYears)),
      schedule: cell(row, idx.schedule),
      type: cell(row, idx.type),
    });
  }
  return { out, dropped };
}

/* ── validate ─────────────────────────────────────────────────────────────── */

export function validate(H, D) {
  const v = CFG.validation;
  const totalDoc = D.out.length + D.dropped.orphan;
  const noCoordRatio = H.quality.noCoords / Math.max(H.out.length, 1);
  const orphanRatio = D.dropped.orphan / Math.max(totalDoc, 1);
  const errs = [];
  if (H.out.length < v.minHospitals) errs.push(`only ${H.out.length} hospitals (min ${v.minHospitals})`);
  if (D.out.length < v.minDoctors) errs.push(`only ${D.out.length} doctors (min ${v.minDoctors})`);
  if (noCoordRatio > v.maxMissingCoordRatio)
    errs.push(`${(noCoordRatio * 100).toFixed(1)}% of hospitals lack usable coordinates (max ${v.maxMissingCoordRatio * 100}%)`);
  if (orphanRatio > v.maxOrphanDoctorRatio)
    errs.push(`${(orphanRatio * 100).toFixed(1)}% of doctors reference an unknown Hospital_Code (max ${v.maxOrphanDoctorRatio * 100}%)`);
  return errs;
}

/* ── write ────────────────────────────────────────────────────────────────── */

/** Indented, but with arrays of plain values kept on one line. Standard
 *  JSON.stringify(obj, null, 2) puts every element of every array on its own
 *  line, which turned the taxonomy audit into half a megabyte of one-number
 *  lines — technically readable, actually unreadable. */
/** A small recursive pretty-printer: indented like JSON.stringify(obj, null, 2),
 *  except that an array of plain values stays on one line. The standard form put
 *  every element of every array on its own line, which turned the taxonomy audit
 *  into half a megabyte of one-number lines — technically readable, in practice not. */
function readableJson(value, indent = '') {
  const pad = `${indent}  `;
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every((v) => v === null || typeof v !== 'object')) return JSON.stringify(value);
    return `[\n${value.map((v) => pad + readableJson(v, pad)).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    if (!keys.length) return '{}';
    return `{\n${keys.map((k) => `${pad}${JSON.stringify(k)}: ${readableJson(value[k], pad)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Atomic write: a crash mid-write cannot leave a half-file the page will parse. */
export function writeJson(absPath, obj, pretty = false) {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(`${absPath}.tmp`, pretty ? readableJson(obj) : JSON.stringify(obj));
  renameSync(`${absPath}.tmp`, absPath);
}

/**
 * hospitals.json — the search index. Every hospital, and only the fields needed
 * to filter, rank and draw a result card. 546 KB → 90 KB.
 *
 * Four things do the work:
 *
 *   1. Rows of values under a `cols` header, instead of 650 copies of the keys.
 *   2. A dictionary for city, state and speciality — the fields that repeat.
 *   3. Insurers as a bitmask over the sorted insurer dictionary. This was over
 *      half the original file: 36 names, spelled out 650 times. A hospital
 *      carries a median of 31 of the 36, so a list of indexes barely helps —
 *      nine hex characters carry the same information.
 *   4. Address and map link are not here at all. They are detail-view fields, and
 *      they were 86 KB that every search paid for before drawing anything.
 *
 * `name` is stored empty when it is exactly `short_city_locality`, which it is
 * for 619 of 650 rows; the page rebuilds it.
 *
 * The page reads `cols` to find its columns rather than hard-coding positions, so
 * adding a field here cannot silently shift every value by one.
 */
export const HOSPITAL_COLS =
  'code,name,short,city,locality,state,pin,lat,lon,ipd,rating,reviews,score,spec,ins';

/** Bit i of the mask is set when the hospital takes dict.ins[i]. Stored low bit
 *  first within each hex digit, which is what app.js `hasInsurer` decodes. */
function insurerMask(insurers, indexOf) {
  const nibbles = [];
  for (const name of insurers) {
    const i = indexOf.get(name);
    if (i === undefined) continue;
    nibbles[i >> 2] = (nibbles[i >> 2] ?? 0) | (1 << (i & 3));
  }
  const width = Math.ceil(indexOf.size / 4);
  let out = '';
  for (let n = 0; n < width; n++) out += (nibbles[n] ?? 0).toString(16);
  return out.replace(/0+$/, '');            // trailing empty nibbles carry nothing
}

function packHospitals(list) {
  const dict = { city: [], state: [], spec: [], ins: [] };
  const seen = { city: new Map(), state: new Map(), spec: new Map(), ins: new Map() };
  const id = (kind, value) => {
    if (!value) return -1;
    if (!seen[kind].has(value)) { seen[kind].set(value, dict[kind].length); dict[kind].push(value); }
    return seen[kind].get(value);
  };
  // Build the speciality and insurer dictionaries in sorted order first, so the
  // page can show `dict.ins` as the insurer picker without re-sorting.
  [...new Set(list.flatMap((h) => h.specialities))].sort().forEach((s) => id('spec', s));
  [...new Set(list.flatMap((h) => h.insurers))].sort().forEach((s) => id('ins', s));

  const rows = list.map((h) => [
    h.code,
    h.name === [h.nameShort, h.city, h.locality].join('_') ? '' : h.name,
    h.nameShort,
    id('city', h.city),
    h.locality,
    id('state', h.state),
    h.pincode ?? '',
    h.lat,
    h.lon,
    h.ipd,
    h.rating,
    h.reviews,
    h.score,
    h.specialities.map((s) => id('spec', s)),
    insurerMask(h.insurers, seen.ins),
  ]);
  return { v: 2, cols: HOSPITAL_COLS, dict, rows };
}

/** The inverse of packHospitals, for the tools that read what was shipped.
 *  app.js necessarily carries its own copy of this — it has no imports — so
 *  `npm test` compares what the browser decodes against what this returns. */
export function unpackHospitals(packed) {
  const at = {};
  packed.cols.split(',').forEach((k, i) => { at[k] = i; });
  const { city, state, spec, ins } = packed.dict;
  return packed.rows.map((r) => {
    const nameShort = r[at.short], cityName = city[r[at.city]] ?? '', locality = r[at.locality];
    const mask = r[at.ins] || '';
    return {
      code: r[at.code],
      name: r[at.name] || [nameShort, cityName, locality].join('_'),
      nameShort,
      city: cityName,
      locality,
      state: state[r[at.state]] ?? '',
      pincode: r[at.pin] || null,
      lat: r[at.lat],
      lon: r[at.lon],
      ipd: r[at.ipd],
      rating: r[at.rating],
      reviews: r[at.reviews],
      score: r[at.score],
      specialities: r[at.spec].map((i) => spec[i]),
      insurers: ins.filter((_, i) => ((parseInt(mask[i >> 2] || '0', 16) >> (i & 3)) & 1) === 1),
    };
  });
}

/** Hospital detail, split into files of DETAIL_SHARD hospital codes.
 *
 *    { v: 2, byHospital: { "12": { addr, map, doctors: [ … ] } } }
 *
 *  Every hospital gets an entry, including the ones with no doctors listed —
 *  otherwise a hospital that is on the panel but has an empty roster would also
 *  lose its address, and the detail page would show a blank where the reason for
 *  the blank is "no doctors", not "no hospital".
 *
 *  Records are left plain rather than packed: a shard is ~12 KB, so compressing
 *  it further would trade readability for nothing anyone can measure. A doctor's
 *  own code and hospital code are dropped — the key already carries the second
 *  and nothing displays the first. */
function packDetail(hospitals, doctors) {
  const shards = new Map();
  const entry = (code) => {
    const s = detailShard(code);
    if (!shards.has(s)) shards.set(s, {});
    return (shards.get(s)[code] ??= { addr: '', map: '', doctors: [] });
  };
  for (const h of hospitals) {
    const e = entry(h.code);
    e.addr = h.address;
    e.map = h.mapUrl;
  }
  for (const d of doctors) {
    entry(d.hospitalCode).doctors.push({
      name: d.name,
      speciality: d.speciality,
      qualification: d.qualification,
      experienceYears: d.experienceYears,
      schedule: d.schedule,
      type: d.type && d.type !== 'NA' ? d.type : '',
    });
  }
  return shards;
}

export function writeAll(H, D, source, taxonomy = null) {
  const packed = packHospitals(H.out);
  const shards = packDetail(H.out, D.out);

  const meta = {
    generatedAt: new Date().toISOString(),
    source,
    format: 2,
    detailShard: DETAIL_SHARD,
    hospitalCount: H.out.length,
    doctorCount: D.out.length,
    cityCount: new Set(H.out.map((h) => h.city).filter(Boolean)).size,
    specialities: packed.dict.spec,
    insurers: packed.dict.ins,
    quality: { ...H.quality, droppedHospitals: H.dropped, droppedDoctors: D.dropped },
  };
  if (taxonomy) {
    meta.taxonomy = {
      surgeries: taxonomy.surgeries.length,
      departments: taxonomy.departments.length,
      autoMapped: taxonomy.auto.applied.length,
      awaitingReview: taxonomy.auto.suggested.length,
    };
  }

  writeJson(join(ROOT, 'data', 'hospitals.json'), packed);

  // Rewrite the shard directory from scratch. A hospital that leaves the
  // inventory must lose its doctors, and a left-behind shard would keep serving
  // them long after the search stopped returning the hospital.
  const dir = join(ROOT, 'data', 'detail');
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(ROOT, 'data', 'doctors'), { recursive: true, force: true });   // format 1 leftovers
  rmSync(join(ROOT, 'data', 'doctors.json'), { force: true });
  for (const [name, byHospital] of shards) writeJson(join(dir, `${name}.json`), { v: 2, byHospital });

  writeJson(join(ROOT, 'data', 'meta.json'), meta, true);
  return { meta, shardCount: shards.size };
}

export function report(H, D, meta) {
  console.log(`\nhospitals  kept ${String(H.out.length).padStart(5)}   dropped ${JSON.stringify(H.dropped)}`);
  console.log(`doctors    kept ${String(D.out.length).padStart(5)}   dropped ${JSON.stringify(D.dropped)}`);
  console.log(`quality    no coords ${H.quality.noCoords} · no speciality ${H.quality.noSpeciality} · no insurer ${H.quality.noInsurer}`);
  console.log(`taxonomy   ${meta.specialities.length} specialities · ${meta.insurers.length} insurers · ${meta.cityCount} cities`);
  if (unmappedInsurers.size) {
    console.log(`\n  ${unmappedInsurers.size} insurer spellings are not in tools/insurers.json (kept as-is):`);
    [...unmappedInsurers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
      .forEach(([s, n]) => console.log(`    ${String(n).padStart(4)}×  ${s}`));
  }
}
