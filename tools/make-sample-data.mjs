#!/usr/bin/env node
/**
 * Generates SYNTHETIC hospital + doctor inventory so the public demo works
 * without shipping the real network. Run: npm run sample
 *
 * Real data comes from tools/sync.mjs. These two write the same shape, so the
 * app cannot tell them apart — only `meta.json.source` differs.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Real taxonomy (generic medical specialities), invented hospitals and doctors.
const SPECIALITIES = ["AyurVaid ENT","AyurVaid General Medicine","AyurVaid General Surgery","AyurVaid OBG","Ayurveda","CTVS","Cardiology","Critical Care Medicine","Dentistry","Dermataology","ENT","Emergency Medicine","Endocrinology","Fetal Medicine","General Medicine","General Surgery","Hair Transplant","Hair Transplant & Dermataology","IVF & Gynec","Internal Medicine","Interventional Radiology","Laparoscopy","Medical Cosmetology","Medical Gastroenterology","Medical Oncology","NEPHROLOGY","Neonatology","Nephrology","Neurosurgery","OBG","ONCOLOGY","Oncology","Ophthalmology","Ortho Surgery","Pediatric Neurology","Pediatrics","Pediatrics and Neonatology","Pharmacology","Plastic Surgery","Pulmonology","Radiation Oncology","Radiology","Reproductive Medicine","Rheumatology","Surgical Gastroenterology","Surgical Oncology","Urology","Vascular Surgery"];

const INSURERS = ["Acko","Aditya Birla","Bajaj Allianz","Bharti AXA","Care Health","Cholamandalam MS","Edelweiss","Future Generali","Go Digit","HDFC Ergo","ICICI Lombard","IFFCO Tokio","IndiaFirst","Kotak Mahindra","Liberty","Magma HDI","Manipal Cigna","Medvantage","National Insurance","Navi","New India Assurance","Niva Bupa","Oriental Insurance","Other insurers","Raheja QBE","Reliance General","Reliance Life","Royal Sundaram","SBI General","Self-pay / Cash","Shikhar","Star Health","Tata AIA","Tata AIG","United India","Universal Sompo"];

// city → [lat, lon, count of hospitals, state, a real pincode in that city]
// The pincode is genuine so the sample build exercises the same shard lookup the
// real one does — a synthetic pincode would make the whole distance path untested.
const CITIES = [
  ['Bengaluru', 12.9716, 77.5946, 22, 'Karnataka', '560001'],
  ['Hyderabad', 17.385, 78.4867, 18, 'Telangana', '500001'],
  ['Chennai', 13.0827, 80.2707, 14, 'Tamil Nadu', '600001'],
  ['Mumbai', 19.076, 72.8777, 16, 'Maharashtra', '400001'],
  ['Pune', 18.5204, 73.8567, 12, 'Maharashtra', '411001'],
  ['Delhi', 28.6139, 77.209, 14, 'Delhi', '110001'],
  ['Gurugram', 28.4595, 77.0266, 9, 'Haryana', '122001'],
  ['Noida', 28.5355, 77.391, 8, 'Uttar Pradesh', '201301'],
  ['Kolkata', 22.5726, 88.3639, 10, 'West Bengal', '700001'],
  ['Ahmedabad', 23.0225, 72.5714, 8, 'Gujarat', '380015'],
  ['Jaipur', 26.9124, 75.7873, 7, 'Rajasthan', '302001'],
  ['Lucknow', 26.8467, 80.9462, 6, 'Uttar Pradesh', '226001'],
  ['Coimbatore', 11.0168, 76.9558, 5, 'Tamil Nadu', '641001'],
  ['Indore', 22.7196, 75.8577, 5, 'Madhya Pradesh', '452001'],
  ['Chandigarh', 30.7333, 76.7794, 5, 'Chandigarh', '160001'],
];

const LOCALITIES = ['Whitefield', 'Indiranagar', 'Andheri West', 'Powai', 'Banjara Hills',
  'Gachibowli', 'Anna Nagar', 'T. Nagar', 'Sector 44', 'Salt Lake', 'Kothrud', 'Baner',
  'Vaishali Nagar', 'Gomti Nagar', 'Satellite', 'Civil Lines', 'Kalyani Nagar', 'HSR Layout'];

const PREFIX = ['Aster', 'Meridian', 'Northstar', 'Sunrise', 'Cordia', 'Vantage', 'Lakeview',
  'Greenfield', 'Everwell', 'Trident', 'Silverline', 'Harmony', 'Beacon', 'Crestview', 'Orchid'];
const SUFFIX = ['Multispeciality Hospital', 'Institute of Surgery', 'Medical Centre',
  'Speciality Clinic', 'Healthcare', 'Surgical Institute', 'Care Hospital'];

const FIRST = ['Ananya', 'Rahul', 'Priya', 'Vikram', 'Meera', 'Arjun', 'Kavya', 'Sanjay',
  'Divya', 'Rohan', 'Ishita', 'Karthik', 'Neha', 'Aditya', 'Shreya', 'Manish', 'Pooja',
  'Nikhil', 'Anjali', 'Farhan', 'Ritu', 'Suresh', 'Lakshmi', 'Imran'];
const LAST = ['Sharma', 'Reddy', 'Iyer', 'Patel', 'Nair', 'Gupta', 'Menon', 'Bose', 'Rao',
  'Kulkarni', 'Desai', 'Chatterjee', 'Pillai', 'Malhotra', 'Joshi', 'Banerjee'];

// deterministic PRNG so regenerating gives identical output
let seed = 20260906;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const pickN = (a, n) => {
  const s = new Set();
  while (s.size < Math.min(n, a.length)) s.add(pick(a));
  return [...s];
};
const jitter = (v, km) => v + (rnd() - 0.5) * (km / 111) * 2;

const hospitals = [];
const doctors = [];
let hn = 0, dn = 0;

for (const [city, clat, clon, count, state, pin] of CITIES) {
  for (let i = 0; i < count; i++) {
    hn++;
    const code = `H${String(hn).padStart(4, '0')}`;
    const specs = pickN(SPECIALITIES, 3 + Math.floor(rnd() * 7));
    const name = `${pick(PREFIX)} ${pick(SUFFIX)}`;
    const lat = +jitter(clat, 18).toFixed(5);
    const lon = +jitter(clon, 18).toFixed(5);
    const ipd = Math.floor(rnd() * 900) + 20;
    const rating = +(3.2 + rnd() * 1.8).toFixed(1);
    const reviews = Math.floor(rnd() * 3000);
    hospitals.push({
      code,
      name,
      nameShort: name.split(' ')[0] + ' ' + city,
      city,
      locality: pick(LOCALITIES),
      state,
      address: `${Math.floor(rnd() * 200) + 1}, ${pick(LOCALITIES)}, ${city}`,
      pincode: pin,
      lat,
      lon,
      ipd,
      rating,
      reviews,
      // Same formula as tools/lib.mjs — the sample build must exercise the real
      // ranking, or the one people can actually see is the one that isn't tested.
      score: +(Math.log10(1 + ipd) * 1.0 + Math.log10(1 + reviews) * 0.5 * (rating / 5)).toFixed(4),
      specialities: specs,
      insurers: pickN(INSURERS, 4 + Math.floor(rnd() * 10)),
      mapUrl: `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`,
    });

    for (const sp of specs) {
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        dn++;
        doctors.push({
          code: `D${String(dn).padStart(5, '0')}`,
          hospitalCode: code,
          name: `Dr. ${pick(FIRST)} ${pick(LAST)}`,
          speciality: sp,
          qualification: pick(['MBBS, MS', 'MBBS, MS, MCh', 'MBBS, DNB', 'MBBS, MS, FMAS', 'MBBS, MD']),
          experienceYears: 3 + Math.floor(rnd() * 27),
        });
      }
    }
  }
}

const meta = {
  generatedAt: new Date().toISOString(),
  source: 'sample',
  note: 'Synthetic demo inventory. Hospital names, doctors and coordinates are invented.',
  hospitalCount: hospitals.length,
  doctorCount: doctors.length,
  specialities: [...new Set(hospitals.flatMap((h) => h.specialities))].sort(),
  insurers: [...new Set(hospitals.flatMap((h) => h.insurers))].sort(),
  cityCount: new Set(hospitals.map((h) => h.city)).size,
};

const w = (f, o) => writeFileSync(join(ROOT, 'data', f), JSON.stringify(o));
w('hospitals.json', hospitals);
w('doctors.json', doctors);
writeFileSync(join(ROOT, 'data', 'meta.json'), JSON.stringify(meta, null, 2));

console.log(`sample data written`);
console.log(`  hospitals   ${hospitals.length}`);
console.log(`  doctors     ${doctors.length}`);
console.log(`  specialities ${meta.specialities.length}`);
console.log(`  insurers    ${meta.insurers.length}`);
console.log(`  cities      ${meta.cityCount}`);
