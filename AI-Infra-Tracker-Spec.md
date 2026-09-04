# AI Infrastructure Relative-Value Tracker — Spec & Build Plan (v2)

*A personal, first-principles tool for ranking AI-infrastructure names against each other and against a price target. This document is the contract: what the app is, what it is not, the data it holds, how the valuation flows, and how to build it. Carry it into Claude Design, Claude Code, and Cowork.*

---

## 1. What this is (one line)

A comparative valuation tracker where **logging a development updates the model**, and the valuation and ranking for all companies recompute live. You record what happened (a lease, an energization, a financing) against the site it touches; the facts change; the price targets and the ranking move. No separate model to maintain.

## 2. What this is NOT (scope guard)

- Not a trading system or anything that touches a broker. The **paper portfolio** (§6b) sizes a hypothetical book from the model's outputs — it never touches execution, an account, or an order.
- Not an auto-scraper. On-demand lookups from your preferred sources are expected; what stays out is unattended, broad ingestion. Governing rule: **retrieval is open, writes are gated** — a lookup produces a *proposed* update you review and accept, then it's applied (the miner-swarm pattern). Every applied fact carries its source.
- Share price is live-fed — the one objective market input, used for the upside calc; everything analytical stays manually entered. (Real-time equity quotes need a paid entitlement; a delayed/snapshot feed is sufficient for a tracker that informs sizing, not execution.)
- Not multi-user. One analyst, one app.
- Not a spreadsheet. You only ever use the app's screens.
- Not a per-name DCF. One time axis only (energization), one discount rate dial — not twenty cash-flow schedules.

Under the hood it is one plain data file the app owns. If the code breaks, the data survives and the app can be rebuilt around it.

## 3. The three tiers (the core architecture)

Everything has a home, and the home is determined by what the fact actually attaches to.

**Site tier — physical facts that roll up. This is where news attaches.**
A site is deliberately just a few fields, never a mini-model:
- MW
- Owned or leased
- Region / power-cost tier
- Energization date — month and year (explicit, from disclosure)
- Provenance of that date: disclosed / estimated / rumored

**Company tier — the commercial and capital layer that does not decompose into concrete.**
- Contracted % (share of the book contracted today — the t=0 snapshot)
- Average term remaining (years — sets the lock on the contracted rate, owners)
- Counterparty quality (reference fact) and financing-mix tag
- Capital stack: net debt, fully-diluted shares, planned equity raise (+ basis), governance discount (+ basis)
- Legacy/non-core: BTC/ETH treasuries (marked live), look-through stakes in tracked names, non-crypto residual

**Global dials — interpret the tags across all names at once.**
- Prevailing GPU rate ($/MW·yr) — the market rate; moves the spot-exposed book
- Owner-operator base margin, compute-value multiple
- Landlord cap rate
- Discount rate (time)
- Revenue ramp to steady-state (months) — delays the UNCONTRACTED share of each site's value after first power (take-or-pay leases bill from commencement)
- GPU gen-curve (%/yr, owners — the generation ladder's blended slope; measured from the contract print-tape, VR = 1H27 by owner mandate) — landlord rents keep their own trend dial
- Lease-up / spot realization (× the uncontracted slice, both paths; base 1.0 = the scarcity conviction that energized capacity gets rented; 0.42 = the consensus uncontracted spread)
- Rumored-pipeline credit (× the rumored provenance haircut; stress the far pipeline to zero without editing data)
- (Fixed tables: provenance → execution probability; region → power-cost adjustment)

## 4. Key mechanics that emerged

**Spot vs contracted is a company number, not a site tag.** It's a property of the revenue book, not the concrete — one number per name (e.g. CRWV ~85% contracted, NBIS ~40%). The contracted book is insulated from the GPU-rate dial; the spot book moves with it. Crank the dial and spot-heavy names fan away from contracted ones — that fan-out is the tradeable signal. The model never says "contracted is good"; the rate dial and your directional view decide. For a scarce-compute bull, spot exposure is upside leverage.

The company contracted % stays the one number, but it applies *site-aware*: uncontracted pipeline (rumored provenance) earns the pure spot rate and moves with the dial, while disclosed/estimated capacity carries the contracted book. Each company's value then splits into a **contracted floor** (dial-insulated) and an **expected upside** (spot + uncontracted pipeline, which moves with the dial) — shown on the comparison bar and in the valuation build.

**Renewals are company/industry-level, and the denominator is model-aware.**
- Compute renews at % of *prevailing market* (it re-rates with your dial) — so the bull thesis flows through the re-signings instead of being capped at a stale vintage.
- Landlords renew at % of *original* (escalators, sticky tenants).
Term remaining sets how fast today's contracted book rolls toward those long-run assumptions.

**Two separate time axes — do not collapse them.**
- *Re-contracting* (tenant to tenant) is a rate question → valued at long-run, no phasing.
- *Energization* (when the MW first switches on) is an arrival question → discounted by year. A 2030 site is the same steady-state dollars as a 2027 site, just discounted three more years. Energization dates are first-power; the global ramp dial then delays the value to steady state. Large or multi-phase campuses are decomposed into per-block site rows on their rollout schedule — a gigawatt does not energize in one shot, so it is entered as the blocks that actually come online year by year.

**Probability and timing stay separate.** Provenance answers *how sure* (execution haircut). Energization year answers *when* (time discount). A permitted-but-slow site and a fast-but-contested site are different bets; one rising discount would blur them.

**Provenance is existence, not leasing.** Provenance measures whether the MW will physically *energize* — driven by land control, power approval, permitting and construction status — NOT whether there's a signed tenant. For an owner-operator the two move together (they don't build speculative shells). For a landlord building on owned, approved land (miner-pivots like RIOT, BTDR), they decouple: the concrete is near-certain (disclosed) while the tenant is not. Owned + power-approved + scheduled capacity is `disclosed` even when unleased; the empty-building risk is carried by a low **contracted %**, not by an existence haircut. Tagging owned/approved buildout `rumored` double-counts the same risk and badly understates real assets.

