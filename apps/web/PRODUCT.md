# Product

## Register

product

## Platform

web

## Users

Sophisticated LPs and capital allocators who already distrust headline APR. They read basis points and TVL fluently, know that displayed liquidity isn't in-range liquidity, and are here specifically because dashboards that average away that distinction have cost them before. They arrive with a deposit size in mind and want the honest number for *that* size — not an ideal-case rate they'll never realize.

## Product Purpose

Aggregators rank USDC LP venues on fees over displayed TVL, but only in-range liquidity earns fees and a deposit changes its own denominator — so the best venue is a function of how much you put in, and no dashboard asks for that number. This tool does: it takes a deposit size and hold period, and returns the APR that size actually earns per venue, ranked honestly.

Two jobs matter equally, not one over the other:
- **Decide** — enter a size, see the ranked, honest APR, know where to put capital.
- **Understand** — see the gap between headline and actual, and read exactly why a venue was excluded rather than approximated.

Success is a user trusting the number enough to act on it, and being able to defend that trust by pointing at the reason.

## Brand Personality

Confident, institutional, composed. This is a private research desk, not a retail dashboard — the tone of a worked proof, not a pitch. Restraint communicates rigor here: nothing needs to perform confidence through motion or saturation because the math already did the work. The product's own voice sets the bar — dilution formulas shown in full, exclusions named with a specific reason, bugs found in production stated plainly in the README — so the interface should read like it was built by the same hand that wrote that, not by a template dropped on top of it afterward.

## Anti-references

Generic DeFi/SaaS dashboard grammar, specifically: neon green/purple accents, glassmorphism, gradient-text headings, the hero-metric template (big number + small label + gradient accent line), decorative glow, and the default shadcn dark palette left unchanged. A prior pass on this page (bracket eyebrows, bronze accent, hairline borders on near-black) was competent and WCAG-clean but read as generic "dark trading terminal" rather than something specific to *this* product's own logic — avoid repeating that outcome. The interface should not need a genre cue (terminal, trading, DeFi) borrowed from other products to feel serious; the seriousness should come from how it handles the vault's own numbers.

## Design Principles

1. **The gap is the hero, not a footnote.** Headline APR vs. your actual APR is the entire value proposition — the layout should make that comparison unavoidable at a glance, not bury it in a table column.
2. **Show the reason, not just the exclusion.** A pool that can't be ranked honestly is not hidden and not approximated — it's named, with the specific measurable cause, at the same visual weight as a ranked row.
3. **Restraint reads as rigor.** Confidence comes from precision and composure — exact figures, deliberate hierarchy, unhurried pacing — not from color intensity, motion, or decorative flourish.
4. **No hand-holding, no unexplained numbers.** The audience reads basis points natively; every figure earns its place by being traceable to the formula in the footer, never presented as an unexplained black box.
5. **Nothing borrowed from "DeFi app" as a genre.** Visual decisions should trace back to this product's own worked logic (the dilution math, the exclusion rule, the honest-vs-headline gap), not to trading-terminal or SaaS-dashboard convention.

## Accessibility & Inclusion

WCAG AAA where practical without compromising the visual direction (AA is the floor, already verified numerically for the existing token set); `prefers-reduced-motion` is honored for all motion. Color is never the sole carrier of meaning (gap direction, exclusion status, and flags all pair color with text/symbols already). Numeric alignment and tabular figures throughout so figures are scannable and comparable without color as a crutch.
