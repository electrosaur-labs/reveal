# reveal-app v1 — Scope Fence

## What v1 Does

- Read an image file (PNG, TIFF, JPEG, PSD) via drag-and-drop or file picker
- Compute image DNA
- Run 3+1 archetype passes: Auto (DNA match), Chameleon, Distilled, User-selected
- Display palette swatches and canvas preview for each
- Click a card to see it full-size
- Export the selected separation as PSD with fill+mask layers

## What v1 Does NOT Do

- No palette surgery (no merge, remove, add, recolor)
- No mechanical knobs UI (no sliders for minVolume, speckleRescue, shadowClamp)
- No loupe, radar HUD, or blink comparator
- No suggested colors / color injection
- No A/B comparison mode
- No production render (uses pipeline's built-in full-res mapping)
- No UI framework (vanilla HTML/JS/CSS)
- No Electron or native wrapper
- No recipe recording or replay

## When to Cross the Fence

Adding any feature from the "Does NOT Do" list requires a deliberate design decision,
not gradual drift. If you're tempted, ask: "Does this make the weekend print run better?"