**Investability tier carries re-rating — a third axis, distinct from provenance and contracted %.** Provenance is *will it get built*, contracted % is *will it get leased* (both already haircut the speculative pipeline), and the tier is *what the market pays per dollar of stabilized income* as a name becomes more investable. The **base case for every name is Proven** — the global cap-rate / multiple dials. Re-rating is the **upside option to take a name up to IG or IG/REIT** grade (cap-rate compression for landlords, multiple expansion for owners) as it earns investability. A name is never marked *below* Proven — provenance and contracted % already carry the execution and lease-up risk, so discounting the tier too would double-count it. The tier is baked into the headline target (not a separate band).

**One global discount rate.** Time value is a single global dial for every name (a per-name cost-of-debt floor was retired as inert — every name sat below the dial). Name-level risk differences live in provenance, contracted %, the tier, and the governance discount — not in bespoke discount rates. The line to hold: no debt-maturity walls, refinancing schedules, or interest-coverage projections — that is the DCF in disguise.

**Disclosure precision correlates with certainty** — near-term dates get disclosed because they're real; far dates stay vague. So provenance is signal, not noise, and it drives both the haircut and a visual fade. Provenance replaced the old "stage" field: the explicit year is the truer "when," provenance the truer "how sure."

## 5. How value flows (facts + dials → output)

**One engine, every name. Only the per-MW step branches by model.** This is binding — a new name must fit it with no new code path.

Per **site** → value/MW:
- **Owner (cloud):** `value/MW = effective rate × margin% × multiple` — two slices, split by the compute-contract registry:
  - **Signed slice**: earns the company's `signedRate` — the $-weighted rate of its actual take-or-pay book (`contracts[]`: dollars + term are the facts; MW is usually inference, so the rate binds at COMPANY level, basis-noted and checks-reconciled against the registry). Lock = `min(term ÷ capitalization-years (≈ the multiple), 1) × contracted%` — a 5-yr book on a ~7-yr capitalization leaves ~30% of every contracted MW at the RE-SIGNING.
  - **Unsigned + re-signing slices**: earn the market rate grown at the **GPU gen-curve dial** (`gpuTrend`, decoupled from landlord rents; VR-revenue-from-1H2027 owner mandate baked into its calibration) × region factor × `genAccess` (frontier-allocation factor) × lease-up. This is how rising $/MW enters over time.
  - Rumored sites = 0% locked.
  - margin% = base-margin dial + region (cheap +5 / mid 0 / costly −5) + (owned +5 / leased −3)
  - multiple = multiple dial × tier factor (Proven 1.0 / IG 1.12 / IG-REIT 1.25) × (1 + 0.40 × contracted%) — **site-aware**: rumored sites earn no contract premium
- **Landlord (colo):** `value/MW = NOI ÷ cap rate` — two regimes, split by the lease registry:
  - **SIGNED site** (`leaseId` → `leases[]`): NOI = the lease's actual **term-average NOI/MW** (a fact from the filing; escalators embedded; one number, never a cash-flow schedule). Fully contracted: full cap compression, no ramp, immune to anchor recalibration. Each lease carries a `kind` — retrofit / conversion / build-to-spec — so prints are never averaged across kinds.
  - **UNLEASED site**: NOI = market anchor × region × (owned/leased) × **size factor** (physical block: <100MW ×0.9, >300MW ×1.1) × lease-up × trend-to-vintage. No cap compression without a signed lease.
  - cap rate = (cap dial + tier spread) × (1 − 0.30 × contracted), **floored at 6.5%** (the DLR fully-leased-IG print)

Then, **identical for both**: `site value = value/MW × MW × provenance haircut (disclosed 0.95 / estimated 0.55 / rumored 0.25) × time-discount [1/(1+disc)^years, years = energization − now + ramp]`

