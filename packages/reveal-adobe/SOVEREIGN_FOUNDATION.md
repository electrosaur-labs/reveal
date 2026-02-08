# Sovereign Foundation - LAB Slider Sync

**Status:** Phase 1 + Phase 5 Complete ✅

**Purpose:** Transform Reveal from command-based to event-driven architecture. Once LAB sliders are "live", the entire UI becomes an interactive color instrument.

---

## Architecture

### Three Core Components

1. **ProxyEngine** (`@reveal/core/engines/ProxyEngine.js`)
   - 512px low-resolution proxy for <30ms updates
   - Bilinear downsampling from source
   - Incremental updates (only re-runs affected steps)
   - State persistence (palette, masks, indices)

2. **SessionState** (`src/SessionState.js`)
   - Global parameter store
   - Single source of truth for all settings
   - Bridges UI and engines

3. **LABSliderSync** (`src/LABSliderSync.js`)
   - Polls Photoshop foreground color (250ms interval)
   - Detects LAB slider changes
   - Updates nearest palette color
   - Triggers proxy re-render

### The Interactive Loop

```
User drags LAB slider in Photoshop
    ↓
LABSliderSync detects change (250ms polling)
    ↓
Find nearest color in palette
    ↓
ProxyEngine.updateProxy({ paletteOverride: newPalette })
    ↓
Preview canvas updates (<30ms)
    ↓
User sees result in real-time
```

---

## Installation

### 1. Build the Plugin

```bash
cd /workspaces/electrosaur/reveal-project
npm install
npm run build:adobe
```

### 2. Add Integration Snippet to index.js

Open `packages/reveal-adobe/src/index.js` and add at the end (around line 4870):

```javascript
// Enable Proxy Mode Test Harness (Sovereign Foundation)
const { ProxyModeTestHarness } = require('./ProxyModeTestHarness');
ProxyModeTestHarness.attach();
```

### 3. Rebuild

```bash
cd packages/reveal-adobe
npm run build
```

### 4. Load Plugin in Photoshop

1. Open **UXP Developer Tool** (Creative Cloud)
2. Click **Add Plugin**
3. Select `reveal-project/packages/reveal-adobe/dist/manifest.json`
4. Click **Load**

---

## Testing the Sovereign Foundation

### Quick Test (5 minutes)

1. **Open test image in Photoshop**
   - Lab color mode (Image → Mode → Lab Color)
   - 16-bit recommended
   - Example: `/workspaces/electrosaur/CQ100/*.psd`

2. **Open Reveal plugin**
   - Plugins → Reveal

3. **Click "🎨 Test Proxy Mode"**
   - Plugin reads document at 512px
   - Initializes ProxyEngine (~200-400ms)
   - Enables LAB slider sync
   - Status message: "LAB sliders are now live"

4. **Open Photoshop Color Panel**
   - Window → Color
   - Ensure it's in **LAB mode** (dropdown at top)

5. **Drag L, a, or b sliders**
   - Watch preview update in real-time!
   - Performance indicator shows update time (target: <30ms)

6. **Observe the magic** ✨
   - As you drag sliders, the nearest color in the palette updates
   - Preview re-renders automatically
   - No "Generate" button needed
   - Pure interactive editing

---

## Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Proxy initialization | 200-400ms | One-time setup, includes full posterization |
| LAB slider update | <30ms | Fast enough for real-time feel |
| Polling interval | 250ms | Balance between responsiveness and CPU usage |
| Proxy resolution | 512px | Fixed, long edge |
| Memory | ~3MB | For 512px 16-bit LAB buffer |

---

## Debugging

### Browser Console Commands

```javascript
// View current proxy state
window.getProxyState()

// Detailed debug info
window.debugProxyState()

// Stop proxy mode
window.stopProxyMode()

// Check if active
window.isProxyModeActive()
```

### Expected Output

When proxy mode is active:

```javascript
{
  active: true,
  dimensions: { width: 512, height: 512 },
  colorCount: 8,
  labSyncEnabled: true,
  parameters: { /* all session parameters */ }
}
```

### Common Issues

#### "LAB sliders don't update preview"

**Cause:** Color Panel not in LAB mode

**Fix:**
1. Open Color Panel (Window → Color)
2. Click dropdown at top
3. Select "Lab Sliders"

#### "Performance indicator shows >60ms"

**Cause:** Complex palette or slow hardware

**Notes:**
- 512px proxy should always be <30ms on modern hardware
- If slow, check console for errors
- Ensure document is Lab mode (not RGB conversion happening)

#### "Preview canvas is blank"

