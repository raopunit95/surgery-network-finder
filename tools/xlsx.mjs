/**
 * Minimal .xlsx reader — enough to read a Google-Sheets or Excel export, nothing more.
 *
 *   import { readWorkbook } from './xlsx.mjs';
 *   const sheets = readWorkbook('incoming/Inventory.xlsx');   // { Bot_Hosp: [[...]], Bot_Doc: [[...]] }
 *
 * Written rather than installed so the project keeps its one real promise: no
 * dependencies, nothing to `npm install`, nothing to audit. An .xlsx is a zip of
 * XML, and Node already ships both halves — `zlib` inflates the entries and a
 * scan over the sheet XML pulls the cells out.
 *
 * Every value comes back as a STRING, exactly as the file stores it, because that
 * is what the CSV path produces and the two must be indistinguishable downstream.
 * A pincode is "560067" and not 560067.0; a code is "1" and not 1.0.
 *
 * Not supported, deliberately: date formatting (no column we read is a date),
 * ZIP64 (it errors clearly instead of returning silent nonsense), and encryption.
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/* ── zip ──────────────────────────────────────────────────────────────────
   Read the central directory at the end of the file rather than walking local
   headers from the front: it is the only place that reliably carries the
   compressed size, and streamed zips leave that field zero in the local header. */

function unzip(buf) {
  // The End Of Central Directory record is last, but a trailing comment can push
  // it back by up to 64 KB, so scan backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record) — is this really an .xlsx?');

  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  if (at === 0xffffffff) throw new Error('ZIP64 workbook is not supported — re-export it, or save as CSV instead');

  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;

    // Skip the local header to reach the payload; its own name/extra lengths can
    // differ from the central directory's, so read them here rather than reusing.
    const lNameLen = buf.readUInt16LE(localAt + 26);
    const lExtraLen = buf.readUInt16LE(localAt + 28);
    const from = localAt + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(from, from + compressed);

    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, inflateRawSync(raw));
    // Any other method (bzip2, lzma) is not something a spreadsheet app emits.
  }
  return files;
}

/* ── xml ─────────────────────────────────────────────────────────────────── */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const unescapeXml = (s) =>
  s.includes('&')
    ? s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, e) =>
      e[0] === '#'
        ? String.fromCodePoint(parseInt(e[1] === 'x' ? e.slice(2) : e.slice(1), e[1] === 'x' ? 16 : 10))
        : (ENTITIES[e] ?? m))
    : s;

/** Concatenate every <t> in a fragment. A shared string that carries formatting
 *  is split into <r> runs, so "Dr Rao" can arrive as three separate <t> nodes. */
const textOf = (xml) => {
  let out = '';
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/g)) out += m[1] ?? '';
  return unescapeXml(out);
};

const sharedStrings = (xml) => {
  if (!xml) return [];
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
};

/* ── sheets ──────────────────────────────────────────────────────────────── */

/** "BC" → 54. Cell refs are the only reliable column index: a row with an empty
 *  cell omits it entirely, so counting <c> elements shifts every later value. */
function colIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function readSheet(xml, strings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const inner = rowMatch[1];
    if (!inner) { rows.push([]); continue; }
    const row = [];
    for (const c of inner.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], body = c[2] ?? '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      const i = ref ? colIndex(ref[1]) : row.length;

      let v = '';
      if (type === 's') {
        const idx = /<v>([\s\S]*?)<\/v>/.exec(body);
        v = idx ? (strings[+idx[1]] ?? '') : '';
      } else if (type === 'inlineStr') {
        v = textOf(body);
      } else if (type === 'b') {
        v = /<v>1<\/v>/.test(body) ? 'TRUE' : 'FALSE';
      } else {
        // "n" (number) and "str" (formula result) both keep the literal text —
        // except that this workbook writes every number with a decimal point, so
        // Hospital_Code 1 arrives as "1.0" and a pincode as "560067.0". Round-trip
        // through Number to get the shortest exact form back: "1.0"→"1",
        // "560067.0"→"560067", while "3.8" and "13.00626069" are left alone.
        const m = /<v>([\s\S]*?)<\/v>/.exec(body);
        v = m ? unescapeXml(m[1]) : '';
        if (type === 'n' && v && Number.isFinite(+v)) v = String(+v);
      }
      row[i] = v;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
    rows.push(row);
  }
  // Drop fully blank rows, matching parseCsv, so a trailing thousand empty rows
  // in the sheet do not become a thousand records to reject one by one.
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

/* ── entry point ─────────────────────────────────────────────────────────── */

/** Every sheet in the workbook, keyed by its visible tab name. */
export function readWorkbook(file) {
  const files = unzip(readFileSync(file));

  const workbook = files.get('xl/workbook.xml');
  if (!workbook) throw new Error(`${file} has no xl/workbook.xml — not a spreadsheet, or it is corrupt`);
  const wb = workbook.toString('utf8');

  // rId → part name. Sheet order in workbook.xml is display order, which is not
  // necessarily sheet1.xml / sheet2.xml, so the relationship has to be followed.
  const rels = new Map(
    [...(files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '')
      .matchAll(/Id="([^"]+)"[^>]*?Target="([^"]+)"/g)]
      .map(([, id, target]) => [id, target.replace(/^\/?(xl\/)?/, 'xl/')])
  );

  const strings = sharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8'));

  const out = {};
  for (const m of wb.matchAll(/<sheet\s([^>]*)\/?>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[1])?.[1];
    const rid = /\br:id="([^"]+)"/.exec(m[1])?.[1];
    if (!name || !rid) continue;
    const part = files.get(rels.get(rid));
    if (!part) continue;
    out[unescapeXml(name)] = readSheet(part.toString('utf8'), strings);
  }
  if (!Object.keys(out).length) throw new Error(`${file} contains no readable sheets`);
  return out;
}
