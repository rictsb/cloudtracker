# AI Infrastructure Relative-Value Tracker — Spec & Build Plan (v2)

*A personal, first-principles tool for ranking AI-infrastructure names against each other and against a price target. This document is the contract: what the app is, what it is not, the data it holds, how the valuation flows, and how to build it. Carry it into Claude Design, Claude Code, and Cowork.*

---

## 1. What this is (one line)

A comparative valuation tracker where **logging a development updates the model**, and the valuation and ranking for all companies recompute live. You record what happened (a lease, an energization, a financing) against the site it touches; the facts change; the price targets and the ranking move. No separate model to maintain.

## 2. What this is NOT (scope guard)

- Not a trading system or anything that touches a broker.
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
- Average term remaining (years — the decay rate on that contracted book)
- Renewal probability (chance a rolled MW stays occupied — re-contracting/occupancy, demand + location)
- Mark-to-market factor (renewal rate; model-aware denominator — see below)
- Counterparty quality (does the current tenant pay)
- Cost of debt (blended average rate) and financing-mix tag (investment-grade / high-yield / ABS-or-project / equity-heavy)
- Capital stack (net debt, shares), legacy business value (hybrids), edge note

**Global dials — interpret the tags across all names at once.**
- Prevailing GPU rate ($/MW·yr) — the market rate; moves the spot-exposed book
- Owner-operator base margin, compute-value multiple
- Landlord cap rate
- Discount rate (time)
- (Fixed tables: provenance → execution probability; region → power-cost adjustment)

## 4. Key mechanics that emerged

**Spot vs contracted is a company number, not a site tag.** It's a property of the revenue book, not the concrete — one number per name (e.g. CRWV ~85% contracted, NBIS ~40%). The contracted book is insulated from the GPU-rate dial; the spot book moves with it. Crank the dial and spot-heavy names fan away from contracted ones — that fan-out is the tradeable signal. The model never says "contracted is good"; the rate dial and your directional view decide. For a scarce-compute bull, spot exposure is upside leverage.

**Renewals are company/industry-level, and the denominator is model-aware.**
- Compute renews at % of *prevailing market* (it re-rates with your dial) — so the bull thesis flows through the re-signings instead of being capped at a stale vintage.
- Landlords renew at % of *original* (escalators, sticky tenants).
Term remaining sets how fast today's contracted book rolls toward those long-run assumptions.

**Two separate time axes — do not collapse them.**
- *Re-contracting* (tenant to tenant) is a rate question → valued at long-run, no phasing.
- *Energization* (when the MW first switches on) is an arrival question → discounted by year. A 2030 site is the same steady-state dollars as a 2027 site, just discounted three more years.

**Probability and timing stay separate.** Provenance answers *how sure* (execution haircut). Energization year answers *when* (time discount). A permitted-but-slow site and a fast-but-contested site are different bets; one rising discount would blur them.

**Cost of debt is a floor on the discount rate, not a cash-flow model.** The global discount dial sets a baseline; a company is never discounted below its own cost of debt. A name borrowing at 11% shouldn't have its far-dated MW discounted at 8%. This differentiates leveraged names and compounds with the time fade — expensive debt plus far-dated capacity is discounted twice over — without any debt machinery. The line to hold: capital cost as an *input to the discount and a qualitative tag* — yes. A debt-maturity wall, refinancing schedule, or interest-coverage projection — no, and probably never in this tool; that is the DCF in disguise. Wanting to know *when* debt comes due is the signal you've crossed the line.

**Disclosure precision correlates with certainty** — near-term dates get disclosed because they're real; far dates stay vague. So provenance is signal, not noise, and it drives both the haircut and a visual fade. Provenance replaced the old "stage" field: the explicit year is the truer "when," provenance the truer "how sure."

## 5. How value flows (facts + dials → output)

For each **site**: steady-state $/MW (model-aware) × MW, adjusted for region + owned/leased, then **haircut by provenance probability**, then **discounted by energization year**.
For each **company**: sum its sites; overlay the commercial layer (the contracted/spot rate blend and renewal economics set the rate the compute sites earn; cap-rate compression for landlords); add legacy business; subtract net debt; divide by shares → price target and upside.

**Value-per-MW and long-run margin are outputs, not inputs** — they're the MW-weighted blend of the site mix. Two identical-MW clouds with different owned/contracted/region mixes show materially different blended margin and $/MW, and that gap is the thing you trade.

## 6. The screens (four)

1. **Comparison dashboard** — all names, sortable by upside or relative-strength score, with a value-composition bar per company.
2. **Company one-pager** — a full research page per ticker (see §6a): the quantitative roll-up plus qualitative narrative and judgement. Presented two ways: a **slide-out panel** for a quick look from the comparison or sites views, and a **full page** that is the panel's superset — the same content with room to grow.
3. **Sites table** — every site across the whole universe in one list: company, MW, owned/leased, region, energization date, provenance, and discounted value contribution. Sortable and filterable. The master inventory the roll-up is built from, and the fastest way to see how much of the universe's MW is disclosed vs rumored, or concentrated in one region or one delivery year.
4. **Assumptions panel** — the global dials; change one and everything recomputes live.

### 6a. The company one-pager

The full page and the quick panel draw from one content model — the panel is a summary surface, the full page is the extensible home, so they never diverge. The full page is laid out more graphically and is built to be extended; the panel shows the core of it.

Core sections (both surfaces):
- **Header** — ticker, model, price, target, upside, relative-strength score.
- **Narrative / thesis** — a few sentences in your words: what this company is, why it's mispriced, what you're underwriting. The freeform view the numbers can't hold.
- **Qualitative blocks** — bull case, bear case, catalysts to watch, key risks. Short bullets, your judgement.
- **Valuation** — graphical and expandable: a per-site value chart, the EV → equity → target build, and a drill-down to site detail.
- **Sites** — the physical roll-up, each with its execution haircut and time discount shown.
- **Commercial & capital** — contracted %, term, renewal, mark-to-market, counterparty quality, cost of debt, financing mix, capital stack.
- **Developments log** — the dated event stream; logging here attaches to a site and updates the facts above.

Planned modules (full page only, not built now — the layout reserves room):
- **Management commentary** — quotes and read-throughs from calls, fireside chats, interviews.
- **Investor & conference calendar** — upcoming earnings, growth conferences, investor days.
- Richer, broken-down / expandable valuation graphics over time.

The one-pager is the thing you'd actually read before sizing a position, and the thing Cowork refreshes each week.

**Signature — the value-composition bar carries time and provenance.** Each site is a segment sized by its discounted, haircut value; near-term capacity reads solid, far-out and rumored capacity reads faded. A target resting on 2030 rumored MW *looks* exactly as thin as it is. A built-in skepticism meter against both timing and source — the antidote to a bull talking himself into rumored upside.

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

1. **State files are present-tense only.** Every file answers "what is true now," never "what changed and when." If a line contains a date, a "previously," a "we thought," or a "this run," it is history — it belongs in the changelog or nowhere.
2. **Ticker state is structured data, not markdown.** A company's current view (sites, commercial layer, narrative, bull/bear) lives in the app's data file as fields you overwrite — not in a per-ticker document. Data holds values, not their history, so cruft has nowhere to land. There are no per-ticker markdown files.
3. **Closed allow-list of markdown files.** Only these exist: this spec/contract, one CHANGELOG, and the wiki (one file, or a few clearly-scoped ones) for durable how-it-works knowledge and discipline definitions. Anything outside this list is not created without being asked.
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
