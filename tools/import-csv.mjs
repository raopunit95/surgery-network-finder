#!/usr/bin/env node
/**
 * Local CSV  ->  data/*.json     (the manual refresh path)
 *
 *   1. In the Google Sheet: File → Download → Comma-separated values, for each tab
 *   2. Save them as incoming/Bot_Hosp.csv and incoming/Bot_Doc.csv
 *   3. npm run import
 *
 * No auth, no network, no npm dependencies.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, CFG, parseCsv, buildHospitals, buildDoctors, validate, writeAll, report, die } from './lib.mjs';

const DRY = process.argv.includes('--dry-run');
const read = (tab) => {
  const p = join(ROOT, 'incoming', `${tab}.csv`);
  if (!existsSync(p)) die(`missing ${p}\n  Export the "${tab}" tab as CSV and save it there.`);
  return parseCsv(readFileSync(p, 'utf8'));
};

const H = buildHospitals(read(CFG.hospitals.tab));
const D = buildDoctors(read(CFG.doctors.tab), new Set(H.out.map((h) => h.code)));

const errs = validate(H, D);
if (errs.length) {
  console.error('\n✗ validation failed — data/ left untouched:');
  errs.forEach((e) => console.error(`   • ${e}`));
  process.exit(1);
}

if (DRY) { report(H, D, { specialities: [], insurers: [], cityCount: 0 }); console.log('\ndry run — nothing written'); process.exit(0); }

const meta = writeAll(H, D, 'sheet-csv');
report(H, D, meta);
console.log(`\n✓ wrote data/hospitals.json · data/doctors.json · data/meta.json`);
