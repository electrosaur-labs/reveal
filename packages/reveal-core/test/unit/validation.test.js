/**
 * Unit Tests for Document Validation
 *
 * These tests run in Node.js without Photoshop UXP dependencies.
 * They test the pure validation logic with mock document objects.
 */

import { describe, test, expect } from 'vitest';

// Import Reveal API
const Reveal = require('../../index.js');

// Simple mock document factory (no uxp-test-runner dependency needed)
function createMockDocument(props = {}) {
    return {
        mode: props.mode || 'LabColorMode',
        bitsPerChannel: props.bitsPerChannel || 'bitDepth8',
        width: props.width || 1000,
        height: props.height || 1000,
        layers: props.layers || { length: 1 }
    };
}

describe('Document Validation - Unit Tests', () => {
    describe('Lab Color Mode Validation', () => {
        test('should require Lab color mode (reject RGB)', () => {
            const mockDoc = createMockDocument({
                mode: 'RGBColorMode',
                bitsPerChannel: 'bitDepth8'
            });

            const validation = Reveal.validateDocument(mockDoc);

            expect(validation.valid).toBe(false);
            expect(validation.errors).toHaveLength(1);
            expect(validation.errors[0]).toMatch(/Lab color mode/i);
            expect(validation.errors[0]).toMatch(/RGBColorMode/);
        });

        test('should require Lab color mode (reject CMYK)', () => {
            const mockDoc = createMockDocument({
                mode: 'CMYKColorMode',
                bitsPerChannel: 'bitDepth8'
            });

            const validation = Reveal.validateDocument(mockDoc);

            expect(validation.valid).toBe(false);
            expect(validation.errors.length).toBeGreaterThan(0);
            expect(validation.errors[0]).toMatch(/Lab color mode/i);
        });

        test('should require Lab color mode (reject Grayscale)', () => {
            const mockDoc = createMockDocument({
                mode: 'GrayscaleMode'
            });

            const validation = Reveal.validateDocument(mockDoc);

            expect(validation.valid).toBe(false);
            expect(validation.errors.length).toBeGreaterThan(0);
            expect(validation.errors[0]).toMatch(/Lab color mode/i);
        });

        test('should accept Lab color mode', () => {
            const mockDoc = createMockDocument({
                mode: 'LabColorMode'
            });

            const validation = Reveal.validateDocument(mockDoc);

            expect(validation.valid).toBe(true);
            expect(validation.errors).toHaveLength(0);
        });
    });

    describe('Bit Depth Validation', () => {
        test('should accept 8-bit color depth (string format)', () => {
            const mockDoc = createMockDocument({
                mode: 'LabColorMode',
                bitsPerChannel: 'bitDepth8'
            });

            const validation = Reveal.validateDocument(mockDoc);

            expect(validation.valid).toBe(true);
            expect(validation.errors).toHaveLength(0);
        });

        test('should accept 8-bit color depth (numeric format)', () => {
            const mockDoc = createMockDocument({
                mode: 'LabColorMode',
                bitsPerChannel: 8
            });

            const validation = Reveal.validateDocument(mockDoc);

            expect(validation.valid).toBe(true);
            expect(validation.errors).toHaveLength(0);
        });

        test('should accept 16-bit color depth (string format)', () => {
            const mockDoc = createMockDocument({
                mode: 'LabColorMode',
                bitsPerChannel: 'bitDepth16'
            });

            const validation = Reveal.validateDocument(mockDoc);

            expect(validation.valid).toBe(true);
            expect(validation.errors).toHaveLength(0);
        });

        test('should accept 16-bit color depth (numeric format)', () => {
            const mockDoc = createMockDocument({
                mode: 'LabColorMode',
                bitsPerChannel: 16
            });

            const validation = Reveal.validateDocument(mockDoc);

            expect(validation.valid).toBe(true);
            expect(validation.errors).toHaveLength(0);
        });

        test('should reject 32-bit color depth (string format)', () => {
            const mockDoc = createMockDocument({
                mode: 'LabColorMode',
                bitsPerChannel: 'bitDepth32'
            });

            const validation = Reveal.validateDocument(mockDoc);

            expect(validation.valid).toBe(false);
            expect(validation.errors.length).toBeGreaterThan(0);
            expect(validation.errors[0]).toMatch(/8 or 16 bits\/channel/i);
            expect(validation.errors[0]).toMatch(/bitDepth32/);
        });

        test('should reject 32-bit color depth (numeric format)', () => {
            const mockDoc = createMockDocument({
                mode: 'LabColorMode',
                bitsPerChannel: 32
            });

            const validation = Reveal.validateDocument(mockDoc);

            expect(validation.valid).toBe(false);
            expect(validation.errors.length).toBeGreaterThan(0);
            expect(validation.errors[0]).toMatch(/8 or 16 bits\/channel/i);
        });
    });

    describe('Document Size Warnings', () => {
        test('should warn on large documents (width)', () => {
            const mockDoc = createMockDocument({
                mode: 'LabColorMode',
                width: 6000,
                height: 800
            });

            const validation = Reveal.validateDocument(mockDoc);

            expect(validation.valid).toBe(true);  // Doesn't block
            expect(validation.errors).toHaveLength(0);
            expect(validation.warnings).toHaveLength(1);
            expect(validation.warnings[0]).toMatch(/Large document/i);
            expect(validation.warnings[0]).toMatch(/6000x800/);
        });

        test('should warn on large documents (height)', () => {
            const mockDoc = createMockDocument({
                mode: 'LabColorMode',
                width: 800,
                height: 8000
            });

            const validation = Reveal.validateDocument(mockDoc);

            expect(validation.valid).toBe(true);  // Doesn't block
            expect(validation.warnings.length).toBeGreaterThan(0);
            expect(validation.warnings[0]).toMatch(/Large document/i);
        });

        test('should not warn on normal-sized documents', () => {
            const mockDoc = createMockDocument({
                mode: 'LabColorMode',
                width: 2000,
                height: 2000
            });

            const validation = Reveal.validateDocument(mockDoc);

            expect(validation.valid).toBe(true);
            expect(validation.warnings).toHaveLength(0);
        });
    });

    describe('Multiple Validation Errors', () => {
        test('should report multiple errors (wrong mode + wrong bit depth)', () => {
            const mockDoc = createMockDocument({
                mode: 'RGBColorMode',
                bitsPerChannel: 'bitDepth32'
            });

            const validation = Reveal.validateDocument(mockDoc);

            expect(validation.valid).toBe(false);
            expect(validation.errors).toHaveLength(2);
            const allErrors = validation.errors.join(' ');
            expect(allErrors).toMatch(/Lab color mode/i);
            expect(allErrors).toMatch(/8 or 16 bits\/channel/i);
        });

        test('should report errors + warnings (wrong mode + large size)', () => {
            const mockDoc = createMockDocument({
                mode: 'RGBColorMode',
                width: 6000,
                height: 6000
            });

            const validation = Reveal.validateDocument(mockDoc);

            expect(validation.valid).toBe(false);  // Errors make it invalid
            expect(validation.errors).toHaveLength(1);
            expect(validation.warnings).toHaveLength(1);
        });
    });

    describe('No Document Handling', () => {
        test('should handle null document', () => {
            const validation = Reveal.validateDocument(null);

            expect(validation.valid).toBe(false);
            expect(validation.errors).toHaveLength(1);
            expect(validation.errors[0]).toMatch(/No document is open/i);
        });

        test('should handle undefined document', () => {
            const validation = Reveal.validateDocument(undefined);

            expect(validation.valid).toBe(false);
            expect(validation.errors[0]).toMatch(/No document is open/i);
        });
    });

    describe('Edge Cases', () => {
        test('should accept Lab mode with lowercase "labColorMode"', () => {
            const mockDoc = createMockDocument({
                mode: 'labColorMode'  // lowercase 'l' (some PS versions return this)
            });

            const validation = Reveal.validateDocument(mockDoc);

            // Should accept both "LabColorMode" and "labColorMode"
            expect(validation.valid).toBe(true);
            expect(validation.errors).toHaveLength(0);
        });

        test('should handle boundary size (exactly 5000px)', () => {
            const mockDoc = createMockDocument({
                mode: 'LabColorMode',
                width: 5000,
                height: 5000
            });

            const validation = Reveal.validateDocument(mockDoc);

            // Should NOT warn at exactly 5000
            expect(validation.valid).toBe(true);
            expect(validation.warnings).toHaveLength(0);
        });

        test('should warn at boundary + 1 (5001px)', () => {
            const mockDoc = createMockDocument({
                mode: 'LabColorMode',
                width: 5001,
                height: 5001
            });

            const validation = Reveal.validateDocument(mockDoc);

            expect(validation.valid).toBe(true);
            expect(validation.warnings).toHaveLength(1);
        });
    });
});
