// Aggregate ./prices.raw.json into ./summary.json (dashboard-ready).
//
// Output shape (per fuel type):
//   kpi:       { total, fuelTypes, brands, regions, updated }
//   byFuelType:[{ fuelType, n, min, max, median, mean, p10, p90 }]
//   byBrand:   [{ brand, fuelType, n, median, mean, min, max }]
//   byRegion:  [{ region, fuelType, n, median, mean }]
//   topCheapest:[{ fuelType, stations: [{ name, address, region, price, brand, lat, lng }] }]
//   priceDist: [{ fuelType, bins: [{ low, high, count }] }]

const fs = require('fs');
const path = require('path');

const RAW = path.join(__dirname, 'prices.raw.json');
const OUT = path.join(__dirname, 'summary.json');
const LGA_GEO = path.join(__dirname, 'lga-nsw.geojson');

if (!fs.existsSync(RAW)) {
  console.error(`Missing ${RAW}. Run "node fetch-prices.js" first.`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
const stations = Array.isArray(raw.stations) ? raw.stations : [];
const prices   = Array.isArray(raw.prices)   ? raw.prices   : [];

// Station lookup by code (NSW API uses `code` as primary key)
const stnByCode = new Map();
for (const s of stations) {
  stnByCode.set(String(s.code), s);
}

// Keep only plausible prices
const rows = prices
  .filter(p => p && p.price && isFinite(+p.price) && +p.price > 50 && +p.price < 400)
  .map(p => {
    const s = stnByCode.get(String(p.stationcode)) || {};
    return {
      code: String(p.stationcode),
      fuelType: String(p.fueltype || '').toUpperCase(),
      price: +p.price,
      lastUpdated: p.lastupdated || null,
      name: s.name || 'Unknown',
      brand: s.brand || 'Unknown',
      address: s.address || '',
      lat: s.location?.latitude ?? null,
      lng: s.location?.longitude ?? null,
      state: s.state || 'NSW'
    };
  });

function quantile(sorted, q){
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function stats(arr){
  if (!arr.length) return null;
  const s = [...arr].sort((a,b) => a - b);
  const sum = s.reduce((a,b) => a + b, 0);
  return {
    n: s.length,
    min: s[0],
    max: s[s.length - 1],
    median: quantile(s, 0.5),
    mean: sum / s.length,
    p10: quantile(s, 0.10),
    p90: quantile(s, 0.90),
  };
}

function groupBy(rows, keyFn){
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// NSW region classifier — primary path uses lat/lng bounding boxes
// (deterministic, covers every station that reports coords), falls back to
// an address regex when coords are missing.
//
// Boxes are deliberately a touch generous to avoid sliver gaps. First match wins.
const REGION_BOXES = [
  // name                latMin   latMax   lngMin   lngMax
  ['Sydney',             -34.20,  -33.45,  150.50,  151.45],
  ['Central Coast',      -33.55,  -33.05,  151.05,  151.70],
  ['Hunter',             -33.05,  -32.00,  150.90,  152.60],
  ['Illawarra',          -34.90,  -34.20,  150.40,  151.10],
  ['South Coast',        -37.60,  -34.90,  149.30,  151.00],
  ['North Coast',        -32.00,  -28.15,  152.00,  153.70],
  ['Blue Mountains',     -34.20,  -33.20,  149.80,  150.50],
  ['Riverina/South',     -36.50,  -34.20,  143.00,  149.80],
  ['New England',        -31.00,  -28.15,  150.50,  152.50],
  ['Inland/West',        -34.90,  -28.15,  140.90,  150.50],
];

function classifyByCoords(lat, lng){
  if (lat == null || lng == null || !isFinite(+lat) || !isFinite(+lng)) return null;
  const la = +lat, lo = +lng;
  for (const [name, laMin, laMax, loMin, loMax] of REGION_BOXES) {
    if (la >= laMin && la <= laMax && lo >= loMin && lo <= loMax) return name;
  }
  return null;
}

function classifyByAddress(address){
  const a = (address || '').toUpperCase();
  if (/\b(SYDNEY|NORTH SYDNEY|PARRAMATTA|CHATSWOOD|BONDI|MANLY|RANDWICK|STRATHFIELD|BURWOOD|NEWTOWN|SURRY HILLS|MARRICKVILLE|ASHFIELD|HURSTVILLE|BLACKTOWN|BANKSTOWN|LIVERPOOL|CAMPBELLTOWN|PENRITH|HORNSBY|RYDE|LANE COVE|MOSMAN|WILLOUGHBY)\b/.test(a)) return 'Sydney';
  if (/\b(NEWCASTLE|LAKE MACQUARIE|MAITLAND|CESSNOCK|PORT STEPHENS|SINGLETON)\b/.test(a)) return 'Hunter';
  if (/\b(WOLLONGONG|SHELLHARBOUR|KIAMA|NOWRA|SHOALHAVEN)\b/.test(a)) return 'Illawarra';
  if (/\b(CENTRAL COAST|GOSFORD|WYONG|TUGGERAH|ERINA)\b/.test(a)) return 'Central Coast';
  if (/\b(COFFS HARBOUR|PORT MACQUARIE|BYRON|LISMORE|BALLINA|KEMPSEY|GRAFTON|TWEED HEADS)\b/.test(a)) return 'North Coast';
  if (/\b(ALBURY|WAGGA|GRIFFITH|DENILIQUIN|HAY|COOMA|QUEANBEYAN|JINDABYNE)\b/.test(a)) return 'Riverina/South';
  if (/\b(TAMWORTH|ARMIDALE|MOREE|INVERELL|NARRABRI|GUNNEDAH)\b/.test(a)) return 'New England';
  if (/\b(DUBBO|ORANGE|BATHURST|MUDGEE|LITHGOW|COWRA|PARKES|FORBES|BROKEN HILL)\b/.test(a)) return 'Inland/West';
  return 'Other NSW';
}

for (const r of rows) {
  r.region = classifyByCoords(r.lat, r.lng) || classifyByAddress(r.address);
}

// ==== LGA classifier (point-in-polygon against simplified NSW LGA boundaries) ====
// We precompute each polygon's bounding box for a fast reject, then run a
// ray-casting test on the remaining candidates. Handles Polygon + MultiPolygon.
let lgaIndex = [];
if (fs.existsSync(LGA_GEO)) {
  const gj = JSON.parse(fs.readFileSync(LGA_GEO, 'utf8'));
  for (const f of (gj.features || [])) {
    const name = (f.properties && (f.properties.lga_name || f.properties.abb_name)) || null;
    if (!name || !f.geometry) continue;
    const polys = f.geometry.type === 'Polygon'
      ? [f.geometry.coordinates]
      : (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : []);
    for (const rings of polys) {
      // bbox
      let minX =  Infinity, minY =  Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const ring of rings) {
        for (const [x, y] of ring) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      lgaIndex.push({ name, rings, bbox: [minX, minY, maxX, maxY] });
    }
  }
  console.log(`Loaded ${lgaIndex.length} LGA polygon parts from ${path.basename(LGA_GEO)}`);
} else {
  console.warn(`LGA boundaries file not found at ${LGA_GEO} — skipping LGA classification`);
}

function pointInRing(x, y, ring){
  // Standard ray-casting (even-odd rule)
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersects = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(x, y, rings){
  // rings[0] is outer ring; rings[1..] are holes
  if (!rings.length || !pointInRing(x, y, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(x, y, rings[i])) return false;
  }
  return true;
}

function classifyByLGA(lat, lng){
  if (lat == null || lng == null || !isFinite(+lat) || !isFinite(+lng)) return null;
  const x = +lng, y = +lat;
  for (const p of lgaIndex) {
    const [minX, minY, maxX, maxY] = p.bbox;
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    if (pointInPolygon(x, y, p.rings)) return p.name;
  }
  return null;
}

let lgaHits = 0;
for (const r of rows) {
  r.lga = classifyByLGA(r.lat, r.lng);
  if (r.lga) lgaHits++;
}
console.log(`LGA classification: ${lgaHits}/${rows.length} rows tagged (${((lgaHits/rows.length)*100).toFixed(1)}%)`);

// ==== aggregates ====
const byFuel = groupBy(rows, r => r.fuelType);

const byFuelType = [...byFuel.entries()].map(([fuelType, arr]) => {
  const s = stats(arr.map(r => r.price));
  return { fuelType, ...s };
}).sort((a,b) => b.n - a.n);

const byBrand = [];
for (const [fuelType, arr] of byFuel) {
  const brandGroups = groupBy(arr, r => r.brand);
  for (const [brand, bArr] of brandGroups) {
    if (bArr.length < 5) continue; // need a minimum sample
    const s = stats(bArr.map(r => r.price));
    byBrand.push({ brand, fuelType, ...s });
  }
}

const byRegion = [];
for (const [fuelType, arr] of byFuel) {
  const regionGroups = groupBy(arr, r => r.region);
  for (const [region, rArr] of regionGroups) {
    const s = stats(rArr.map(r => r.price));
    byRegion.push({ region, fuelType, ...s });
  }
}

const byLGA = [];
for (const [fuelType, arr] of byFuel) {
  const lgaGroups = groupBy(arr.filter(r => r.lga), r => r.lga);
  for (const [lga, lArr] of lgaGroups) {
    if (lArr.length < 2) continue; // require at least 2 stations for a stable median
    const s = stats(lArr.map(r => r.price));
    byLGA.push({ lga, fuelType, ...s });
  }
}

const topCheapest = [];
for (const [fuelType, arr] of byFuel) {
  const top = [...arr].sort((a,b) => a.price - b.price).slice(0, 15)
    .map(r => ({
      name: r.name, brand: r.brand, address: r.address,
      region: r.region, price: r.price, lat: r.lat, lng: r.lng
    }));
  topCheapest.push({ fuelType, stations: top });
}

const priceDist = [];
for (const [fuelType, arr] of byFuel) {
  const vals = arr.map(r => r.price).sort((a,b) => a - b);
  if (!vals.length) continue;
  const lo = Math.floor(vals[0] / 5) * 5;
  const hi = Math.ceil(vals[vals.length - 1] / 5) * 5;
  const bins = [];
  for (let b = lo; b < hi; b += 5) {
    const count = vals.filter(v => v >= b && v < b + 5).length;
    bins.push({ low: b, high: b + 5, count });
  }
  priceDist.push({ fuelType, bins });
}

// Full station/price payload for the in-browser "Worth the drive?" calculator.
// We dedupe stations (one row per code) then emit per-fuel price maps keyed by
// station index. Keeps the payload compact (~500 KB -> ~150 KB gzipped).
const stnIndex = new Map();
const stnList = [];
for (const r of rows) {
  if (stnIndex.has(r.code)) continue;
  stnIndex.set(r.code, stnList.length);
  stnList.push({
    code: r.code,
    name: r.name,
    brand: r.brand,
    address: r.address,
    region: r.region,
    lga: r.lga || null,
    lat: r.lat,
    lng: r.lng
  });
}
const pricesByFuel = {};
for (const r of rows) {
  const i = stnIndex.get(r.code);
  if (i == null) continue;
  if (!pricesByFuel[r.fuelType]) pricesByFuel[r.fuelType] = [];
  pricesByFuel[r.fuelType].push({ i, p: r.price });
}

const out = {
  kpi: {
    total: rows.length,
    fuelTypes: byFuel.size,
    brands: new Set(rows.map(r => r.brand)).size,
    regions: new Set(rows.map(r => r.region)).size,
    updated: raw.fetchedAt || new Date().toISOString()
  },
  byFuelType,
  byBrand: byBrand.sort((a,b) => a.median - b.median),
  byRegion: byRegion.sort((a,b) => a.region.localeCompare(b.region)),
  byLGA: byLGA.sort((a,b) => a.lga.localeCompare(b.lga)),
  topCheapest,
  priceDist,
  // Full dataset for client-side calculator
  stations: stnList,
  prices: pricesByFuel
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`Rows: ${rows.length} | Fuel types: ${byFuel.size} | Brands: ${out.kpi.brands} | Regions: ${out.kpi.regions}`);
console.log('Fuel type breakdown:', byFuelType.map(f => `${f.fuelType}:${f.n}`).join(' | '));
