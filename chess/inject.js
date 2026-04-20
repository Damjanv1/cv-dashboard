// Inject summary.json into the template to produce the final standalone HTML
const fs = require('fs');
const path = require('path');

const tmpl = fs.readFileSync(path.join(__dirname, 'chess-dashboard-template.html'), 'utf8');
const data = fs.readFileSync(path.join(__dirname, 'summary.min.json'), 'utf8');

const out = tmpl.replace('__DATA_PLACEHOLDER__', data);
const outPath = path.join(__dirname, '..', 'chess-dashboard.html');
fs.writeFileSync(outPath, out);
console.log('Wrote', outPath, '-', fs.statSync(outPath).size, 'bytes');
