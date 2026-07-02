# Compute / Value — Wiki

The terse, always-current reference. Plain-English companion to `AI-Infra-Tracker-Spec.md` (binding). Present-tense only — no history (that's `CHANGELOG.md`).

## What it is
First-principles relative-value tracker for AI-infrastructure equities; value rolls up from sites. Static web app, all data in `data.json`. Screens: **Comparison** (dashboard) · **All sites** · **Company full-page** · **Global dials**.

## The formula
One engine; only the per-MW step branches by model.
```
OWNER     value/MW = effRate × margin% × multiple
LANDLORD  value/MW = NOI ÷ cap rate
both      site value = value/MW × MW × provenance haircut × time-discount
          EV     = Σ sites + legacy
          equity = (EV − net debt) × (1 − governance discount)
          target = equity ÷ (shares + planned raise ÷ price)
          upside = target ÷ price − 1
```
- **effRate** = contracted slice (locked at today's GPU rate) + uncontracted slice (today's rate grown by the trend to the site's year) × region factor.
- **NOI** grows the same way; **cap** = (cap dial + tier spread) × (1 − 0.30 × contracted%).
- **provenance haircut**: disclosed 0.95 / estimated 0.55 / rumored 0.25. **time-discount** = 1/(1+disc)^years, years = energization − now + ramp.
- **legacy** = BTC × live price + ETH × live price + stake (pct × the held company's modelled equity) + non-crypto residual (`legacyEV`).

## Dashboard gauge
Per row: bar = our value (target), split **contracted floor (solid) / expected pipeline (hatched) / legacy (gold)**; dark line = market price; green gap = upside, red = overvalued. Sorted by upside. "▸ valuation narrative" expands the per-name thesis.

## Dials (8)
| Dial | Does | Hits |
|---|---|---|
| GPU rate | today's $/MW·yr | owners |
| GPU rate trend | %/yr growth of that rate | owners + landlord rents |
| Owner margin | operating margin % | owners |
| Compute multiple | × on owner economics | owners |
| Landlord cap rate | NOI yield | landlords |
| Discount rate | time value | all |
| Revenue ramp | commissioning lag (months) | all |
| Dilution stress | × the planned equity raise | all |

Intuition: the real discount on future compute = discount − trend.

## Fields (per company, `data.json`)
- **Move the target:** `model` (owner/landlord/holdco) · `tier` (proven/ig/ig-reit) · `sites[]` {n, mw, owned, region cheap/mid/exp/eu/au, yr, mo, prov disclosed/estimated/rumored} · `contractedPct` · `termYrs` (owner lock) · `mtm` (landlord) · `netDebt` · `shares` (fully diluted) · `legacyEV` · `btc` · `eth` · `stake` {tk, pct} · `plannedRaise` · `equityDiscount`.
- **Need a `basis` note:** `plannedRaise`, non-Proven `tier`, `equityDiscount`.
- **Reference only:** `narrative`, `thesis`, `bull`, `bear`, `catalysts`, `risks`, `finMix`, `log`.

## Conventions
- **Provenance = existence** (will the MW energize), not leasing. Leasing risk lives in `contractedPct`.
- **Uncontracted = upside**, not a markdown: valued at the future (rising) rate, not a spot haircut.
- **Net debt** = borrowings + finance leases − cash − escrowed construction cash. Exclude operating leases and crypto. Project/SPV debt counted only when **drawn**.
- **Shares = fully diluted** (if-converted): count in-the-money converts (and remove their principal from net debt), RSUs, ITM warrants; out-of-money converts stay debt.
- **Dilution** = the realistic equity raise (`plannedRaise`), not full build capex.
- **Holdco (SOTP)** = stakes (live look-through) + crypto treasuries (live) + legacy − net debt; no sites.
- **Geography**: region rate factor — US 1.0, EU/AU 0.70.
- **Tiers**: base Proven; re-rate to IG / IG-REIT only for investment-grade contracted income.
- **Scale on trajectory** (secured power + credible pipeline), capped ~2030–31. Louder ≠ bigger.
- **Ignore sell-side price targets.**

## Data & benchmarks
Live prices: Finnhub (stocks) + Coinbase (BTC, ETH), hourly + manual ↻. Cap-rate sanity: DLR/Blackstone (Jun 2026) ≈ $17M/MW equity, ~6.5% cap, ~15× NOI for fully-leased IG hyperscale.

## Keeping it current
- **`node checks.js`** — the data test suite (run before every push; the weekly sweep runs it too). Deterministic checks: schema, site schedules & phasing, provenance consistency, capital-structure sanity, basis notes on judgement inputs, stake integrity, freshness. Research checks (FD shares vs filings, new debt/equity issuance, contract announcements, GPU spot pricing vs the rate/trend dials) run in the weekly sweep.
- Weekly scheduled refresh re-checks each name and proposes thesis/input changes for review.
- **Update a name**: edit its fields (new lease → raise `contractedPct` / upgrade site `prov`; new debt or raise → `netDebt` / `shares`).
- **Add a name**: data entry into `companies[]` only — never touch the engine (spec §5a).

## Known limitations
- Revenue-multiple, not a per-name DCF.
- Beyond `plannedRaise`, future build-debt isn't modelled; targets are pre-further-dilution.
- Landlord lease-up isn't separately haircut (provenance = existence only).
- A relative-value signal, not investment advice.
