#!/usr/bin/env node
/**
 * Unit tests for the mapping engine.  `npm run test:map`
 *
 * The point of these is what the mapper must NOT do. It is allowed to restate a
 * rule you already wrote; it is not allowed to invent one. The loose first draft
 * of the modifier rule filed "Renal Transplant" under Aesthetic, because "Hair
 * Transplant" was the only mapped speciality containing the word "transplant" —
 * so that case is a test now, not a comment.
 *
 * Runs against synthetic sheets, not the inventory. It has to fail for a reason
 * in the code, not because this month's export happens to be clean.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTaxonomy, canonSpeciality, canonSpecialityList, loadTaxonomyConfig } from './taxonomy.mjs';
import { detailShard, DETAIL_SHARD } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadTaxonomyConfig(ROOT);

let pass = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  if (cond) pass++;
  else failures.push(`${label}${detail ? `\n      ${detail}` : ''}`);
};
const same = (label, actual, expected) =>
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `got      ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`);

/* ── canonicalisation ─────────────────────────────────────────────────────── */

same('a typo folds to the correct spelling', canonSpeciality('Dermataology'), ['Dermatology']);
same('the correct spelling is left alone', canonSpeciality('Dermatology'), ['Dermatology']);
same('shouting folds to title case', canonSpeciality('NEPHROLOGY'), ['Nephrology']);
same('an unknown value passes through untouched', canonSpeciality('Hepatology'), ['Hepatology']);
same('a compound cell splits', canonSpeciality('Hair Transplant & Dermataology'), ['Hair Transplant', 'Dermatology']);
same('a named unit is NOT split', canonSpeciality('IVF & Gynec'), ['IVF & Gynec']);
same('a whole cell splits and folds together',
  canonSpecialityList('OBG,Pediatrics and Neonatology,NEPHROLOGY').sort(),
  ['Neonatology', 'Nephrology', 'OBG', 'Pediatrics']);
same('an empty cell yields nothing', canonSpecialityList(''), []);

/* ── a small synthetic world ──────────────────────────────────────────────── */

const DEPT = [
  { Hospital_Speciality: 'OBG', Department_Name: 'Gynaecology' },
  { Hospital_Speciality: 'General Surgery', Department_Name: 'General Surgery' },
  { Hospital_Speciality: 'Nephrology', Department_Name: 'Nephrology' },
  { Hospital_Speciality: 'Medical Gastroenterology', Department_Name: 'Gastrointestinal' },
  { Hospital_Speciality: 'Hair Transplant', Department_Name: 'Aesthetic' },
  { Hospital_Speciality: 'Dermataology', Department_Name: 'Aesthetic' },
  { Hospital_Speciality: 'ENT', Department_Name: 'ENT' },
  { Hospital_Speciality: 'Urology', Department_Name: 'Urology' },
  { Hospital_Speciality: 'IVF & Gynec', Department_Name: 'Fertility|Gynaecology' },
];

const SUB = [
  { SubDepartment_Id: '1', UI_SubDepartment_Name: 'Piles', Department_Name: 'Proctology', Specialities: '' },
  { SubDepartment_Id: '2', UI_SubDepartment_Name: 'Botox', Department_Name: 'Aesthetic', Specialities: 'Dermataology' },
  { SubDepartment_Id: '3', UI_SubDepartment_Name: 'Peel', Department_Name: 'Aesthetic', Specialities: 'Dermatology' },
  { SubDepartment_Id: '4', UI_SubDepartment_Name: 'Delivery', Department_Name: 'Gynaecology', Specialities: '' },
  { SubDepartment_Id: '5', UI_SubDepartment_Name: 'IVF', Department_Name: 'Fertility', Specialities: '' },
  { SubDepartment_Id: '6', UI_SubDepartment_Name: 'Ghost', Department_Name: 'Aesthetic', Specialities: 'Trichology' },
];

