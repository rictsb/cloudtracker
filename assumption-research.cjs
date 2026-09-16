#!/usr/bin/env node
/* Store the current evidence review in the existing proposal queue. No model writes.
   node assumption-research.cjs --input /path/to/review.json [--check]
   Input: {scope,findings:[{findingId,fingerprint,conclusion,status,sources:[{label,url,date}]}]}
   A source-verification timestamp only applies to the findings actually investigated. */
'use strict';
const fs = require('node:fs'), path = require('node:path');
const copy = x => JSON.parse(JSON.stringify(x));
function recordResearch(queue, snapshot, input, now = new Date().toISOString()) {
  if (snapshot.status !== 'ready') throw new Error('A successful current numerical review is required.');
  if (!input || typeof input.scope !== 'string' || input.scope.trim().length < 10) throw new Error('Describe the actual scope of research.');
  if (!Array.isArray(input.findings) || !input.findings.length || input.findings.length > 100) throw new Error('List the findings actually investigated.');
  const P = copy(queue), seen = new Set();
  const records = { ...(P.assumptionResearch?.findings || {}) };
  for (const item of input.findings) {
    const f = snapshot.findings.find(f => f.id === item.findingId);
    if (!f || f.fingerprint !== item.fingerprint) throw new Error('Finding changed or is missing: ' + item.findingId);
    if (seen.has(f.id)) throw new Error('Duplicate finding: ' + f.id);
    seen.add(f.id);
    if (!['needs-evidence', 'proposal-ready', 'explained'].includes(item.status)) throw new Error('Unknown research outcome.');
    if (typeof item.conclusion !== 'string' || item.conclusion.trim().length < 30 || item.conclusion.length > 12000) throw new Error('A substantive research conclusion is required.');
    if (!Array.isArray(item.sources) || (item.status !== 'needs-evidence' && !item.sources.length)) throw new Error('Explained findings and proposed changes require sources.');
    if (item.sources.length > 30) throw new Error('Too many research sources.');
    const sources = item.sources.map(s => {
      let u; try { u = new URL(s.url); } catch (_) { throw new Error('Invalid source URL.'); }
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || typeof s.label !== 'string' || !s.label.trim()) throw new Error('Sources require a public URL and title.');
      if (s.date != null && (!/^\d{4}-\d{2}-\d{2}$/.test(s.date) || !Number.isFinite(Date.parse(s.date)) || new Date(s.date).toISOString().slice(0, 10) !== s.date || s.date > now.slice(0, 10))) throw new Error('Invalid source date.');
      return { label: s.label.trim(), url: u.href, ...(s.date ? { date: s.date } : {}) };
    });
    if (item.status === 'proposal-ready' && !(P.items || []).some(p => p.kind === 'assumption' && p.id === item.proposalId && p.status === 'pending' && (p.findingId === f.id || (p.findingIds || []).includes(f.id)))) throw new Error('A pending numerical proposal linked to this finding must exist before labeling it proposal-ready.');
    records[f.id] = { fingerprint: f.fingerprint, ticker: f.ticker, reviewedAt: now, conclusion: item.conclusion.trim(), status: item.status, sources, ...(item.proposalId ? { proposalId: item.proposalId } : {}) };
  }
  // Present state only: old results for vanished or changed findings are not retained as current evidence.
  for (const [id, result] of Object.entries(records)) if (!snapshot.findings.some(f => f.id === id && f.fingerprint === result.fingerprint)) delete records[id];
  P.assumptionResearch = { checkedAt: now, scope: input.scope.trim(), reviewedFindingIds: [...seen], findings: records };
  return P;
}
module.exports = { recordResearch };
if (require.main === module) {
  try {
    const args = process.argv.slice(2), index = args.indexOf('--input');
    if (index < 0 || !args[index + 1]) throw new Error('Usage: node assumption-research.cjs --input /path/to/review.json [--check]');
    const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
    const root = __dirname, input = read(args[index + 1]), snapshot = read(path.join(root, 'assumption-review.json'));
    const { hashJSON, modelHash } = require('./assumption-review.cjs');
    if (snapshot.sourceHash !== hashJSON(read(path.join(root, 'data.json'))) || snapshot.modelHash !== modelHash(root)) throw new Error('Refresh the numerical review before recording source research.');
    const file = path.join(root, 'proposals.json'), next = recordResearch(read(file), snapshot, input);
    if (!args.includes('--check')) { const temp = file + '.research.tmp'; fs.writeFileSync(temp, JSON.stringify(next, null, 1) + '\n'); fs.renameSync(temp, file); }
    console.log(JSON.stringify({ status: args.includes('--check') ? 'validated' : 'recorded', findings: input.findings.length, modelChanged: false }));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
