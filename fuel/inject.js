// Inject summary.min.json into fuel-dashboard-template.html -> ../fuel-dashboard.html
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, 'fuel-dashboard-template.html');
const DATA     = path.join(__dirname, 'summary.min.json');
const OUT      = path.join(__dirname, '..', 'fuel-dashboard.html');

if (!fs.existsSync(DATA)) {
  console.error(`Missing ${DATA}. Run aggregate first, then minify.`);
  process.exit(1);
}
if (!fs.existsSync(TEMPLATE)) {
  console.error(`Missing ${TEMPLATE}.`);
  process.exit(1);
}

const tpl = fs.readFileSync(TEMPLATE, 'utf8');
const json = fs.readFileSync(DATA, 'utf8');
const out = tpl.replace('__DATA_PLACEHOLDER__', json);

fs.writeFileSync(OUT, out);
console.log(`Wrote ${OUT} - ${fs.statSync(OUT).size} bytes`);

// Copy LGA boundaries next to the dashboard so the client can lazy-load them
const LGA_SRC = path.join(__dirname, 'lga-nsw.geojson');
const LGA_DST = path.join(__dirname, '..', 'lga-nsw.geojson');
if (fs.existsSync(LGA_SRC)) {
  fs.copyFileSync(LGA_SRC, LGA_DST);
  console.log(`Copied ${LGA_DST} - ${fs.statSync(LGA_DST).size} bytes`);
} else {
  console.warn(`No ${LGA_SRC} - LGA choropleth tier will be unavailable in the dashboard`);
}
