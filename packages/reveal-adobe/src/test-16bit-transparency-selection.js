/**
 * Test: Create blue fill layer with circular mask
 *
 * Creates a visible layer to verify mask application works in both 8-bit and 16-bit Lab.
 * Expected result: Blue circle visible in document
 */

const { app, action } = require("photoshop");
const { imaging } = require("photoshop");

async function testTransparencySelection() {
    const doc = app.activeDocument;
    if (!doc) {
        console.log("ERROR: No active document");
        return;
    }

    console.log("\n=== BLUE CIRCLE MASK TEST ===");
    console.log(`Document: ${doc.name}`);
    console.log(`Color mode: ${doc.mode}`);
    console.log(`Bit depth: ${doc.bitsPerChannel}`);
    console.log(`Size: ${doc.width}x${doc.height}`);

    // Detect bit depth
    const bitDepthStr = String(doc.bitsPerChannel).toLowerCase();
    const is16bit = bitDepthStr.includes('16') || doc.bitsPerChannel === 16;
    const componentSize = is16bit ? 16 : 8;

    try {
        // STEP 1: Create temp layer with circular alpha mask
        console.log("\nStep 1: Creating temp layer with circular alpha...");
        await action.batchPlay([{
            "_obj": "make",
            "_target": [{ "_ref": "layer" }],
            "name": "__MASK_TEMP__"
        }], {});

        const tempLayer = doc.activeLayers[0];
        console.log(`✓ Temp layer created: ID ${tempLayer.id}`);

        // STEP 2: Create circular mask data (white circle on transparent)
        console.log(`\nStep 2: Creating circular mask data (${componentSize}-bit)...`);
        const width = Math.min(doc.width, 200);
        const height = Math.min(doc.height, 200);
        const centerX = width / 2;
        const centerY = height / 2;
        const radius = Math.min(width, height) / 3;

        const maxValue = is16bit ? 32768 : 255;
        const rgbaData = is16bit
            ? new Uint16Array(width * height * 4)
            : new Uint8Array(width * height * 4);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const dx = x - centerX;
                const dy = y - centerY;
                const distance = Math.sqrt(dx * dx + dy * dy);

                // White RGB
                rgbaData[idx] = maxValue;
                rgbaData[idx + 1] = maxValue;
                rgbaData[idx + 2] = maxValue;

                // Alpha: opaque inside circle, transparent outside
                rgbaData[idx + 3] = distance <= radius ? maxValue : 0;
            }
        }

        const imageData = await imaging.createImageDataFromBuffer(rgbaData, {
            width, height,
            components: 4,
            componentSize: componentSize,
            chunky: true,
            colorSpace: "RGB",
            colorProfile: "sRGB IEC61966-2.1"
        });

        await imaging.putPixels({
            layerID: tempLayer.id,
            imageData: imageData,
            replace: true
        });

        imageData.dispose();
        console.log(`✓ Circular mask data written (${width}x${height}, radius=${radius.toFixed(0)})`);

        // STEP 2b: Verify temp layer has transparency
        console.log("\nStep 2b: Verifying temp layer has transparency...");
        console.log(`  Layer ID: ${tempLayer.id}`);
        console.log(`  Layer name: ${tempLayer.name}`);
        console.log(`  Layer opacity: ${tempLayer.opacity}`);
        console.log(`  Layer bounds: ${JSON.stringify(tempLayer.bounds)}`);

        // Try to read back a few pixels to verify alpha was written
        try {
            const testReadback = await imaging.getPixels({
                sourceBounds: {
                    left: 0,
                    top: 0,
                    right: Math.min(10, width),
                    bottom: Math.min(10, height)
                },
                layerID: tempLayer.id,
                componentSize: componentSize,
                targetBuffer: is16bit ? new Uint16Array(10 * 10 * 4) : new Uint8Array(10 * 10 * 4)
            });

            // Check first pixel's alpha
            const firstAlpha = testReadback.imageData.getData()[3];
            const centerPixelIdx = (5 * 10 + 5) * 4 + 3; // Pixel at (5,5) alpha channel
            const centerAlpha = testReadback.imageData.getData()[centerPixelIdx];

            console.log(`  First pixel alpha (corner, should be 0): ${firstAlpha}`);
            console.log(`  Center pixel alpha (inside circle, should be ${maxValue}): ${centerAlpha}`);

            testReadback.imageData.dispose();
        } catch (e) {
            console.log(`  ⚠️ Could not read back pixels: ${e.message}`);
        }

        // STEP 3: Load transparency as selection
        console.log("\nStep 3: Loading transparency as selection...");
        const result = await action.batchPlay([{
            "_obj": "set",
            "_target": [{ "_ref": "channel", "_property": "selection" }],
            "to": {
                "_ref": "channel",
                "_enum": "channel",
                "_value": "transparencyEnum"
            }
        }], {});

        console.log(`Selection result: ${JSON.stringify(result)}`);

        // Check selection bounds
        let selectionExists = false;
        try {
            const bounds = doc.selection.bounds;
            console.log(`✓ Selection created with bounds: ${JSON.stringify(bounds)}`);
            console.log(`  Selection size: ${bounds.right - bounds.left} x ${bounds.bottom - bounds.top}`);
            selectionExists = true;
        } catch (e) {
            console.log(`✗ ERROR: No selection created!`);
            console.log(`  Error: ${e.message}`);
            console.log(`  This means transparency channel is empty or not accessible`);
            throw new Error("Failed to create selection from transparency");
        }

        // Verify selection is not inverted
        console.log("\nStep 3b: Checking if selection needs inversion...");
        console.log(`  (In Lab, transparent = outside circle, opaque = inside circle)`);
        console.log(`  Selection should be the opaque area (inside circle)`);

        // STEP 4: Create blue fill layer AND mask in a SINGLE batchPlay command
        console.log("\nStep 4: Creating blue fill layer with mask (combined command)...");

        // Double-check selection exists before creating layer+mask
        try {
            const bounds = doc.selection.bounds;
            console.log(`  Selection active before creating layer: ${JSON.stringify(bounds)}`);
        } catch (e) {
            console.log(`  ⚠️ WARNING: No selection before creating layer! ${e.message}`);
        }

        // Create fill layer with mask in one batch
        await action.batchPlay([
            // First: create the fill layer
            {
                "_obj": "make",
                "_target": [{ "_ref": "contentLayer" }],
                "using": {
                    "_obj": "contentLayer",
                    "type": {
                        "_obj": "solidColorLayer",
                        "color": {
                            "_obj": "labColor",
                            "luminance": 50,  // Mid-tone blue
                            "a": 20,
                            "b": -50
                        }
                    }
                },
                "layerID": 999999
            },
            // Second: immediately add mask from selection (in same batch)
            {
                "_obj": "make",
                "_target": [{ "_ref": "channel", "_enum": "channel", "_value": "mask" }],
                "new": { "_class": "channel" },
                "at": { "_ref": "layer", "_enum": "ordinal", "_value": "targetEnum" },
                "using": { "_enum": "userMaskEnabled", "_value": "revealSelection" }
            }
        ], {});

        const fillLayer = doc.activeLayers[0];
        fillLayer.name = "TEST: Blue Circle";
        console.log(`✓ Blue fill layer with mask created: ID ${fillLayer.id}`);

        // STEP 5: Verify mask exists
        console.log("\nStep 5: Verifying mask was created...");
        if (fillLayer.mask) {
            console.log(`  ✓ Mask exists on layer`);
            console.log(`  Mask bounds: ${fillLayer.mask.bounds}`);
        } else {
            console.log(`  ✗ WARNING: No mask found on layer!`);
        }

        // STEP 6: Now delete temp layer (after mask is created)
        console.log("\nStep 6: Deleting temp layer...");
        await tempLayer.delete();
        console.log(`✓ Temp layer deleted`);

        // STEP 7: Deselect
        console.log("\nStep 7: Clearing selection...");
        await action.batchPlay([{
            "_obj": "set",
            "_target": [{ "_ref": "channel", "_property": "selection" }],
            "to": { "_enum": "ordinal", "_value": "none" }
        }], {});

        console.log(`✓ Selection cleared`);
        console.log("\n=== TEST COMPLETE ===");
        console.log(`✓ Check document for blue circle - layer name: "TEST: Blue Circle"`);

    } catch (error) {
        console.log(`\n✗ TEST FAILED WITH ERROR:`);
        console.log(`  ${error.message}`);
        console.log(`  ${error.stack}`);

        // Try cleanup
        try {
            const tempLayers = doc.layers.filter(l => l.name === '__MASK_TEMP__' || l.name === 'TEST: Blue Circle');
            for (const layer of tempLayers) {
                await layer.delete();
            }
        } catch (cleanupErr) {
            console.log(`Could not clean up: ${cleanupErr.message}`);
        }
    }
}

// Export for use in plugin
module.exports = { testTransparencySelection };
