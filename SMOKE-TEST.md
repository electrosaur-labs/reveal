# Photoshop Smoke Test Plan

Run this checklist after every significant Navigator change.
Takes ~10 minutes with two test images.

## Test Images

| Image | File | Why |
|-------|------|-----|
| **Jethro** | `JethroAsMonroe-original-16bit.psd` | High contrast, 6 distinct hues, large neutrals, stress-tests palette boundaries |
| **Horse** | `horse.psd` | Warm-dominant, continuous tones, stress-tests gradient regions |

## Pre-flight

- [ ] Fresh Navigator build (`npm run build:navigator`)
- [ ] Reload plugin in Photoshop (Developer Tool > Reload)
- [ ] Open test image (flatten if needed)

## Per-Image Checklist

Run for **both** Jethro and Horse.

### 1. Chameleon (default)

- [ ] Preview loads, carousel populates
- [ ] Preview looks correct (no green cast, no obvious artifacts)
- [ ] **Commit** — inspect each separation layer:
  - [ ] No white spots (substrate showing through)
  - [ ] No wrong-color dots (black on white, white on black)
  - [ ] Layer count matches preview palette
  - [ ] Colors look correct (compare hex values to preview chips)

### 2. Distilled

- [ ] Swap to Distilled, preview updates
- [ ] **Commit** — inspect layers:
  - [ ] No spots or cast
  - [ ] ~8-12 colors (Distilled's range)

### 3. Salamander

- [ ] Swap to Salamander, preview updates
- [ ] **Commit** — inspect layers:
  - [ ] No green cast
  - [ ] No spots
  - [ ] Detail preserved in shadow/highlight transitions

### 4. Dither Type Sweep (Jethro + Chameleon only)

Only needed after dither-related changes.

| Dither | Expected |
|--------|----------|
| blue-noise | Sharp, may have minor spots at boundaries |
| atkinson | Sharp, clean (recommended for Salamander) |
| none | Slightly softer, fully clean |
| floyd-steinberg | Smooth gradients, clean |

- [ ] Switch dither type in Advanced panel
- [ ] **Commit** each — verify no white spots

### 5. Knob Stress Test (Jethro + Chameleon only)

- [ ] speckleRescue=10 → Commit → no white spots
- [ ] shadowClamp=15 → Commit → no white spots
- [ ] minVolume=3 → Commit → plates merge correctly

## Known Issues

| Symptom | Cause | Workaround |
|---------|-------|------------|
| White/black dots at color boundaries | blue-noise dither + speckleRescue conflict | Switch dither to `atkinson` or `none` |
| Green cast on Salamander | CIE94 + `none` dither shifts boundaries at full res | Use `atkinson` dither |
| Detail loss with `none` dither | No error diffusion to smooth color transitions | Use `atkinson` dither |

## Pass Criteria

All checkboxes checked = PASS. Any white spots, color casts, or missing
layers = FAIL. Stop, note which archetype/dither/knob combination failed,
and file a bug before proceeding.
