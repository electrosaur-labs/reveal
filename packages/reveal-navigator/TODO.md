# reveal-navigator TODOs

## General

- [ ] Add more comprehensive integration tests for ProductionWorker.
- [ ] "Black lock / keyline snap" option — for source images where the linework
      is genuinely a separate black plate (e.g. cartoon/illustration art with
      solid black outlines), let the artist lock black to its own dedicated
      ink and snap keyline pixels to it directly, instead of letting the
      quantizer/dither/mesh-rescue pipeline treat keyline pixels like any
      other chromatic region (which can fragment or erode thin linework).
      Surfaced while debugging the arson-20-8c.png halftone report.
