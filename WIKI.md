# Compute / Value — Wiki

The terse, always-current reference. Plain-English companion to `AI-Infra-Tracker-Spec.md` (binding). Present-tense only — no history (that's `CHANGELOG.md`).

## What it is
First-principles relative-value tracker for AI-infrastructure equities; value rolls up from sites. Static web app, all data in `data.json`. Screens: **Comparison** (dashboard) · **All sites** · **Leases** (the registry + print tape) · **Company full-page** · **Global dials** · **Checks** (the data test suite, live in the browser) · **Portfolio** (the self-balancing paper book).

## The formula
One engine; only the per-MW step branches by model.
```
OWNER     value/MW = effRate × margin% × multiple
          signed slice @ signedRate (the actual take-or-pay book, $-weighted)
          unsigned + re-sign slices @ market × (1+gpuTrend)^vintage × genAccess
LANDLORD  signed site:   value/MW = actual lease NOI (term-avg fact) ÷ cap
          unleased site: value/MW = anchor × region × size × lease-up × trend ÷ cap
          (cap floored at 6.5% — the DLR print; compression only with a signed lease)
both      site value = value/MW × MW × provenance haircut × time-discount
          EV     = Σ sites + legacy
          equity = (EV − net debt − committed project debt − preferred/NCI) × (1 − governance discount)
          target = equity ÷ (shares + planned raise ÷ price)
          upside = target ÷ price − 1
```
- **effRate** = contracted slice (locked at today's GPU rate) + uncontracted slice (today's rate grown by the trend to the site's year) × region factor × **lease-up dial**. The contract premium and cap compression are **site-aware** — rumored capacity earns neither. The **ramp** delays only the uncontracted share (take-or-pay leases bill from commencement). Trend is capped at disc − 2 so the time axis can't invert.
- **Owner books bind as dollars+term**: compute contracts live in `contracts[]` (dollars and term are contractual; MW is inference — flagged). Each owner's $-weighted `signedRate` binds its contracted slice; the lock is term ÷ capitalization-years, so ~30% of a 5-yr book prices at the re-signing off the gen-curve. CRWV's registry reconciles to its $99.4B reported backlog; NVIDIA backstops its unsold capacity through Apr 2032.
- **Signed economics bind**: every signed lease lives in the `leases[]` registry (counterparty, MW, term, term-average NOI, `kind` = retrofit / conversion / build-to-spec, source) and its sites value at the ACTUAL contract — recalibrating the anchor never touches a signed dollar. The registry doubles as the market print-tape (current range: $0.60M retrofit-with-head-lease → $2.06M premium conversion; build-to-spec IG cluster $1.4–1.9M).
- **provenance haircut**: disclosed 0.95 / estimated 0.55 / rumored 0.25. **time-discount** = 1/(1+disc)^years, years = energization − now + ramp.
- **legacy** = BTC × live price + ETH × live price + stake (pct × the held company's modelled equity) + non-crypto residual (`legacyEV`).

## Paper portfolio (spec §6b)
Hypothetical daily-rebalanced book — measures whether the ranking adds alpha within the universe. Long-only + cash; no broker, ever.
```
view       ν = λ × confidence × m × ln(target ÷ price)
confidence   = 0.35 + 0.65 × (contracted floor + legacy) ÷ EV, less open watch-items
weights      = softmax(ν, T=0.15) over ν>0 names — concentrated, no cap, by mandate
gross        = min(1, Σν⁺ ÷ 0.75) — cash grows mechanically when total edge thins
```
- **λ** (fight-the-market) follows realized rank-IC monthly; per-name **m** shrinks only when the market opposed the view **vs the universe median** in **two consecutive** learning windows, and recovers only when vindicated. Simulated-genesis records never feed learning. `conviction: true` on a name in `portfolio.json` exempts it. Learning adapts *sizing only* — it never edits `data.json`; facts still enter through the proposal path.
- **Unattended-safety guards** (daily job): violent moves are split-checked (shares adjust, value-preserving) or quarantined on source conflict (3 suspect days → red Action + GitHub issue); dead feed → red Action; partial tape marks NAV but suspends trading; names stale >10d freeze as uninvestable; BTC/ETH forward-fill on outage. The Checks tab carries a "Portfolio ledger" group (NAV recompute, basis tripwire, staleness).
- **Files**: `portfolio.json` (state, overwritten) · `portfolio-history.json` (the one sanctioned ledger). `engine.js` is the shared valuation engine (browser + node — one math). Daily mark: GitHub Action → `node portfolio-run.js` after US close, commits, Render redeploys.
- **Benchmark**: equal-weight universe, monthly rebalance. Beat that, not SPX.
- **Excluding a name from the book**: add it to `exclude` in `portfolio.json` with a one-line basis — it leaves book AND benchmark at the next mark; it stays in the tracker. (BTBT is excluded — special case.)
- **Chart**: cumulative % return over a selectable window (1D/5D/1M/6M/1Y), both lines rebased to 0% at window start; absolute returns per window in the table above it.
- **Genesis is simulated** (today's data.json vs last year's prices — not alpha); live record starts after `backtestThrough`. Regenerate with `node portfolio-backtest.js` (uses `FINNHUB_TOKEN` env if it has candle access, else Yahoo daily closes; BTC/ETH from Coinbase).

## Dashboard gauge
Per row: bar = our value (target), split **contracted floor (solid) / expected pipeline (hatched) / legacy (gold)**; dark line = market price; green gap = upside, red = overvalued. Sorted by upside. "▸ valuation narrative" expands the per-name thesis.

## Dials (10)
| Dial | Does | Hits |
|---|---|---|
| GPU rate | today's $/MW·yr | owners |
| GPU gen-curve | %/yr the owner $/MW ladder climbs (Hopper→Blackwell→VR; VR = 1H27 mandate; default +8 from the measured ladder, bull 15-20 / bear ≤0) | owners |
| Landlord rent trend | %/yr rent escalation on unleased space | landlords |
| Owner margin | operating margin % | owners |
| Compute multiple | × on owner economics | owners |
| Landlord cap rate | NOI yield | landlords |
| Discount rate | time value | all |
| Revenue ramp | commissioning lag (months) | all |
| Dilution stress | × the planned equity raise | all |
| Lease-up / spot realization | × the uncontracted slice (both paths). **1.0 = our view: energized capacity gets rented (scarcity)**; 0.42 = consensus uncontracted spread | all |
| Rumored-pipeline credit | × the rumored haircut; 0 = no credit for rumored GW | all |

Intuition: the real discount on future compute = discount − trend.

## Fields (per company, `data.json`)
- **Move the target:** `model` (owner/landlord/holdco) · `tier` (proven/ig/ig-reit) · `sites[]` {n, mw, owned, region cheap/mid/exp/eu/au, yr, mo, prov disclosed/estimated/rumored} · `contractedPct` · `termYrs` (owner lock) · `mtm` (landlord) · `netDebt` · `committedDebt` (issued project bonds funding credited sites, even if escrowed) · `seniorClaims` (drawn preferred + NCI) · `shares` (fully diluted) · `legacyEV` · `btc` · `eth` · `stake` {tk, pct} · `plannedRaise` · `equityDiscount`.
- **Need a `basis` note:** `plannedRaise`, non-Proven `tier`, `equityDiscount`, `committedDebt`, `seniorClaims`.
- **Reference only:** `narrative`, `thesis`, `bull`, `bear`, `catalysts`, `risks`, `finMix`, `log`.

## Conventions
- **Provenance = existence** (will the MW energize), not leasing. Leasing risk lives in `contractedPct`.
- **Uncontracted = upside**, not a markdown: valued at the future (rising) rate, not a spot haircut.
- **Net debt** = borrowings + finance leases − cash. Exclude operating leases and crypto. **Financing is charged symmetrically with the credit**: issued project bonds funding credited sites count via `committedDebt` even while escrowed (the escrow becomes the building we already credit).
- **Shares = fully diluted** (if-converted): count in-the-money converts (and remove their principal from net debt), RSUs, ITM warrants; out-of-money converts stay debt.
- **Dilution** = the realistic equity raise (`plannedRaise`), not full build capex.
- **Holdco (SOTP)** = stakes (live look-through, diluted through the held name's raise; a controlling stake uses pre-discount equity) + crypto treasuries (live) + legacy − net debt; no sites.
- **Geography**: region rate factor — US 1.0, EU/AU 0.70.
- **Tiers**: base Proven; re-rate to IG / IG-REIT only for investment-grade contracted income.
- **Scale on trajectory** (secured power + credible pipeline), capped ~2030–31. Louder ≠ bigger.
- **The 7× multiple** ≈ 15× steady-state FCF at ~45–50% EBITDA→FCF conversion under durable-pricing/refresh economics — it embeds GPU refresh and capital intensity. The margin dial is a **steady-state EBITDA proxy**, not today's operating margin.
- **Ignore sell-side price targets.**

## Data & benchmarks
Live prices: Finnhub (stocks) + Coinbase (BTC, ETH), hourly + manual ↻. Cap-rate sanity: DLR/Blackstone (Jun 2026) ≈ $17M/MW equity, ~6.5% cap, ~15× NOI for fully-leased IG hyperscale. Base landlord NOI is calibrated to the MIDPOINT OF THE BULLISH CASE on signed hyperscaler prints ($1.76M/MW·yr cheap-market owned): conservative read = year-1 de-escalated (~$1.5M, WULF/Anthropic 7/26), bullish read = term-average (~$2.0M — justified because the engine locks contracted rent flat, so year-1 anchoring drops the signed escalators). Owner's deliberate calibration, 2026-07-06.

## Keeping it current
- **Checks tab / `node checks.js`** — the same test suite runs live in the browser on every load AND as the pre-push CLI (shared `checks-core.js`). Deterministic checks: schema, site schedules & phasing, provenance consistency, capital-structure sanity, basis notes on judgement inputs, stake integrity, freshness. Research checks (FD shares vs filings, new debt/equity issuance, contract announcements, GPU spot pricing vs the rate/trend dials) run in the weekly sweep.
- Weekly scheduled refresh re-checks each name, proposes thesis/input changes for review, and stamps `verified` dates (capital / contracts, + `config.verifiedPricing`) on approval — the Checks tab colors them by age.
- **Update a name**: new signed lease → append a `leases[]` record + tag its site rows with `leaseId`; new debt or raise → `netDebt` / `shares`.
- **Add a name**: data entry into `companies[]` only — never touch the engine (spec §5a).

## Known limitations
- Revenue-multiple, not a per-name DCF.
- Committed project bonds are charged; **uncommitted** future build capex is not — it shows as the per-name "funding gap" estimate in the facts panel.
- Lease-up defaults to 1.0 — a deliberate scarcity conviction (energized capacity gets rented), not an oversight; dial to 0.42 for the consensus board.
- A relative-value signal, not investment advice.
