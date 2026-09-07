#!/usr/bin/env node
/**
 * Two mapping sheets + a secondary-department config  ->  data/surgeries.json
 *
 *   node tools/build-surgeries.mjs
 *
 * The department is the intermediary between two vocabularies that never agreed:
 *
 *   what the patient has          what the hospital sheet says
 *   ────────────────────          ────────────────────────────
 *   Piles                         "General Surgery"
 *        │                              ▲
 *        └── Proctology ──(secondary)───┘
 *            (SubDept_Map)         (Dept_Map, inverted)
 *
 * Inputs
 *   incoming/SubDept_Map.tsv   surgery            → department   (218 rows)
 *   incoming/Dept_Map.tsv      hospital speciality → department  (57 rows, "A|B" for multi)
 *   tools/departments.json     department         → secondary departments
 *
 * Output
 *   data/surgeries.json        [{ id, name, departments, secondary, specialities }]
 *
 * Precomputed here so the browser does one dictionary lookup per search instead
 * of walking three tables.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, die } from './lib.mjs';

const path = (...p) => join(ROOT, ...p);
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const tsv = (file) => {
  if (!existsSync(file)) die(`missing ${file}`);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const head = lines[0].split('\t').map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const c = l.split('\t');
    return Object.fromEntries(head.map((h, i) => [h, (c[i] ?? '').trim()]));
  });
};

/* ── 1. hospital speciality → department(s) ───────────────────────────── */

const deptRows = tsv(path('incoming', 'Dept_Map.tsv'));
const specToDepts = new Map();          // normalised speciality → [departments]
const allDepartments = new Set();
for (const r of deptRows) {
  const spec = r.Hospital_Speciality || r.Speciality;
  const dept = r.Department_Name || r.Department;
  if (!spec || !dept) continue;
  const depts = dept.split('|').map((d) => d.trim()).filter(Boolean);
  specToDepts.set(norm(spec), depts);
  depts.forEach((d) => allDepartments.add(d));
}
// A speciality string that is itself a department name maps to itself.
for (const d of allDepartments) if (!specToDepts.has(norm(d))) specToDepts.set(norm(d), [d]);

/* ── 2. invert: department → hospital speciality strings that are live ── */

const hospitals = existsSync(path('data', 'hospitals.json'))
  ? JSON.parse(readFileSync(path('data', 'hospitals.json'), 'utf8'))
  : [];
const liveSpecs = [...new Set(hospitals.flatMap((h) => h.specialities))];

const deptToSpecs = new Map();
const unmappedLive = [];
for (const s of liveSpecs) {
  const depts = specToDepts.get(norm(s));
  if (!depts) { unmappedLive.push(s); continue; }
  for (const d of depts) {
    if (!deptToSpecs.has(d)) deptToSpecs.set(d, new Set());
    deptToSpecs.get(d).add(s);
  }
}

/* ── 3. surgery → departments (+ secondaries) → specialities ──────────── */

const SEC = JSON.parse(readFileSync(path('tools', 'departments.json'), 'utf8')).secondary;

const expand = (dept, seen = new Set()) => {
  if (seen.has(dept)) return seen;
  seen.add(dept);
  for (const s of SEC[dept] || []) expand(s, seen);
  return seen;
};

const subRows = tsv(path('incoming', 'SubDept_Map.tsv'));
const out = [];
const byName = new Map();
const unknownDept = new Set();
const deadEnds = [];

for (const r of subRows) {
  const name = r.UI_SubDepartment_Name;
  const dept = r.Department_Name;
  if (!name || !dept) continue;

  const chain = [...expand(dept)];
  const specs = [...new Set(chain.flatMap((d) => [...(deptToSpecs.get(d) || [])]))].sort();
  if (!deptToSpecs.has(dept) && !SEC[dept]) unknownDept.add(dept);
  if (!specs.length) deadEnds.push(`${name} → ${chain.join(' + ')}`);

  const key = norm(name);
  if (byName.has(key)) {                       // same surgery listed twice: union
    const prev = out[byName.get(key)];
    prev.specialities = [...new Set([...prev.specialities, ...specs])].sort();
    if (!prev.departments.includes(dept)) prev.departments.push(dept);
    continue;
  }
  byName.set(key, out.length);
  out.push({
    id: r.SubDepartment_Id || null,
    name,
    departments: [dept],
    secondary: SEC[dept] || [],
    specialities: specs,
  });
}

out.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(path('data', 'surgeries.json'), JSON.stringify(out));

/* ── report ───────────────────────────────────────────────────────────── */

console.log(`speciality→department rules   ${specToDepts.size}`);
console.log(`departments                   ${allDepartments.size}`);
console.log(`surgeries                     ${out.length}`);
console.log(`resolve to ≥1 live speciality ${out.filter((s) => s.specialities.length).length} / ${out.length}`);

if (unmappedLive.length) {
  console.log(`\n  ! ${unmappedLive.length} live hospital specialities have no department rule — hospitals`);
  console.log(`    listing ONLY these are unreachable. Add them to incoming/Dept_Map.tsv:`);
  unmappedLive.forEach((s) => console.log(`      ${s}`));
}
if (unknownDept.size) console.log(`\n  ! departments with neither a live speciality nor a secondary: ${[...unknownDept].join(', ')}`);
if (deadEnds.length) {
  console.log(`\n  ! ${deadEnds.length} surgeries resolve to nothing and will always return zero results:`);
  deadEnds.slice(0, 15).forEach((d) => console.log(`      ${d}`));
  if (deadEnds.length > 15) console.log(`      …and ${deadEnds.length - 15} more`);
}

const unreachable = liveSpecs.filter((s) => !out.some((o) => o.specialities.includes(s)));
if (unreachable.length) {
  console.log(`\n  · ${unreachable.length} live specialities no surgery points at (not an error, just unused):`);
  console.log(`      ${unreachable.join(', ')}`);
}
console.log(`\nwrote data/surgeries.json`);
