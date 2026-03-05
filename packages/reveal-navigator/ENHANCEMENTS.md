# Navigator Enhancements — Architect Review + Developer Critique

**Source:** External architecture review ("The Architect"), February 2026
**Reviewed by:** Claude (Developer), against current Navigator codebase

---

## 1. Enhance Squeegee Splash with E_rev Progress

**Architect's suggestion:** Display Revelation Error (E_rev) alongside the squeegee
animation during ingest.

**Implementation critique:** Scoped wrong. The splash is transient (~1-2s during ingest).
There is no "40-image audit" in the Navigator — it processes one document. E_rev lives
in reveal-batch and an inlined copy in reveal-adobe, neither accessible here. The correct
location would be the persistent `#status-text` element, updated on every proxy cycle.

**Value critique:** Low. E_rev as a live number during archetype exploration is
*theoretically* useful — it tells you "this archetype maps your image with mean ΔE 4.2."
But in practice, the user is already looking at the preview. If the preview looks wrong,
they swipe the carousel. If it looks right, they don't care what the number says. A
number doesn't change behavior when the decision surface is visual. The exception would
be comparing two archetypes that *look* similar but have different E_rev — but that's
a rare edge case, and the Ghost Overlay (#2) solves it better by making the difference
visible rather than numeric. E_rev is a batch-validation metric, not a real-time
navigation aid.

**Verdict:** Skip unless users specifically ask for a quality score. The preview IS
the quality score.

---

## 2. Ghost Overlay (A/B Comparison)

**Architect's suggestion:** Toggle button overlays the previous archetype at 50% opacity
to show hue drift between swaps.

**Implementation critique:** The Architect pointed to `_archetypeStateCache` but it
doesn't store pixel buffers. Feasible by caching the base64 data URL string (~30-50KB)
in Preview.js before each swap. `mix-blend-mode: difference` would be more diagnostic
than plain opacity.

**Value critique:** Medium-High for experienced users, but with a real workflow risk.
The value is in answering "what changed?" when swapping archetypes — specifically in
low-contrast regions where hue shifts are hard to see. A difference blend makes this
surgical: bright pixels = divergence, black = identical.

The risk: it adds a mode. Modes create confusion. The user has to remember to toggle
it off, and while it's on, the preview doesn't show what the output will look like.
For a tool where Preview = Production is a sacred principle, any overlay that breaks
that correspondence is dangerous. A user who forgets they're in ghost mode might make
palette edits based on a blended image that doesn't represent reality.

Mitigation: make it momentary (hold-to-compare, not toggle). Show only while a
button is pressed, snap back to true preview on release. This preserves the A/B
utility without creating a persistent mode that can mislead.

**Verdict:** Build it, but as hold-to-compare, not toggle. The momentary interaction
preserves Preview = Production integrity.

---

## 3. Interactive Region-of-Interest (ROI) E_rev in Loupe

**Architect's suggestion:** Display a local E_rev score in the Loupe for the tile under
inspection.

**Implementation critique:** The Loupe already has both original and posterized pixels
in memory after `ProductionWorker.renderTile()`. Computing mean ΔE is ~50 lines of
trivial math. Display as a corner label with threshold coloring (green/yellow/red).

**Value critique:** This is the only suggestion that creates genuinely new information
the user cannot get any other way. Here's why:

The preview shows you what the *whole image* looks like. The Loupe shows you what a
*region* looks like at native resolution. But neither tells you *how far off* a region
is from the original. A face can look "okay" in the Loupe while actually being ΔE 10
from the source — the human eye adapts and normalizes. A number breaks through that
adaptation. It turns "this looks fine I guess" into "this is ΔE 11.2, I should try
another archetype."

This is especially critical for the screen printing use case: a ΔE of 8 on a sky
background is acceptable, but a ΔE of 8 on skin tones is a reject. The Loupe is
already the tool for inspecting critical regions — adding a quality number makes it
a diagnostic instrument, not just a magnifier.

The prerequisite (moving E_rev to reveal-core) has independent value — both
reveal-batch and reveal-adobe have their own copies of the same math, which is a
maintenance liability. The refactor pays for itself.

**Verdict:** Build this first. Highest value-to-effort ratio in the list. The refactor
unblocks it and pays down existing tech debt simultaneously.

---

## 4. Edit-Lock Indicators on Carousel Cards

**Architect's suggestion:** Add orange dots to carousel cards showing which archetypes
have manual palette edits.

**Implementation critique:** Trivial — check `_archetypeStateCache` for non-empty
`paletteOverrides`, add a CSS dot. Note: the Architect misunderstands the override
model. Edits are per-archetype, not carried across. The dot means "you customized
this one," not "edits propagated here."

**Value critique:** Low. This solves a problem that barely exists. The typical
workflow is: swipe carousel → find a good archetype → edit its palette → commit.
Users don't edit multiple archetypes in a single session and then forget which ones
they touched. The carousel is 17 cards — even if you edited 3 of them, you remember
which 3 because you just did it 30 seconds ago.

Where this *would* matter: if the Navigator supported saving sessions and resuming
later. Then you might open a session from yesterday and genuinely not remember which
archetypes had manual edits. But session persistence doesn't exist yet, so the
indicator has no scenario where it provides information the user doesn't already have.

The one marginal benefit: it's a visual confirmation that the cache round-trip
worked. "I edited warm-naturalist, swiped away, swiped back — is my edit still
there?" The orange dot answers that without clicking into PaletteSurgeon. But the
swatch strip on the card already shows the edited colors, so even this is redundant.

**Verdict:** Defer. Build it when session persistence lands. Until then, it's
decoration.

---

## 5. Harden triggerProxyUpdate Concurrency Guard

**Architect's suggestion:** Ensure stale posterizations don't overwrite fresh ones
during slider scrubbing.

**Implementation critique:** Already implemented correctly. 50ms debounce +
`_updateInFlight` boolean + `_updateQueued` drain in `finally` block. Rapid scrubbing
produces at most one running + one queued update. The queued update reads live state
at execution time, so staleness is impossible.

**Value critique:** Zero — this is a non-issue. The Architect flagged a concern
that the code already addresses. The debounce-and-queue-one pattern is the standard
solution for this exact problem, and the implementation is textbook correct.

If anything, the current 50ms debounce could be *reduced* to 30ms for snappier
slider feel, since the proxy update itself only takes ~30ms for mechanical knobs.
But that's a tuning knob, not a bug.

**Verdict:** No action. Already solved.

---

## Summary

| # | Enhancement | Value | Effort | Build? |
|---|------------|-------|--------|--------|
| 3 | ROI E_rev in Loupe | **High** — new diagnostic information | Low (after E_rev refactor) | **Yes, first** |
| 2 | Ghost overlay (A/B) | Medium — hold-to-compare only | Low | **Yes, second** |
| 1 | E_rev in status bar | Low — preview is already the score | Medium | Defer |
| 4 | Edit-lock indicators | Low — no forgetting scenario exists yet | Trivial | Defer to session persistence |
| 5 | Concurrency guard | None — already implemented | N/A | No action |

**Build order:** Refactor E_rev to reveal-core → #3 (ROI Loupe) → #2 (Ghost, momentary).

---

## Clarification: Navigator vs. Batch Pipeline

The Architect's review references a "40-image audit" in several places. This refers to
the **reveal-batch** CLI pipeline, which processes the TESTIMAGES dataset and computes
a global E_rev score per image. That is a separate tool from the Navigator.

| | reveal-batch | reveal-navigator |
|---|---|---|
| **Mode** | Offline CLI | Interactive UXP panel |
| **Input** | 40+ PSD files in a directory | One live Photoshop document |
| **E_rev** | Global score per image | Not currently computed |
| **Purpose** | Archetype quality validation | Real-time archetype exploration |
| **User** | Runs unattended, results reviewed after | User is actively scrubbing UI |

They share the same core engines (`@electrosaur-labs/core`) but serve completely different
workflows. E_rev from the batch audit informs archetype quality *offline* — the
Navigator's job is *real-time* exploration of one image.

The ROI Loupe enhancement (#3) bridges that gap: it brings per-region E_rev into the
interactive workflow, which the batch pipeline cannot do because it only computes a
single global score per image. This is why #3 is the highest-value enhancement — it
creates a feedback loop that doesn't exist in either tool today.

### Remaining Disagreements with Architect's Refined Plan

1. **Ghost Overlay must be hold-to-compare, NOT toggle (shortcut G).** A toggle mode
   violates the Preview = Production principle. A user who hits G and forgets is making
   palette edits against a blended image that doesn't represent the actual output.
   Hold-to-compare (show ghost only while key is held) preserves A/B utility without
   the risk of a persistent misleading mode.

2. **Edit-lock dots (#4) are still premature.** The Architect re-justified them as
   preventing "accidentally losing work" — but `_archetypeStateCache` already preserves
   edits across carousel swaps automatically. You cannot lose palette surgery by
   auditioning another archetype. The cache round-trips silently. The dot would confirm
   something that already works. Defer to session persistence.

3. **`#accuracy-text` span does not exist** in the current `index.html`. The Architect's
   refined plan references it as if it's already there. It would need to be added to the
   `#doc-header` or status bar area.

---

## Patent Analysis — Developer Assessment

**Context:** A patent application was proposed for the technology embodied by the
Navigator. The codebase is currently unreleased with a single contributor, so licensing
can be changed freely. The following analysis evaluates the negatives in depth.

### What's Potentially Patentable

- The DNA → Archetype → Parameter pipeline (image signature drives all downstream config)
- The 40/45/15 weighted archetype matching system (7D centroids)
- The 512px proxy engine with resolution-aware threshold overrides
- The progressive pulse ingest (DNA → Carousel → Preview in <550ms)
- The mechanical knobs as post-separation print-quality controls
- The Loupe with native-res tile fetch through the proxy separation pipeline

### Negative #1: Prior Art Exposure Is Deep

The individual techniques are well-established:

- **Median cut color quantization** — Heckbert, 1982. Forty-four years old.
- **CIE Lab perceptual distance** — CIE76 (1976), CIE94 (1994), CIEDE2000 (2001).
  International standards.
- **Expert systems mapping image features to parameters** — predates AI/ML by decades.
  Photoshop's Auto Color (2002) does a simpler version of this.
- **Proxy/thumbnail preview with full-res commit** — standard in Lightroom, Capture One,
  every RAW processor since the 2000s.
- **Halftone/separation software** — Spot Process (2003), AccuRIP, FastFilms, Separation
  Studio. All do color separation for screen printing.

The novelty would need to be in the *specific combination* — the DNA fingerprint driving
archetype selection driving parameter generation driving proxy preview with mechanical
knobs. But "combining known techniques in a predictable way" is exactly what Alice Corp
v. CLS Bank (2014) and subsequent case law attacks. The USPTO and courts have become
increasingly hostile to software patents that combine existing ideas, even if the
combination is clever.

A patent examiner will decompose claims into: (a) analyze image features, (b) match to
templates, (c) generate parameters, (d) apply color reduction, (e) show preview. Each
step has deep prior art. Prosecution could take years arguing the combination is
non-obvious.

### Negative #2: Disclosure Destroys the Actual Competitive Advantage

A patent application is a **public document**. The entire specification — algorithms,
thresholds, 40/45/15 scoring weights, 7D centroid structure, proxy-safe threshold
overrides — becomes searchable public knowledge 18 months after filing.

The competitive moat is not the algorithm — it's the *tuning*. The TUNING object in
PosterizationEngine, the archetype centroid JSONs, the ParameterGenerator mapping rules,
the Green Rescue activation thresholds — these are hard-won empirical values from
hundreds of hours of testing against the CQ100 and SP100 datasets. A competitor reading
source code could replicate the architecture, but getting the tuning right requires the
same investment.

A patent application would organize and explain these tuning decisions in a way that's
far more accessible than reading raw source code — effectively writing a manual for
competitors. And after 20 years (or sooner if the patent is invalidated), they can use
it royalty-free.

### Negative #3: Cost vs. Market Size

- Patent prosecution: $15,000-$30,000 (filing, office actions, grant)
- Maintenance fees over 20 years: ~$12,000
- International filing (PCT + national phase, 3-5 countries): $50,000-$100,000+
- **Total: $80,000-$130,000** for meaningful protection

Patent enforcement (litigation): **$1M-$5M minimum** for an infringement case through
trial.

The addressable market for screen printing color separation software is small. Screen
printing is a $10B industry, but the software tools segment is a tiny fraction. Direct
competitors (Spot Process, Separation Studio) are small companies. Even if one infringed,
damages collected would likely not cover litigation costs.

### Negative #4: Claims Scope Dilemma

If claims are broad ("a method for automatically selecting color separation parameters
based on image analysis"), the examiner will cite Photoshop Auto Color, adaptive image
processing papers, and reject.

If claims are narrow enough to survive prosecution ("a method using a 7-dimensional
centroid comprising lightness, chroma, blackness, L-standard-deviation, entropy, color
temperature, and sector weight, scored with 40% structural, 45% sector affinity, and
15% pattern weighting to select from a plurality of archetype templates"), any competitor
can design around it by using 6 dimensions, different weights, or a neural network
instead of centroid matching.

This is the fundamental dilemma with software patents on algorithmic innovations: the
novelty is in the specific numbers, and specific numbers are trivially varied.

### Negative #5: Timeline vs. Technology Lifecycle

Patent prosecution takes 2-4 years. The patent lasts 20 years from filing. But:

- UXP may be replaced by Adobe's next plugin framework
- AI-driven approaches (diffusion models, neural color transfer) may make algorithmic
  separation obsolete
- The screen printing industry is consolidating toward DTG and DTF
  (direct-to-garment/film), reducing demand for traditional separation

The investment would protect a technique that may be superseded before the patent grants.

### Negative #6: Defensive Patent Value Is Low

The common counterargument: "We just need it defensively, so nobody can patent our
approach and sue us." This has merit in patent-dense industries (mobile, semiconductors)
where trolls and cross-licensing are realities. But in screen printing software:

- **Adobe** doesn't care about screen printing separation (30,000+ patents, not patenting
  color quantization)
- **Spot Process / AccuRIP / competitors** are small companies almost certainly not filing
  patents
- **Patent trolls** target large companies with deep pockets, not niche plugin developers

The threat being defended against is largely theoretical.

### Negative #7: Unreleased Code Makes Patent Unnecessary

Since the codebase is unreleased with a single contributor, full trade secret protection
already exists — for free, indefinitely, with no public disclosure. Filing a patent
would actually *weaken* the current position by requiring disclosure of what is currently
completely private.

### Recommendation: Trade Secret, Not Patent

The strongest IP position for an unreleased codebase:

1. **Keep the engines proprietary** — do not open-source the core algorithms
2. **Distribute only as compiled UXP plugins** — obfuscated webpack bundles
3. **Document the invention internally with dated records** — establishes prior art
   defense if a competitor attempts to patent similar techniques
4. **Ship and iterate faster** than anyone who tries to replicate

This provides all the protection of a patent (nobody can use the exact approach) plus
indefinite duration, zero cost, and no public disclosure. The only thing lost is the
ability to sue someone who independently invents the same technique — but given the
market size, that lawsuit would never be worth filing.

The competitive moat for Reveal is not the algorithm — it's the calibration, the
archetype library, the print-validated tuning, and the user experience. None of those
are well-served by a patent. All of them are well-served by shipping faster than
competitors.
