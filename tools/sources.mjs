/**
 * Where a refresh can get its rows from. Four sources, one shape: a header row
 * followed by data rows, exactly as a spreadsheet hands them over.
 *
 *   xlsx    incoming/Inventory.xlsx        the normal route
 *   csv     incoming/Bot_Hosp.csv + Bot_Doc.csv
 *   sheet   Google Sheets API, or published-CSV URLs
 *   sample  generated, for the public demo
 *
 * Returning raw rows rather than finished records is the point: every source then
 * goes through the same buildHospitals / buildDoctors in lib.mjs, so they cannot
 * drift apart. They already had — the old sync.mjs re-implemented the whole
 * pipeline and quietly omitted Rating and Reviews, so a Sheets-API refresh
 * published a network with no ratings and the rating sort silently did nothing.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSign } from 'node:crypto';
import { ROOT, CFG, parseCsv, die } from './lib.mjs';
import { readWorkbook } from './xlsx.mjs';

const at = (...p) => join(ROOT, ...p);

/* ── xlsx ─────────────────────────────────────────────────────────────────── */

export const WORKBOOK = at('incoming', CFG.workbook);

function fromWorkbook(file = WORKBOOK) {
  if (!existsSync(file)) {
    die(`missing ${file}\n  Save the inventory workbook there — both tabs, one file — and run this again.`);
  }
  const wb = readWorkbook(file);
  const pick = (tab) => {
    if (wb[tab]) return wb[tab];
    // Tab renamed or re-cased: match loosely before giving up, because "Bot_hosp"
    // is not worth a failed refresh.
    const hit = Object.keys(wb).find((k) => k.toLowerCase() === tab.toLowerCase());
    if (hit) return wb[hit];
    die(`${file} has no "${tab}" tab. It contains: ${Object.keys(wb).join(', ')}`);
  };
  return { hospitals: pick(CFG.hospitals.tab), doctors: pick(CFG.doctors.tab), source: 'workbook' };
}

/* ── csv ──────────────────────────────────────────────────────────────────── */

function fromCsv() {
  const read = (tab) => {
    const p = at('incoming', `${tab}.csv`);
    if (!existsSync(p)) die(`missing ${p}\n  Export the "${tab}" tab as CSV and save it there.`);
    return parseCsv(readFileSync(p, 'utf8'));
  };
  return { hospitals: read(CFG.hospitals.tab), doctors: read(CFG.doctors.tab), source: 'sheet-csv' };
}

/* ── google sheet ─────────────────────────────────────────────────────────── */

async function accessToken(saJson) {
  const sa = JSON.parse(saJson);
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claim = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })}`;
  const sig = createSign('RSA-SHA256').update(claim).sign(sa.private_key, 'base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${claim}.${sig}`,
    }),
  });
  if (!res.ok) die(`token exchange failed (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

async function fromSheet() {
  const sa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const token = sa ? await accessToken(sa) : null;
  console.log(`auth: ${token ? 'service account' : 'published CSV'}`);

  const tab = async (name, csvUrlEnv) => {
    if (token) {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}/values/${encodeURIComponent(name)}?majorDimension=ROWS`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) die(`sheets api ${res.status} for tab "${name}": ${await res.text()}`);
      const values = (await res.json()).values || [];
      if (!values.length) die(`tab "${name}" is empty`);
      return values;
    }
    const url = process.env[csvUrlEnv];
    if (!url) die(`no auth: set GOOGLE_SERVICE_ACCOUNT_JSON, or ${csvUrlEnv} for a published sheet`);
    const res = await fetch(url);
    if (!res.ok) die(`csv fetch ${res.status} for ${csvUrlEnv}`);
    return parseCsv(await res.text());
  };

  return {
    hospitals: await tab(CFG.hospitals.tab, 'SHEET_CSV_HOSP'),
    doctors: await tab(CFG.doctors.tab, 'SHEET_CSV_DOC'),
    source: 'sheet',
  };
}

/* ── sample ───────────────────────────────────────────────────────────────── */

/* Synthetic inventory for the public demo: invented hospitals and doctors on the
   real speciality taxonomy, so every mapping path is exercised without publishing
   the network. Emitted as rows through the same builder as the real thing —
   generating finished records instead would leave the real path untested by
   `npm run sample`, which is the only build most people can run. */

