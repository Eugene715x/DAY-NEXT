# Beatty / Rhyolite: original OpenStreetMap data

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

This is desert terrain. Seasonal and intermittent waterways represent dry washes rather than permanent rivers. No elevation model is inferred from OSM. Roof and surface styling is artistic; real materials, levels and addresses are only shown when provided by tags.

## Previous source

Before the live refresh pipeline, the game used a historical GraphHopper test extract with only 104 buildings inside the chosen bounds, latest timestamp `2017-08-18T15:44:51Z`. Its pinned source remains reproducible:

<https://raw.githubusercontent.com/graphhopper/graphhopper/f59c9ce254aa192fa8c57ab610589bc84ef3ef51/reader-gtfs/files/beatty.osm>

SHA-256: `7975e54fa0b30f5b1e23305c2c4d4fd8a04f63ba991bc18404ba0f4111ddb56f`. The previous source and its provenance remain in repository history.

## Attribution and license

**© OpenStreetMap contributors.** Both original OSM data and derived geographic database are distributed under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Preserve [OpenStreetMap attribution](https://www.openstreetmap.org/copyright), provenance and license when redistributing source or derived maps. A software license on a mirror does not replace the data license.
