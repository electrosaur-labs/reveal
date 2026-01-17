/**
 * DocumentValidator - Pure validation logic
 *
 * Pure functions for validating document properties.
 * No UXP dependencies - can be unit tested in Node.js.
 */

class DocumentValidator {
    /**
     * Validate document properties
     *
     * Pure function that validates a document object without any API calls.
     *
     * @param {Object} doc - Document object with properties
     * @param {string} doc.mode - Color mode (e.g., 'LabColorMode', 'RGBColorMode')
     * @param {string|number} doc.bitsPerChannel - Bit depth (e.g., 'bitDepth8', 8)
     * @param {number} doc.width - Width in pixels
     * @param {number} doc.height - Height in pixels
     * @param {Object} doc.layers - Layer collection with length property
     * @returns {Object} - {valid: boolean, errors: Array<string>, warnings: Array<string>}
     */
    static validate(doc) {
        const errors = [];
        const warnings = [];

        if (!doc) {
            errors.push("No document is open. Please open an image in Photoshop.");
            return { valid: false, errors, warnings };
        }

        // Check color mode - REQUIRE Lab mode for accurate perceptual color separation
        // Note: Photoshop may return "LabColorMode" or "labColorMode" depending on version
        const mode = String(doc.mode);
        const isLabMode = mode === "LabColorMode" || mode === "labColorMode";

        if (!isLabMode) {
            errors.push(
                `Document must be in Lab color mode (currently: ${doc.mode}). ` +
                `Convert via Image > Mode > Lab Color.`
            );
        }

        // Check bit depth - Photoshop returns string like "bitDepth8", "bitDepth16", "bitDepth32"
        const bitDepthStr = String(doc.bitsPerChannel).toLowerCase();
        const is8Bit = bitDepthStr.includes('8') || doc.bitsPerChannel === 8;

        if (!is8Bit) {
            errors.push(
                `Document must be 8 bits/channel (currently: ${doc.bitsPerChannel}). ` +
                `Convert via Image > Mode > 8 Bits/Channel.`
            );
        }

        // Check layer count - REQUIRE single layer for clean separation
        // Multiple layers complicate separation and can cause unexpected results
        if (doc.layers && doc.layers.length > 1) {
            errors.push(
                `Document must have only a single layer (currently: ${doc.layers.length} layers). ` +
                `Flatten the image via Layer > Flatten Image before running Reveal.`
            );
        }

        // Check dimensions (warn if too large, but don't fail validation)
        if (doc.width > 5000 || doc.height > 5000) {
            warnings.push(
                `Large document (${doc.width}x${doc.height}). Processing may take longer.`
            );
        }

        return {
            valid: errors.length === 0,
            errors,
            warnings
        };
    }
}

// Export for use in plugin and tests
if (typeof module !== 'undefined' && module.exports) {
    module.exports = DocumentValidator;
}
