#!/usr/bin/env node
// Builds docs/index.html (GitHub Pages site that reads docs/data/*.json)
// and dist/dashboard-snapshot.html (single file with the latest data embedded).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const body = fs.readFileSync(path.join(root, 'src/dashboard.html'), 'utf8');
const head = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">';
const [title, rest] = [body.slice(0, body.indexOf('</title>') + 8), body.slice(body.indexOf('</title>') + 8)];
const styleEnd = rest.indexOf('</style>') + 8;
fs.writeFileSync(path.join(root, 'docs/index.html'), `${head}${title}${rest.slice(0, styleEnd)}</head><body>${rest.slice(styleEnd)}</body></html>\n`);

const latest = path.join(root, 'docs/data/latest.json');
if (fs.existsSync(latest)) {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const data = fs.readFileSync(latest, 'utf8').replace(/</g, '\\u003c');
  const i = body.indexOf('<script>');
  fs.writeFileSync(path.join(root, 'dist/dashboard-snapshot.html'),
    body.slice(0, i) + `<script type="application/json" id="embedded-data">${data}</script>\n` + body.slice(i));
}
console.log('built docs/index.html' + (fs.existsSync(latest) ? ' and dist/dashboard-snapshot.html' : ''));
