# Reveal Cross-Project Parity & Port TODOs

Tracking deferred cross-language ports from the JavaScript reference implementation (`@electrosaur-labs/core`, `reveal-navigator`, `reveal-cli`) to the Python and C ports (`pyreveal`, `libreveal`, `krita-reveal`).

---

## 1. Cross-Language Mesh Physics & Line-Spine Parity (2026-11-15)

The JavaScript reference implementation (`reveal-core`, `reveal-navigator`, `reveal-cli`) now implements full SAATI `(TPI - µm)` plain-weave mesh physics, configurable `ruleOfN`, and self-supporting line-spine filament pruning. Port the following three invariants to `pyreveal/`, `libreveal/`, and `krita-reveal/`:

- [ ] **SAATI `(tpi, tdia)` `MeshPhysics` & Open-Area Scaling (`pyreveal`, `libreveal`, `krita-reveal`):**
  - Port the 20 official SAATI polyester mesh rolls (`SAATI_MESH_PRESETS`, `110-80` through `420-27`, including standard and `Hi-R` thin-thread diameters), `DEFAULT_THREAD_UM = 31` (for `DEFAULT_MESH_TPI = 355`), `F_OPEN_REF` (`230-48` baseline, `~32.0%` open area), `computeOpenArea(meshTpi, threadDiaUm)`, and `minDotPx(meshTpi, dpi, ruleOfN, threadDiaUm)` with `ceil((n * d / tpi) * sqrt(f_ref / f_open) - 1e-9)` open-area scaling (falling back to unscaled `ceil(n * d / tpi)` when `threadDiaUm` is omitted or `0`).
  - Expose `Screen Mesh (TPI - µm)` + `Custom (TPI / µm)` in the Krita PyQt5 Docker (`krita-reveal/krita_reveal/dock.py`) and re-vendor `pyreveal` (`cp -r pyreveal/pyreveal krita-reveal/krita_reveal/vendor/pyreveal`).
- [ ] **Configurable `ruleOfN` Plumbing (`pyreveal`, `libreveal`, `krita-reveal`):**
  - Thread configurable `ruleOfN` (`default: 7.0`, range `4.0–10.0`) through `SeparationEngine`, `MechanicalKnobs` (`applySpeckleRescue` + `enforceMeshRuleOfSeven`), manifest/sidecar metadata (`threadDiaUm`, `ruleOfN`, `minDotPx`), and the Krita Docker UI.
- [ ] **Self-Supporting Line-Spine Filament Pruning (`_pruneUnsupportedFilaments` in `pyreveal` & `libreveal`):**
  - Port the O(W·H) connected-component spine-seed fix in `SeparationEngine._pruneUnsupportedFilaments`: any 8-connected mask component without a broad dot (`sqDist >= dotSqRadius`) whose bounding-box diagonal meets `hypot(maxX - minX, maxY - minY) >= minLineLength` (`2 * minDotPx`) must seed geodesic reconstruction from its own line-spine (`sqDist >= lineSqRadius`, `>= 2 px` wide) rather than only from `sqDist >= dotSqRadius` anchors, preventing fine standalone line art, crosshatching, and typography from being amputated while still pruning thin whiskers dangling off broad blobs.
