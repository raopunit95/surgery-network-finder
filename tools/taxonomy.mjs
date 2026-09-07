/**
 * The mapping engine. One place where every vocabulary in this project is
 * reconciled, so the site can never disagree with itself about what a word means.
 *
 * Two vocabularies never agreed. A patient types "Piles"; the inventory says
 * "General Surgery". The department is the intermediary, and the full chain is:
 *
 *   surgery ─► primary dept ─► secondary dept ─► speciality ─► hospital ─► doctor
 *   ───────    ────────────    ──────────────    ──────────    ────────    ──────
 *   SubDept_Map.tsv            taxonomy.json     Dept_Map.tsv  Inventory.xlsx
 *   (col 2)     (col 4)        ("secondary")     (inverted)    (Speciality)
 *
 * Three things live here and nowhere else:
 *
 *   1. canonSpeciality — one spelling per speciality, applied to every input.
 *      Before this, a value in SubDept_Map had to reproduce the inventory's typos
 *      character for character ("Dermataology", "NEPHROLOGY") or it silently
 *      matched nothing. Now either spelling resolves and the site shows the right one.
 *
 *   2. autoMap — what to do with a speciality the inventory has and Dept_Map does
 *      not. Deterministic restatements of mappings you already made are applied;
 *      anything requiring a guess is reported and NOT used, so the site never
 *      claims a mapping your sheets do not state.
 *
 *   3. resolve — surgery to the live specialities, hospitals and doctors that can
 *      actually answer it, with the route recorded so a wrong answer is traceable.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const key = (s) => norm(s).replace(/[^a-z0-9]/g, '');

/* ── configuration ───────────────────────────────────────────────────────── */

let CFG = null;

export function loadTaxonomyConfig(root = join(dirname(fileURLToPath(import.meta.url)), '..')) {
  if (CFG) return CFG;
  const raw = JSON.parse(readFileSync(join(root, 'tools', 'taxonomy.json'), 'utf8'));
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));

  const aliasOf = new Map();                    // key(variant) → canonical
  for (const [canonical, variants] of Object.entries(strip(raw.specialityAliases))) {
    // The canonical spelling is an alias of itself so folding twice is a no-op —
    // the same bug insurers.json had, where a cell reading exactly "SBI General"
    // fell through unmapped because only the variants were listed.
    aliasOf.set(key(canonical), canonical);
    for (const v of variants) aliasOf.set(key(v), canonical);
  }

  const splitInto = new Map();                  // key(raw) → [raw parts]
  for (const [raw_, parts] of Object.entries(strip(raw.specialitySplits))) splitInto.set(key(raw_), parts);

  CFG = { aliasOf, splitInto, secondary: strip(raw.secondary), auto: raw.autoMap };
  return CFG;
}

/** One inventory value → one or more canonical specialities.
 *  Splits first, then folds each part, so "Hair Transplant & Dermataology"
 *  becomes ["Hair Transplant", "Dermatology"] and is findable as either. */
export function canonSpeciality(raw) {
  if (!CFG) loadTaxonomyConfig();
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const parts = CFG.splitInto.get(key(s)) ?? [s];
  return [...new Set(parts.map((p) => CFG.aliasOf.get(key(p)) ?? p.trim()).filter(Boolean))];
}

/** A whole cell: "OBG,Pediatrics and Neonatology" → 3 canonical specialities. */
export const canonSpecialityList = (cell, separator = ',') =>
  [...new Set(String(cell ?? '').split(separator).flatMap(canonSpeciality))];

/* ── string similarity, for suggestions only ─────────────────────────────── */

const trigrams = (s) => {
  const p = `  ${key(s)}  `;
  const out = new Set();
  for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  return out;
};

/** Sørensen–Dice on character trigrams. Cheap, no dependency, and good enough to
 *  rank a shortlist for a human — it is never used to decide anything by itself. */
function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return (2 * shared) / (A.size + B.size || 1);
}

/* ── the engine ──────────────────────────────────────────────────────────── */

/**
 * @param {object}   src
 * @param {object[]} src.deptRows   Dept_Map.tsv rows      (speciality → department)
 * @param {object[]} src.subRows    SubDept_Map.tsv rows   (surgery → department [+ specialities])
 * @param {object[]} src.hospitals  built hospitals, `specialities` already canonical
 * @param {object[]} src.doctors    built doctors, `speciality` already canonical
 */