Roll-up to **target**:
- `EV = Σ site values + legacy`  (legacy = `btc × live BTC price + legacyEV` residual)
- `equity = (EV − net debt − committed project debt − preferred/NCI claims) × (1 − governance discount)` — financing is charged symmetrically with the credit: issued project bonds funding credited sites count (`committedDebt`, even while escrowed); drawn preferred + NCI count (`seniorClaims`)
- `funded shares = shares + planned equity raise ÷ live price`  (dilution = realistic ATM/issuance, **not** full build capex — the multiple already embeds capital intensity)
- `TARGET = equity ÷ funded shares;  upside = target ÷ live price − 1`

**Value-per-MW and blended margin are outputs, not inputs** — the MW-weighted blend of the site mix is the thing you trade.

## 5a. Adding a name (the only recipe)

Pure data entry into `data.json` `companies[]` — **never touch the engine** (no per-ticker code exists).

- **Valuation inputs** (move the target): `model`, `tier`, `sites[]` (`{n, mw, owned, region, yr, mo, prov}`), `contracts[]` (owner compute-contract registry: {id, counterparty, totalRevM, termYrs, signed, gen: hopper/blackwell/vera-rubin/mixed/tpu, inferredMW, ratePerMWyr?, effective, source}) + company `signedRate` (+basis) and `genAccess` (+basis if ≠1), `leases[]` (the registry: one record per signed rate book — {id, counterparty, mw, termYrs, noiPerMWyr (term-average), kind, effective, signed, source}; sites link via `leaseId`, JV slices carry `physMW`), `contractedPct` (owners; derived from the registry for landlords), `termYrs` (owner lock), `netDebt`, `committedDebt`, `seniorClaims`, `shares`, `legacyEV` (non-BTC residual), `btc`/`eth` (counts, if any), `stake` ({tk,pct}, holdcos), `plannedRaise`, `equityDiscount` (default 0).
- **Judgement inputs need a one-line `basis`** (shown in the panel): `plannedRaise`, `equityDiscount`, `committedDebt`, `seniorClaims`, any non-Proven `tier`.
- **Reference facts** (do NOT move the target): `narrative`, `bull`, `bear`, `catalysts`, `risks`, `finMix`, `leaseQ` (ranking score only), `log`, `raises[]` (§6c), `ramp` (screen 11 — the quarterly GPU-ramp research overlay for GPU-cloud owners: `{asOf, basis, spot{year:$/GPU-hr}, spotMult{gen}, mining{qtr:$M}, consensus{qtr:[total,ai]$M} + consensusSource, tranches[{n, campus, grossMW, itMW, gpus, gen: hopper/blackwell/rubin/next, energize "YYYYQn", rev "YYYYQn", rampQtrs, ctr 0-1, rate $/GPU-hr, signed 0-1}]}`; display-only, never a valuation input, carries its own basis).
- **Capital-structure discipline (the most error-prone inputs):** `shares` = **fully-diluted** via if-converted/treasury — add deep-in-the-money convertibles (and remove their principal from `netDebt` when you count them), RSUs, and penny/ITM warrants; out-of-the-money converts stay in `netDebt` and add **no** shares. `netDebt` = borrowings + finance leases − cash − escrowed construction proceeds, EXCLUDING operating leases and crypto treasuries; **project/SPV debt is netted only to the extent drawn** — forward/undrawn facilities are not parent net debt. Hold shares, cash, and debt to ONE as-of date. (Audited to filings 2026-06-30 across the universe.)

First-principles per name: sites + MW · energization schedule + certainty (→ provenance) · data-center tier/quality (size, power source, owned/leased → region & $/MW) · anchor/hyperscaler tenants (→ contracted% + tier) · capital structure (net debt, shares, converts, BTC, planned equity raise → dilution).

## 6. The screens (eleven)

