# Compute / Value — tracker

`AI-Infra-Tracker-Spec.md` is the binding contract and source of truth. It overrides any other instinct about structure. When a change isn't covered by the spec, stop and ask. When tempted to add a file, structure, or feature not in the spec, point back to the spec instead.

## What this is

A static web app (HTML / CSS / vanilla JS, no framework) — a first-principles relative-value tracker for AI-infrastructure names. All company and site data lives in `data.json`, loaded at runtime. The app is a Render Static Site; push to `main` auto-deploys.

The valuation engine lives in `engine.js` (shared browser + node — never fork the math). The paper portfolio (spec §6b) is `portfolio-core.js` (allocation), `portfolio-run.js` (daily job, run by the GitHub Action), `portfolio-backtest.js` (regenerates history), `portfolio.json` (state, overwritten daily) and `portfolio-history.json` (the ONE sanctioned time-series ledger).

## File discipline (spec §10–§11 — hard rules)

1. **State is present-tense only.** No file records "previously X, now Y, updated on…". History lives in `CHANGELOG.md`, nowhere else.
2. **Ticker state is structured data in `data.json`** — fields you overwrite, not markdown. There are no per-ticker files.
3. **Closed allow-list of markdown.** Only these may exist: `CLAUDE.md`, `AI-Infra-Tracker-Spec.md`, `CHANGELOG.md`, and (optionally) one `WIKI.md`. Do not create any other markdown file without asking.
4. **Edit in place, never append.** When state changes, overwrite it and add one line to `CHANGELOG.md`.

## Working rules

- Match the prototype's behaviour and look; rebuild, don't redesign.
- Before every push, verify the app actually works. Never push a broken build.
- Small, frequent commits, conventional messages. Use `[skip render]` for commits that shouldn't deploy (spec/changelog edits).
- Keep this file terse and present-tense.