const SPECIALITIES = ['AyurVaid ENT', 'AyurVaid General Medicine', 'AyurVaid General Surgery', 'AyurVaid OBG',
  'Ayurveda', 'CTVS', 'Cardiology', 'Critical Care Medicine', 'Dentistry', 'Dermataology', 'ENT',
  'Emergency Medicine', 'Endocrinology', 'Fetal Medicine', 'General Medicine', 'General Surgery',
  'Hair Transplant', 'Hair Transplant & Dermataology', 'IVF & Gynec', 'Internal Medicine',
  'Interventional Radiology', 'Laparoscopy', 'Medical Cosmetology', 'Medical Gastroenterology',
  'Medical Oncology', 'NEPHROLOGY', 'Neonatology', 'Nephrology', 'Neurosurgery', 'OBG', 'ONCOLOGY',
  'Oncology', 'Ophthalmology', 'Ortho Surgery', 'Pediatric Neurology', 'Pediatrics',
  'Pediatrics and Neonatology', 'Pharmacology', 'Plastic Surgery', 'Pulmonology', 'Radiation Oncology',
  'Radiology', 'Reproductive Medicine', 'Rheumatology', 'Surgical Gastroenterology', 'Surgical Oncology',
  'Urology', 'Vascular Surgery'];

const INSURERS = ['Acko', 'Aditya Birla', 'Bajaj Allianz', 'Bharti AXA', 'Care Health', 'Cholamandalam MS',
  'Edelweiss', 'Future Generali', 'Go Digit', 'HDFC Ergo', 'ICICI Lombard', 'IFFCO Tokio', 'IndiaFirst',
  'Kotak Mahindra', 'Liberty', 'Magma HDI', 'Manipal Cigna', 'Medvantage', 'National Insurance', 'Navi',
  'New India Assurance', 'Niva Bupa', 'Oriental Insurance', 'Raheja QBE', 'Reliance General',
  'Royal Sundaram', 'SBI General', 'Shikhar', 'Star Health', 'Tata AIG', 'United India', 'Universal Sompo'];

// city → lat, lon, hospitals, state, a REAL pincode in that city. Genuine so the
// sample build exercises the same shard lookup the real one does; a made-up
// pincode would leave the whole distance path untested.
const CITIES = [
  ['Bengaluru', 12.9716, 77.5946, 22, 'Karnataka', '560001'],
  ['Hyderabad', 17.3850, 78.4867, 18, 'Telangana', '500001'],
  ['Chennai', 13.0827, 80.2707, 14, 'Tamil Nadu', '600001'],
  ['Mumbai', 19.0760, 72.8777, 16, 'Maharashtra', '400001'],
  ['Pune', 18.5204, 73.8567, 12, 'Maharashtra', '411001'],
  ['Delhi', 28.6139, 77.2090, 14, 'Delhi', '110001'],
  ['Gurugram', 28.4595, 77.0266, 9, 'Haryana', '122001'],
  ['Noida', 28.5355, 77.3910, 8, 'Uttar Pradesh', '201301'],
  ['Kolkata', 22.5726, 88.3639, 10, 'West Bengal', '700001'],
  ['Ahmedabad', 23.0225, 72.5714, 8, 'Gujarat', '380015'],
  ['Jaipur', 26.9124, 75.7873, 7, 'Rajasthan', '302001'],
  ['Lucknow', 26.8467, 80.9462, 6, 'Uttar Pradesh', '226001'],
  ['Coimbatore', 11.0168, 76.9558, 5, 'Tamil Nadu', '641001'],
  ['Indore', 22.7196, 75.8577, 5, 'Madhya Pradesh', '452001'],
  ['Chandigarh', 30.7333, 76.7794, 5, 'Chandigarh', '160001'],
];

const LOCALITIES = ['Whitefield', 'Indiranagar', 'Andheri West', 'Powai', 'Banjara Hills', 'Gachibowli',
  'Anna Nagar', 'T. Nagar', 'Sector 44', 'Salt Lake', 'Kothrud', 'Baner', 'Vaishali Nagar',
  'Gomti Nagar', 'Satellite', 'Civil Lines', 'Kalyani Nagar', 'HSR Layout'];
const PREFIX = ['Aster', 'Meridian', 'Northstar', 'Sunrise', 'Cordia', 'Vantage', 'Lakeview', 'Greenfield',
  'Everwell', 'Trident', 'Silverline', 'Harmony', 'Beacon', 'Crestview', 'Orchid'];
const SUFFIX = ['Multispeciality Hospital', 'Institute of Surgery', 'Medical Centre', 'Speciality Clinic',
  'Healthcare', 'Surgical Institute', 'Care Hospital'];
