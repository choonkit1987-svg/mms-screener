#!/usr/bin/env node
// Builds docs/index.html (GitHub Pages site that reads docs/data/*.json)
// docs/crypto/index.html (crypto page) and dist/*-snapshot.html (single files with data embedded).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const body = fs.readFileSync(path.join(root, 'src/dashboard.html'), 'utf8');
const head = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">';
const [title, rest] = [body.slice(0, body.indexOf('</title>') + 8), body.slice(body.indexOf('</title>') + 8)];
const styleEnd = rest.indexOf('</style>') + 8;
const page = `${head}${title}${rest.slice(0, styleEnd)}</head><body>${rest.slice(styleEnd)}</body></html>\n`;
fs.writeFileSync(path.join(root, 'docs/index.html'), page);
fs.mkdirSync(path.join(root, 'docs/crypto'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/crypto/index.html'), page.replace('<title>MMS Daily Screener</title>', '<title>MMS Crypto Screener</title>'));

const snaps = [['docs/data/latest.json', 'dist/dashboard-snapshot.html'], ['docs/crypto/data/latest.json', 'dist/crypto-snapshot.html']];
for (const [src, dst] of snaps) {
  const latest = path.join(root, src);
  if (!fs.existsSync(latest)) continue;
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const data = fs.readFileSync(latest, 'utf8').replace(/</g, '\\u003c');
  const b = src.includes('crypto') ? body.replace('<title>MMS Daily Screener</title>', '<title>MMS Crypto Screener</title>') : body;
  const allFile = path.join(path.dirname(latest), 'all.json');
  const all = fs.existsSync(allFile) ? `<script type="application/json" id="embedded-all">${fs.readFileSync(allFile, 'utf8').replace(/</g, '\\u003c')}</script>\n` : '';
  fs.writeFileSync(path.join(root, dst), b.slice(0, b.indexOf('<script>')) + `<script type="application/json" id="embedded-data">${data}</script>\n` + all + b.slice(b.indexOf('<script>')));
}
console.log('built docs/index.html, docs/crypto/index.html and snapshots');
