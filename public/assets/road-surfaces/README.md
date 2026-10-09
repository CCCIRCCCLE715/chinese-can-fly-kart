# Scanned village road surfaces

These original 1K JPEG PBR maps are downloaded from Poly Haven, which publishes them under CC0 1.0 Universal. `sources.json` records each exact URL, MD5 hash and file size. No lighting is painted into the albedo maps and none of the downloaded raster maps has been edited.

- Gravel Stones — Amal Kumar — 2 m wide: https://polyhaven.com/a/gravel_stones
- Gravel Ground 01 — Rob Tuytel — 3 m wide: https://polyhaven.com/a/gravel_ground_01
- Brown Mud Dry — Rob Tuytel — 1.3 m wide: https://polyhaven.com/a/brown_mud_dry

Sandy Gravel (Charlotte Baglioni, 2.1 m wide, https://polyhaven.com/a/sandy_gravel) is retained as an optional reference. The three active sets are listed in `sources.json`.

The road blends dense aggregate, finer gravel and bare dry soil in irregular, world-position-based patches. Tile offsets and quarter-turns vary independently of the larger dirt and aggregate-density masks. Rotated OpenGL tangent normals and roughness use the same offsets as their albedo, with explicit texture gradients to preserve mip selection. The fine ground never uses a single repeating normal pattern over the whole course.

Blue-grey slab bonds retain their orientation in town centers, with per-slab tone and larger wear patches. Asphalt cold joints and transverse construction seams have been removed from the gravel road. Gravel and paving continue to blend through the existing feathered district weights. Patches change only the material: the race surface, driving centerline, checkpoints and route are unchanged.