1. **Comparison dashboard** — all names ranked by upside; each row carries a **value gauge** (bar = our target value split contracted-floor / expected / legacy; dark line = market price; shaded gap = upside or overvalued) and a collapsed **valuation narrative** toggle. Each row also carries the **execution floor** — the target recomputed with the unsigned/expected slice at zero (signed contracts + legacy only, same claims/discount/dilution) — shown as its own sortable **Floor** column (floor price + floor-vs-price %, mirroring the Target column) and a dashed tick on the bar: the visible measure of how much of each target is executed fact vs awarded future.
2. **Company one-pager** — a full research page per ticker (see §6a): the quantitative roll-up plus qualitative narrative and judgement. Hash-routed (`#TICKER`), deep-linkable; clicking a dashboard row goes straight to it.
3. **Sites table** — every site across the whole universe in one list: company, MW, owned/leased, region, energization date, provenance, and discounted value contribution. Sortable and filterable. The master inventory the roll-up is built from, and the fastest way to see how much of the universe's MW is disclosed vs rumored, or concentrated in one region or one delivery year.
4. **Assumptions panel** — the global dials; change one and everything recomputes live. Collapsible sidebar (header toggle), collapsed by default; the preference persists per browser.
5. **Leases** — the lease registry rendered: every signed book (lessor, tenant + credit support, campus, kind, term, signed date, critical-IT MW (gross where disclosed), term-average NOI/MW, annual NOI, base-term value, capitalized value contribution and % of company EV). Header: universe totals + the print tape (median signed NOI by kind and by signing vintage) against the current forward anchor. Signed-but-not-effective books shown dimmed, excluded from totals and the engine. Row click → the company page.
6. **Coverage** — confirmed contracted value against today's market cap, one row per name, every column sortable. Market cap = **reported (basic) shares** × live price (a display-only `sharesReported` field; the engine keeps fully-diluted `shares`). Contracted = the **gross headline** value of every signed/effective lease + compute contract (a display-only `grossTotalM` on leases — the announced $, not the NOI the engine uses; compute contracts use `totalRevM`). Columns: market cap, contracted, gross-weighted avg term, annualized (Σ gross ÷ term — a term-average, not a current run-rate), annual ÷ cap, backlog ÷ cap. Row click → the per-contract breakdown with terms. Excludes options, LOIs and non-performing books.
7. **Raises** — the capital-raise event study: every announced raise from the registry (§6c) with its day-0 reaction and +5/+15/+30 trading-day forward returns, absolute and in excess of the equal-weight universe benchmark — all derived at render time from the sanctioned ledger (§6b), never stored. Aggregates (N, median, hit rate) by window and by instrument type test the drop-then-recover hypothesis. Incomplete windows show return-so-far, progress-marked, excluded from aggregates. Row click → terms, purpose, source.
8. **Outlook** — the forward book, two sub-tabs, refreshed weekly by the Monday sweep and stored as a top-level `outlook` object (present-tense, overwritten; judgement only — NEVER a valuation input). *Next leases*: every name's probability of a new binding lease/compute contract inside ~6 months, expected MW range, window, candidate tenant/site, differential build-speed score, and the evidence trail (negotiation language quoted from filings/calls, financing tripwires, exclusivities, tenant-side signals) — with a big-leases-only filter (≥100MW expected). *Earnings setup*: per reporting date (owner-supplied calendar, confirmed vs estimated), a −5…+5 surprise score measuring likely earnings-day surprise RELATIVE TO WHAT IS PRICED, the key metric that decides the print, consensus anchor, drivers and a sentiment read. Sortable; rows expand to evidence; every claim carries sources per the §9 registry ceilings.
9. **Checks** — the data test suite, run live in the browser against the deployed data on every load (same code as `node checks.js`): group verdicts, findings, a per-company matrix, filing-verification ages (stamped by the weekly sweep via per-company `verified` dates + `config.verifiedPricing`), and the open watch-items registry (`watchItems`). A pass/warn/fail badge sits on the tab.
10. **Portfolio** — the paper portfolio (§6b): NAV vs the equal-weight universe benchmark, current holdings with the confidence math behind each weight, the trade ledger, and the learning state (λ, per-name multipliers, where the market is disagreeing with us and what it has cost).
11. **GPU ramp** — the quarterly capacity/fleet/revenue path for GPU-cloud owners (per-company `ramp` object; IREN first, CRWV/NBIS as researched). Three layers on one time axis, generation-colored (Hopper/Blackwell/Rubin-class/next-gen): *Concrete* — capacity tranches from energization to first revenue (thickness = gross MW, solid = signed today, hatched = uncontracted, ◆ = first revenue); *Silicon* — revenue-generating GPUs stacked by generation with the signed-book line; *Money* — quarterly revenue bars by generation + residual mining vs the Bloomberg consensus line; plus the quarterly table (gross MW cum, critical-IT MW active, GPUs added/cum, signed-today % vs modeled contracted %, blend $/GPU-hr, revenue, consensus, Δ). The screen is a **rollout explorer**: a timeline scrubber + replay rebuilds the company quarter by quarter across all three layers simultaneously (future ghosted, clip-revealed to the scrub position), with a live state panel (GPUs earning, gross/IT MW, revenue/qtr, blend, signed %), per-quarter event callouts derived from the tranches (power-on / first-revenue / computed milestones like program targets, fleet round numbers, generation firsts, the consensus crossover), milestone dots on the track, click-to-seek from any chart or table row, synced hover highlights across layers, and a per-tranche spotlight (click a bar → everything else dims, that tranche's GPU/revenue path traces through the other charts, detail card opens). The state panel carries q/q deltas and a vs-street readout; the timeline carries era bands (the calendar's chapters) and year ticks. The Money layer has a mode toggle — *by generation* (stacked bars + consensus line) or *vs street* (model total vs consensus lines, the wedge sign-shaded per quarter with Δ labels and a cumulative wedge callout). Replay honors prefers-reduced-motion. RESEARCH OVERLAY: filings-anchored near-term (company-disclosed programs), modeled cadence beyond; rates from the contract print tape; NEVER a valuation input — the engine never reads `ramp`. Every model carries `asOf` + `basis`; refresh cadence = each earnings/8-K event on a covered name.

### 6a. The company one-pager

The full page is the extensible home — laid out graphically (build-out chart, value-bridge waterfall, per-site math) and built to be extended.