const FIRST = ['Ananya', 'Rahul', 'Priya', 'Vikram', 'Meera', 'Arjun', 'Kavya', 'Sanjay', 'Divya', 'Rohan',
  'Ishita', 'Karthik', 'Neha', 'Aditya', 'Shreya', 'Manish', 'Pooja', 'Nikhil', 'Anjali', 'Farhan',
  'Ritu', 'Suresh', 'Lakshmi', 'Imran'];
const LAST = ['Sharma', 'Reddy', 'Iyer', 'Patel', 'Nair', 'Gupta', 'Menon', 'Bose', 'Rao', 'Kulkarni',
  'Desai', 'Chatterjee', 'Pillai', 'Malhotra', 'Joshi', 'Banerjee'];

function fromSample() {
  let seed = 20260906;                                  // fixed, so output is reproducible
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const pickN = (a, n) => {
    const s = new Set();
    while (s.size < Math.min(n, a.length)) s.add(pick(a));
    return [...s];
  };
  const jitter = (v, km) => +(v + (rnd() - 0.5) * (km / 111) * 2).toFixed(5);

  // Headers are taken from config.json rather than written out, so a renamed
  // column cannot make the sample build pass while the real one fails.
  const head = (c) => Object.values(c.columns).map((aliases) => aliases[0]);
  const hospitals = [head(CFG.hospitals)];
  const doctors = [head(CFG.doctors)];
  const hCol = Object.keys(CFG.hospitals.columns);
  const dCol = Object.keys(CFG.doctors.columns);
  const row = (keys, values) => keys.map((k) => values[k] ?? '');

  let hn = 0, dn = 0;
  for (const [city, clat, clon, count, state, pin] of CITIES) {
    for (let i = 0; i < count; i++) {
      // Plain integers, like the real inventory — so the sample build exercises
      // the real detail-shard rule instead of dropping every hospital into the
      // non-numeric fallback bucket.
      const code = String(++hn);
      const specs = pickN(SPECIALITIES, 3 + Math.floor(rnd() * 7));
      const name = `${pick(PREFIX)} ${pick(SUFFIX)}`;
      const lat = jitter(clat, 18), lon = jitter(clon, 18);
      hospitals.push(row(hCol, {
        code, status: CFG.hospitals.activeValue,
        name, nameShort: `${name.split(' ')[0]} ${city}`,
        lat, lon, city, locality: pick(LOCALITIES), state,
        address: `${Math.floor(rnd() * 200) + 1}, ${pick(LOCALITIES)}, ${city}`,
        pincode: pin,
        ipd: Math.floor(rnd() * 900) + 20,
        rating: (3.2 + rnd() * 1.8).toFixed(1),
        reviews: Math.floor(rnd() * 3000),
        specialities: specs.join(CFG.listSeparator),
        insurers: pickN(INSURERS, 4 + Math.floor(rnd() * 10)).join(CFG.listSeparator),
        mapUrl: '',
      }));

      for (const sp of specs) {
        for (let k = 1 + Math.floor(rnd() * 3); k > 0; k--) {
          doctors.push(row(dCol, {
            code: `D${String(++dn).padStart(5, '0')}`,
            hospitalCode: code, status: CFG.doctors.activeValue,
            name: `Dr. ${pick(FIRST)} ${pick(LAST)}`,
            speciality: sp,
            qualification: pick(['MBBS, MS', 'MBBS, MS, MCh', 'MBBS, DNB', 'MBBS, MS, FMAS', 'MBBS, MD']),
            experienceYears: `${3 + Math.floor(rnd() * 27)} Years`,
            schedule: pick(['9:00 AM to 1:00 PM Mon–Sat', '10 AM to 4 PM', '5 PM to 8 PM Mon–Fri']),
            type: pick(['Visiting Consultant', 'Full Time', '']),
          }));
        }
      }
    }
  }
  return { hospitals, doctors, source: 'sample' };
}

/* ── chooser ──────────────────────────────────────────────────────────────── */

export const SOURCES = ['auto', 'xlsx', 'csv', 'sheet', 'sample'];

export async function readSource(which = 'auto') {
  if (which === 'auto') {
    if (existsSync(WORKBOOK)) which = 'xlsx';
    else if (existsSync(at('incoming', `${CFG.hospitals.tab}.csv`))) which = 'csv';
    else die(`nothing to import.\n  Save the inventory as incoming/${CFG.workbook}, or run with --source=sheet`);
  }
  if (which === 'xlsx') return fromWorkbook();
  if (which === 'csv') return fromCsv();
  if (which === 'sheet') return fromSheet();
  if (which === 'sample') return fromSample();
  die(`unknown source "${which}" — one of ${SOURCES.join(', ')}`);
}
