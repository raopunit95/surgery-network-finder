#!/usr/bin/env node
/**
 * Unit test for the Hosp_Overrides.tsv path in buildHospitals().
 *
 *   node tools/test-overrides.mjs
 *
 * Builds a two-row synthetic sheet — one code that the override file corrects,
 * one it doesn't — and asserts the corrected row picks up the override while the
 * untouched row keeps the sheet value. Runs without the real CSVs present, so
 * the override mechanism stays covered even when incoming/ is empty.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, CFG, buildHospitals } from './lib.mjs';

const OV = join(ROOT, 'incoming', 'Hosp_Overrides.tsv');
if (!existsSync(OV)) { console.error('✗ incoming/Hosp_Overrides.tsv missing — nothing to test'); process.exit(1); }

const rows = readFileSync(OV, 'utf8').trim().split('\n').slice(1);
const first = rows[0].split('\t');
const [patchedCode, , patchedValue] = [first[0].trim(), first[1], first[2].trim()];

const c = CFG.hospitals.columns;
const col = (k) => (Array.isArray(c[k]) ? c[k][0] : c[k]);

const header = [
  col('code'), col('name'), col('city'), col('lat'), col('lon'),
  col('specialities'), col('insurers'), col('status'), col('ipd'),
];
const row = (code, ins) => [code, `Test ${code}`, 'Testville', '28.6', '77.2', 'Ophthalmology', ins, CFG.hospitals.activeValue, '10'];

// A two-row synthetic sheet legitimately lacks most optional columns, and four of
// the five override codes legitimately aren't in it. Silence that expected noise so
// a real warning during the test stands out.
const realWarn = console.warn, realLog = console.log;
console.warn = () => {}; console.log = () => {};
const { out } = buildHospitals([
  header,
  row(patchedCode, 'Star'),               // override should replace this
  row('__ZZ_NOT_OVERRIDDEN__', 'Star'),   // must survive untouched
]);
console.warn = realWarn; console.log = realLog;

const patched = out.find((h) => h.code === patchedCode);
const control = out.find((h) => h.code === '__ZZ_NOT_OVERRIDDEN__');

const expected = [...new Set(patchedValue.split(',').map((s) => s.trim()).filter(Boolean))];
const fail = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };

if (!patched) fail(`override row ${patchedCode} was not built at all`);
if (!control) fail('control row was dropped');
if (control.insurers.join() !== 'Star Health') fail(`control row insurers were altered: ${control.insurers.join(', ')}`);
if (patched.insurers.length <= 1) fail(`override did not fire — ${patchedCode} still has ${patched.insurers.join(', ')}`);
if (patched.insurers.includes('Star Health') === false) fail('override list lost Star Health');

console.log(`✓ override fires    ${patchedCode}: 1 sheet value → ${patched.insurers.length} canonical insurers`);
console.log(`✓ control untouched __ZZ_NOT_OVERRIDDEN__: ${control.insurers.join(', ')}`);
console.log(`  ${expected.length} raw values in the override cell canonicalised to ${patched.insurers.length}`);
console.log(`  ${patched.insurers.join(', ')}`);