Core sections (both surfaces):
- **Header** — ticker, model, tier, price, target, upside.
- **Narrative / thesis** — a few sentences in your words: what this company is, why it's mispriced, what you're underwriting. The freeform view the numbers can't hold.
- **Qualitative blocks** — bull case, bear case, catalysts to watch, key risks. Short bullets, your judgement.
- **Valuation** — graphical and expandable: a per-site value chart where each bar expands to its live step-by-step build (rate → margin/NOI → multiple/cap → value/MW → MW → provenance haircut → time discount → site value, with the contracted-floor / expected-upside split), plus the EV → equity → target build.
- **Sites** — the physical roll-up, each with its execution haircut and time discount shown.
- **Commercial & capital** — contracted %, term, renewal, mark-to-market, counterparty quality, cost of debt, financing mix, capital stack.
- **Developments log** — the dated event stream; logging here attaches to a site and updates the facts above.

Planned modules (full page only, not built now — the layout reserves room):
- **Management commentary** — quotes and read-throughs from calls, fireside chats, interviews.
- **Investor & conference calendar** — upcoming earnings, growth conferences, investor days.
- Richer, broken-down / expandable valuation graphics over time.

The one-pager is the thing you'd actually read before sizing a position, and the thing Cowork refreshes each week.

**Signature — the value-composition bar carries time and provenance.** Each site is a segment sized by its discounted, haircut value; near-term capacity reads solid, far-out and rumored capacity reads faded. A target resting on 2030 rumored MW *looks* exactly as thin as it is. A built-in skepticism meter against both timing and source — the antidote to a bull talking himself into rumored upside.

### 6b. The paper portfolio (self-balancing)

The tracker's outputs become a daily-rebalanced hypothetical book. Purpose: measure whether the model's ranking adds alpha *within* the universe, and force a disciplined confrontation with the market's view. Paper only — no broker, no orders (§2). Long-only plus cash for now; the machinery supports shorting later without redesign.

**Allocation rule (binding, one formula for every name):**

- **Raw view** per name: `μ = ln(target ÷ price)` — the model's mispricing signal, computed by the same engine as the dashboard (one engine, §5).
- **Confidence** `c ∈ [cMin, 1]`, computed from what the model already knows: the share of EV that is contracted floor + legacy (marked-to-market treasuries/stakes) vs expected/pipeline, times a penalty per open watch-item. A 60% upside built on signed leases sizes bigger than 60% built on rumored 2030 MW.
- **Learning multipliers**: a global λ (how hard we fight the market) and a per-name multiplier `m` (where the market has persistently disagreed). Effective view: `ν = λ × c × m × μ`.
- **Weights**: softmax over the ν > 0 names at concentration temperature T — low T concentrates into the top convictions (no per-name cap, by mandate). Gross exposure = min(1, Σν⁺ ÷ grossFullAt); **cash is the remainder**, so it grows mechanically as universe-wide edge thins. Sub-1% weights drop to zero. Names without a live price — or with a stale/suspect one — are uninvestable (weight frozen or 0) until they print cleanly.
- **Rebalance band**: recompute daily, trade to target only when some weight drifts beyond the band — the ledger records decisions, not noise.
- **Exclusions**: `portfolio.json` `exclude` maps ticker → one-line basis. An excluded name is uninvestable for **both book and benchmark** (an existing position is sold at market at the next mark; the benchmark rebuilds immediately — book and yardstick must share a universe). A judgement input: the basis is required, checks-enforced. The name stays in the tracker itself.

**Learning rule (adapts sizing, never edits the model):** every 21 trading days, λ moves with the realized rank-correlation between past views and subsequent returns (clamped). Per-name `m` decays only when a name's return has opposed the view **vs the universe median** (an arithmetic mean is destroyed by one moonshot) in **two consecutive learning windows** (one bad window is noise; overlapping windows must not multiply-count one episode), and recovers only when vindicated. Simulated-genesis records never feed learning — the era gate keeps hindsight out of λ and `m`. A `conviction` flag exempts a name from shrinkage — the override is explicit, never silent. Disagreements and their running cost are *surfaced on the Portfolio screen*; changing the underlying valuation inputs remains the analyst's job through the normal proposal path (§9). Numeric parameters live in `portfolio.json` and are shown on the screen — the formula is spec, the calibration is data.

**Benchmark**: equal-weight basket of the investable universe, rebalanced monthly. Beating SPX measures the sector; beating equal-weight measures the ranking. Both NAVs start at 100.

**Files (the only three, all owned by the app):**
- `portfolio.json` — present-tense state: parameters, current holdings, cash, λ, per-name multipliers, as-of date. Overwritten daily.
- `portfolio-history.json` — **the single sanctioned time-series ledger** in the repo (§10 carve-out): one record per trading day (NAV, benchmark NAV, weights, trades, λ). A `backtestThrough` date marks where simulation ends and the live record begins.
- `data-pit.json` — the dated point-in-time company snapshots the reconstructed genesis runs on (data, engine schema, each snapshot basis-noted and date-disciplined; regenerated rarely, only through review).

