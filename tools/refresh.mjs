#!/usr/bin/env node
/**
 * The whole refresh, in one pass.
 *
 *   npm run refresh                  read incoming/Inventory.xlsx, rebuild data/
 *   npm run refresh -- --dry-run     do all of it, write nothing
 *   npm run refresh -- --source=sheet|csv|sample
 *
 * inventory ─► records ─► validate ─► taxonomy ─► data/*.json ─► report
 *
 * One pass matters. The old pipeline built hospitals, wrote them, then had a
 * second script read data/hospitals.json back off disk to work out the surgery
 * mapping — so a failed second step left the site claiming a taxonomy that no
 * longer matched its own inventory. Here nothing is written until everything
 * resolves, and `--dry-run` genuinely exercises the same code.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, CFG, readTsv, buildHospitals, buildDoctors, validate, writeAll, writeJson, report,
} from './lib.mjs';
import { buildTaxonomy, suggestionsTsv } from './taxonomy.mjs';
import { readSource } from './sources.mjs';

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const DRY = process.argv.includes('--dry-run');
const at = (...p) => join(ROOT, ...p);

/* ── 1. read ──────────────────────────────────────────────────────────────── */

const src = await readSource(arg('source', 'auto'));
console.log(`source     ${src.source} · ${CFG.hospitals.tab} ${src.hospitals.length - 1} rows · ${CFG.doctors.tab} ${src.doctors.length - 1} rows`);

/* ── 2. records ───────────────────────────────────────────────────────────── */

const H = buildHospitals(src.hospitals);
const D = buildDoctors(src.doctors, new Set(H.out.map((h) => h.code)));

/* ── 3. refuse to publish a broken snapshot ───────────────────────────────── */

const errs = validate(H, D);
if (errs.length) {
  console.error('\n✗ validation failed — data/ left untouched:');
  errs.forEach((e) => console.error(`   • ${e}`));
  process.exit(1);
}

/* ── 4. taxonomy ──────────────────────────────────────────────────────────── */

const T = buildTaxonomy({
  deptRows: readTsv(at('incoming', 'Dept_Map.tsv')),
  subRows: readTsv(at('incoming', 'SubDept_Map.tsv')),
  hospitals: H.out,
  doctors: D.out,
});

/* ── 5. write ─────────────────────────────────────────────────────────────── */

if (DRY) {
  report(H, D, { specialities: [...T.usage.keys()], insurers: [], cityCount: 0 });
  printTaxonomy(T);
  console.log('\ndry run — nothing written');
  process.exit(0);
}

const { meta, shardCount } = writeAll(H, D, src.source, T);

// The app only needs enough to run a search; the audit detail goes next door.
writeJson(at('data', 'surgeries.json'), T.surgeries.map(({ hospitalCodes, ...s }) => s));

// The full resolved map, every link spelled out: surgery → primary department →
// secondary departments → specialities → the hospital codes and doctor count that
// answer it. Nothing reads this — it exists so a wrong answer on the site can be
// traced to the row that caused it without re-running anything.
writeJson(at('data', 'taxonomy.json'), {
  generatedAt: meta.generatedAt,
  source: src.source,
  departments: T.departments,
  secondary: T.secondary,
  specialityToDepartments: T.specialityToDepartments,
  autoMapped: T.auto.applied,
  awaitingReview: T.auto.suggested,
  surgeries: T.surgeries,
}, true);

writeFileSync(at('incoming', 'Dept_Map.suggested.tsv'), suggestionsTsv(T));

/* ── 6. report ────────────────────────────────────────────────────────────── */

report(H, D, meta);
console.log(`\nwrote      data/hospitals.json · data/detail/*.json (${shardCount} shards) · data/surgeries.json`);
console.log(`           data/meta.json · data/taxonomy.json · incoming/Dept_Map.suggested.tsv`);
printTaxonomy(T);

function printTaxonomy(T) {
  const { counts, issues, auto, surgeries } = T;
  console.log(`\nmapping    ${counts.rules} speciality→department rules · ${T.departments.length} departments`);
  console.log(`surgeries  ${surgeries.length} · ${counts.explicit} targeted explicitly · ${counts.department} via department`);
  console.log(`           ${surgeries.filter((s) => s.specialities.length).length} resolve to at least one live speciality`);

  if (auto.applied.length) {
    console.log(`\n  auto-mapped ${auto.applied.length} speciality/ies Dept_Map.tsv does not list.`);
    console.log(`  These restate a mapping you already made — nothing new was invented:`);
    auto.applied.forEach((a) =>
      console.log(`      ${a.speciality} → ${a.departments.join(' | ')}   [${a.rule}]  ${a.hospitals}h ${a.doctors}d`));
  }

  if (auto.suggested.length) {
    console.log(`\n  ! ${auto.suggested.length} speciality/ies could not be settled automatically and are NOT mapped.`);
    console.log(`    Hospitals listing only these cannot be found by any search. Suggestions are in`);
    console.log(`    incoming/Dept_Map.suggested.tsv — move the lines you agree with into Dept_Map.tsv:`);
    auto.suggested.forEach((s) =>
      console.log(`      ${s.speciality}  →  ${s.guess.join(' | ') || '(no guess)'}   ${s.hospitals}h ${s.doctors}d  conf ${s.confidence}`));
  }

  if (issues.badOverride.length) {
    console.log(`\n  ! ${issues.badOverride.length} SubDept_Map row(s) name a speciality no active hospital lists.`);
    console.log(`    Spelling variants are handled now, so these are genuinely absent or genuinely wrong:`);
    issues.badOverride.forEach((b) => console.log(`      ${b}`));
  }

  if (issues.wide.length) {
    console.log(`\n  · ${issues.wide.length} surgeries match more than ${counts.wide} specialities via their department.`);
    console.log(`    Fill the Specialities column in incoming/SubDept_Map.tsv to narrow any that look wrong:`);
    const byDept = new Map();
    for (const s of issues.wide) {
      const k = s.departments.join('/');
      if (!byDept.has(k)) byDept.set(k, []);
      byDept.get(k).push(s.name);
    }
    for (const [d, names] of byDept) {
      console.log(`      ${d} (${names.length}): ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}`);
    }
  }

  if (issues.unknownDept.length) {
    console.log(`\n  ! departments with neither a live speciality nor a secondary: ${issues.unknownDept.join(', ')}`);
  }
  if (issues.deadEnds.length) {
    console.log(`\n  ! ${issues.deadEnds.length} surgeries resolve to nothing and will always return zero results:`);
    issues.deadEnds.slice(0, 15).forEach((d) => console.log(`      ${d}`));
    if (issues.deadEnds.length > 15) console.log(`      …and ${issues.deadEnds.length - 15} more`);
  }
  if (issues.unreachable.length) {
    console.log(`\n  · ${issues.unreachable.length} live specialities no surgery points at (not an error, just unused):`);
    console.log(`      ${issues.unreachable.join(', ')}`);
  }
}
