# reveal-cli - Requirements

## Introduction

A command-line tool that accepts standard image formats (PNG, TIFF, JPEG), runs Reveal's perceptual color quantization pipeline, and outputs posterized results in multiple formats. Designed to make Reveal accessible without Photoshop — for FOSS users, batch workflows, and anyone who wants production-grade color separation from the terminal.

## Requirements

### REQ-1: Image Input

**User Story:** As a user, I want to provide any standard image file and have it processed without manual conversion, so that I don't need Photoshop or special tooling to prepare my input.

#### Acceptance Criteria

1. WHEN the user provides a PNG file THE SYSTEM SHALL read it and convert it to 16-bit Lab internally for processing.
2. WHEN the user provides a TIFF file THE SYSTEM SHALL read it and convert it to 16-bit Lab internally for processing.
3. WHEN the user provides a JPEG file THE SYSTEM SHALL read it and convert it to 16-bit Lab internally for processing.
4. WHEN the user provides a Lab PSD file THE SYSTEM SHALL read it directly using reveal-psd-reader without color space conversion.
5. IF the input file does not exist THEN THE SYSTEM SHALL exit with a non-zero code and a clear error message.
6. IF the input file is not a supported format THEN THE SYSTEM SHALL exit with a non-zero code listing supported formats.
7. WHEN the user provides an image with an embedded ICC profile THE SYSTEM SHALL use it for accurate RGB-to-Lab conversion (via sharp/libvips automatic profile handling).
8. IF the input image has no embedded ICC profile THE SYSTEM SHALL assume sRGB.
9. THE SYSTEM SHALL NOT support custom ICC profile files in v1 (deferred to v2).

### REQ-2: Archetype Selection

**User Story:** As a user, I want the tool to automatically select the best archetype for my image, so that I get optimal separation without needing to understand the archetype system.

#### Acceptance Criteria

1. WHEN no --archetype flag is provided THE SYSTEM SHALL run DNA analysis on the input image and select the top-scoring archetype automatically.
2. WHEN the user provides --archetype <name> THE SYSTEM SHALL use the specified archetype, bypassing auto-detection.
3. IF the user specifies an archetype that does not exist THEN THE SYSTEM SHALL exit with a non-zero code and list available archetypes.
4. WHEN the user provides --list-archetypes THE SYSTEM SHALL print all available archetype names grouped by category (graphic, faithful, dramatic) and exit.
5. WHEN auto-detection selects an archetype THE SYSTEM SHALL print the selected archetype name and match score to stderr.

### REQ-3: Color Count

**User Story:** As a user, I want the color count to be sensible by default but overridable, so that I get good results without configuration but can control the palette when needed.

#### Acceptance Criteria

1. WHEN no --colors flag is provided THE SYSTEM SHALL use the target color count defined by the selected archetype.
2. WHEN the user provides --colors N THE SYSTEM SHALL override the archetype's default and target N colors.
3. IF --colors is less than 2 or greater than 10 THEN THE SYSTEM SHALL exit with a non-zero code and state the valid range.

### REQ-4: Flat Image Output

**User Story:** As a user, I want a single posterized image file as the default output, so that I can see the result immediately without dealing with layers or separation plates.

#### Acceptance Criteria

1. WHEN no output flags are provided THE SYSTEM SHALL produce a single flat posterized image.
2. WHEN the input is a PNG THE SYSTEM SHALL output a PNG by default.
3. WHEN the input is a TIFF THE SYSTEM SHALL output a TIFF by default.
4. WHEN the input is a JPEG THE SYSTEM SHALL output a PNG (lossless) by default.
5. WHEN the user provides --output <path> THE SYSTEM SHALL write the flat image to the specified path.
6. WHEN no --output is provided THE SYSTEM SHALL write to <input-basename>_reveal.<ext> in the input file's directory.
7. THE SYSTEM SHALL reconstruct the flat image by mapping each pixel to its assigned palette color and converting from Lab back to RGB.

### REQ-5: PSD Output

**User Story:** As a screen printer, I want layered PSD output with fill+mask separation plates, so that I can use the separations directly in my print workflow.

#### Acceptance Criteria

1. WHEN the user provides --psd THE SYSTEM SHALL produce a layered Lab PSD file using reveal-psd-writer.
2. WHEN --psd is provided without a path argument THE SYSTEM SHALL write to <input-basename>_reveal.psd in the input file's directory.
3. THE SYSTEM SHALL create one fill+mask layer per palette color, ordered by Lab lightness (lightest on top).
4. WHEN --trap <pixels> is provided THE SYSTEM SHALL apply TrapEngine trapping to all layered outputs (PSD, ORA, plates) before writing. The flat image output is NOT affected by trapping.

### REQ-6: ORA (OpenRaster) Output

**User Story:** As a GIMP/Krita user, I want layered output in an open format, so that I can work with separation plates without Photoshop.

#### Acceptance Criteria

1. WHEN the user provides --ora THE SYSTEM SHALL produce an OpenRaster (.ora) file containing separation plates as individual layers.
2. WHEN --ora is provided without a path argument THE SYSTEM SHALL write to <input-basename>_reveal.ora in the input file's directory.
3. THE SYSTEM SHALL write the ORA file as a ZIP archive containing: mimetype file (uncompressed, first entry), mergedimage.png (flat composite), individual layer PNGs, and stack.xml describing the layer order.
4. THE SYSTEM SHALL include layer names matching the palette color names.
5. THE SYSTEM SHALL write each layer as a colorized RGBA PNG: pixels filled with the palette color's RGB value where ink is present, transparent elsewhere.