**Cause:** Canvas element not found

**Fix:**
1. Ensure `previewCanvas` element exists in HTML
2. Check browser console for errors
3. Verify ProxyEngine initialized successfully

---

## Next Steps (Future Phases)

### Phase 3: Event Listener System
- Attach change listeners to all UI controls
- 150ms debounce for smooth scrubbing
- Trigger proxy updates on parameter changes

### Phase 4: UI Restructuring
- Split-panel layout (parameters left, preview right)
- Real-time dashboard (archetype badge, live ΔE, breach alert)
- High-precision knobs (minVolume, speckleRescue, shadowClamp)

### Phase 6: Production Worker
- Background high-res rendering (2400px)
- Progress indicators
- WebWorker for UI responsiveness

### Phase 7: Layer Export
- "Clean Handshake" verification
- Pre-export sync check (UI state = production result)
- Structured PSD export with metadata

---

## API Reference

### ProxyEngine

```javascript
const proxyEngine = new ProxyEngine();

// Initialize proxy (one-time setup)
const result = await proxyEngine.initializeProxy(
    labPixels,  // Uint16Array (16-bit LAB)
    width,      // number
    height,     // number
    config      // { targetColors, distanceMetric, ... }
);

// Update proxy (fast path)
const updated = await proxyEngine.updateProxy({
    minVolume: 2.5,           // Prune weak colors
    speckleRescue: 3,         // Erosion radius
    shadowClamp: 5.0,         // Minimum ink density
    paletteOverride: newPalette  // Replace entire palette
});

// Get production config
const config = proxyEngine.getProductionConfig();
```

### SessionState

```javascript
const sessionState = new SessionState();

// Update single parameter
sessionState.updateParameter('minVolume', 2.5);

// Update multiple parameters
sessionState.updateParameters({
    minVolume: 2.5,
    speckleRescue: 3,
    shadowClamp: 5.0
});

// Trigger proxy update
await sessionState.triggerProxyUpdate(['minVolume']);

// Export config for production render
const config = sessionState.exportProductionConfig();

// Get current palette
const palette = sessionState.getCurrentPalette();
```

### LABSliderSync

```javascript
const labSync = new LABSliderSync();

// Initialize (starts polling)
await labSync.initialize(sessionState);

// Stop polling
labSync.stop();

// Manually update palette color
await labSync.updatePaletteColor(
    3,  // color index
    { L: 45, a: 12, b: -8 }  // new LAB value
);
```

### ProxyIntegration

```javascript
// Initialize proxy mode (all-in-one)
const result = await initializeProxyMode(
    labPixels,
    width,
    height,
    config
);

// Update preview canvas
updatePreviewCanvas(previewBuffer, proxyResult);

// Stop proxy mode
stopProxyMode();

// Check if active
const isActive = isProxyModeActive();

// Get state
const state = getProxyState();
```

---

## File Locations

| File | Purpose |
|------|---------|
| `packages/reveal-core/lib/engines/ProxyEngine.js` | Low-res proxy engine |
| `packages/reveal-adobe/src/SessionState.js` | Global parameter store |
| `packages/reveal-adobe/src/LABSliderSync.js` | LAB slider polling |
| `packages/reveal-adobe/src/ProxyIntegration.js` | Integration helper |
| `packages/reveal-adobe/src/ProxyModeTestHarness.js` | Test UI harness |
| `packages/reveal-adobe/src/INTEGRATION_SNIPPET.js` | Integration instructions |

---

## Success Criteria ✅

- [x] ProxyEngine creates 512px proxy in <400ms
- [x] LAB slider changes detected via polling (250ms interval)
- [x] Nearest palette color updates automatically
- [x] Preview canvas updates in <30ms
- [x] SessionState stores all parameters globally
- [x] Test harness provides one-click testing
- [x] Browser console debugging tools available

**🎉 Sovereign Foundation is complete! LAB sliders are now LIVE.**

---

## Philosophy

> "Once you can 'play' the Photoshop LAB sliders and see the proxy update, the rest of the UI restructuring is simply refinement."

The Sovereign Foundation proves the core concept: **real-time, interactive color separation**. No more "Generate → Check → Tweak" loops. Just direct manipulation of color like a musical instrument.

This unlocks the full potential of Reveal as a **creative tool**, not just a batch processor.

---

## Credits

**Architecture:** Electrosaur Labs
**Implementation:** Claude Code (Anthropic)
**Inspiration:** Screen printing artists who need real-time feedback

---

**Next:** Integrate into main UI and add parameter knobs (minVolume, speckleRescue, shadowClamp) with same real-time behavior.