**Daily job**: a scheduled GitHub Action runs `node portfolio-run.js` after US close (Mon–Fri): fetch closes (Finnhub) + BTC/ETH (Coinbase), value every name with the engine at the run date (the time discount rolls forward daily), rebalance, append the ledger, commit — the site redeploys with the new state. Idempotent per date. News never enters here: facts flow through the normal proposal path into `data.json`, and the next run reprices them. The job **fails loudly rather than record silently wrong numbers**: violent overnight moves are cross-checked for splits (share counts adjust, value-preserving) vs source conflicts (name freezes; three suspect days fail the run), a mostly-missing tape marks NAV but suspends trading, names without a fresh print for >10 days freeze as uninvestable, a dead feed or unresolved conflict turns the Action red and opens a GitHub issue, and BTC/ETH forward-fill from the ledger on an outage — never a static fallback.

**Genesis provenance (honest reconstruction):** the genesis year runs on `data-pit.json` — dated snapshots of every company rebuilt from disclosures **published on or before each snapshot date**: leases enter when signed, sites when disclosed, raises when closed, names at listing, and pre-pivot names appear as what they then were (a miner, a holdco). Facts are period-true; three residual biases are structural and stay stated: the model's *structure and calibration* are today's, the *universe selection* is today's (survivorship), and reconstructed *judgement fields* (provenance, contracted %) are inferred from disclosure, not re-lived. A reconstruction, never a track record — the live record starting at `backtestThrough` is the only evidence that counts, and the Portfolio screen toggles the genesis off to show the live record alone.

### 6c. The capital-raise registry (Raises screen)

`raises[]` per company — a dated fact registry like `leases[]`, one record per announcement: `{d (ISO announcement date), ah (true = announced after the close; day 0 becomes the next session), kind (equity | atm | convert | debt | pref | other), sizeM ($M gross; ATM = program cap; null = undisclosed), terms, use, source}`. Same-day equity + convert pairs are separate records. Display-only — the engine never reads it; dilution stays where it lives (`plannedRaise` / `netDebt` / `shares`, §5a).

Returns are **derived, never stored** (§10 rule 1 stands — the ledger remains the only time series): day 0 = the first ledger session on/after the announcement (rolled past `ah` and non-trading days), baseline = the prior ledger close, windows anchored at the day-0 close, excess = the name's return minus the benchmark's over the same window. Events predating a name's ledger history are shown as facts without returns.

### 6d. Standalone research pages

A research page is one self-contained HTML file at the repo root, one per name, named `<ticker>.html` in lower case (`iren.html` is the first). It is a **dated snapshot**: its numbers are a cut of the name's `ramp` object and the engine's inputs as of the date stamped in its header and footer, with every assumption stated on the page. It reads no live data and changes only when regenerated by `node onepager.js <TK>` from the name's `page` and `ramp` blocks in `data.json` (§6e), which is one CHANGELOG line. It is deliberately not linked from the app's navigation; it carries a link back to the tracker's GPU-ramp screen as the live model. Display-only — the engine never reads it. It obeys §10: present-tense state, no history, edited in place.

### 6e. Research one-pager playbook (the recipe every research page follows)

Every research page (§6d) is built from the same template, the same math and the same recipe, so the pages are comparable across names and a reader who knows one knows them all. The recipe is invoked with the `/one-pager <TK>` skill; this section is the contract it obeys.

**Files.** `onepager-template.html` is the page shell (markup, styles, charts, the quarterly cash waterfall, the tie-out). `onepager.js` (node) fills it for one name — `node onepager.js IREN` writes `iren.html`; `--check` prints the tie-out and the summary-table totals without writing; `--sens` prints the per-share effect of the standard sensitivities — from two blocks of the name's record in `data.json`: `ramp` (the tranche schedule, rates, spot, calibration — the same object the GPU RAMP tab reads) and `page` (everything else the page needs: header facts, capex by vintage, the financing terms, the steady-state per-MW inputs, the prose notes, the sources). `ramp-core.js` holds the ramp math and is shared by the browser tab and the generator — never forked. Per-name research packs (the sourced fact files the sweeps produce) and raw source exports live outside the repo in `~/Research/<TK>/`; only extracted facts, with their dates and quotes, enter `data.json` (`page.sources`, `log[]`).

