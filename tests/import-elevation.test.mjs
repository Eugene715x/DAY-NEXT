import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import elevation from '../maps/beatty-elevation.js';
import map from '../maps/usa.js';

const root = new URL('../', import.meta.url);
const raw = await readFile(new URL('maps/source/beatty-elevation.tif', root));
const provenance = JSON.parse(await readFile(new URL('maps/source/beatty-elevation.provenance.json', root), 'utf8'));
// Minimal reader for the preserved 32-bit floating-point source, independent of
// the authoring rasterio decoder. The game does not need this TIFF reader.
function tiffTags(bytes) {
  const little = bytes.subarray(0, 2).toString() === 'II';
  const u16 = offset => little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const u32 = offset => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  assert.equal(u16(2), 42, 'The preserved source is classic TIFF');
  const directory = u32(4), tags = new Map(), sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8 };
  for (let i = 0; i < u16(directory); i++) {
    const entry = directory + 2 + i * 12, tag = u16(entry), type = u16(entry + 2), count = u32(entry + 4), size = sizes[type];
    if (!size) continue;
    const offset = count * size <= 4 ? entry + 8 : u32(entry + 8);
    const values = Array.from({ length: count }, (_, index) => {
      const p = offset + index * size;
      if (type === 3) return u16(p);
      if (type === 4) return u32(p);
      if (type === 11) return little ? bytes.readFloatLE(p) : bytes.readFloatBE(p);
      if (type === 12) return little ? bytes.readDoubleLE(p) : bytes.readDoubleBE(p);
      return bytes[p];
    });
    tags.set(tag, values);
  }
  return { tags, little };
}
const { tags, little } = tiffTags(raw);
const close = (actual, expected, tolerance = 1e-7) => assert(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);

test('the offline elevation grid identifies its exact preserved USGS floating-point source', () => {
  assert.equal(elevation.format, 'day-next-elevation');
  assert.equal(elevation.units, 'm');
  assert.equal(elevation.rowOrder, 'north-to-south');
  assert.deepEqual(elevation.bbox, map.bbox);
  assert.equal(elevation.values.length, elevation.columns * elevation.rows);
  assert.equal(raw.length, provenance.sourceBytes);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  assert.equal(sha256, provenance.sha256); assert.equal(sha256, elevation.source.sha256);
  assert.match(elevation.source.provider, /USGS.*3DEP/);
  assert.equal(elevation.source.verticalDatum, null, 'An unreported vertical datum is not invented');
  assert.equal(tags.get(258)[0], 32); assert.equal(tags.get(339)[0], 3, 'Source samples are real floating-point elevations');
  assert.equal(tags.get(256)[0], elevation.columns); assert.equal(tags.get(257)[0], elevation.rows);
});

test('raw GeoTIFF pixel centres align with all four game bbox endpoints, without a half-cell shift', () => {
  const [sx, sy] = tags.get(33550), [pixelX, pixelY, , geoX, geoY] = tags.get(33922);
  const west = geoX + (.5 - pixelX) * sx, north = geoY - (.5 - pixelY) * sy;
  const east = west + (elevation.columns - 1) * sx, south = north - (elevation.rows - 1) * sy;
  for (const [actual, expected] of [[west, elevation.bbox[0]], [south, elevation.bbox[1]], [east, elevation.bbox[2]], [north, elevation.bbox[3]]]) close(actual, expected);
  const keys = tags.get(34735), geographicKey = Array.from({ length: keys[3] }, (_, i) => keys.slice(4 + i * 4, 8 + i * 4)).find(item => item[0] === 2048);
  assert.equal(geographicKey[3], 4326, 'Raw source coordinates are geographic WGS84');
});

test('every game elevation sample agrees with the independent source TIFF decode within storage rounding', () => {
  const width = tags.get(256)[0], height = tags.get(257)[0], tileWidth = tags.get(322)[0], tileHeight = tags.get(323)[0];
  const offsets = tags.get(324), lengths = tags.get(325), tilesAcross = Math.ceil(width / tileWidth), compression = tags.get(259)[0];
  assert.equal(tags.get(317)?.[0] || 1, 1, 'The fixture uses raw samples without a prediction transform');
  const tiles = offsets.map((offset, index) => {
    const block = raw.subarray(offset, offset + lengths[index]);
    return compression === 1 ? block : [8, 32946].includes(compression) ? inflateSync(block) : assert.fail(`Unsupported preserved TIFF compression ${compression}`);
  });
  let minimum = Infinity, maximum = -Infinity, valid = 0;
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const tile = tiles[Math.floor(row / tileHeight) * tilesAcross + Math.floor(column / tileWidth)];
    const offset = ((row % tileHeight) * tileWidth + column % tileWidth) * 4;
    const source = little ? tile.readFloatLE(offset) : tile.readFloatBE(offset), displayed = elevation.values[row * width + column];
    if (!Number.isFinite(source) || source === provenance.raster.nodata) { assert.equal(displayed, null); continue; }
    assert(Number.isFinite(displayed), `Valid sample ${column},${row} must not disappear`);
    close(displayed, source, .050001);
    minimum = Math.min(minimum, source); maximum = Math.max(maximum, source); valid++;
  }
  close(minimum, provenance.statistics.minimumMeters, .000501); close(maximum, provenance.statistics.maximumMeters, .000501);
  assert.equal(valid, provenance.statistics.validSamples);
  assert.equal(elevation.values.length - valid, provenance.statistics.noDataSamples);
});
