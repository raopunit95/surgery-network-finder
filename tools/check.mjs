#!/usr/bin/env node
/**
 * Health check on the data that was actually built.  `npm run check`
 *
 * Deliberately independent of the refresh. The refresh reports what it decided;
 * this reads data/ back off disk, decodes it the way the browser will, and asks
 * whether the result can answer a search. If the two ever disagree, the shipped
 * files are what users get.
 *
 * Everything mechanical — column mapping, insurer canonicalisation, the
 * surgery→speciality resolution — is code and runs on every refresh. Four things
 * genuinely need a human:
 *
 *   1. an insurer spelling nobody has mapped yet
 *   2. a speciality with no department rule, so its hospitals are unreachable
 *   3. a surgery that resolves to nothing, or to obviously too much
 *   4. a doctor vocabulary that has drifted from the hospital one
 *
 * Quiet when things are fine. Exit 1 only when something is search-breaking, so
 * it can gate a deploy without failing on every rough edge.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, canonInsurer, unmappedInsurers, unpackHospitals, detailShard } from './lib.mjs';

const p = (...x) => join(ROOT, ...x);
const read = (f) => JSON.parse(readFileSync(p('data', f), 'utf8'));

for (const f of ['hospitals.json', 'surgeries.json', 'meta.json', 'taxonomy.json']) {
  if (!existsSync(p('data', f))) {
    console.error(`\n✗ data/${f} is missing. Run \`npm run refresh\` (or \`npm run sample\`) first.\n`);
    process.exit(1);
  }
}
if (!existsSync(p('data', 'detail'))) {
  console.error('\n✗ data/detail/ is missing. Run `npm run refresh` first.\n');
  process.exit(1);
}

const M = read('meta.json');
const S = read('surgeries.json');
const T = read('taxonomy.json');
const H = unpackHospitals(read('hospitals.json'));

const detail = new Map();
for (const f of readdirSync(p('data', 'detail'))) {
  const shard = JSON.parse(readFileSync(p('data', 'detail', f), 'utf8'));
  for (const [code, entry] of Object.entries(shard.byHospital)) detail.set(code, { ...entry, file: f });
}

const blocking = [], review = [];
const byCode = new Map(H.map((h) => [h.code, h]));
const nameOf = (code) => (byCode.get(code) ? `${code} ${byCode.get(code).nameShort}` : code);
const list = (arr, n = 10) =>
  arr.slice(0, n).map((x) => `      ${x}`).join('\n') + (arr.length > n ? `\n      …and ${arr.length - n} more` : '');

/* ── 1. structural: can the page work at all? ──────────────────────────────── */

if (H.length < 10) blocking.push(`only ${H.length} hospitals`);

const noCoords = H.filter((h) => h.lat === null);
if (noCoords.length / H.length > 0.1) {
  blocking.push(`${noCoords.length} of ${H.length} hospitals have no usable coordinates — they can never appear`);
} else if (noCoords.length) {
  review.push(`${noCoords.length} hospital(s) have no usable coordinates and will never appear:\n${list(noCoords.map((h) => nameOf(h.code)), 8)}`);
}

/* ── 2. shard integrity — the failure mode this format introduced ─────────── */

// A detail file is fetched by a rule computed in the browser. If the two rules
// ever disagree, every hospital page 404s while search keeps working perfectly,
// which is a hard bug to see. So check the shipped files against the rule.
const misfiled = H
  .filter((h) => detail.has(h.code) && detail.get(h.code).file !== `${detailShard(h.code)}.json`)
  .map((h) => `${nameOf(h.code)} is in ${detail.get(h.code).file}, expected ${detailShard(h.code)}.json`);
if (misfiled.length) blocking.push(`${misfiled.length} hospital(s) are in the wrong detail shard:\n${list(misfiled)}`);

const missingDetail = H.filter((h) => !detail.has(h.code));
if (missingDetail.length) {
  blocking.push(`${missingDetail.length} hospital(s) have no detail entry — their page cannot load:\n${list(missingDetail.map((h) => nameOf(h.code)))}`);
}
const strayDetail = [...detail.keys()].filter((c) => !byCode.has(c));
if (strayDetail.length) {
  review.push(`${strayDetail.length} detail entr(ies) belong to a hospital that is no longer active — stale shard files`);
}

const doctors = [...detail.values()].flatMap((e) => e.doctors);
if (doctors.length !== M.doctorCount) {
  review.push(`meta.json says ${M.doctorCount} doctors, the shards hold ${doctors.length}`);
}

/* ── 3. blank fields: invisible failures ──────────────────────────────────── */

const noSpec = H.filter((h) => !h.specialities.length);
if (noSpec.length) {
  review.push(`${noSpec.length} hospital(s) have a blank Speciality — unfindable by any surgery:\n${list(noSpec.map((h) => nameOf(h.code)))}`);
}

const noIns = H.filter((h) => !h.insurers.length);
if (noIns.length) {
  review.push(`${noIns.length} hospital(s) have a blank Short_Ins — they disappear the moment a user picks
      an insurer:\n${list(noIns.map((h) => nameOf(h.code)))}
      Fix Short_Ins in the inventory. A single cell holding the whole list without
      commas reads as one 400-character insurer name and gets dropped entirely.`);
}

