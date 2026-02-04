/**
 * DNAValidator.js
 * Validates DNA v1.0 and v2.0 objects against JSON schemas
 */

class DNAValidator {
    /**
     * Validate a DNA object (auto-detects version)
     * @param {Object} dna - DNA object to validate
     * @returns {Object} Validation result { valid, errors, warnings, version }
     */
    static validate(dna) {
        if (!dna || typeof dna !== 'object') {
            return {
                valid: false,
                errors: ['DNA must be an object'],
                warnings: [],
                version: null
            };
        }

        // Detect version
        const isDnaV2 = dna.version === '2.0' && dna.global && dna.sectors;
        const version = isDnaV2 ? '2.0' : '1.0';

        if (isDnaV2) {
            return this.validateV2(dna);
        } else {
            return this.validateV1(dna);
        }
    }

    /**
     * Validate DNA v1.0 (4D: L/C/K/σL)
     * @param {Object} dna - DNA v1.0 object
     * @returns {Object} Validation result
     */
    static validateV1(dna) {
        const errors = [];
        const warnings = [];

        // Required fields
        const required = ['l', 'c', 'k', 'l_std_dev'];
        for (const field of required) {
            if (dna[field] === undefined || dna[field] === null) {
                errors.push(`Missing required field: ${field}`);
            } else if (typeof dna[field] !== 'number') {
                errors.push(`Field ${field} must be a number`);
            }
        }

        if (errors.length > 0) {
            return { valid: false, errors, warnings, version: '1.0' };
        }

        // Range validation
        if (dna.l < 0 || dna.l > 100) {
            errors.push(`l must be 0-100 (got ${dna.l})`);
        }
        if (dna.c < 0 || dna.c > 150) {
            errors.push(`c must be 0-150 (got ${dna.c})`);
        }
        if (dna.k < 0 || dna.k > 100) {
            errors.push(`k must be 0-100 (got ${dna.k})`);
        }
        if (dna.l_std_dev < 0 || dna.l_std_dev > 50) {
            errors.push(`l_std_dev must be 0-50 (got ${dna.l_std_dev})`);
        }

        // Warnings for unusual values
        if (dna.c > 100) {
            warnings.push(`Unusually high chroma: ${dna.c} (typical range 0-80)`);
        }
        if (dna.l_std_dev > 35) {
            warnings.push(`Very high lightness variance: ${dna.l_std_dev}`);
        }

        return {
            valid: errors.length === 0,
            errors,
            warnings,
            version: '1.0'
        };
    }

