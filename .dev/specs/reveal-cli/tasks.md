# reveal-cli - Tasks

## Phase 1: Package Scaffolding

- [ ] **Task 1.1**: Create package structure and configuration
  - **ID**: `task-1.1`
  - **BlockedBy**: none
  - **File**: `packages/reveal-cli/package.json`, `packages/reveal-cli/bin/reveal.js`
  - **Change**: Create `packages/reveal-cli/` directory tree: `bin/reveal.js` (shebang entry point), `src/` dirs, `package.json` with dependencies (reveal-core, reveal-psd-reader, reveal-psd-writer, sharp, commander), `bin` field pointing to `bin/reveal.js`. Register in root `package.json` workspaces.
  - **Outcome**: `npm install` from monorepo root resolves all workspace links. `node packages/reveal-cli/bin/reveal.js --help` runs without error.
  - **Context**: REQ-13. Follow existing monorepo patterns from reveal-batch/package.json. Use `@electrosaur-labs/reveal-cli` as package name. Node >=16. bin entry: `"reveal": "bin/reveal.js"`.

## Phase 2: Core Modules (parallelizable)

- [ ] **Task 2.1**: Implement ingest.js — multi-format image reader
  - **ID**: `task-2.1`
  - **BlockedBy**: `task-1.1`
  - **File**: `packages/reveal-cli/src/ingest.js`
  - **Change**: Export `async ingest(filePath)` that returns `{ lab16bit, width, height, inputFormat }`. For PNG/TIFF/JPEG: use sharp to read → `toColourspace('lab')` → `.raw()` → normalize to engine 16-bit encoding (L: 0-32768, a/b: 0-32768 with 16384=neutral). For .psd: use reveal-psd-reader, then convert to engine 16-bit Lab using reveal-batch's `convertPsd16bitToEngineLab` / `convert8bitTo16bitLab` patterns. Detect format by extension. Validate file exists.
  - **Outcome**: Given a PNG/TIFF/JPEG/PSD, returns a normalized 16-bit Lab buffer identical in format to what posterize-psd.js feeds into the pipeline.
  - **Context**: REQ-1. Sharp's Lab output is float L:0-100, a/b:-128..127. Must convert to engine's integer encoding. See reveal-batch/src/batch-utils.js for conversion functions. Embedded ICC profiles are handled automatically by sharp.

- [ ] **Task 2.2**: Implement pipeline.js — core processing pipeline
  - **ID**: `task-2.2`
  - **BlockedBy**: `task-1.1`
  - **File**: `packages/reveal-cli/src/pipeline.js`
  - **Change**: Export `async processSingle(lab16bit, width, height, options)` returning `{ palette, paletteLab, paletteRgb, masks, colorIndices, dna, config, metrics }`. Options: `{ archetype, colors, minVolume, speckleRescue, shadowClamp, trap, onProgress }`. Pipeline steps: DNA → archetype selection → ParameterGenerator → BilateralFilter → MedianFilter → posterizeImage → mapPixelsToPaletteAsync → pruneWeakColors → MechanicalKnobs → TrapEngine. Also export `listArchetypes()` for --list-archetypes.
  - **Outcome**: Pure computation, no I/O. Reusable by single mode and compare mode. Tested with synthetic Lab buffers.
  - **Context**: REQ-2, REQ-3, REQ-5 AC-4, REQ-9. Port logic from reveal-batch/src/posterize-psd.js lines 93-307. Use Reveal.DNAGenerator, Reveal.ParameterGenerator, Reveal.posterizeImage, Reveal.engines.SeparationEngine, Reveal.MechanicalKnobs, Reveal.TrapEngine. Include PSEUDO_ARCHETYPES map (chameleon/distilled/salamander) from posterize-psd.js.

- [ ] **Task 2.3**: Implement recipe.js — recipe file reader/writer
  - **ID**: `task-2.3`
  - **BlockedBy**: `task-1.1`
  - **File**: `packages/reveal-cli/src/recipe.js`
  - **Change**: Export `loadRecipe(filePath)` that reads and validates JSON, and `saveRecipe(filePath, effectiveParams)` that writes the recipe. Validation: check known fields, reject unknown keys with warning, validate ranges (colors 2-10, minVolume 0-5, etc.). Return normalized object with all fields (undefined for unset).
  - **Outcome**: Loading a valid recipe returns a config object. Invalid JSON or missing file throws with clear message. Save produces a valid recipe that can be loaded back.
  - **Context**: REQ-11. Schema: `{ archetype, colors, trap, minVolume, speckleRescue, shadowClamp, outputs: string[], outputDir }`.

## Phase 3: Output Writers (parallelizable)

