#!/usr/bin/env node
/**
 * India Post pincode CSV  ->  data/pincodes/<first-3-digits>.json
 *
 *   node tools/build-pincodes.mjs path/to/pincodes.csv
 *
 * Why this exists, and why it is not a straight copy of the source file:
 *
 * The source has one row per POST OFFICE (160,092 of them) across 19,441
 * pincodes, and some of those coordinates are wrong. Averaging them per
 * pincode gives a "centre" that is 117 km wide at the 90th percentile and
 * 1,119 km wide at the 99th — bad enough to route someone to another state.
 *
 * So: take the MEDIAN per pincode, drop any office more than 50 km from it,
 * and re-take the median. That removes ~10,100 bad rows across 21% of
 * pincodes and brings the residual error to 3.5 km median / 17.5 km p90.
 *
 * Output is sharded by the first three digits so a search downloads ~2 KB
 * instead of the whole 900 KB table.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, parseCsv, die } from './lib.mjs';

const src = process.argv[2];
if (!src) die('usage: node tools/build-pincodes.mjs <pincodes.csv>');

const rows = parseCsv(readFileSync(src, 'utf8'));
const head = rows[0].map((h) => h.trim().toLowerCase());
const col = (n) => head.indexOf(n);
const [iPin, iLat, iLon, iDist, iState] =
  ['pincode', 'latitude', 'longitude', 'district', 'state'].map(col);
if ([iPin, iLat, iLon].some((i) => i < 0)) die('CSV needs pincode, latitude and longitude columns');

const byPin = new Map();
for (const r of rows.slice(1)) {
  const pin = String(r[iPin]).replace(/\D/g, '').padStart(6, '0');
  const lat = parseFloat(r[iLat]), lon = parseFloat(r[iLon]);
  if (pin.length !== 6 || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  if (lat < 6 || lat > 38 || lon < 68 || lon > 98) continue;   // outside India
  if (!byPin.has(pin)) byPin.set(pin, { lat: [], lon: [], district: r[iDist], state: r[iState] });
  const g = byPin.get(pin);
  g.lat.push(lat); g.lon.push(lon);
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

let droppedOffices = 0, pinsCleaned = 0;
const shards = new Map();
for (const [pin, g] of byPin) {
  const mLat = median(g.lat), mLon = median(g.lon);
  const keep = g.lat.map((_, i) =>
    Math.abs(g.lat[i] - mLat) * 111 < 50 && Math.abs(g.lon[i] - mLon) * 100 < 50);
  const n = keep.filter(Boolean).length;
  const drop = keep.length - n;
  if (drop) { droppedOffices += drop; pinsCleaned++; }
  const use = n ? keep : keep.map(() => true);
  const lat = +median(g.lat.filter((_, i) => use[i])).toFixed(4);
  const lon = +median(g.lon.filter((_, i) => use[i])).toFixed(4);
  const pre = pin.slice(0, 3);
  if (!shards.has(pre)) shards.set(pre, {});
  shards.get(pre)[pin] = [lat, lon, g.district || '', g.state || ''];
}

const dir = join(ROOT, 'data', 'pincodes');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
for (const [pre, obj] of shards) writeFileSync(join(dir, `${pre}.json`), JSON.stringify(obj));
writeFileSync(join(dir, '_index.json'), JSON.stringify({
  pincodeCount: byPin.size, shardCount: shards.size,
  droppedOffices, pinsCleaned,
  method: 'median lat/long per pincode, after dropping offices >50km from that median',
}, null, 1));

console.log(`pincodes ${byPin.size}  shards ${shards.size}`);
console.log(`cleaned  ${pinsCleaned} pincodes (${((pinsCleaned / byPin.size) * 100).toFixed(1)}%), ${droppedOffices} outlier offices dropped`);
