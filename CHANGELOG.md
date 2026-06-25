# Changelog

The single record of what changed. One line per change, newest first.

- Global dial: "Revenue ramp to steady-state (months)" — delays each site's value by N months in the time-discount, modeling commissioning / GPU fill / contract ramp after first power, without per-site phasing. Base case 9mo (CRWV target $216 → $198). Shown in each site's time-discount line.
- Full-page valuation: each per-site bar in "where the value comes from" expands to a live step-by-step breakdown (rate → margin → multiple → value/MW → gross → haircut → time-discount → site value, with contracted/expected split). Model-aware (owner vs landlord); recomputes with the dials. Panel sites stay a concise summary.
- Engine: site-aware contracted/spot split — uncontracted (rumored) pipeline earns the spot rate and moves with the GPU-rate dial; disclosed/estimated capacity carries the contracted book. New "contracted floor vs expected upside" split shown on the comparison bar and in each company's valuation build. Implements spec §4 (contracted book insulated, spot book moves).
- CRWV: real researched data replaces placeholders — 14 sites (full contracted book + ramped path to 8 GW by 2030), capital stack (~$22.9B net debt, 545M shares, $102), and sourced narrative. Target ~$218 at base case; ~21% of value rests on rumored capacity.
- Phase 1 app: four screens (comparison, sites, company panel + full page, assumptions dials), valuation engine ported from the prototype, all data loaded from `data.json` at runtime. Three names: CRWV, NBIS, RIOT.
- Scaffold Phase 1: repo, `CLAUDE.md`, spec and prototype copied in.
