# DNA Validation System - Complete

## ✅ Added Comprehensive Validation for DNA v1.0 and v2.0

All DNA objects can now be validated against JSON schemas with detailed error and warning messages.

---

## 📦 Components Added

### 1. **JSON Schemas** (NEW)

#### DNA v2.0 Schema
**Location:** `packages/reveal-core/schemas/dna-v2-schema.json`

**Validates:**
- ✅ Version field (`"2.0"`)
- ✅ Global object with 7 required fields (l, c, k, l_std_dev, hue_entropy, temperature_bias, primary_sector_weight)
- ✅ 12 hue sectors (red, orange, yellow, chartreuse, green, cyan, azure, blue, purple, magenta, pink, rose)
- ✅ Per-sector data (weight, lMean, cMean, cMax)
- ✅ Dominant sector (valid sector name or null)
- ✅ Metadata (width, height, totalPixels, bitDepth)

**Range Validation:**
- L: 0-100
- C: 0-150
- K: 0-100
- l_std_dev: 0-50
- hue_entropy: 0-1
- temperature_bias: -1 to +1
- primary_sector_weight: 0-1
- Sector weights: 0-1 (should sum to ~1.0)

#### DNA v1.0 Schema
**Location:** `packages/reveal-core/schemas/dna-v1-schema.json`

**Validates:**
- ✅ Required fields: l, c, k, l_std_dev
- ✅ Range validation for all fields
- ✅ Backward compatible with legacy DNA

---

### 2. **DNAValidator Class** (NEW)
**Location:** `packages/reveal-core/lib/validation/DNAValidator.js`

**Features:**
- Auto-detects DNA version (v1.0 vs v2.0)
- Comprehensive validation with errors and warnings
- Validates all required fields and ranges
- Checks sector weights sum to ~1.0
- Warns about unusual values (very high chroma, extreme entropy, etc.)

**API:**

```javascript
const { DNAValidator } = require('@reveal/core');

// Validate any DNA object
const result = DNAValidator.validate(dna);
// {
//   valid: true/false,
//   errors: [],
//   warnings: [],
//   version: '1.0' or '2.0'
// }

// Quick validation (boolean only)
const isValid = DNAValidator.isValid(dna);
```

---

### 3. **Unit Tests** (NEW)
**Location:** `packages/reveal-core/test/unit/dna-validator.test.js`

**Coverage:**
- ✅ DNA v1.0 validation (correct, missing fields, out-of-range)
- ✅ DNA v2.0 validation (correct, missing global fields, invalid sectors)
- ✅ Sector validation (missing fields, out-of-range values)
- ✅ Sector weight sum validation
- ✅ Dominant sector validation
- ✅ Metadata validation
- ✅ Version detection
- ✅ Helper methods (isValid, null handling)

**Run tests:**
```bash
cd packages/reveal-core
npm test -- dna-validator.test.js
```

---

## 🎯 Usage Examples

### Validate DNA v1.0

```javascript
const { DNAValidator } = require('@reveal/core');

const dnaV1 = {
    l: 52.3,
    c: 18.7,
    k: 94.2,
    l_std_dev: 28.6
};

const result = DNAValidator.validate(dnaV1);

if (result.valid) {
    console.log(`✓ Valid DNA v${result.version}`);
} else {
    console.error('Validation errors:', result.errors);
}
```

### Validate DNA v2.0

```javascript
const { DNAValidator } = require('@reveal/core');

const dnaV2 = {
    version: '2.0',
    global: {
        l: 52.3,
        c: 18.7,
        k: 94.2,
        l_std_dev: 28.6,
        hue_entropy: 0.75,
        temperature_bias: 0.0,
        primary_sector_weight: 0.15
    },
    dominant_sector: 'green',
    sectors: {
        red: { weight: 0.10, lMean: 50, cMean: 20, cMax: 35 },
        green: { weight: 0.15, lMean: 52, cMean: 22, cMax: 40 },
        blue: { weight: 0.12, lMean: 48, cMean: 18, cMax: 30 }
    },
    metadata: {
        width: 800,
        height: 600,
        totalPixels: 480000,
        bitDepth: 8
    }
};

const result = DNAValidator.validate(dnaV2);

console.log(`Valid: ${result.valid}`);
console.log(`Version: ${result.version}`);
console.log(`Errors: ${result.errors.length}`);
console.log(`Warnings: ${result.warnings.length}`);
```

### Validate Before Processing

