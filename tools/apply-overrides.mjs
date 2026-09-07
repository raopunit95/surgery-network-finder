#!/usr/bin/env node
/**
 * Apply incoming/Hosp_Overrides.tsv to an ALREADY-BUILT data/hospitals.json.
 *
 *   node tools/apply-overrides.mjs
 *
 * Normally you don't need this: `npm run import` and `npm run sync` read the
 * override file themselves. This exists for the case where you have the built
 * JSON but not the source CSVs — it patches in place using the same
 * canonicalisation, so the result is byte-identical to a fresh import.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, CFG, canonInsurer, norm, die, writeJson } from './lib.mjs';

const p = (...x) => join(ROOT, ...x);
const H = JSON.parse(readFileSync(p('data', 'hospitals.json'), 'utf8'));
const byCode = new Map(H.map((h) => [h.code, h]));

const lines = readFileSync(p('incoming', 'Hosp_Overrides.tsv'), 'utf8').trim().split('\n');
const head = lines[0].split('\t').map((s) => s.trim());
const [iC, iF, iV] = ['Hospital_Code', 'Field', 'Value'].map((n) => head.indexOf(n));
if ([iC, iF, iV].some((i) => i < 0)) die('Hosp_Overrides.tsv needs Hospital_Code, Field, Value');

const sep = CFG.listSeparator;
const split = (v) => String(v || '').split(sep).map((s) => s.trim()).filter(Boolean);

let patched = 0;
const missing = [];

for (const l of lines.slice(1)) {
  const c = l.split('\t');
  const code = (c[iC] || '').trim();
  const field = norm(c[iF] || '');
  const value = (c[iV] || '').trim();
  if (!code) continue;

  const h = byCode.get(code);
  if (!h) { missing.push(code); continue; }

  if (field === norm('Short_Ins')) {
    const before = h.insurers.length;
    h.insurers = [...new Set(split(value).map(canonInsurer).filter(Boolean))].sort();
    console.log(`  ${code}  ${h.name}`);
    console.log(`         insurers ${before} → ${h.insurers.length}`);
    patched++;
  } else if (field === norm('Speciality')) {
    h.specialities = split(value);
    console.log(`  ${code}  ${h.name}  specialities → ${h.specialities.length}`);
    patched++;
  } else {
    console.warn(`  ! ${code}: unsupported override field "${c[iF]}" — skipped`);
  }
}

if (missing.length) console.warn(`\n  ! Hospital_Code(s) not in data/hospitals.json: ${missing.join(', ')}`);
if (!patched) die('nothing patched — data/hospitals.json is unchanged');

writeJson(p('data', 'hospitals.json'), H);
console.log(`\npatched ${patched} hospital${patched === 1 ? '' : 's'} → data/hospitals.json`);