- [ ] **Task 3.1**: Implement output/flat.js — flat posterized image writer
  - **ID**: `task-3.1`
  - **BlockedBy**: `task-2.2`
  - **File**: `packages/reveal-cli/src/output/flat.js`
  - **Change**: Export `async writeFlat(colorIndices, paletteLab, width, height, outputPath, inputFormat)`. Reconstruct Lab pixel buffer from indices + palette (each pixel gets its palette color's Lab value). Convert to engine 16-bit Lab buffer → sharp raw input → `toColourspace('srgb')` → write as PNG or TIFF (match input format; JPEG inputs get PNG output).
  - **Outcome**: Given posterization results, writes a flat RGB image where each pixel shows its assigned palette color.
  - **Context**: REQ-4. The tricky part is feeding Lab data back to sharp correctly. Sharp expects float Lab (L:0-100, a/b:-128..127) or 8-bit Lab (L:0-255 maps to 0-100, a/b:0-255 maps to -128..127). Test with known palette colors and verify RGB output matches expected values.

- [ ] **Task 3.2**: Implement output/psd.js — layered PSD writer
  - **ID**: `task-3.2`
  - **BlockedBy**: `task-2.2`
  - **File**: `packages/reveal-cli/src/output/psd.js`
  - **Change**: Export `async writePsd(paletteLab, paletteRgb, masks, width, height, outputPath, options)`. Use PSDWriter from reveal-psd-writer. Create fill+mask layers sorted by L descending. Include thumbnail and composite. Layer naming: `[N] #HEXCOLOR L{L} a{a} b{b}`.
  - **Outcome**: Writes a valid Lab PSD that opens in Photoshop and GIMP with correct color layers.
  - **Context**: REQ-5. Port PSD writing logic from posterize-psd.js lines 393-454. Always write as 16-bit Lab. Include composite for QuickLook preview (use reveal-batch's generateThumbnail pattern).

- [ ] **Task 3.3**: Implement output/ora.js — OpenRaster writer
  - **ID**: `task-3.3`
  - **BlockedBy**: `task-2.2`
  - **File**: `packages/reveal-cli/src/output/ora.js`
  - **Change**: Export `async writeOra(paletteLab, paletteRgb, masks, colorIndices, width, height, outputPath)`. Build ZIP manually using Node.js zlib: (1) mimetype entry (stored, uncompressed, MUST be first), (2) mergedimage.png (flat composite as RGB PNG via sharp), (3) per-layer RGBA PNGs (palette color where mask=255, transparent where mask=0) via sharp, (4) stack.xml with layer names and ordering. Write ZIP using manual local file headers + central directory + end-of-central-directory.
  - **Outcome**: Writes a valid .ora file. GIMP File → Open shows all layers with correct names and colors. `unzip -l output.ora` shows mimetype as first entry with stored compression.
  - **Context**: REQ-6. ORA spec: https://www.freedesktop.org/wiki/Specifications/OpenRaster/. ZIP format: mimetype must be at offset 0, stored (no compression), no extra field. Use `zlib.deflateRawSync` for other entries. Layer PNGs are RGBA: for each mask pixel, if 255 write (R,G,B,255), if 0 write (0,0,0,0). Use sharp to encode each RGBA buffer as PNG.

- [ ] **Task 3.4**: Implement output/plates.js — individual mask PNGs
  - **ID**: `task-3.4`
  - **BlockedBy**: `task-2.2`
  - **File**: `packages/reveal-cli/src/output/plates.js`
  - **Change**: Export `async writePlates(masks, paletteRgb, width, height, outputDir, basename)`. Write one grayscale PNG per mask using sharp. Filename: `<basename>_plate_<NN>_<hexcolor>.png`. Create output directory if needed.
  - **Outcome**: Each plate PNG is a grayscale image where 255=ink and 0=no ink. File count matches palette size.
  - **Context**: REQ-7. Use sharp: `sharp(Buffer.from(mask), { raw: { width, height, channels: 1 } }).png().toFile(path)`.

- [ ] **Task 3.5**: Implement output/sidecar.js — JSON metadata writer
  - **ID**: `task-3.5`
  - **BlockedBy**: `task-2.2`
  - **File**: `packages/reveal-cli/src/output/sidecar.js`
  - **Change**: Export `writeSidecar(outputPath, data)`. Write JSON with: meta (filename, timestamp, dimensions), archetype (id, name, score, breakdown), dna (full DNA vector), palette (per-color: Lab, RGB, hex, name, coverage%), parameters (knobs, trap, colors), outputs (list of files written).
  - **Outcome**: Valid JSON file with all separation metadata. Structure matches reveal-batch's sidecar format for consistency.
  - **Context**: REQ-8. Port sidecar structure from posterize-psd.js lines 458-end.

## Phase 4: CLI Orchestration

- [ ] **Task 4.1**: Implement cli.js — argument parsing and dispatch
  - **ID**: `task-4.1`
  - **BlockedBy**: `task-2.1`, `task-2.2`, `task-2.3`, `task-3.1`, `task-3.2`, `task-3.3`, `task-3.4`, `task-3.5`
  - **File**: `packages/reveal-cli/src/cli.js`
  - **Change**: Use Commander to define all flags per design doc. Validation: mutual exclusion (--compare vs --archetype), range checks, file existence. Recipe merging: load recipe first, overlay CLI flags. Dispatch: single mode calls `ingest → pipeline → outputs`. Compare mode calls `ingest → DNA once → pipeline×4 → outputs×4 in subdirs`. Progress to stderr. Summary table on completion. Wire up --list-archetypes, --save-recipe, --quiet, --verbose.
  - **Outcome**: `reveal input.png` works end-to-end. All flags produce expected behavior. Exit codes correct.
  - **Context**: REQ-2, REQ-10, REQ-11, REQ-12. The cli.js is the thin orchestration layer — all logic is in pipeline.js and output/*.js. For --compare, create `<basename>_reveal/` parent dir with subdirs per archetype. Print comparison table: `Archetype | Score | Colors | Output Dir`.

## Phase 5: Testing

- [ ] **Task 5.1**: Unit tests — ingest, recipe, ORA
  - **ID**: `task-5.1`
  - **BlockedBy**: `task-2.1`, `task-2.3`, `task-3.3`
  - **File**: `packages/reveal-cli/test/unit/ingest.test.js`, `test/unit/recipe.test.js`, `test/unit/ora.test.js`
  - **Change**: ingest.test.js: test PNG/TIFF/JPEG → Lab conversion (use small test images created by sharp in beforeAll), PSD passthrough, missing file error, bad format error. recipe.test.js: load valid recipe, merge with CLI overrides, save and reload, invalid JSON error, missing file error. ora.test.js: create ORA from known masks/palette, unzip and verify: mimetype first + stored, stack.xml valid XML, layer PNGs correct dimensions and RGBA values.
  - **Outcome**: All unit tests pass. Coverage of error paths and happy paths.
  - **Context**: Use vitest (consistent with rest of monorepo). Create test images programmatically via sharp — no fixture files needed. For ORA verification, use Node.js zlib to decompress and inspect.

- [ ] **Task 5.2**: Integration tests — end-to-end CLI
  - **ID**: `task-5.2`
  - **BlockedBy**: `task-4.1`
  - **File**: `packages/reveal-cli/test/integration/cli.test.js`
  - **Change**: Create a small test PNG (50x50 gradient) in beforeAll. Test: (1) default run → flat PNG + JSON exist, (2) --psd --ora --plates → all formats exist, (3) --compare → 4 subdirs with outputs, (4) --archetype chameleon → runs with specified archetype, (5) --recipe → loads recipe, (6) --list-archetypes → stdout contains archetype names, exit 0, (7) nonexistent file → exit 1, (8) --compare --archetype → exit 1, (9) --save-recipe → recipe JSON written. Verify output files exist and JSON sidecar is valid.
  - **Outcome**: Full CLI exercised end-to-end. All exit codes correct. All output formats produced.
  - **Context**: REQ-1 through REQ-13. Use `child_process.execFileSync('node', ['bin/reveal.js', ...])` to test CLI as subprocess. Use tmp directory for outputs. Clean up after each test.

## Phase 6: Polish

- [ ] **Task 6.1**: Add to monorepo build scripts and README
  - **ID**: `task-6.1`
  - **BlockedBy**: `task-5.2`
  - **File**: `package.json` (root), `packages/reveal-cli/README.md`
  - **Change**: Add `build:cli` and `test:cli` scripts to root package.json. Write a concise README with: installation, usage examples (basic, --psd, --compare, --recipe), flag reference table, output format descriptions.
  - **Outcome**: `npm run test:cli` from monorepo root runs all reveal-cli tests. README provides clear getting-started instructions.
  - **Context**: REQ-13. Follow existing monorepo patterns (see root package.json scripts for reveal-core, reveal-navigator, etc.).

## Dependencies

```
task-1.1 ──┬──▶ task-2.1 ──────────────────┐
           │                                │
           ├──▶ task-2.2 ──┬──▶ task-3.1 ──┤
           │               ├──▶ task-3.2 ──┤
           │               ├──▶ task-3.3 ──┤
           │               ├──▶ task-3.4 ──┤
           │               └──▶ task-3.5 ──┤
           │                                │
           └──▶ task-2.3 ──────────────────┤
                                            │
                                            ▼
                                        task-4.1 ──▶ task-5.2 ──▶ task-6.1
                                            ▲
           task-5.1 (can run after 2.1+2.3+3.3)
```

**Parallel opportunities:**
- Phase 2: tasks 2.1, 2.2, 2.3 can all run in parallel after 1.1
- Phase 3: tasks 3.1–3.5 can all run in parallel after 2.2
- Phase 5: task 5.1 can run in parallel with task 4.1

## Completion Criteria

- [ ] `node bin/reveal.js photo.png` produces a flat posterized PNG and JSON sidecar
- [ ] `node bin/reveal.js photo.png --psd --ora --plates` produces all 4 output formats
- [ ] `node bin/reveal.js photo.png --compare` produces 4 subdirectories (chameleon, distilled, salamander, top-match)
- [ ] `node bin/reveal.js photo.png --recipe recipe.json` applies recipe settings
- [ ] `node bin/reveal.js photo.png --save-recipe out.json` writes reusable recipe
- [ ] ORA output opens correctly in GIMP with named colorized layers
- [ ] PSD output opens correctly in Photoshop/GIMP with fill+mask layers
- [ ] All unit and integration tests pass
- [ ] `npm run test:cli` works from monorepo root
