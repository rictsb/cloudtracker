#!/usr/bin/env node
/* Applies ACCEPTED proposals (proposals.json, spec §6g) to data.json.
   Run by the apply-proposals GitHub Action whenever proposals.json changes on main (a Yes on the
   Approvals screen commits a decision; this turns it into the fact). Never applies anything that
   is not status 'accepted'. Refuses to write if the data checks would get worse. */
const fs = require('fs');
const path = require('path');
const { runChecks } = require('./checks-core.js');
const ROOT = __dirname;
const P = JSON.parse(fs.readFileSync(path.join(ROOT, 'proposals.json'), 'utf8'));
const raw = fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8');
const D = JSON.parse(raw);
const today = new Date().toISOString().slice(0, 10);

const todo = (P.items || []).filter(p => p.status === 'accepted' && !p.applied);
if (!todo.length) { console.log('no accepted proposals to apply'); process.exit(0); }

const before = runChecks(JSON.parse(raw)).summary.fail;
const lines = [];
for (const p of todo) {
  const c = D.companies.find(x => x.tk === p.tk);
  if (!c) { p.status = 'error'; p.error = 'unknown ticker'; continue; }
  if (p.kind === 'log') {
    c.log = c.log || [];
    const e = Object.assign({}, p.proposed);
    if (!c.log.some(l => l.d === e.d && l.x === e.x)) c.log.unshift(e);
    c.log.sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')));
  } else if (p.kind === 'site') {
    const s = (c.sites || []).find(x => x.n === p.site);
    if (!s) { p.status = 'error'; p.error = 'site not found: ' + p.site; continue; }
    Object.assign(s, p.proposed);
  } else if (p.kind === 'catalyst') {
    c.catalysts = c.catalysts || [];
    if (!c.catalysts.includes(p.proposed.text)) c.catalysts.unshift(p.proposed.text);
  } else { p.status = 'error'; p.error = 'unknown kind ' + p.kind; continue; }
  p.applied = today;
  lines.push(`- ${p.tk}: ${p.title} — approved on the Approvals screen ${p.decided || today}, applied ${today} (proposal ${p.id}; source ${p.sourceName || 'McNallie Money (YouTube)'}${p.evidence && p.evidence[0] ? ', ' + p.evidence[0].url : ''}).`);
}

const after = runChecks(D).summary.fail;
if (after > before) {
  for (const p of todo) if (p.applied === today) { p.status = 'error'; p.error = `not applied: data checks would go from ${before} to ${after} FAIL`; delete p.applied; }
  fs.writeFileSync(path.join(ROOT, 'proposals.json'), JSON.stringify(P, null, 1) + '\n');
  console.log(`REFUSED: checks would go from ${before} to ${after} FAIL — data.json untouched, proposals marked error`);
  process.exit(1);
}

fs.writeFileSync(path.join(ROOT, 'data.json'), JSON.stringify(D, null, 1) + '\n');
fs.writeFileSync(path.join(ROOT, 'proposals.json'), JSON.stringify(P, null, 1) + '\n');
if (lines.length) {
  const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').split('\n');
  const at = cl.findIndex(l => l.startsWith('- '));
  cl.splice(at < 0 ? cl.length : at, 0, ...lines);
  fs.writeFileSync(path.join(ROOT, 'CHANGELOG.md'), cl.join('\n'));
}
console.log(`applied ${lines.length} proposal(s):\n` + lines.join('\n'));
