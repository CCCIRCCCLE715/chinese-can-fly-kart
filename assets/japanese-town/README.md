# Imported Japanese town assets

71 GLB files are stored locally for offline game use. The original 62 files were downloaded from these open-content scene kits by 3D Assets:

- Feudal Japan Castle Town: https://3dassets.dev/packs/feudal-japan-castle-town
- Japanese School and City Street: https://3dassets.dev/packs/japanese-school-and-city-street
- Izakaya Alley and Ramen Shop: https://3dassets.dev/packs/izakaya-alley-and-ramen-shop
- Dense Temperate Forest Flora: https://3dassets.dev/packs/dense-temperate-forest-flora
- Forest Trees and Woodland Plants: https://3dassets.dev/packs/temperate-forest-ecology

Those 62 downloaded files are published as **CC0 1.0 Universal**: https://creativecommons.org/publicdomain/zero/1.0/
The publisher identifies the assets as AI-assisted geometry. Per-file source pages, immutable download URLs, dimensions, license metadata and that disclosure are preserved in `catalog.json`.

Integration preserves the downloaded meshes. Plaster colors, instance scale, placement and additional shop signs are adjusted to fit this game's colorful town. Static GLB node transforms and quantized vertex attributes are decoded before instancing. Each original building asset is capped at five visible instances, irrespective of paint or scale. Street furniture is excluded from this building limit.

The street layout draws on stone-paved alleys, residences with gardens and mixed commercial streets in Usuki and Kakunodate; it is an original game layout, not a reconstruction:

- https://www.japan.travel/en/spot/2276/
- https://tazawako-kakunodate.com/spots/5996/

Side streets and the two parks are scenery. The original racing centerline, checkpoints and lap route remain one loop.

The six detached-home designs are complete two- and three-storey assemblies built in `TownResidences.ts` and `ImportedTown.ts` from the downloaded Japanese facade, balcony, garage, lattice doorway and tiled-roof modules. These complete homes are local compositions, not separately downloaded complete house files. Wide and narrow plans, floor counts, balcony counts and entrances differ; every assembled design is also capped at five visible copies.

Cross alleys connect to back streets between the two housing rows. Each lot has a paved entrance and furnished frontage; the two parks remain reserved. Five new tree silhouettes mix flowering cherries from two forest packs with young cherry, maple and birch. Mature forest trees are reduced to village scale. The race ribbon uses one opaque PBR material that blends gravel and grey stone slabs through vertex weights, including albedo, normal and roughness; there is no material-group threshold at district boundaries.

## Natural sakura replacement

The town now uses nine naturally branching sakura growth forms baked from [Sakura Realm](https://github.com/Leonxlnx/sakura-realm), commit `4dd670e9ccbf7dba6a72462288fd8111021b3006`, by Leonxlnx. This source is **MIT**, not CC0; its complete copyright and license notice is included in `licenses/sakura-realm-MIT.txt` and `tools/vendor/sakura-realm/LICENSE`. The game does not load the previous solid blossom-mass models into the scene.

`tools/bake-sakura.mjs` reproduces the nine quantized GLBs from the vendored pure generators. The crown follows a connected, thickness-ordered subtree with 850 modeled branches. Flowers grow in variable-length sprays on the modeled branches and on a sampled set of fine shoots from the complete growth skeleton. A continuous upper-crown bend shortens excessively upright leaders into a broad rounded silhouette while preserving connected forks. Paired four-flower cutouts spread around each twig in three dimensions; the finest twig wood inside these patches is represented by the proxy. Patch sizes taper within each spray, with larger umbels on stronger shoots. Sparse interior wood and gaps between sprays remain visible; there are no equal-radius spherical foliage clusters. Patch widths span several scales while intrinsic pink colors vary by only 3%.

Botanical references guide this game adaptation: [RHS](https://www.rhs.org.uk/plants/prunus/large-prunus-ornamental-cherry) describes flowers clustered along branches, before or around leaf emergence; [Cornell's Japanese flowering cherry profile](https://woodyplants.cals.cornell.edu/plant/194) describes vase-to-rounded crown form. This depicts spring bloom rather than a dense summer leaf canopy.

Flower cards use the scene's standard PBR light and environment response, receive and cast masked sun shadows, and have no emissive term or luminance clamp. A small indirect-light gain softens the contrast. The native N8AO mask removes 45% of flower-card contact darkening rather than all of it; trunks and the street retain their contact shadows. Roadside and park cherries now range from about 6.7–10.3 m. Each tree and its four nearest cherries use five different seeded growth forms, including across opposite roadsides and in parks. Saturation-first neighborhood assignment prevents repetition before instancing. Each form has a different height, branching seed, crown aspect, upper-crown rise, trunk thickness and flowering density; bloom stays at 96–112% of the reference population. Orientation and horizontal scale also vary per placement. The wood mesh stays below 8,500 triangles. Near trees use full flower cards; middle-distance trees retain interleaved samples along every flowering shoot. Beyond 90 m, the entire tree becomes a two-triangle billboard using an eight-view 128 px atlas rendered directly from the model, with sun, sky fill and self-shadowing. Atlas frames follow viewing direction; the 3D meshes are not drawn at that distance. No source weather, atmosphere, wind or user interface is imported. These are adaptations of an open-source procedural tree, not downloaded photogrammetry scans.