/* ── 4. insurer spellings nobody has mapped ───────────────────────────────── */

unmappedInsurers.clear();
for (const h of H) h.insurers.forEach(canonInsurer);
if (unmappedInsurers.size) {
  const spellings = [...unmappedInsurers.entries()].sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${String(n).padStart(4)}×  ${s}`);
  review.push(`${unmappedInsurers.size} insurer name(s) are not in tools/insurers.json, so each shows as its own
      dropdown entry instead of merging with the real insurer:\n${list(spellings, 15)}`);
}

/* ── 5. taxonomy coverage ─────────────────────────────────────────────────── */

if (T.awaitingReview?.length) {
  const rows = T.awaitingReview.map((s) =>
    `${s.speciality}  →  ${s.guess.join(' | ') || '(no guess)'}   ${s.hospitals} hospitals, ${s.doctors} doctors`);
  review.push(`${T.awaitingReview.length} speciality(ies) have no department rule and could not be settled
      automatically. A hospital listing only these is unreachable unless a surgery
      names it explicitly. Suggested lines are in incoming/Dept_Map.suggested.tsv:\n${list(rows, 15)}`);
}

if (T.autoMapped?.length) {
  const rows = T.autoMapped.map((a) => `${a.speciality} → ${a.departments.join(' | ')}   [${a.rule}]`);
  review.push(`${T.autoMapped.length} speciality(ies) were auto-mapped. Each restates a rule you already wrote,
      but confirm them once and add the ones you agree with to Dept_Map.tsv:\n${list(rows, 15)}`);
}

const dead = S.filter((s) => !s.specialities.length);
if (dead.length) {
  blocking.push(`${dead.length} surgery(ies) resolve to no speciality and will always return "nothing found":\n${list(dead.map((s) => `${s.name} → ${s.departments.join('/')}`), 12)}`);
}

const live = [...new Set(H.flatMap((h) => h.specialities))];
const unused = live.filter((s) => !S.some((x) => x.specialities.includes(s)));

const WIDE = 3;
const wide = S.filter((s) => s.via === 'department' && s.specialities.length > WIDE);
if (wide.length) {
  const byDept = new Map();
  for (const s of wide) {
    const k = s.departments.join('/');
    if (!byDept.has(k)) byDept.set(k, []);
    byDept.get(k).push(s.name);
  }
  const rows = [...byDept].map(([d, n]) => `${d} (${n.length}): ${n.slice(0, 5).join(', ')}${n.length > 5 ? ', …' : ''}`);
  review.push(`${wide.length} surgery(ies) match more than ${WIDE} specialities through their department.
      Not automatically wrong — a cancer patient wants any oncology unit — but this is
      where silent over-matching lives. Narrow one by filling its Specialities column
      in incoming/SubDept_Map.tsv:\n${list(rows)}`);
}

/* ── 6. doctor vocabulary ─────────────────────────────────────────────────── */

const liveSet = new Set(live);
const docOrphan = new Map();
for (const d of doctors) {
  if (d.speciality && !liveSet.has(d.speciality)) docOrphan.set(d.speciality, (docOrphan.get(d.speciality) || 0) + 1);
}
if (docOrphan.size) {
  const rows = [...docOrphan.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${String(n).padStart(4)}×  ${s}`);
  review.push(`${docOrphan.size} doctor speciality(ies) do not exist on the hospital side, so those doctors
      always land under "Other specialities here" instead of the surgery searched for:\n${list(rows)}`);
}

/* ── report ───────────────────────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(6);
const withoutDoctors = H.filter((h) => !(detail.get(h.code)?.doctors.length));
console.log(`\n  source                ${M.source}`);
console.log(`  built                 ${new Date(M.generatedAt).toLocaleString('en-IN')}`);
console.log(`  format                ${M.format ?? 1}   (detail shards of ${M.detailShard} codes)`);
console.log(`  hospitals         ${pad(H.length)}`);
console.log(`  doctors           ${pad(doctors.length)}   across ${detail.size} detail entries`);
console.log(`  surgeries         ${pad(S.length)}   (${S.filter((s) => s.via === 'explicit').length} explicitly targeted)`);
console.log(`  specialities      ${pad(live.length)}   (${unused.length} with no surgery pointing at them)`);
console.log(`  insurers          ${pad(M.insurers.length)}`);
console.log(`  hospitals with no doctor listed ${withoutDoctors.length}`);

if (blocking.length) {
  console.log(`\n━━ BLOCKING ${'━'.repeat(52)}`);
  blocking.forEach((b) => console.log(`\n  ✗ ${b}`));
}
if (review.length) {
  console.log(`\n━━ NEEDS YOUR ATTENTION ${'━'.repeat(40)}`);
  review.forEach((r) => console.log(`\n  · ${r}`));
}
if (unused.length) {
  console.log(`\n━━ FYI ${'━'.repeat(57)}`);
  console.log(`\n  · ${unused.length} specialities no surgery points at (expected for diagnostics and support`);
  console.log(`    departments; a problem only if patients should be able to search for them):`);
  console.log(`      ${unused.join(', ')}`);
}

if (!blocking.length && !review.length) console.log('\n✓ nothing needs attention\n');
else console.log('');

process.exit(blocking.length ? 1 : 0);