/** hospitals from a list of [code, ...raw speciality cells] */
const world = (rows, docs = []) => buildTaxonomy({
  deptRows: DEPT,
  subRows: SUB,
  hospitals: rows.map(([code, ...cells]) => ({ code, specialities: cells.flatMap(canonSpeciality) })),
  doctors: docs.map(([hospitalCode, speciality]) => ({ hospitalCode, speciality: canonSpeciality(speciality)[0] ?? '' })),
});

const surgery = (T, name) => T.surgeries.find((s) => s.name === name);

/* ── the chain, end to end ────────────────────────────────────────────────── */

{
  const T = world([
    ['1', 'General Surgery'],
    ['2', 'OBG'],
    ['3', 'Dermataology'],
    ['4', 'IVF & Gynec'],
  ], [['1', 'General Surgery'], ['3', 'Dermatology']]);

  // Proctology has no hospital anywhere; the secondary department is what saves it.
  same('a surgery reaches its primary department', surgery(T, 'Delivery').specialities, ['IVF & Gynec', 'OBG']);
  same('a surgery falls through to its secondary department', surgery(T, 'Piles').specialities, ['General Surgery']);
  same('the secondary chain is recorded, not just used', surgery(T, 'Piles').secondary, ['General Surgery']);
  // Fertility's secondary is Gynaecology, so IVF widens to OBG as well. That is
  // the secondary rule doing its job, not over-matching: a fertility patient at a
  // hospital that files the unit under OBG is still at the right hospital.
  same('a surgery widens through its secondary', surgery(T, 'IVF').specialities, ['IVF & Gynec', 'OBG']);
  same('a multi-department row feeds both departments',
    [T.deptToSpecs.get('Fertility')?.has('IVF & Gynec'), T.deptToSpecs.get('Gynaecology')?.has('IVF & Gynec')],
    [true, true]);

  // The whole reason canonSpeciality exists: before it, a Specialities value had
  // to reproduce the inventory's typo exactly or the surgery matched nothing.
  same('an explicit speciality written with the typo resolves', surgery(T, 'Botox').specialities, ['Dermatology']);
  same('an explicit speciality written correctly resolves too', surgery(T, 'Peel').specialities, ['Dermatology']);
  ok('both spellings reach the same hospital',
    surgery(T, 'Botox').hospitalCodes.join() === '3' && surgery(T, 'Peel').hospitalCodes.join() === '3');

  // A named speciality no hospital lists is a typo or a gap, and must be said out
  // loud rather than silently narrowing the surgery to nothing.
  ok('a speciality no hospital lists is reported', T.issues.badOverride.some((b) => b.startsWith('Ghost:')));
  same('and that surgery is a named dead end', surgery(T, 'Ghost').specialities, []);
  ok('the dead end is listed', T.issues.deadEnds.some((d) => d.startsWith('Ghost ')));

  // "all the details": the surgery knows which hospitals and how many doctors.
  same('a surgery carries its hospital codes', surgery(T, 'Piles').hospitalCodes, ['1']);
  same('a surgery counts its doctors', surgery(T, 'Piles').doctorCount, 1);
  same('the flat speciality→department map is exposed',
    T.specialityToDepartments['General Surgery'], ['General Surgery']);
}

/* ── what the auto-mapper may do ──────────────────────────────────────────── */

{
  const T = world([
    ['1', 'Surgical Gastroenterology'],   // differs from a mapped one by a modifier
    ['2', 'AyurVaid ENT'],                // a brand in front of a mapped one
    ['3', 'Urology & Nephrology'],        // two mapped ones in one cell
    ['4', 'Gynaecology'],                 // the value is itself a department name
  ]);
  const got = Object.fromEntries(T.auto.applied.map((a) => [a.speciality, a.departments]));

  same('a modifier-only difference is applied', got['Surgical Gastroenterology'], ['Gastrointestinal']);
  same('a brand prefix is stripped', got['AyurVaid ENT'], ['ENT']);
  same('a conjunction is split', got['Urology & Nephrology'], ['Urology', 'Nephrology']);
  // Resolved before the auto-mapper is reached — every department name is seeded
  // as a speciality that maps to itself — so it is an exact hit, not a guess.
  same('a department name maps to itself', T.specialityToDepartments.Gynaecology, ['Gynaecology']);
  ok('every applied rule says why', T.auto.applied.every((a) => a.rule && a.rule.length > 3));
  ok('applied specialities become reachable',
    T.deptToSpecs.get('Gastrointestinal')?.has('Surgical Gastroenterology') === true);
}