export function buildTaxonomy({ deptRows, subRows, hospitals, doctors }) {
  /* 1 ── speciality → primary department(s), from the sheet you own ───────── */

  const specToDepts = new Map();                // key(canonical speciality) → Set<department>
  const departments = new Set();
  const addRule = (spec, depts) => {
    const k = key(spec);
    if (!specToDepts.has(k)) specToDepts.set(k, new Set());
    for (const d of depts) { specToDepts.get(k).add(d); departments.add(d); }
  };

  for (const r of deptRows) {
    const spec = r.Hospital_Speciality || r.Speciality;
    const dept = r.Department_Name || r.Department;
    if (!spec || !dept) continue;
    const depts = dept.split('|').map((d) => d.trim()).filter(Boolean);
    // A left-hand value that itself splits ("Hair Transplant & Dermataology")
    // gives its department to each half, which is what the row means.
    for (const s of canonSpeciality(spec)) addRule(s, depts);
  }
  for (const d of Object.keys(CFG.secondary)) departments.add(d);
  for (const list of Object.values(CFG.secondary)) list.forEach((d) => departments.add(d));

  // A speciality string that is itself a department name maps to itself.
  for (const d of departments) if (!specToDepts.has(key(d))) addRule(d, [d]);

  /* 2 ── what the inventory actually contains, and how much rides on each ── */

  const usage = new Map();                      // canonical speciality → {hospitals, doctors}
  const bump = (s, k) => {
    if (!s) return;
    if (!usage.has(s)) usage.set(s, { hospitals: 0, doctors: 0 });
    usage.get(s)[k]++;
  };
  for (const h of hospitals) for (const s of h.specialities) bump(s, 'hospitals');
  for (const d of doctors) bump(d.speciality, 'doctors');

  /* 3 ── auto-map the ones Dept_Map has never seen ────────────────────────── */

  const A = CFG.auto;
  const mapped = [...specToDepts.keys()];

  /** The words that carry the meaning: everything except the modifiers that
   *  qualify a speciality without moving it to another department. */
  const coreWords = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w && !A.modifierWords.includes(w));
  const coreKey = (s) => coreWords(s).sort().join(' ');

  // core word set → the mapped spellings that reduce to it. Built from the real
  // spellings, not from key(), because key() strips the spaces that make a word a
  // word: key("General Surgery") is one 14-letter token with no words in it.
  //
  // An empty core is skipped. "General Surgery" and "General Medicine" are both
  // nothing but modifiers, and they belong to different departments — matching on
  // an empty set would make every unrecognised value collide with them.
  const coreIndex = new Map();
  const indexCore = (spelling) => {
    const k = coreKey(spelling);
    if (!k) return;
    if (!coreIndex.has(k)) coreIndex.set(k, new Set());
    coreIndex.get(k).add(key(spelling));
  };
  for (const r of deptRows) {
    const spec = r.Hospital_Speciality || r.Speciality;
    if (spec) canonSpeciality(spec).forEach(indexCore);
  }
  for (const d of departments) indexCore(d);

  const applied = [], suggested = [];

  /** Resolve one unknown speciality. Returns departments to apply, or null to
   *  suggest. Every branch records why, so `npm run check` can show its working. */
  function autoResolve(spec, depth = 0) {
    if (depth > 2) return null;
    const known = specToDepts.get(key(spec));
    if (known) return { depts: [...known], rule: 'exact' };

    const words = String(spec).trim().split(/\s+/);

    // (a) the value is a department name
    if (A.apply.selfIsDepartment && departments.has(spec)) return { depts: [spec], rule: 'is-a-department' };

    // (b) a provider brand in front of an ordinary speciality: "AyurVaid ENT"
    if (A.apply.stripLeadingBrandWord && words.length > 1 && A.brandWords.some((b) => key(b) === key(words[0]))) {
      const inner = autoResolve(words.slice(1).join(' '), depth + 1);
      if (inner) return { depts: inner.depts, rule: `brand-prefix (as "${words.slice(1).join(' ')}")` };
    }

    // (c) one cell naming two specialities, both of which resolve
    if (A.apply.splitOnConjunction) {
      const parts = String(spec).split(/\s*(?:&|\+|\/|\band\b)\s*/i).map((p) => p.trim()).filter(Boolean);
      if (parts.length > 1) {
        const each = parts.map((p) => autoResolve(p, depth + 1));
        if (each.every(Boolean)) {
          return { depts: [...new Set(each.flatMap((e) => e.depts))], rule: `split (${parts.join(' + ')})` };
        }
      }
    }

    // (d) identical to something already mapped once modifier words are removed.
    //     "Surgical Gastroenterology" lands on Gastrointestinal because "Medical
    //     Gastroenterology" already does and the two differ by one word that
    //     never changes a department. Applied only when every speciality sharing
    //     that core agrees on one department; if they disagree, it is a genuine
    //     judgement call and gets suggested instead.
    const siblings = new Set(coreIndex.get(coreKey(spec)) ?? []);
    siblings.delete(key(spec));
    if (siblings.size) {
      const union = new Set([...siblings].flatMap((k) => [...(specToDepts.get(k) ?? [])]));
      if (A.apply.differsOnlyByModifier && union.size === 1) {
        return { depts: [...union], rule: `differs only by a modifier from ${siblings.size} mapped speciality/ies` };
      }
    }
    return null;
  }

  for (const [spec, counts] of usage) {
    if (specToDepts.has(key(spec))) continue;
    const hit = autoResolve(spec);
    if (hit) {
      addRule(spec, hit.depts);
      applied.push({ speciality: spec, departments: hit.depts, rule: hit.rule, ...counts });
    } else {
      const near = mapped
        .map((k) => ({ k, score: similarity(spec, k) }))
        .filter((x) => x.score >= A.suggestAboveSimilarity)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      const guess = [...new Set(near.flatMap((n) => [...(specToDepts.get(n.k) ?? [])]))];
      suggested.push({
        speciality: spec,
        guess,
        confidence: near[0] ? +near[0].score.toFixed(2) : 0,
        ...counts,
      });
    }
  }
  applied.sort((a, b) => b.hospitals - a.hospitals || a.speciality.localeCompare(b.speciality));
  suggested.sort((a, b) => b.hospitals - a.hospitals || b.confidence - a.confidence);

  /* 4 ── invert: department → the live specialities that satisfy it ───────── */

  const liveHospitalSpecs = new Set(hospitals.flatMap((h) => h.specialities));
  const deptToSpecs = new Map();
  for (const s of liveHospitalSpecs) {
    for (const d of specToDepts.get(key(s)) ?? []) {
      if (!deptToSpecs.has(d)) deptToSpecs.set(d, new Set());
      deptToSpecs.get(d).add(s);
    }
  }

  /** primary department + every secondary reachable from it, transitively. */
  const expand = (dept, seen = new Set()) => {
    if (seen.has(dept)) return seen;
    seen.add(dept);
    for (const s of CFG.secondary[dept] ?? []) expand(s, seen);
    return seen;
  };

  /* 5 ── surgery → specialities, hospitals, doctors ──────────────────────── */

  const bySpec = new Map();                     // canonical speciality → hospital codes
  for (const h of hospitals) {
    for (const s of h.specialities) {
      if (!bySpec.has(s)) bySpec.set(s, new Set());
      bySpec.get(s).add(h.code);
    }
  }
  const docsBySpec = new Map();
  for (const d of doctors) docsBySpec.set(d.speciality, (docsBySpec.get(d.speciality) ?? 0) + 1);

  const surgeries = [];
  const byName = new Map();
  const issues = { unknownDept: new Set(), deadEnds: [], badOverride: [], wide: [] };
  let explicit = 0;

  for (const r of subRows) {
    const name = r.UI_SubDepartment_Name;
    const dept = r.Department_Name;
    if (!name || !dept) continue;

    const listed = String(r.Specialities || '').split('|').map((x) => x.trim()).filter(Boolean);
    let specs, via, secondary;

    if (listed.length) {
      // Explicit targeting wins. The department is a filing category in the
      // source sheet, not a matching key: "Aesthetic" spans Plastic Surgery,
      // Dermatology, Cosmetology and Hair Transplant, so fanning out through it
      // matched Rhinoplasty to a hair clinic and Botox to a surgical ward.
      const wanted = listed.flatMap(canonSpeciality);
      const unknown = wanted.filter((x) => !liveHospitalSpecs.has(x));
      if (unknown.length) issues.badOverride.push(`${name}: ${[...new Set(unknown)].join(', ')}`);
      specs = [...new Set(wanted.filter((x) => liveHospitalSpecs.has(x)))].sort();
      via = 'explicit';
      secondary = [];
      explicit++;
    } else {
      const chain = [...expand(dept)];
      specs = [...new Set(chain.flatMap((d) => [...(deptToSpecs.get(d) ?? [])]))].sort();
      via = 'department';
      secondary = CFG.secondary[dept] ?? [];
      if (!deptToSpecs.has(dept) && !CFG.secondary[dept]) issues.unknownDept.add(dept);
    }

    if (!specs.length) issues.deadEnds.push(`${name} → ${via === 'explicit' ? r.Specialities : dept}`);

    const codes = [...new Set(specs.flatMap((s) => [...(bySpec.get(s) ?? [])]))];
    const record = {
      id: r.SubDepartment_Id || null,
      name,
      departments: [dept],
      secondary,
      specialities: specs,
      via,
      hospitalCount: codes.length,
      doctorCount: specs.reduce((n, s) => n + (docsBySpec.get(s) ?? 0), 0),
      hospitalCodes: codes.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    };

    const k = norm(name);
    if (byName.has(k)) {                        // same surgery listed twice: union
      const prev = surgeries[byName.get(k)];
      prev.specialities = [...new Set([...prev.specialities, ...specs])].sort();
      prev.hospitalCodes = [...new Set([...prev.hospitalCodes, ...codes])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      prev.hospitalCount = prev.hospitalCodes.length;
      prev.doctorCount = prev.specialities.reduce((n, s) => n + (docsBySpec.get(s) ?? 0), 0);
      if (!prev.departments.includes(dept)) prev.departments.push(dept);
      prev.secondary = [...new Set([...prev.secondary, ...secondary])];
      continue;
    }
    byName.set(k, surgeries.length);
    surgeries.push(record);
  }

  surgeries.sort((a, b) => a.name.localeCompare(b.name));

  /* A surgery matching many specialities is not automatically wrong — a cancer
     patient wants any oncology unit — but it is where silent over-matching
     lives, so it is surfaced rather than buried. */
  const WIDE = 3;
  issues.wide = surgeries
    .filter((s) => s.via === 'department' && s.specialities.length > WIDE)
    .sort((a, b) => b.specialities.length - a.specialities.length);
  issues.unreachable = [...liveHospitalSpecs]
    .filter((s) => !surgeries.some((o) => o.specialities.includes(s)))
    .sort();
  issues.unknownDept = [...issues.unknownDept];

  // Flat, sorted, ready to read: every speciality the inventory contains and the
  // departments it resolves to. An empty array is the interesting case — it means
  // the speciality is unmapped and nothing can reach the hospitals that list it.
  const specialityToDepartments = Object.fromEntries(
    [...usage.keys()].sort().map((s) => [s, [...(specToDepts.get(key(s)) ?? [])].sort()])
  );

  return {
    surgeries,
    departments: [...departments].sort(),
    specToDepts,
    specialityToDepartments,
    deptToSpecs,
    secondary: CFG.secondary,
    usage,
    auto: { applied, suggested },
    issues,
    counts: { rules: specToDepts.size, explicit, department: surgeries.length - explicit, wide: WIDE },
  };
}

/** Paste-ready lines for the two mapping decisions still open. Written to
 *  incoming/Dept_Map.suggested.tsv — a work queue, not a source file, which is
 *  why nothing reads it back. Move a line into Dept_Map.tsv to make it real. */
export function suggestionsTsv(T) {
  const lines = [
    '# Specialities the inventory contains that Dept_Map.tsv does not map.',
    '# Nothing here is in effect. Hospitals listing only these specialities cannot',
    '# be found by any search until you move a line into Dept_Map.tsv.',
    '#',
    '# confidence is spelling similarity to something already mapped — a shortlist,',
    '# not a verdict. Check the department is clinically right before pasting.',
    '#',
    'Hospital_Speciality\tDepartment_Name\t# hospitals\tdoctors\tconfidence',
  ];
  for (const s of T.auto.suggested) {
    lines.push(`${s.speciality}\t${s.guess.join('|') || '?'}\t# ${s.hospitals}\t${s.doctors}\t${s.confidence}`);
  }
  if (!T.auto.suggested.length) lines.push('# (nothing outstanding — every speciality in the inventory is mapped)');
  return `${lines.join('\n')}\n`;
}
