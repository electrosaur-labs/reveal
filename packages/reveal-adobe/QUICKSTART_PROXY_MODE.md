# Quick Start: Test Proxy Mode in 5 Minutes

**Goal:** See LAB sliders update the preview in real-time.

---

## Step 1: Add Integration Snippet (30 seconds)

Open `/workspaces/electrosaur/reveal-project/packages/reveal-adobe/src/index.js`

Add this at the **very end** of the file (after line 4870):

```javascript
// Enable Proxy Mode Test Harness (Sovereign Foundation)
const { ProxyModeTestHarness } = require('./ProxyModeTestHarness');
ProxyModeTestHarness.attach();
```

**Save the file.**

---

## Step 2: Build the Plugin (1 minute)

```bash
cd /workspaces/electrosaur/reveal-project
npm run build:adobe
```

Wait for build to complete (~30 seconds).

---

## Step 3: Load Plugin in Photoshop (1 minute)

1. Open **UXP Developer Tool** (from Creative Cloud)
2. Click **"Add Plugin"**
3. Navigate to: `/workspaces/electrosaur/reveal-project/packages/reveal-adobe/dist/manifest.json`
4. Click **"Load"**

Plugin should appear in Photoshop under **Plugins → Reveal**.

---

## Step 4: Test with Sample Image (2 minutes)

### Prepare Test Image

1. Open sample image: `/workspaces/electrosaur/CQ100/Almonds.psd`
   - *If CQ100 doesn't exist, use any image*

2. **Convert to Lab mode**:
   - Image → Mode → **Lab Color**
   - (If already Lab, skip this step)

3. **Ensure 16-bit**:
   - Image → Mode → **16 Bits/Channel**

### Run Proxy Test

1. **Open Reveal plugin**: Plugins → Reveal

2. **Look for new button**: "🎨 Test Proxy Mode"
   - Should appear next to "Posterize →" button
   - If not visible, check console for errors

3. **Click "🎨 Test Proxy Mode"**
   - Status: "Reading document..."
   - Status: "Initializing proxy engine..."
   - Status: "✓ Proxy mode active - Adjust LAB sliders in Photoshop Color Panel"
   - Performance indicator appears (shows update time in ms)

4. **Open Photoshop Color Panel**:
   - Window → **Color**
   - Ensure dropdown at top says **"Lab Sliders"**
   - If not, click dropdown and select "Lab Sliders"

5. **🎉 TEST THE MAGIC:**
   - Drag the **L** (Lightness) slider
   - Watch the preview update in real-time!
   - Drag **a** (green-red) slider
   - Watch colors shift!
   - Drag **b** (blue-yellow) slider
   - See instant feedback!

---

## Expected Results ✅

- Preview updates **instantly** (<30ms)
- Performance indicator shows green (good) or yellow (acceptable)
- No lag or freezing
- Smooth, responsive feel
- Like "playing" a color instrument!

---

## Troubleshooting

### "Button not visible"

**Check:** Integration snippet added correctly to index.js?

**Fix:**
1. Verify snippet is at end of index.js
2. Rebuild: `npm run build:adobe`
3. Reload plugin in UXP Developer Tool

### "Color Panel not updating preview"

**Check:** Is Color Panel in LAB mode?

**Fix:**
1. Window → Color
2. Click dropdown at top of panel
3. Select **"Lab Sliders"**
4. Try dragging sliders again

### "Performance indicator shows red (>60ms)"

**Cause:** Complex image or slow hardware

**Notes:**
- 512px proxy should be <30ms on modern machines
- Check console for errors
- Try simpler test image

### "Preview canvas is blank"

**Check:** Console errors?

**Fix:**
1. Open browser console (F12)
2. Look for errors starting with `[ProxyEngine]` or `[LABSliderSync]`
3. Verify document is in Lab mode
4. Try clicking "Test Proxy Mode" again

---

## Debug Commands (Browser Console)

```javascript
// View current state
window.getProxyState()

// Detailed debug info
window.debugProxyState()

// Stop proxy mode
window.stopProxyMode()

// Check if active
window.isProxyModeActive()
```

---

## What You Should See

When working correctly:

1. **Drag L slider UP** → Image gets brighter
2. **Drag L slider DOWN** → Image gets darker
3. **Drag a slider RIGHT** → Colors shift toward red
4. **Drag a slider LEFT** → Colors shift toward green
5. **Drag b slider UP** → Colors shift toward yellow
6. **Drag b slider DOWN** → Colors shift toward blue

**All updates happen instantly with <30ms latency.**

---

## Success! 🎉

If you see real-time updates, the **Sovereign Foundation is working!**

The core interactive loop is proven:
```
LAB slider → palette update → proxy render → preview refresh
```

Everything else (dashboard UI, parameter knobs, layer export) builds on this foundation.

---

## Next Steps

1. **Test with different images** (photos, graphics, halftones)
2. **Try extreme slider values** (test performance limits)
3. **Check different color counts** (3-9 colors)
4. **Integrate into main posterization flow**
5. **Add parameter knobs** (minVolume, speckleRescue, shadowClamp)

---

## Report Issues

If something doesn't work:

1. **Check console** for errors
2. **Run debug commands** (see above)
3. **Verify build completed** successfully
4. **Check UXP Developer Tool** for plugin errors

---

## The North Star ⭐

> **"Once you can 'play' the Photoshop LAB sliders and see the proxy update, the rest of the UI restructuring is simply refinement."**

**You've reached the North Star!** The event-driven foundation is complete.

**Time to test:** ~5 minutes
**Time to master:** unlimited 🎨