**Invariants — every page, every name.**
1. Seven sections in this order: power (announced, energised, earning; site-by-site phasing), GPUs (commissioned fleet by generation, quarterly), ARR (the company's own definition, one series), CapEx (by vintage per IT MW, and the funding stack per MW), what one megawatt earns (the steady-state per-MW DCF that yields the EV/ARR multiple, with regimes), valuation (run-rate × multiple, less net debt and other claims, discounted, over the diluted count, plus EPS), and the summary table (quarters across: Power · Use · GPUs · Rate · Revenue · Cash · Balance sheet · Earnings) whose cash waterfall reproduces the base-case value to the dollar.
2. No typed constants anywhere the table can supply: step 6 and the header tile render from the waterfall.
3. Every number on the page traces to a dated primary source or to arithmetic on one; derived numbers say so.
4. The page is a dated snapshot (§6d); regenerating it is one CHANGELOG line.

**Honest-base rules (apply to every name; deviations are stated on the page, not silently dropped).**
- Convertible notes are equity when the model's own price puts them in the money: if-converted shares net of capped calls, carried at the cash coupon meanwhile, removed from net debt at the horizon. Prepaid forwards and other share-return instruments come off the count when they mature inside the window.
- Customer prepayments are timing, not funding: received when the contract says, credited back against fees on the filed mechanism (Microsoft-style after month 24 to end of term unless a filing says otherwise), and the balance still owed at the horizon is deducted at PV like debt. No credit for prepayments on contracts that do not exist yet.
- Financing terms as filed: rate, amortisation, tenor, covenants, recourse. Restricted cash counts against the debt it secures. Lease liabilities are debt-like for tenants.
- Capex by vintage on the real silicon curve (filed orders per MW, then the disclosed inflation on later orders), shell by build type; contract pricing set so the company's own stated payback holds on that curve; unsigned capacity carries a stated contracted share, the rest earns realised spot; signed rates never escalate, they reprice at renewal.
- Equity for the residual the flywheel cannot cover, at a stated issue price, with the sensitivity to today's price shown.
- Sell-side numbers are read for facts, never for targets. Peer prints and market rate sweeps are the check on any rate the company implies.

**Source hierarchy.** (1) Filings and exhibits — 10-K/10-Q/8-K, 20-F/6-K, S-1, the customer contracts and credit agreements filed as exhibits, XBRL for the balance sheet. (2) The company's decks, releases and earnings calls, quoted with speaker and date. (3) A named allow-list of trusted secondary sources: SemiAnalysis, TrendForce, construction and satellite trackers (Frans Bakker for IREN), named Substack analysts (Agrippa Investments). (4) Press only to locate a primary. Paywalled work reaches the model only as an export the owner drops in `~/Research/<TK>/`.

**Business-model variants.**

| Step | Owner-operator (IREN) | Tenant cloud (CoreWeave, Nebius-leased) | Landlord (Riot, Core Scientific) |
|---|---|---|---|
| Power | Energised MW by own site | Contracted vs active MW by lessor site and lease start | Leased MW by tenant, start, term, escalator |
| CapEx | GPUs + ancillaries, and shell | GPUs + ancillaries only; the shell is a lease | Shell and electrical only; tenant funds fit-out |
| Debt-like | Debt, converts, prepayments owed | Same, plus lease liabilities at PV | Same, plus tenant-improvement obligations |
| Revenue | $/MW-yr on commissioned GPUs, company ARR definition | Same; backlog/RPO definitions differ by name | $/kW-month lease revenue |
| Margin | ~65% EBITDA | Lower after lease and power; finance leases hide cost below EBITDA — restate | 85–90% NOI |
| Multiple | Per-MW DCF | Per-MW DCF with the lease inside it | Cap rate on NOI, or EV per contracted MW |
| Legacy | Mining impairments, non-cash | None | Mining cash for two more years, then runoff |

Nebius is a hybrid (owns Finland and some US sites, rents the rest) and takes both columns site by site.

**The loop (what `/one-pager <TK>` does).** Scope → research-pack workflow (one agent per source strand, an independent refuter per strand, a consolidator, a completeness critic, up to two gap rounds) → fill `page` and `ramp` from the pack → `node onepager.js <TK>` → the verify workflow (the ten largest assumptions each refuted twice, a harness reproduction, a critic) → loop until two rounds add nothing → CHANGELOG line, commit, publish. Done means: the tie-out reproduces the base; the harness reproduces the page; two adversarial rounds find nothing material; the critic reports no unread source type and no unsourced claim; the owner has had the "what are we overly optimistic on" pass.

## 7. Build plan

**Phase 0 — disposable prototype (no infrastructure).** Self-contained interactive page, a few fully-modeled names, live dials. Validate logic, look, feel. Use Claude Design to refine. Throw away freely.

**Phase 1 — real app (Claude Code), only once Phase 0 is right.** Data moves out of code into its own file; full universe; persistent developments log; deployed somewhere reachable. Enter with a locked target so scope stays contained.

**Phase 2 — operate (Cowork).** Weekly: read leases/interviews/conference notes, log developments against sites, re-score, get a note. Same loop as miner-swarm.

**Discipline:** a site is a few tags, never a mini-model. Capital stack, legacy, edge stay at company level. Three rungs of provenance, not five. One discount rate, not a DCF. This document is the contract — point the tool back here when it drifts.

## 8. Data-gathering method (art + science)

The schema is the science; populating it is the art, and the process is iterative. You don't need all twenty names fully sourced to start — build with a few, pour real data in as it's gathered, and let coverage deepen over time. Data is public and judgement-laden: company disclosures, proprietary research (e.g. SemiAnalysis), interviews and conference notes, entered deliberately.

A guiding prior for the judgement calls (how to set provenance, contracted %, and the likelihood that pipeline power converts to contracts): **power proximity drives contracts.** The nearer a megawatt is to energizing, the more likely it gets contracted — because the supply/demand imbalance for compute is tighter in the near term than the long term. So near-dated, high-provenance capacity should also carry higher contract likelihood; far-dated capacity is softer on both counts. Note this naturally reinforces the time-and-provenance fade already in the model.

This is stated as **analyst method, not hard-coded logic** — it guides how you fill the fields, it is not a formula the tool computes for you. If it ever earns a mechanic, the lightest form would be an optional global "supply/demand tightness by year" prior that nudges contract-likelihood for near vs far sites — a later consideration, deliberately not built now, and not a step toward a DCF.

## 9. Data sources & live price

**Live share price.** Price is the only field fed automatically, because it's the only input that's an objective market fact rather than your judgement. It refreshes from a quote feed, drives the upside calc (target ÷ price − 1), and stays overrideable. Real-time equity data requires a paid entitlement (as with Bloomberg / IBKR market data); a delayed or snapshot quote is sufficient here. An app feature — Claude Code builds the fetch.

**Preferred-source registry.** A maintained, prioritised list of where data comes from, grouped by type: market data (price); primary filings (EDGAR, IR sites); proprietary research (e.g. SemiAnalysis); a *curated* set of expert commentary / interview feeds (not the open firehose); investor & conference calendars. Each source carries a trust level that maps to provenance when a fact sourced from it is logged — so the source travels with the fact into the audit trail. Curation is the point: a handful of trusted sources, not everything.

**Paywalled sources** (SemiAnalysis, Bloomberg, etc.) are accessed through your own authenticated access or entered manually and tagged proprietary — never scraped or circumvented.

**Retrieval vs writes — the boundary that keeps "look up" from becoming "autoscraper."** Looking things up is open and assisted (largely Cowork's job in the weekly loop, using web / Drive access against the registry). Changing the model is gated: a lookup yields a proposed update you review and accept, mirroring miner-swarm's proposal queue. The boundary isn't on retrieval — it's on what's allowed to write.

## 10. File discipline (read this first, Claude Code)

The failure mode that sinks projects like this is markdown sprawl — files that accumulate session history ("previously X, now Y, updated June 24…") until they read as lab notebooks. Four hard rules:

1. **State files are present-tense only.** Every file answers "what is true now," never "what changed and when." If a line contains a date, a "previously," a "we thought," or a "this run," it is history — it belongs in the changelog or nowhere. One carve-out: `portfolio-history.json` is the single sanctioned time-series ledger (§6b) — a market record appended by the daily job, not narrative state. No other file accumulates history.
2. **Ticker state is structured data, not markdown.** A company's current view (sites, commercial layer, narrative, bull/bear) lives in the app's data file as fields you overwrite — not in a per-ticker document. Data holds values, not their history, so cruft has nowhere to land. There are no per-ticker markdown files.
3. **Closed allow-list of markdown files.** Only these exist: this spec/contract, one CHANGELOG, the wiki (one file, or a few clearly-scoped ones) for durable how-it-works knowledge and discipline definitions, and the one skill prompt `.claude/skills/one-pager/SKILL.md` (§6e; a prompt, not state). Anything outside this list is not created without being asked.
4. **Edit in place, never append.** When state changes, overwrite the old value. That it used to differ is one line in the CHANGELOG, recorded once, then gone from view. No file grows just because time passed.

## 11. Analytical disciplines — lenses, not silos

The work spans distinct expertises — financial analysis; energy & interconnect; sentiment from calls, interviews and conferences; policy & regulatory. The anti-sprawl resolution: **disciplines are how you gather and reason, not how you store.** Each is a review lens (a skill in Cowork's operate-loop) with its own remit and sources, but every lens converges on the same schema and the same changelog. Richness in process; minimalism in artifacts. The structure mirrors the miner-swarm dimension agents, extended onto this schema.

Each lens reads its slice of the source registry, produces proposals against existing fields, tags provenance, and creates no storage of its own:

| Lens | Reads | Writes to (existing schema) |
|---|---|---|
| Financial analysis | filings, IR, debt docs | company tier — net debt, cost of debt, financing mix, shares (valuation is computed from these) |
| Energy & interconnect | IR, queue data, power agreements, proprietary research | site tier — MW, energization date, provenance, owned/leased, region |
| Sentiment (calls, interviews, conferences) | transcripts, curated feeds | dated developments + a present-tense narrative / bull-bear read; nudges provenance and contract-likelihood judgement |
| Policy & regulatory | policy sources, news, filings | mostly site provenance / energization date (permitting risk slips dates, softens provenance); sector view → narrative / edge; durable regional context → wiki |

Rules that keep lenses from becoming silos:
- A lens writes only to an existing shared field, a dated development, or a narrative field — never a new file or data structure.
- A lens's *expertise* (what to look for, which sources, how to judge) lives in its skill definition (allow-listed, durable) — not in per-run outputs.
- Qualitative lenses (sentiment, policy) keep a single terse present-tense read per company, overwritten, with the raw dated events in the log — never a running commentary.
- All lenses feed one proposal queue and one changelog. One approval path, one history.
