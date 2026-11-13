# REVEAL: 60-SECOND TEASER SCRIPT
**Title:** *"Stop Doing Manual Seps."*  
**Format:** 16:9 (YouTube / Reddit) + 9:16 Crop Safe (Reels / Shorts / TikTok)  
**Tone:** Confident, knowledgeable prepress engineer speaking directly to print shop owners. No corporate filler.  
**Audio Track:** Low, rhythmic, punchy industrial beat (modern analog synth / tight kick drum).  
**Cadence:** ~145 spoken words (~2.4 words/sec over 60 seconds).

---

## Shot-by-Shot Storyboard & Voiceover

| Time | Visual / On-Screen Action | Voiceover (Spoken Audio) | Text on Screen (Burn-In) |
| :--- | :--- | :--- | :--- |
| **0:00 – 0:08** *(8s)* | **[SCREEN CAPTURE - THE PAIN]**<br>Photoshop screen: user cycling through tedious manual steps — Indexed Color mode + custom palette edits, then Select → Color Range and Layer via Cut. Zooming into a screen mask showing isolated 1-pixel specks and razor-thin lines in the washout booth.<br>*(SFX: Rapid, tedious mouse clicking)* | "If you do spot color in Photoshop, you know the grind: hours in Indexed Color and Color Range, ending up with screens full of tiny open areas that wash out and never hold on press." | **THE PHOTOSHOP MANUAL GRIND**<br>Indexed Color • Color Range • Unholdable Open Areas |
| **0:08 – 0:17** *(9s)* | **[SCREEN CAPTURE - THE LAUNCH]**<br>Cut to a full-screen, high-res complex poster illustration with typography (*The 44 Agreements*).<br>Click **Plugins → Reveal Navigator**.<br>The sleek modal panel pops up instantly.<br>*(SFX: Clean digital 'whoosh')* | "What if you could do it in 300 milliseconds? Meet Reveal. Running pure 16-bit CIELAB color math." | **REVEAL 2.0**<br>Pure 16-bit CIELAB Engine |
| **0:17 – 0:26** *(9s)* | **[SCREEN CAPTURE - THE SCRUB]**<br>Mouse grabs the **Colors** slider and smoothly drags it from 10 down to 6.<br>The live proxy preview updates in real-time, instantly redistributing the spot color palette with zero lag. | "Set your screen budget—8 colors, 6 colors. Reveal doesn't guess; it mathematically places every spot ink where the human eye actually needs it." | **REAL-TIME PROXY SCRUBBING**<br>Instant 6-Color Palette Allocation |
| **0:26 – 0:38** *(12s)* | **[SCREEN CAPTURE - DUAL-SCALE & MESH]**<br>Activate the **Loupe** tool. Zoom 400% into the text letters (*"BY P. K."*).<br>Show the letter outlines: razor-sharp vector contours.<br>Pan the loupe down across the solid color shapes.<br>Show UI knob: **Mesh: 355 TPI \| Rule of N: 7.0**. | "No messy halftones to fake gradients. Reveal builds pure, opinionated spot color reductions, enforcing a strict physical dot floor for your exact mesh—so every screen washes out and prints cleanly on press." | **MESH-AWARE PRESS CONTRACT**<br>• Pure Spot Color (No Halftones)<br>• Guaranteed Printable Dot Floor |
| **0:38 – 0:48** *(10s)* | **[SCREEN CAPTURE - SURGERY & TRAP]**<br>In **Palette Surgery**, mouse grabs a weak swatch showing `0.4%` coverage and drags it onto a dark brown swatch to merge.<br>Toggle **"Show Traps"** checkbox: light ink highlights flash showing automated 2px under-dark dilation.<br>Mouse clicks big **[Separate]** button. | "Kill weak inks with drag-and-drop Palette Surgery. Automatic directional trapping. Hit Separate—" | **PALETTE SURGERY & TRAPPING**<br>• Drag-to-Merge Weak Inks<br>• Light-Under-Dark Trapping |
| **0:48 – 0:54** *(6s)* | **[SCREEN CAPTURE - THE LAYERS]**<br>Navigator closes. Photoshop's Layers panel instantly fills with clean, labeled **Solid Color Fill Layers with Layer Masks**, stacked Light-to-Dark in actual press print order.<br>*(SFX: Satisfying stamp/thud sound)* | "—and Photoshop instantly builds production-ready solid color fill layers and masks, stacked in exact print order." | **PRODUCTION-READY LAYERS**<br>Native Fill Layers + Layer Masks |
| **0:54 – 1:00** *(6s)* | **[B-ROLL & CALL TO ACTION]**<br>Quick 2-second cut to real press footage: a squeegee pulling a crisp spot color print on an automatic press or manual poster bench.<br>Cut to final card: Bold **REVEAL** logo with GitHub mark and download link.<br>*(Music swells and cuts cleanly)* | "No eight-hundred-dollar plugins. No subscriptions. 100% open source. Download Reveal free on GitHub." | **REVEAL**<br>Free & Open Source Screen Separation<br>**github.com/electrosaur-labs/reveal** |

---

## Production & Recording Checklist

1. **Resolution & Scaling:**
   * Record desktop at **1440p (2560×1440)** or **4K (3840×2160)**.
   * If cropping for 9:16 (TikTok / Reels / YouTube Shorts), keep mouse action centered in the middle 1080px width.
2. **Artwork Assets to Use:**
   * Primary: `/Users/shankar/tmp/agreement-10.psd` (*The 44 Agreements* poster). Shows typography, character illustration, and textured halftone bricks all in one frame.
   * Alternate: `fixtures/JethroAsMonroe-original-16bit.psd` (Great for demonstrating complex portrait skin gradients).
3. **Cursor & Interaction:**
   * Set display cursor size slightly larger than normal (macOS Settings → Accessibility → Display → Pointer size).
   * Enable a subtle click-highlight ring in ScreenFlow or OBS.
   * Make deliberate, smooth slider drags—no erratic mouse shaking.
4. **Audio Mixing:**
   * Voiceover should peak between $-3\text{ dB}$ and $-6\text{ dB}$.
   * Music track should sit at $-18\text{ dB}$ to $-22\text{ dB}$ under the voiceover.
   * Add subtle sound effects: mechanical click on slider drop, whoosh on Navigator modal opening, solid thud when Photoshop layers populate.
