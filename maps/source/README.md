# Beatty / Rhyolite: geographic source data

## Original OpenStreetMap data

`beatty.osm` contains the original, unmodified OSM XML used to build the Nevada game map. It is geographic source data, not a rendered image. Selected bounds: `west=-116.86, south=36.86, east=-116.73, north=36.94`, approximately 11.6 × 8.9 km, covering Beatty, Rhyolite and Gold Center in Nye County, Nevada, USA.

The exact source URL, download date, timestamp range, byte length and SHA-256 are recorded in [`beatty.provenance.json`](beatty.provenance.json). [`coverage.json`](coverage.json) audits conversion of that exact file; the in-game atlas displays its date and counts.

## Refresh and reproduce

The [Refresh Beatty map workflow](https://github.com/Eugene715x/DAY-NEXT/actions/workflows/update-map.yml) downloads the official OSM extract, converts it, runs tests, builds the offline HTML/ZIP and commits the data and downloads together. Run it manually with **Run workflow**. There is no scheduled background update.

```sh
npm run map:refresh
npm test
npm run build
```

Local refresh requires Node.js 24 and HTTPS access to the [official map API](https://api.openstreetmap.org/api/0.6/map?bbox=-116.86,36.86,-116.73,36.94). With restricted cloud egress, the repository workflow provides the reusable data-import/build pipeline. No account or API key is required to download this public OSM data.

The game atlas also links directly to the official XML attachment for the entered bbox. Download it in your browser, then import the file into the game. This works without a cross-origin JavaScript fetch.

## Coverage and interpretation

The OSM map API returns nodes in the bbox, ways using those nodes, all coordinates of those ways and related relation records. The bbox is 0.0104 square degrees, below the API's 0.25 square degree area limit. Relation partners outside the extract may be absent; those references and available fragments are preserved and reported. Missing contours are never invented. Route relations group existing roads instead of drawing duplicate roads.

Coverage is relative to the downloaded file, not to every object that exists in reality. Some buildings may not yet be mapped in OSM. Untagged coordinate vertices are geometry rather than standalone game objects. Latest edit time and download time are different facts, both kept in the metadata.

This is desert terrain. Seasonal and intermittent waterways represent dry washes rather than permanent rivers. No elevation model is inferred from OSM: the separate USGS source below supplies real heights. Roof and surface styling is artistic. Real street/building names, road reference labels and addresses are excluded from game labels, cards and public rendered-object descriptions; their original facts remain in the archived OSM data.

## Real USGS elevation

[`beatty-elevation.tif`](beatty-elevation.tif) is the original 32-bit floating-point GeoTIFF returned by the [USGS 3DEP elevation ImageServer](https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer) for the same Nevada bounds. Its raw bytes are retained, rather than replaced with a rendered relief image. The preserved [`beatty-elevation.provenance.json`](beatty-elevation.provenance.json) records source URLs, export parameters, download time, SHA-256, no-data handling and raster transform. [`beatty-elevation.service.json`](beatty-elevation.service.json) and [`beatty-elevation.export.json`](beatty-elevation.export.json) preserve the service metadata and original export response.

The source was downloaded on 2026-10-22: 2,294,864 bytes, SHA-256 `907063fbe4009343df30c29595f4ed5433b8abd6bc1463575c7f334c7c6ccc24`. It has 769 × 593 valid samples with no no-data gaps. Raw source heights range from 926.69 to 1824.635 m. The game grid in [`../beatty-elevation.js`](../beatty-elevation.js) stores metre values rounded to 0.1 m for compactness; this storage precision is not a claim of measurement accuracy.

The first and last sample centres coincide with the geographic bbox endpoints. Rows run north to south, columns west to east; approximate sample spacing is 15.069 m by 15.043 m. ArcGIS export pixel-edge bounds were expanded by half a sample to preserve that alignment. Sampling uses the service's bilinear interpolation. No synthetic terrain, gap filling or vertical datum conversion was applied.

The dynamic service combines multiple source products. Their native resolution, survey date and vertical datum for this export were not established and are not inferred from the output grid spacing or service-wide metadata. Download time is not survey time. The retained GeoTIFF and service responses support later inspection.

### Refresh and reproduce elevation

The [Fetch Beatty elevation workflow](https://github.com/Eugene715x/DAY-NEXT/actions/workflows/fetch-elevation.yml) runs `scripts/import-elevation.py`, validates the public USGS export and commits the original GeoTIFF, provenance and derived game grid. It can be run manually and also runs when its acquisition script or workflow changes; there is no scheduled download. This authoring workflow installs Python 3.12, NumPy and rasterio at the pinned versions shown in the workflow. The game, ordinary Node.js tests and `npm run build` do not require those packages or network access.

With the authoring tools installed, rebuild the game grid from the preserved original without downloading it again:

```sh
python scripts/import-elevation.py --rebuild
npm run build
```

Running `python scripts/import-elevation.py` performs a fresh official download; the provenance stores the repeatable export request. A temporary service download URL can expire, so the preserved source file and export parameters are the basis of offline reproduction.

USGS-authored U.S. elevation data are public domain. Attribution: **Elevation: U.S. Geological Survey, 3D Elevation Program (3DEP).** See the [USGS copyright and credit policy](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits) and [`../LICENSE.md`](../LICENSE.md).

## Previous OSM source

Before the live refresh pipeline, the game used a historical GraphHopper test extract with only 104 buildings inside the chosen bounds, latest timestamp `2017-08-18T15:44:51Z`. Its pinned source remains reproducible:

<https://raw.githubusercontent.com/graphhopper/graphhopper/f59c9ce254aa192fa8c57ab610589bc84ef3ef51/reader-gtfs/files/beatty.osm>

SHA-256: `7975e54fa0b30f5b1e23305c2c4d4fd8a04f63ba991bc18404ba0f4111ddb56f`. The previous source and its provenance remain in repository history.

## Attribution and license

**© OpenStreetMap contributors.** Both original OSM data and derived geographic database are distributed under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Preserve [OpenStreetMap attribution](https://www.openstreetmap.org/copyright), provenance and license when redistributing source or derived maps. A software license on a mirror does not replace the data license.
