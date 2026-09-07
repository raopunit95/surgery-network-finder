#!/usr/bin/env node
/**
 * Google Sheet  ->  data/hospitals.json + data/doctors.json + data/meta.json
 *
 *   node tools/sync.mjs            # fetch, validate, write
 *   node tools/sync.mjs --dry-run  # fetch and validate, write nothing
 *
 * Auth, in order of preference:
 *   1. GOOGLE_SERVICE_ACCOUNT_JSON  — the whole service-account key as one env var.
 *      Share the sheet with the service account's client_email as Viewer.
 *      Required for a private sheet.
 *   2. SHEET_CSV_HOSP / SHEET_CSV_DOC — "publish to web" CSV URLs.
 *      Only for a sheet you are happy to have publicly readable.
 *
 * Zero npm dependencies: JWT signing uses node:crypto.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSign } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = JSON.parse(readFileSync(join(ROOT, 'tools', 'config.json'), 'utf8'));
const DRY = process.argv.includes('--dry-run');

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('  !', ...a);
const die = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };

/* ── auth ─────────────────────────────────────────────────────────────── */

async function accessToken(saJson) {
  const sa = JSON.parse(saJson);
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claim = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })}`;
  const sig = createSign('RSA-SHA256').update(claim).sign(sa.private_key, 'base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${claim}.${sig}`,
    }),
  });
  if (!res.ok) die(`token exchange failed (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

/* ── fetching ─────────────────────────────────────────────────────────── */

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

async function fetchTab(tab, csvUrlEnv, token) {
  if (token) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}/values/${encodeURIComponent(tab)}?majorDimension=ROWS`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) die(`sheets api ${res.status} for tab "${tab}": ${await res.text()}`);
    const values = (await res.json()).values || [];
    if (!values.length) die(`tab "${tab}" is empty`);
    return values;
  }
  const url = process.env[csvUrlEnv];
  if (!url) die(`no auth: set GOOGLE_SERVICE_ACCOUNT_JSON, or ${csvUrlEnv} for a published sheet`);
  const res = await fetch(url);
  if (!res.ok) die(`csv fetch ${res.status} for ${csvUrlEnv}`);
  return parseCsv(await res.text());
}

/* ── normalising ──────────────────────────────────────────────────────── */

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');

function indexHeader(header, columns) {
  const lookup = new Map(header.map((h, i) => [norm(h), i]));
  const idx = {}, missing = [];
  for (const [field, aliases] of Object.entries(columns)) {
    const hit = aliases.map(norm).find((a) => lookup.has(a));
    if (hit === undefined) missing.push(`${field} (tried: ${aliases.join(', ')})`);
    else idx[field] = lookup.get(hit);
  }
  return { idx, missing };
}

const cell = (row, i) => (i === undefined ? '' : String(row[i] ?? '').trim());
const splitList = (v) =>
  String(v || '')
    .split(CFG.listSeparator)
    .map((s) => s.trim())
    .filter(Boolean);
