# Real source map: Beatty / Rhyolite, Nevada, USA

`beatty.osm` is an unmodified, historical OpenStreetMap XML extract, downloaded from GraphHopper's public test-data directory. It is real geographic source data, not a hand-drawn map or a synthetic test grid.

- **Selected game area:** `west=-116.86, south=36.86, east=-116.73, north=36.94` (approximately 11.6 × 8.9 km).
- **Locations:** Beatty, Rhyolite ghost town, and Gold Center, Nye County, Nevada, USA.
- **Source repository commit:** `f59c9ce254aa192fa8c57ab610589bc84ef3ef51`.
- **Pinned source URL:** <https://raw.githubusercontent.com/graphhopper/graphhopper/f59c9ce254aa192fa8c57ab610589bc84ef3ef51/reader-gtfs/files/beatty.osm>.
- **SHA-256:** `7975e54fa0b30f5b1e23305c2c4d4fd8a04f63ba991bc18404ba0f4111ddb56f`.
- **Download date:** 2026-10-20 UTC.
- **Newest OSM element timestamp in this extract:** 2017-08-18T15:44:51Z. This is a historical snapshot, not a claim about present-day conditions.
- **Original counts:** 6,624 nodes, 344 ways, 8 relations. The original extract is larger than the selected game area and contains complete referenced geometry outside its bounds.

Machine-readable provenance, original bounds, timestamp range and selected-area counts are in `beatty.provenance.json`.

## Conversion coverage

`coverage.json` records the conversion audit of this exact source file and selected bbox. The current conversion retains 372 of 372 eligible source elements inside the selected bounds; 53 further tagged features are outside them. Untagged coordinate vertices are geometry, not standalone map objects. Physical map layers preserve 156 road segments, 104 buildings and 100 other features, plus natural areas and watercourses. Route/group relations are kept as metadata rather than painting duplicate road geometry.

Six relations in the original extract have missing members. The converter preserves available fragments, source identities and missing-member references; it does not fabricate closed polygons. Coverage is relative to this historical file, not to today's OpenStreetMap website.

## Source-data attribution and license

**© OpenStreetMap contributors.** OpenStreetMap source data and the derived geographic database are available under the **Open Database License 1.0 (ODbL-1.0)**:

- Attribution: <https://www.openstreetmap.org/copyright>.
- License: <https://opendatacommons.org/licenses/odbl/1-0/>.

GraphHopper redistributes this extract as test data; its software license does not replace the OpenStreetMap data license. Preserve this attribution and the provenance when redistributing the source or derived map database.

## Interpretation

This is desert terrain. Most waterway features in the source are marked `intermittent` or `seasonal`; they represent dry washes rather than permanently impassable blue rivers. No real forests are recorded in this extract. Procedural decoration must be distinguished from imported geographic facts.

## Reproduce the source download

```sh
curl --fail --location \
  'https://raw.githubusercontent.com/graphhopper/graphhopper/f59c9ce254aa192fa8c57ab610589bc84ef3ef51/reader-gtfs/files/beatty.osm' \
  --output maps/source/beatty.osm
sha256sum maps/source/beatty.osm
```

During development, live requests to `api.openstreetmap.org` and `overpass-api.de` were blocked by the cloud egress proxy (HTTP CONNECT 403). The checked-in GitHub-hosted source allows a reproducible import without those live services.
