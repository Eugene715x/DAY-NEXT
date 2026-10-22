# Geographic data licenses

## OpenStreetMap

© OpenStreetMap contributors.

The OpenStreetMap source extract in `source/beatty.osm` and the derived geographic database in `usa.js` are made available under the Open Database License (ODbL) 1.0:

https://opendatacommons.org/licenses/odbl/1-0/

Attribution and information about OpenStreetMap data:

https://www.openstreetmap.org/copyright

The map embedded in `../downloads/day-next.html` and its ZIP contains this derived database and retains the source attribution and license metadata. Keep this attribution and the ODbL terms when redistributing the geographic database or adaptations. The checked-in unmodified source, pinned upstream URL and provenance are available in `source/README.md` and `source/beatty.provenance.json`.

## USGS elevation

The elevation source `source/beatty-elevation.tif` and sampled grid `beatty-elevation.js` come from the U.S. Geological Survey, 3D Elevation Program (3DEP), via its public elevation ImageServer. Attribution:

**Elevation: U.S. Geological Survey, 3D Elevation Program (3DEP).**

USGS-authored U.S. elevation data are in the public domain. Keep their source attribution and provenance when redistributing them. The original service copyright text, source URLs, source byte count, SHA-256 and available metadata are retained in [`source/beatty-elevation.provenance.json`](source/beatty-elevation.provenance.json), `source/beatty-elevation.service.json` and `source/beatty-elevation.export.json`.

USGS copyright and credit policy:

https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits

The approximately 15 m exported sampling grid does not establish the native resolution or vertical accuracy of the underlying dynamic mosaic. A survey date and vertical datum were not reported for this export; no vertical transformation or inferred datum is claimed. The USGS source remains separately identified from the OpenStreetMap database.

This notice covers geographic and elevation data. It does not relicense the application source code or GraphHopper software.