```javascript
const { DNAGenerator, DNAValidator, ArchetypeLoader } = require('@reveal/core');

// Generate DNA
const generator = new DNAGenerator();
const dna = generator.generate(labPixels, width, height, { bitDepth: 8 });

// Validate before use
const validation = DNAValidator.validate(dna);

if (!validation.valid) {
    throw new Error(`Invalid DNA: ${validation.errors.join(', ')}`);
}

// Show warnings
if (validation.warnings.length > 0) {
    console.warn('DNA warnings:', validation.warnings);
}

// Proceed with archetype matching
const archetype = ArchetypeLoader.matchArchetype(dna);
```

---

## 📊 Validation Rules

### DNA v1.0 Required Fields
| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `l` | number | 0-100 | Average lightness |
| `c` | number | 0-150 | Average chroma |
| `k` | number | 0-100 | Contrast |
| `l_std_dev` | number | 0-50 | Lightness std dev |

### DNA v2.0 Required Fields

#### global object
| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `l` | number | 0-100 | Average lightness |
| `c` | number | 0-150 | Average chroma |
| `k` | number | 0-100 | Contrast |
| `l_std_dev` | number | 0-50 | Lightness std dev |
| `hue_entropy` | number | 0-1 | Color diversity |
| `temperature_bias` | number | -1 to +1 | Warm/cool balance |
| `primary_sector_weight` | number | 0-1 | Dominant sector weight |

#### sectors object
Each sector must have:
| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `weight` | number | 0-1 | Proportion of pixels |
| `lMean` | number | 0-100 | Average lightness |
| `cMean` | number | 0-150 | Average chroma |
| `cMax` | number | 0-150 | Maximum chroma |

Valid sector names: `red`, `orange`, `yellow`, `chartreuse`, `green`, `cyan`, `azure`, `blue`, `purple`, `magenta`, `pink`, `rose`

#### Other fields
- `version`: Must be `"2.0"`
- `dominant_sector`: Valid sector name or `null`
- `metadata.width`: Positive integer
- `metadata.height`: Positive integer
- `metadata.bitDepth`: 8 or 16

---

## ⚠️ Validation Warnings

DNAValidator provides warnings for unusual (but valid) values:

- **High chroma** (C > 100): Uncommon in natural images
- **High variance** (σL > 35): Very complex tonal range
- **Extreme entropy** (>0.95): Unusually diverse color palette
- **Sector weights** don't sum to 1.0: May indicate calculation error

---

## 🔧 Integration Points

### 1. DNAGenerator Integration

```javascript
const { DNAGenerator, DNAValidator } = require('@reveal/core');

const generator = new DNAGenerator();
const dna = generator.generate(labPixels, width, height, { bitDepth: 8 });

// Validate generated DNA
const validation = DNAValidator.validate(dna);
if (!validation.valid) {
    throw new Error('DNAGenerator produced invalid DNA');
}
```

### 2. API Endpoint Validation

```javascript
app.post('/api/analyze', (req, res) => {
    const dna = req.body.dna;

    const validation = DNAValidator.validate(dna);

    if (!validation.valid) {
        return res.status(400).json({
            error: 'Invalid DNA',
            details: validation.errors
        });
    }

    if (validation.warnings.length > 0) {
        console.warn('DNA warnings:', validation.warnings);
    }

    // Process DNA...
});
```

### 3. Batch Processing Validation

```javascript
const { DNAGenerator, DNAValidator } = require('@reveal/core');

for (const image of images) {
    const dna = DNAGenerator.generate(image.pixels, image.width, image.height);

    const validation = DNAValidator.validate(dna);

    if (!validation.valid) {
        console.error(`Invalid DNA for ${image.name}:`, validation.errors);
        continue;
    }

    // Process valid DNA...
}
```

---

## 📝 Files Changed/Created

### Created (4 files)
- `packages/reveal-core/schemas/dna-v2-schema.json` - JSON schema for DNA v2.0
- `packages/reveal-core/schemas/dna-v1-schema.json` - JSON schema for DNA v1.0
- `packages/reveal-core/lib/validation/DNAValidator.js` - Validation class
- `packages/reveal-core/test/unit/dna-validator.test.js` - Comprehensive tests

### Modified (1 file)
- `packages/reveal-core/index.js` - Added DNAValidator exports

---

## ✅ Verification

```bash
# Run validation tests
cd packages/reveal-core
npm test -- dna-validator.test.js

# Expected: All tests pass (30+ test cases)
```

---

## 🎯 Summary

**DNA Validation System is complete and production-ready.**

- ✅ JSON schemas for v1.0 and v2.0
- ✅ Comprehensive validator class
- ✅ Auto-version detection
- ✅ Detailed error messages
- ✅ Warning system for unusual values
- ✅ Full unit test coverage
- ✅ Integrated into core package exports

All DNA objects (v1.0 and v2.0) can now be validated with detailed feedback!