### REQ-7: Plate Output

**User Story:** As a user integrating with other tools, I want individual per-color mask images, so that I can use them in any workflow.

#### Acceptance Criteria

1. WHEN the user provides --plates THE SYSTEM SHALL produce one PNG file per palette color containing the binary separation mask.
2. WHEN --plates is provided THE SYSTEM SHALL write plate files as <input-basename>_plate_<N>_<colorname>.png in the input file's directory or the directory specified by --output.
3. THE SYSTEM SHALL write plates as grayscale PNGs where 255 = ink and 0 = no ink.
4. WHEN --trap is active THE SYSTEM SHALL write trapped masks (see REQ-5 AC-4).

### REQ-8: JSON Sidecar

**User Story:** As a developer or analyst, I want machine-readable metadata about the separation, so that I can integrate Reveal into automated workflows.

#### Acceptance Criteria

1. WHEN any output is produced THE SYSTEM SHALL also write a JSON sidecar file containing: palette (Lab + RGB + hex + names), archetype used, match score, DNA vector, color count, and processing parameters.
2. THE SYSTEM SHALL write the sidecar as <input-basename>_reveal.json in the output directory.
3. WHEN the user provides --no-json THE SYSTEM SHALL suppress the JSON sidecar.

### REQ-9: Mechanical Knobs

**User Story:** As an advanced user, I want to control post-processing parameters, so that I can fine-tune the separation for my specific print workflow.

#### Acceptance Criteria

1. WHEN the user provides --min-volume <percent> THE SYSTEM SHALL apply ghost plate removal at the specified threshold (0-5%).
2. WHEN the user provides --speckle-rescue <pixels> THE SYSTEM SHALL apply halftone solidity despeckle at the specified threshold (0-10px).
3. WHEN the user provides --shadow-clamp <percent> THE SYSTEM SHALL apply ink body clamping at the specified threshold (0-20%).
4. WHEN no knob flags are provided THE SYSTEM SHALL use the archetype's default knob values.

### REQ-10: Compare Mode

**User Story:** As a user, I want to see multiple separation interpretations of my image side by side, so that I can pick the one that looks best rather than trusting a score.

#### Acceptance Criteria

1. WHEN the user provides --compare THE SYSTEM SHALL process the image through all 3 adaptive archetypes (Chameleon, Distilled, Salamander) plus the top-scoring archetype from auto-detection.
2. WHEN --compare is active THE SYSTEM SHALL create a subdirectory per archetype under the output location (e.g., input_reveal/chameleon/, input_reveal/distilled/, input_reveal/salamander/, input_reveal/<top-match>/).
3. WHEN --compare is active THE SYSTEM SHALL produce the requested output formats (flat, psd, ora, plates) in each subdirectory.
4. WHEN --compare is active THE SYSTEM SHALL print a summary table to stderr showing each archetype's name, match score, and color count.
5. IF --compare and --archetype are both provided THEN THE SYSTEM SHALL exit with a non-zero code (mutually exclusive flags).

### REQ-11: Recipe File


**User Story:** As a user with a repeatable workflow, I want to define my separation settings in a reusable file, so that I can apply consistent settings across multiple images without retyping flags.

#### Acceptance Criteria

1. WHEN the user provides --recipe <path.json> THE SYSTEM SHALL read separation parameters from the JSON file.
2. THE SYSTEM SHALL support the following fields in the recipe: archetype, colors, trap, minVolume, speckleRescue, shadowClamp, outputs (array of: flat, psd, ora, plates), and outputDir.
3. WHEN both --recipe and command-line flags are provided THE SYSTEM SHALL let command-line flags override recipe values.
4. IF the recipe file does not exist or contains invalid JSON THEN THE SYSTEM SHALL exit with a non-zero code and a clear error message.
5. WHEN the user provides --save-recipe <path.json> THE SYSTEM SHALL write the effective parameters (including auto-detected archetype) to a JSON file after processing, so the user can reuse the exact settings.

### REQ-12: Progress and Feedback

**User Story:** As a user, I want to know what the tool is doing, so that I don't think it's hung on large images.

#### Acceptance Criteria

1. WHILE processing an image THE SYSTEM SHALL print progress updates to stderr (archetype selected, quantization progress, output files written).
2. WHEN the user provides --quiet THE SYSTEM SHALL suppress all progress output, printing only errors.
3. WHEN the user provides --verbose THE SYSTEM SHALL print detailed timing and diagnostic information.
4. WHEN processing completes THE SYSTEM SHALL print a summary listing all output files produced.

### REQ-13: Non-Functional Requirements

**User Story:** As a user, I want the tool to be fast, reliable, and easy to install, so that I can trust it in my workflow.

#### Acceptance Criteria

1. THE SYSTEM SHALL process a 4000x3000 RGB image in under 30 seconds on a modern machine.
2. THE SYSTEM SHALL exit with code 0 on success and non-zero on any error.
3. THE SYSTEM SHALL be installable via `npm install -g @electrosaur-labs/reveal-cli` (when published).
4. THE SYSTEM SHALL have zero dependencies beyond reveal-core, reveal-psd-reader, reveal-psd-writer, sharp, and commander.
5. THE SYSTEM SHALL support Node.js 16+.

## Constraints

- Single file processing only (v1). Batch/glob mode deferred to future version.
- Input limited to PNG, TIFF, JPEG, and Lab PSD. No RAW/CR2/DNG support.
- ORA output is RGB (not Lab) — GIMP/Krita don't support Lab in ORA.
- Maximum input dimensions limited by available memory (sharp handles streaming for I/O, but reveal-core processes full pixel buffers).