/* ── what it may NOT do ───────────────────────────────────────────────────── */

{
  const T = world([
    ['1', 'Renal Transplant'],      // shares only the word "transplant" with Hair Transplant
    ['2', 'Hepatology'],            // nothing like it is mapped
    ['3', 'Paediatric Oncology'],   // both halves unmapped here
  ]);
  const applied = T.auto.applied.map((a) => a.speciality);
  const suggested = T.auto.suggested.map((s) => s.speciality);

  ok('a shared word alone does not map a speciality',
    !applied.includes('Renal Transplant'), `it was mapped to ${JSON.stringify(T.auto.applied)}`);
  ok('Renal Transplant is suggested for review instead', suggested.includes('Renal Transplant'));
  ok('an unrecognised speciality is not mapped', !applied.includes('Hepatology'));
  ok('an unrecognised speciality is suggested', suggested.includes('Hepatology'));
  ok('a suggestion carries its blast radius',
    T.auto.suggested.every((s) => Number.isInteger(s.hospitals) && Number.isInteger(s.doctors)));
  ok('nothing unmapped becomes reachable by a surgery',
    !T.surgeries.some((s) => s.specialities.some((x) => suggested.includes(x))),
    'a suggestion leaked into a live surgery');
}

/* ── the modifier rule must not collapse on an all-modifier name ──────────── */

{
  // "General Surgery" and "General Medicine" are nothing but modifier words. If
  // the rule matched on an empty core, every unknown value would collide with
  // them — and they sit in different departments.
  const T = world([['1', 'General Practice'], ['2', 'Clinical Medicine']]);
  const applied = T.auto.applied.map((a) => a.speciality);
  ok('an all-modifier name is not matched by the modifier rule',
    !applied.includes('Clinical Medicine'), `mapped to ${JSON.stringify(T.auto.applied)}`);
  ok('and neither is a near-empty one', !applied.includes('General Practice'));
}

/* ── the shard rule the page recomputes ───────────────────────────────────── */

// app.js has no imports, so it carries its own copy of this rule. A drift between
// the two 404s every hospital page while search keeps working perfectly, which is
// a miserable bug to find — so both halves of the rule are compared here, and the
// e2e run separately proves the shard the page fetched actually arrived.
{
  const app = readFileSync(join(ROOT, 'app.js'), 'utf8');
  const size = Number(/const DETAIL_SHARD = (\d+)/.exec(app)?.[1]);
  ok('app.js declares the same shard size', size === DETAIL_SHARD, `app.js ${size}, lib.mjs ${DETAIL_SHARD}`);
  ok('app.js uses the same fallback bucket count', /% 32/.test(app) && /n \* 31 \+ code\.charCodeAt/.test(app));

  same('a numeric code divides', [detailShard('0'), detailShard('24'), detailShard('25'), detailShard('374')], ['0', '0', '1', '14']);
  ok('a non-numeric code buckets rather than piling into one file',
    /^x\d+$/.test(detailShard('H0007')) && detailShard('H0007') !== detailShard('H0008'),
    `H0007→${detailShard('H0007')}  H0008→${detailShard('H0008')}`);
  ok('the fallback bucket is stable across calls', detailShard('ABC') === detailShard('ABC'));
}

/* ── report ───────────────────────────────────────────────────────────────── */

if (failures.length) {
  console.error(`\n✗ ${failures.length} of ${pass + failures.length} taxonomy checks failed:\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error('');
  process.exit(1);
}
console.log(`✓ ${pass} taxonomy checks passed`);
