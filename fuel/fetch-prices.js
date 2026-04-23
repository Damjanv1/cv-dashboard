// Fetch full-state NSW fuel price snapshot from api.nsw.gov.au.
// Writes ./prices.raw.json
//
// Requires env vars:
//   NSW_FUEL_KEY    - consumer key
//   NSW_FUEL_SECRET - consumer secret
//
// Locally: use .env.local (see .env.example)
// CI: use repo secrets (GitHub Actions -> Settings -> Secrets)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load .env.local if present (local dev). Not needed in CI.
try { require('dotenv').config({ path: path.join(__dirname, '.env.local') }); } catch (_) {}

const KEY = process.env.NSW_FUEL_KEY;
const SECRET = process.env.NSW_FUEL_SECRET;

if (!KEY || !SECRET) {
  console.error('Missing NSW_FUEL_KEY / NSW_FUEL_SECRET. Set them in fuel/.env.local or as CI secrets.');
  process.exit(1);
}

const BASE = 'https://api.onegov.nsw.gov.au';
const TOKEN_URL = `${BASE}/oauth/client_credential/accesstoken?grant_type=client_credentials`;
const PRICES_URL = `${BASE}/FuelPriceCheck/v1/fuel/prices`;

function authHeader(){
  return 'Basic ' + Buffer.from(`${KEY}:${SECRET}`).toString('base64');
}

function nowNswStamp(){
  // API wants dd/MM/yyyy HH:mm:ss in AEST.
  const d = new Date();
  const fmt = (n) => String(n).padStart(2, '0');
  return `${fmt(d.getDate())}/${fmt(d.getMonth()+1)}/${d.getFullYear()} ${fmt(d.getHours())}:${fmt(d.getMinutes())}:${fmt(d.getSeconds())}`;
}

async function getToken(){
  const res = await fetch(TOKEN_URL, {
    method: 'GET',
    headers: { 'Authorization': authHeader() }
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (!body.access_token) throw new Error('No access_token in response: ' + JSON.stringify(body));
  return body.access_token;
}

async function fetchAllPrices(token){
  const res = await fetch(PRICES_URL, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'apikey': KEY,
      'transactionid': crypto.randomUUID(),
      'requesttimestamp': nowNswStamp(),
      'Content-Type': 'application/json; charset=utf-8',
      'Accept': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`Prices request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

(async () => {
  console.log('Requesting access token...');
  const token = await getToken();
  console.log('Token ok. Fetching full-state price snapshot...');
  const data = await fetchAllPrices(token);

  const stations = Array.isArray(data.stations) ? data.stations.length : 0;
  const prices = Array.isArray(data.prices) ? data.prices.length : 0;
  console.log(`Received ${stations} stations, ${prices} price records.`);

  const out = {
    fetchedAt: new Date().toISOString(),
    ...data
  };

  const outFile = path.join(__dirname, 'prices.raw.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`Wrote ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(1)} KB)`);
})().catch(e => {
  console.error('Fetch failed:', e.message);
  process.exit(1);
});
