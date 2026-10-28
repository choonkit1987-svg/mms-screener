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
// [folder, page title, snapshot file]
const MARKETS = [['', 'MMS US Stocks Screener', 'dashboard'],
  ['bursa', 'MMS Bursa Screener', 'bursa'], ['china', 'MMS China Screener', 'china'], ['watch', 'MMS Watchlist', 'watch'], ['crypto', 'MMS Crypto Screener', 'crypto']];
const retitle = (html, t) => html.replace('<title>MMS Daily Screener</title>', `<title>${t}</title>`);
for (const [dir, t, snap] of MARKETS) {
  const out = path.join(root, 'docs', dir);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'index.html'), retitle(page, t));
  // single-file snapshot with the latest data embedded (for sharing / offline)
  const latest = path.join(out, 'data/latest.json');
  if (!fs.existsSync(latest)) continue;
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const b = retitle(body, t), esc = f => fs.readFileSync(f, 'utf8').replace(/</g, '\\u003c');
  const allFile = path.join(out, 'data/all.json');
  const all = fs.existsSync(allFile) ? `<script type="application/json" id="embedded-all">${esc(allFile)}</script>\n` : '';
  fs.writeFileSync(path.join(root, `dist/${snap}-snapshot.html`), b.slice(0, b.indexOf('<script>')) + `<script type="application/json" id="embedded-data">${esc(latest)}</script>\n` + all + b.slice(b.indexOf('<script>')));
}
// The Nasdaq-100 and Dow pages are now part of US Stocks: old links forward there (a ticker in the link is kept)
for (const dir of ['nasdaq', 'dow']) {
  fs.mkdirSync(path.join(root, 'docs', dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', dir, 'index.html'), `${head}<title>MMS US Stocks Screener</title><meta http-equiv="refresh" content="0; url=../"><link rel="canonical" href="../"><script>location.replace('../'+location.hash)</script></head><body><p>This page is now part of <a href="../">US Stocks</a>.</p></body></html>\n`);
}
// Agent Desk page (docs/agents/) + a single-file snapshot with both markets embedded
{
  const deskBody = fs.readFileSync(path.join(root, 'src/desk/dashboard.html'), 'utf8');
  const [dt, drest] = [deskBody.slice(0, deskBody.indexOf('</title>') + 8), deskBody.slice(deskBody.indexOf('</title>') + 8)];
  const dEnd = drest.indexOf('</style>') + 8;
  const out = path.join(root, 'docs/agents');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'index.html'), `${head}${dt}${drest.slice(0, dEnd)}</head><body>${drest.slice(dEnd)}</body></html>\n`);
  const emb = ['us', 'crypto'].map(m => path.join(out, `data/${m}.json`)).filter(f => fs.existsSync(f))
    .map(f => `<script type="application/json" id="embedded-${path.basename(f, '.json')}">${fs.readFileSync(f, 'utf8').replace(/</g, '\\u003c')}</script>\n`).join('');
  if (emb) {
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/agents-snapshot.html'), deskBody.slice(0, deskBody.indexOf('<script>')) + emb + deskBody.slice(deskBody.indexOf('<script>')));
  }
}
console.log('built docs/{,bursa/,china/,watch/,crypto/,agents/}index.html, nasdaq/ and dow/ redirects, and snapshots');
