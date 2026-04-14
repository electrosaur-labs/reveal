# reveal-navigator TODOs

## Krita Parity (B/W & Grayscale)

- [ ] **Enforce B/W Palette Constraints:** If `colorMode` is `bw`, force exactly 2 colors (Black/White), hide the Suggested tray, and hide the "Add Color" button.
- [ ] **Enforce Grayscale Constraints:** If `colorMode` is `grayscale`, hide the Suggested tray (or filter for monochromatic values).
- [ ] **Mode-Aware Color Picker:**
    - Disable picker completely for `bw` mode.
    - Restrict picker to pure luminance/grayscale for `grayscale` mode (hide chroma planes/HSV sliders, force S=0).

## Palette Surgeon Fixes

- [ ] **Smart Removal for Added Colors:** When a user-added color (marked with `isAdded: true`) is deleted or merged from, hard-delete it from the palette array instead of soft-deleting/remapping. Original engine colors should continue to use soft-delete.

## UI Labels

- [ ] Rename "Halftone" label (Output group, `picker-ditherType`) to **"Dither"** — matches Krita plugin convention and is more technically accurate for the screen printing workflow.