const num = (v) => {
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function buildHospitals(values) {
  const c = CFG.hospitals;
  const { idx, missing } = indexHeader(values[0], c.columns);
  if (idx.code === undefined) die(`Bot_Hosp: no Hospital_Code column. Header was: ${values[0].join(' | ')}`);
  missing.forEach((m) => warn(`Bot_Hosp missing column → ${m}`));

  const out = [], dropped = { inactive: 0, noCode: 0, noCoords: 0, duplicate: 0 };
  const seen = new Set();

  for (const row of values.slice(1)) {
    const code = cell(row, idx.code);
    if (!code) { dropped.noCode++; continue; }
    if (idx.status !== undefined && norm(cell(row, idx.status)) !== norm(c.activeValue)) { dropped.inactive++; continue; }
    if (seen.has(code)) { dropped.duplicate++; continue; }

    const lat = num(cell(row, idx.lat)), lon = num(cell(row, idx.lon));
    const inIndia = lat !== null && lon !== null && lat >= 6 && lat <= 38 && lon >= 68 && lon <= 98;
    if (!inIndia) dropped.noCoords++;

    seen.add(code);
    const name = cell(row, idx.name) || code;
    out.push({
      code,
      name,
      nameShort: cell(row, idx.nameShort) || name,
      city: cell(row, idx.city),
      locality: cell(row, idx.locality),
      address: cell(row, idx.address),
      lat: inIndia ? lat : null,
      lon: inIndia ? lon : null,
      ipd: num(cell(row, idx.ipd)) ?? 0,
      specialities: splitList(cell(row, idx.specialities)),
      insurers: splitList(cell(row, idx.insurers)),
      mapUrl: cell(row, idx.mapUrl) || (inIndia ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}` : ''),
    });
  }
  return { out, dropped };
}

function buildDoctors(values, hospitalCodes) {
  const c = CFG.doctors;
  const { idx, missing } = indexHeader(values[0], c.columns);
  if (idx.hospitalCode === undefined) die(`Bot_Doc: no Hospital_Code column. Header was: ${values[0].join(' | ')}`);
  missing.forEach((m) => warn(`Bot_Doc missing column → ${m}`));

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
    });
  }
  return { out, dropped };
}

/* ── run ──────────────────────────────────────────────────────────────── */

const sa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const token = sa ? await accessToken(sa) : null;
log(`auth: ${token ? 'service account' : 'published CSV'}`);

const hospValues = await fetchTab(CFG.hospitals.tab, 'SHEET_CSV_HOSP', token);
const docValues = await fetchTab(CFG.doctors.tab, 'SHEET_CSV_DOC', token);
log(`fetched: ${CFG.hospitals.tab} ${hospValues.length - 1} rows · ${CFG.doctors.tab} ${docValues.length - 1} rows`);

const H = buildHospitals(hospValues);
const D = buildDoctors(docValues, new Set(H.out.map((h) => h.code)));

log(`\nhospitals kept ${H.out.length}   dropped: ${JSON.stringify(H.dropped)}`);
log(`doctors   kept ${D.out.length}   dropped: ${JSON.stringify(D.dropped)}`);

/* validation — refuse to publish a broken snapshot */
const v = CFG.validation;
const totalDoc = D.out.length + D.dropped.orphan;
const noCoordRatio = H.out.filter((h) => h.lat === null).length / Math.max(H.out.length, 1);
const orphanRatio = D.dropped.orphan / Math.max(totalDoc, 1);
const errs = [];
if (H.out.length < v.minHospitals) errs.push(`only ${H.out.length} hospitals (min ${v.minHospitals})`);
if (D.out.length < v.minDoctors) errs.push(`only ${D.out.length} doctors (min ${v.minDoctors})`);
if (noCoordRatio > v.maxMissingCoordRatio) errs.push(`${(noCoordRatio * 100).toFixed(1)}% of hospitals have no usable coordinates (max ${v.maxMissingCoordRatio * 100}%)`);
if (orphanRatio > v.maxOrphanDoctorRatio) errs.push(`${(orphanRatio * 100).toFixed(1)}% of doctors point at an unknown Hospital_Code (max ${v.maxOrphanDoctorRatio * 100}%)`);

if (errs.length) {
  console.error('\n✗ validation failed — existing data left untouched:');
  errs.forEach((e) => console.error(`   • ${e}`));
  process.exit(1);
}
log('\n✓ validation passed');

const meta = {
  generatedAt: new Date().toISOString(),
  source: 'sheet',
  hospitalCount: H.out.length,
  doctorCount: D.out.length,
  droppedHospitals: H.dropped,
  droppedDoctors: D.dropped,
  specialities: [...new Set(H.out.flatMap((h) => h.specialities))].sort(),
  insurers: [...new Set(H.out.flatMap((h) => h.insurers))].sort(),
  cities: [...new Set(H.out.map((h) => h.city).filter(Boolean))].sort(),
};

if (DRY) { log('\ndry run — nothing written'); process.exit(0); }

mkdirSync(join(ROOT, 'data'), { recursive: true });
const atomic = (file, obj) => {
  const p = join(ROOT, 'data', file);
  writeFileSync(`${p}.tmp`, JSON.stringify(obj));
  renameSync(`${p}.tmp`, p);
};
atomic('hospitals.json', H.out);
atomic('doctors.json', D.out);
atomic('meta.json', meta);

log(`\nwrote data/hospitals.json · data/doctors.json · data/meta.json`);
log(`specialities ${meta.specialities.length} · insurers ${meta.insurers.length} · cities ${meta.cities.length}`);
