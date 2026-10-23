import test from 'node:test';
import assert from 'node:assert/strict';
import { createLandscape, LANDSCAPE_TYPES } from '../landscape.js';
import { createRealWorld } from '../real-world.js';
import { createElevationRenderer } from '../elevation-renderer.js';
import map from '../maps/usa.js';
import dem from '../maps/beatty-elevation.js';

const fixture = (changes = {}) => ({ width: 2000, height: 1000, cellSize: 25, cols: 80, rows: 40, metersPerUnit: 1, ...changes });

test('landscape responds to physical gradient and relative relief, not absolute elevation', () => {
  const world = fixture();
  for (const [gradient, expected] of [[0, 'plain'], [.04, 'uneven'], [.1, 'hills'], [.2, 'mountains'], [.45, 'high_mountains']]) {
    const low = createLandscape(world, { elevationAt: x => 100 + x * gradient });
    const high = createLandscape(world, { elevationAt: x => 5000 + x * gradient });
    const point = low.getAt(1000, 500), elevated = high.getAt(1000, 500);
    assert.equal(point.id, expected);
    assert.equal(elevated.id, expected, 'Raising a whole measured surface does not change its shape');
    assert(Math.abs(point.slopePercent - gradient * 100) < .001);
    assert.equal(point.multiplier, LANDSCAPE_TYPES[expected].multiplier);
  }
  const enlargedWorld = fixture({ width: 1000, height: 500, cellSize: 12.5, metersPerUnit: 2 });
  const original = createLandscape(world, { elevationAt: x => 100 + x * .1 });
  const scaled = createLandscape(enlargedWorld, { elevationAt: x => 100 + x * 2 * .1 });
  assert.deepEqual(scaled.getAt(500, 250), original.getAt(1000, 500), 'World coordinates cannot change a physical terrain class');
});

test('a flat mountain summit keeps its regional rugged landscape while a high flat plateau stays plain', () => {
  const world = fixture();
  const summit = createLandscape(world, { elevationAt: (x, y) => 1800 - Math.max(0, Math.hypot(x - 1000, y - 500) - 110) });
  assert.equal(summit.getAt(1000, 500).id, 'high_mountains');
  assert.equal(summit.getAt(1000, 500).slopePercent, 0);
  const plateau = createLandscape(world, { elevationAt: () => 4500 });
  assert.equal(plateau.getAt(1000, 500).id, 'plain');
});

test('missing DEM coverage remains unknown and cannot become fabricated flat landscape', () => {
  for (const elevationAt of [undefined, () => null, () => NaN]) {
    const landscape = createLandscape(fixture(), { elevationAt });
    assert.equal(landscape.available, false);
    assert.equal(landscape.getAt(100, 100), null);
    assert.equal(landscape.draw({}), false);
    assert.equal(landscape.getStats().classifiedCells, 0);
  }
  const partial = createLandscape(fixture(), { elevationAt: x => x < 900 ? 1200 : null });
  assert.equal(partial.getAt(100, 100).id, 'plain');
  assert.equal(partial.getAt(1500, 100), null);
  assert(partial.getInfo().unknownCells > 0);
  for (const [x, y] of [[-1, 10], [2000, 10], [10, 1000], [NaN, 10], [10, Infinity]]) assert.equal(partial.getAt(x, y), null);
  assert.equal(createLandscape(fixture({ cols: 500000 }), { elevationAt: () => 0 }).getInfo().reason, 'invalid-world');
});

test('classification and returned metadata preserve all input world state', () => {
  const world = fixture({ cells: [{ biome: 'forest', landscape: 'existing-value', cost: 3 }], source: { id: 'do-not-edit' } });
  const before = structuredClone(world);
  const landscape = createLandscape(world, { elevationAt: x => 900 + x * .1 });
  assert.deepEqual(world, before);
  const info = landscape.getInfo(), point = landscape.getAt(1000, 500);
  info.types[0].name = 'changed'; info.thresholds.gradientRadiusMeters = 1; info.counts.hills = 0;
  point.id = 'changed'; point.multiplier = 100;
  assert.equal(landscape.getInfo().types[0].name, 'Равнина');
  assert.equal(landscape.getInfo().thresholds.gradientRadiusMeters, 75);
  assert(landscape.getInfo().counts.hills > 0);
  assert.equal(landscape.getAt(1000, 500).id, 'hills');
});

test('optional landscape raster clips to the world, remains translucent and is cached across zooms', () => {
  const previousCanvas = globalThis.OffscreenCanvas, canvases = [];
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; canvases.push(this); }
    getContext() { return {
      createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: image => { this.pixels = image.data; },
    }; }
  };
  try {
    let reads = 0;
    const world = fixture({ width: 200, height: 100, cols: 8, rows: 4 });
    const landscape = createLandscape(world, { elevationAt: x => { reads++; return 100 + x * .04; } });
    const context = { images: [], clips: [], save() {}, restore() {}, beginPath() {}, clip() {},
      rect(...args) { this.clips.push(args); }, drawImage(...args) { this.images.push({ args, alpha: this.globalAlpha }); } };
    landscape.draw(context, { zoom: .32 });
    landscape.draw(context, { zoom: 24 });
    assert.equal(reads, 32, 'Drawing never reads the DEM again');
    assert.equal(canvases.length, 1);
    assert.equal(landscape.getStats().rasterBuilds, 1);
    assert.equal(landscape.getStats().drawCount, 2);
    assert.deepEqual(context.clips, [[0, 0, 200, 100], [0, 0, 200, 100]]);
    assert(context.images.every(image => image.alpha === .32));
    assert.deepEqual(context.images[0].args.slice(1), [0, 0, 200, 100]);
    assert.equal(canvases[0].width, 16); assert.equal(canvases[0].height, 8);
    assert(canvases[0].pixels.every((value, index) => index % 4 !== 3 || value === 255));
  } finally {
    if (previousCanvas === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = previousCanvas;
  }
});

test('the actual USGS map has complete exclusive landscape coverage without changing source data', () => {
  const mapBefore = JSON.stringify(map), demBefore = JSON.stringify(dem);
  const world = createRealWorld(map, { navigationCellSize: map.cellSize / 4 });
  const elevation = createElevationRenderer(world, dem);
  const landscape = createLandscape(world, { elevationAt: elevation.sampleAt });
  const info = landscape.getInfo();
  assert.equal(info.available, true);
  assert.equal(info.unknownCells, 0);
  assert.equal(Object.values(info.counts).reduce((sum, count) => sum + count, 0), 178560);
  assert(Object.values(info.counts).every(count => count > 0), 'All five gameplay landscape classes occur on the real terrain');
  assert.equal(landscape.getAt(world.start.x, world.start.y).id, 'plain');
  assert.equal(landscape.getAt(180, 180).id, 'high_mountains');
  assert.equal(JSON.stringify(map), mapBefore);
  assert.equal(JSON.stringify(dem), demBefore);
});
