/**
 * Shared normalisation for every data source (Google Sheet, local CSV, sample).
 * Whatever comes in, the same shape goes out — so the app can't tell them apart.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CFG = JSON.parse(readFileSync(join(ROOT, 'tools', 'config.json'), 'utf8'));
const INS = JSON.parse(readFileSync(join(ROOT, 'tools', 'insurers.json'), 'utf8'));

export const warn = (...a) => console.warn('  !', ...a);
export const die = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };

/* ── insurer canonicalisation ─────────────────────────────────────────── */

const insKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const INS_MAP = new Map();
for (const [canonical, variants] of Object.entries(INS)) {
  if (canonical.startsWith('_')) continue;
  for (const v of variants) INS_MAP.set(insKey(v), canonical);
}
const INS_DROP = new Set(INS._drop.values.map(insKey));
const INS_MAXLEN = INS._drop.dropLongerThanChars;

export const unmappedInsurers = new Map();

export function canonInsurer(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > INS_MAXLEN) return null;
  const k = insKey(s);
  if (!k || INS_DROP.has(k)) return null;
  const hit = INS_MAP.get(k);
  if (hit) return hit;
  unmappedInsurers.set(s, (unmappedInsurers.get(s) || 0) + 1);
  return s; // keep it, but report it so the map can be extended
}

/* ── generic helpers ──────────────────────────────────────────────────── */

export const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
export const cell = (row, i) => (i === undefined ? '' : String(row[i] ?? '').trim());
export const num = (v) => {
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const splitList = (v) =>
  String(v || '').split(CFG.listSeparator).map((s) => s.trim()).filter(Boolean);

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

/* ── builders ─────────────────────────────────────────────────────────── */

/** incoming/Hosp_Overrides.tsv — patch a field on one hospital without waiting for a sheet sync.
 *  Columns: Hospital_Code, Field, Value. Applied after column mapping, before parsing. */
function loadOverrides() {
  const p = join(ROOT, 'incoming', 'Hosp_Overrides.tsv');
  if (!existsSync(p)) return new Map();
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  const head = lines[0].split('\t').map((h) => h.trim());
  const [iC, iF, iV] = ['Hospital_Code', 'Field', 'Value'].map((n) => head.indexOf(n));
  if ([iC, iF, iV].some((i) => i < 0)) { warn('Hosp_Overrides.tsv needs Hospital_Code, Field, Value'); return new Map(); }
  const m = new Map();
  for (const l of lines.slice(1)) {
    const c = l.split('\t');
    const code = (c[iC] || '').trim();
    if (!code) continue;
    if (!m.has(code)) m.set(code, {});
    m.get(code)[norm(c[iF] || '')] = (c[iV] || '').trim();
  }
  return m;
}

export function buildHospitals(values) {
  const c = CFG.hospitals;
  const overrides = loadOverrides();
  let overridesHit = 0;
  const overrideCodesSeen = new Set();
  const idx = indexHeader(values[0], c.columns, c.tab);
  if (idx.code === undefined) die(`${c.tab}: no Hospital_Code column. Header: ${values[0].slice(0, 8).join(' | ')}`);

  const out = [], dropped = { inactive: 0, noCode: 0, duplicate: 0 };
  let noCoords = 0, noSpeciality = 0, noInsurer = 0;
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

    const ov = overrides.get(code);
    if (ov) overrideCodesSeen.add(code);
    const raw = (field, i) => {
      if (ov && ov[norm(field)] !== undefined) { overridesHit++; return ov[norm(field)]; }
      return cell(row, i);
    };

    const specialities = splitList(raw('Speciality', idx.specialities));
    const insurers = [...new Set(splitList(raw('Short_Ins', idx.insurers)).map(canonInsurer).filter(Boolean))].sort();
    if (!specialities.length) noSpeciality++;
    if (!insurers.length) noInsurer++;

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
      score: +(Math.log10(1 + ipd) * 1.0 + Math.log10(1 + (reviews || 0)) * 0.5 * ((rating || 3.5) / 5)).toFixed(4),
      specialities,
      insurers,
      mapUrl: cell(row, idx.mapUrl) || (geo ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}` : ''),
    });
  }
  if (overrides.size) {
    console.log(`  overrides: ${overrideCodesSeen.size}/${overrides.size} hospitals patched (${overridesHit} field${overridesHit === 1 ? '' : 's'}) from incoming/Hosp_Overrides.tsv`);
    const missed = [...overrides.keys()].filter((k) => !overrideCodesSeen.has(k));
    // A code in the override file that never appears is silent data rot: someone
    // corrected a row that has since been renamed or deactivated upstream.
    if (missed.length) warn(`Hosp_Overrides.tsv has ${missed.length} Hospital_Code(s) not found among active rows: ${missed.join(', ')}`);
  }
  return { out, dropped, quality: { noCoords, noSpeciality, noInsurer, overrides: overrideCodesSeen.size } };
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

    out.push({
      code,
      hospitalCode,
      name: cell(row, idx.name) || 'Doctor',
      speciality: cell(row, idx.speciality),
      qualification: cell(row, idx.qualification),
      experienceYears: num(cell(row, idx.experienceYears)),
      schedule: cell(row, idx.schedule),
      type: cell(row, idx.type),
    });
  }
  return { out, dropped };
}

/* ── validate + write ─────────────────────────────────────────────────── */

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

/** Atomic JSON write: a crash mid-write can't leave a half-file the page will parse. */
export function writeJson(absPath, obj, pretty = false) {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(`${absPath}.tmp`, JSON.stringify(obj, null, pretty ? 2 : 0));
  renameSync(`${absPath}.tmp`, absPath);
}

export function writeAll(H, D, source) {
  const specialities = [...new Set(H.out.flatMap((h) => h.specialities))].sort();
  const insurers = [...new Set(H.out.flatMap((h) => h.insurers))].sort();
  const meta = {
    generatedAt: new Date().toISOString(),
    source,
    hospitalCount: H.out.length,
    doctorCount: D.out.length,
    cityCount: new Set(H.out.map((h) => h.city).filter(Boolean)).size,
    specialities,
    insurers,
    quality: { ...H.quality, droppedHospitals: H.dropped, droppedDoctors: D.dropped },
  };
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const atomic = (f, o) => {
    const p = join(ROOT, 'data', f);
    writeFileSync(`${p}.tmp`, JSON.stringify(o));
    renameSync(`${p}.tmp`, p);
  };
  atomic('hospitals.json', H.out);
  atomic('doctors.json', D.out);
  writeFileSync(join(ROOT, 'data', 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

export function report(H, D, meta) {
  console.log(`\nhospitals  kept ${H.out.length.toString().padStart(5)}   dropped ${JSON.stringify(H.dropped)}`);
  console.log(`doctors    kept ${D.out.length.toString().padStart(5)}   dropped ${JSON.stringify(D.dropped)}`);
  console.log(`quality    no coords ${H.quality.noCoords} · no speciality ${H.quality.noSpeciality} · no insurer ${H.quality.noInsurer}`);
  console.log(`taxonomy   ${meta.specialities.length} specialities · ${meta.insurers.length} insurers · ${meta.cityCount} cities`);
  if (unmappedInsurers.size) {
    console.log(`\n  ${unmappedInsurers.size} insurer spellings are not in tools/insurers.json (kept as-is):`);
    [...unmappedInsurers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
      .forEach(([s, n]) => console.log(`    ${String(n).padStart(4)}×  ${s}`));
  }
}