    /**
     * Validate DNA v2.0 (7D + 12-sector)
     * @param {Object} dna - DNA v2.0 object
     * @returns {Object} Validation result
     */
    static validateV2(dna) {
        const errors = [];
        const warnings = [];

        // Check version
        if (dna.version !== '2.0') {
            errors.push(`Invalid version: ${dna.version} (expected '2.0')`);
        }

        // Validate global object
        if (!dna.global || typeof dna.global !== 'object') {
            errors.push('Missing or invalid global object');
            return { valid: false, errors, warnings, version: '2.0' };
        }

        // Required global fields
        const requiredGlobal = ['l', 'c', 'k', 'l_std_dev', 'hue_entropy', 'temperature_bias', 'primary_sector_weight'];
        for (const field of requiredGlobal) {
            if (dna.global[field] === undefined || dna.global[field] === null) {
                errors.push(`Missing required global field: ${field}`);
            } else if (typeof dna.global[field] !== 'number') {
                errors.push(`global.${field} must be a number`);
            }
        }

        if (errors.length > 0) {
            return { valid: false, errors, warnings, version: '2.0' };
        }

        // Range validation for global fields
        const g = dna.global;
        if (g.l < 0 || g.l > 100) errors.push(`global.l must be 0-100 (got ${g.l})`);
        if (g.c < 0 || g.c > 150) errors.push(`global.c must be 0-150 (got ${g.c})`);
        if (g.k < 0 || g.k > 100) errors.push(`global.k must be 0-100 (got ${g.k})`);
        if (g.l_std_dev < 0 || g.l_std_dev > 50) errors.push(`global.l_std_dev must be 0-50 (got ${g.l_std_dev})`);
        if (g.hue_entropy < 0 || g.hue_entropy > 1) errors.push(`global.hue_entropy must be 0-1 (got ${g.hue_entropy})`);
        if (g.temperature_bias < -1 || g.temperature_bias > 1) errors.push(`global.temperature_bias must be -1 to 1 (got ${g.temperature_bias})`);
        if (g.primary_sector_weight < 0 || g.primary_sector_weight > 1) errors.push(`global.primary_sector_weight must be 0-1 (got ${g.primary_sector_weight})`);

        // Validate sectors object
        if (!dna.sectors || typeof dna.sectors !== 'object') {
            errors.push('Missing or invalid sectors object');
        } else {
            const validSectors = ['red', 'orange', 'yellow', 'chartreuse', 'green', 'cyan', 'azure', 'blue', 'purple', 'magenta', 'pink', 'rose'];

            // Check for invalid sector names
            for (const sectorName of Object.keys(dna.sectors)) {
                if (!validSectors.includes(sectorName)) {
                    warnings.push(`Unknown sector name: ${sectorName}`);
                }
            }

            // Validate sector data
            for (const [sectorName, sector] of Object.entries(dna.sectors)) {
                if (!validSectors.includes(sectorName)) continue;

                if (typeof sector !== 'object') {
                    errors.push(`sectors.${sectorName} must be an object`);
                    continue;
                }

                // Required sector fields
                const requiredSector = ['weight', 'lMean', 'cMean', 'cMax'];
                for (const field of requiredSector) {
                    if (sector[field] === undefined || sector[field] === null) {
                        errors.push(`sectors.${sectorName}.${field} is required`);
                    } else if (typeof sector[field] !== 'number') {
                        errors.push(`sectors.${sectorName}.${field} must be a number`);
                    }
                }

                // Range validation
                if (sector.weight !== undefined && (sector.weight < 0 || sector.weight > 1)) {
                    errors.push(`sectors.${sectorName}.weight must be 0-1 (got ${sector.weight})`);
                }
                if (sector.lMean !== undefined && (sector.lMean < 0 || sector.lMean > 100)) {
                    errors.push(`sectors.${sectorName}.lMean must be 0-100 (got ${sector.lMean})`);
                }
                if (sector.cMean !== undefined && (sector.cMean < 0 || sector.cMean > 150)) {
                    errors.push(`sectors.${sectorName}.cMean must be 0-150 (got ${sector.cMean})`);
                }
                if (sector.cMax !== undefined && (sector.cMax < 0 || sector.cMax > 150)) {
                    errors.push(`sectors.${sectorName}.cMax must be 0-150 (got ${sector.cMax})`);
                }
            }

            // Check total sector weights
            const totalWeight = Object.values(dna.sectors)
                .filter(s => typeof s === 'object' && s.weight !== undefined)
                .reduce((sum, s) => sum + s.weight, 0);

            if (Math.abs(totalWeight - 1.0) > 0.1) {
                warnings.push(`Sector weights should sum to ~1.0 (got ${totalWeight.toFixed(3)})`);
            }
        }

        // Validate dominant_sector
        const validSectors = ['red', 'orange', 'yellow', 'chartreuse', 'green', 'cyan', 'azure', 'blue', 'purple', 'magenta', 'pink', 'rose', null];
        if (dna.dominant_sector !== undefined && !validSectors.includes(dna.dominant_sector)) {
            errors.push(`Invalid dominant_sector: ${dna.dominant_sector}`);
        }

        // Validate metadata (if present)
        if (dna.metadata) {
            if (dna.metadata.width !== undefined && (!Number.isInteger(dna.metadata.width) || dna.metadata.width < 1)) {
                errors.push(`metadata.width must be a positive integer`);
            }
            if (dna.metadata.height !== undefined && (!Number.isInteger(dna.metadata.height) || dna.metadata.height < 1)) {
                errors.push(`metadata.height must be a positive integer`);
            }
            if (dna.metadata.bitDepth !== undefined && ![8, 16].includes(dna.metadata.bitDepth)) {
                errors.push(`metadata.bitDepth must be 8 or 16`);
            }
        }

        // Warnings for unusual values
        if (g.c > 100) warnings.push(`Unusually high chroma: ${g.c}`);
        if (g.l_std_dev > 35) warnings.push(`Very high lightness variance: ${g.l_std_dev}`);
        if (g.hue_entropy > 0.95) warnings.push(`Extremely high hue entropy: ${g.hue_entropy}`);

        return {
            valid: errors.length === 0,
            errors,
            warnings,
            version: '2.0'
        };
    }

    /**
     * Quick check if DNA is valid (returns boolean only)
     * @param {Object} dna - DNA object
     * @returns {boolean} True if valid
     */
    static isValid(dna) {
        return this.validate(dna).valid;
    }
}

module.exports = DNAValidator;
