import test from 'node:test';
import assert from 'node:assert/strict';
import { createElevationRenderer } from '../elevation-renderer.js';

const world = { width: 100, height: 80, bbox: [0, 0, 2, 2] };
const dem = (values, columns = 2, rows = 2, changes = {}) => ({
  format: 'day-next-elevation', version: 1, bbox: [0, 0, 2, 2], columns, rows,
  units: 'm', rowOrder: 'north-to-south', values, source: { provider: 'Fixture measurements', verticalDatum: null }, ...changes,
});
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);

test('a measured affine surface uses inclusive north-west/east and south edge samples', () => {
  const renderer = createElevationRenderer(world, dem([100, 200, 300, 400]));
  assert.equal(renderer.available, true);
  assert.equal(renderer.sampleAt(0, 0), 100);
  assert.equal(renderer.sampleAt(100, 0), 200);
  assert.equal(renderer.sampleAt(0, 80), 300);
  assert.equal(renderer.sampleAt(100, 80), 400);
  close(renderer.sampleAt(25, 20), 175);
  close(renderer.sampleAt(50, 40), 250);
  assert.equal(renderer.sampleAt(-.001, 0), null);
  assert.equal(renderer.sampleAt(100.001, 80), null);
  assert.equal(renderer.sampleAt(NaN, 10), null);
  assert.deepEqual([renderer.getInfo().min, renderer.getInfo().max], [100, 400]);
});

test('an imported map inside DEM coverage samples its real geographic subset instead of stretching the raster', () => {
  const renderer = createElevationRenderer({ ...world, bbox: [.5, .5, 1.5, 1.5] }, dem([100, 200, 300, 400]));
  assert.equal(renderer.available, true);
  close(renderer.sampleAt(0, 0), 175);
  close(renderer.sampleAt(100, 80), 325);
  close(renderer.sampleAt(50, 40), 250);
});

test('missing samples stay unavailable, valid negative elevations and exact vertices remain usable', () => {
  const renderer = createElevationRenderer(world, dem([-50, null, 0, 50]));
  assert.equal(renderer.sampleAt(0, 0), -50, 'A zero-weight missing neighbour cannot erase a measured vertex');
  assert.equal(renderer.sampleAt(0, 80), 0);
  assert.equal(renderer.sampleAt(50, 40), null, 'A missing corner cannot silently become zero or fabricated interpolated terrain');
  assert.equal(renderer.sampleAt(50, 80), 25);
  const sentinel = createElevationRenderer(world, dem([-9999, 10, 20, 30], 2, 2, { noDataValue: -9999 }));
  assert.equal(sentinel.sampleAt(0, 0), null);
  assert.equal(sentinel.getInfo().min, 10);
});

test('real coverage and valid dimensions are required; no flat substitute is fabricated', () => {
  assert.equal(createElevationRenderer(world).available, false);
  assert.equal(createElevationRenderer({ ...world, bbox: [-1, 0, 2, 2] }, dem([1, 2, 3, 4])).getInfo().reason, 'outside-coverage');
  assert.equal(createElevationRenderer({ ...world, width: Infinity }, dem([1, 2, 3, 4])).available, false);
  assert.equal(createElevationRenderer(world, dem([null, null, null, null])).getInfo().reason, 'no-valid-elevations');
  assert.equal(createElevationRenderer(world, dem([1, 2, 3])).getInfo().reason, 'invalid-data');
  assert.equal(createElevationRenderer(world, dem([1, 2, 3, 4], 2, 2, { rowOrder: 'south-to-north' })).available, false);
});

test('height data and source attribution cannot be changed through input or returned metadata', () => {
  const data = dem([10, 20, 30, 40]), original = structuredClone(data);
  const renderer = createElevationRenderer(world, data), info = renderer.getInfo();
  assert.deepEqual(data, original);
  data.values[0] = 1000; data.source.provider = 'Changed';
  info.source.provider = 'Mutated'; info.bbox[0] = 100; info.palette[0].color = '#000000';
  assert.equal(renderer.sampleAt(0, 0), 10);
  assert.equal(renderer.getInfo().source.provider, 'Fixture measurements');
  assert.equal(renderer.getInfo().bbox[0], 0);
  assert.notEqual(renderer.getInfo().palette[0].color, '#000000');
});

function withCanvas(run) {
  const previousCanvas = globalThis.OffscreenCanvas, previousPath = globalThis.Path2D, canvases = [];
  globalThis.Path2D = class { commands = []; moveTo(x, y) { this.commands.push(['move', x, y]); } lineTo(x, y) { this.commands.push(['line', x, y]); } };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; canvases.push(this); }
    getContext() { return {
      createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: image => { this.pixels = image.data; },
    }; }
  };
  try { return run(canvases); }
  finally {
    if (previousCanvas === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = previousCanvas;
    if (previousPath === undefined) delete globalThis.Path2D; else globalThis.Path2D = previousPath;
  }
}
function targetContext() {
  return {
    images: [], imageModes: [], strokes: [],
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, setLineDash() {},
    drawImage(...args) { this.images.push(args); this.imageModes.push(this.globalCompositeOperation); },
    stroke(path) { this.strokes.push({ path, width: this.lineWidth, color: this.strokeStyle }); },
  };
}

test('50 metre contours follow an analytic east-rising plane; raster and vector caches are reused', () => withCanvas(canvases => {
  const renderer = createElevationRenderer(world, dem([0, 100, 200, 0, 100, 200, 0, 100, 200], 3, 3));
  const context = targetContext();
  assert.equal(renderer.draw(context, { zoom: 1 }), true);
  const info = renderer.getInfo();
  assert.equal(info.contourInterval, 50); assert.equal(info.majorContourInterval, 100);
  const major = context.strokes.filter(stroke => stroke.width === 1.05);
  assert(major.some(stroke => stroke.path.commands.every(command => Math.abs(command[1] - 50) < 1e-8)), 'The measured 100 m isoline is exactly at half the world width');
  const minor = context.strokes.filter(stroke => stroke.width === .65);
  assert(minor.some(stroke => stroke.path.commands.every(command => Math.abs(command[1] - 25) < 1e-8)), 'The 50 m contour is exactly one quarter across');
  assert.equal(canvases.length, 1);
  assert.deepEqual(context.images[0].slice(1), [.5, .5, 2, 2, 0, 0, 100, 80], 'Source pixel centres align with inclusive DEM vertices');
  renderer.draw(context, { zoom: 4 });
  assert.equal(renderer.getStats().rasterBuilds, 1); assert.equal(renderer.getStats().contourBuilds, 1);
  assert.equal(renderer.getStats().drawCount, 2); assert.equal(renderer.getStats().contourLevels, 4);
  assert.equal(canvases.length, 1, 'Camera or zoom changes cannot recompute the DEM raster');
  assert(canvases[0].pixels.every((value, index) => index % 4 !== 3 || value === 255));
}));

test('northwest illumination distinguishes opposite slopes at the same measured elevation', () => withCanvas(canvases => {
  const bbox = [0, 0, .001, .001], region = { ...world, bbox };
  const eastRising = dem([0, 100, 200, 0, 100, 200, 0, 100, 200], 3, 3, { bbox });
  const westRising = dem([200, 100, 0, 200, 100, 0, 200, 100, 0], 3, 3, { bbox });
  createElevationRenderer(region, eastRising).draw(targetContext(), { zoom: 1, elevationContours: false });
  createElevationRenderer(region, westRising).draw(targetContext(), { zoom: 1, elevationContours: false });
  const center = 4 * 4;
  assert(canvases[0].pixels[center] > canvases[1].pixels[center], 'A slope facing northwest sunlight is brighter than the opposite slope');
}));

test('nodata remains transparent and a flat measured map draws without invented contour lines', () => withCanvas(canvases => {
  const missing = createElevationRenderer(world, dem([null, 1, 1, 1]));
  missing.draw(targetContext(), { zoom: 1 });
  assert.equal(canvases[0].pixels[3], 0); assert.equal(canvases[0].pixels[7], 255);
  const flat = createElevationRenderer(world, dem([125, 125, 125, 125]));
  flat.draw(targetContext(), { zoom: 1 });
  assert.equal(flat.getStats().contourLevels, 0);
  assert.equal(flat.sampleAt(50, 40), 125);
}));


test('neutral relief is achromatic and invariant to absolute altitude offsets', () => withCanvas(canvases => {
  const bbox = [0, 0, .002, .002], region = { ...world, bbox };
  const values = [10, 80, 40, 20, 130, 100, 40, 100, 25];
  const first = createElevationRenderer(region, dem(values, 3, 3, { bbox }));
  const raised = createElevationRenderer(region, dem(values.map(value => value + 1500), 3, 3, { bbox }));
  first.draw(targetContext(), { elevationContours: false });
  raised.draw(targetContext(), { elevationContours: false });
  assert.deepEqual(canvases[0].pixels, canvases[1].pixels, 'Only shape and illumination may affect the relief raster; elevation palette must not reappear');
  for (let pixel = 0; pixel < canvases[0].pixels.length; pixel += 4) {
    assert.equal(canvases[0].pixels[pixel], canvases[0].pixels[pixel + 1]);
    assert.equal(canvases[0].pixels[pixel], canvases[0].pixels[pixel + 2]);
  }
  assert.equal(first.getInfo().renderMode, 'neutral-relief-mask');
  for (const stop of first.getInfo().palette) assert(/^#([0-9a-f]{2})\1\1$/i.test(stop.color));
}));

test('a flat measured surface supplies a neutral soft-light mask reused with the standalone raster', () => withCanvas(canvases => {
  const renderer = createElevationRenderer(world, dem([125, 125, 125, 125]));
  const context = targetContext();
  assert.equal(renderer.drawMask(context, { elevationContours: false }), true);
  assert.equal(context.imageModes[0], 'soft-light', 'Biome colours must be illuminated rather than covered with a grey source-over matte');
  for (let pixel = 0; pixel < canvases[0].pixels.length; pixel += 4) {
    assert.equal(canvases[0].pixels[pixel], 128);
    assert.equal(canvases[0].pixels[pixel + 1], 128);
    assert.equal(canvases[0].pixels[pixel + 2], 128);
  }
  renderer.draw(context, { zoom: 4, elevationContours: false });
  renderer.drawMask(context, { zoom: 24, elevationContours: false });
  assert.equal(context.imageModes[1], 'source-over');
  assert.equal(context.imageModes[2], 'soft-light');
  assert.equal(renderer.getStats().rasterBuilds, 1);
  assert.equal(renderer.getStats().maskDrawCount, 2);
  assert.equal(renderer.getStats().drawCount, 3);
  assert.equal(canvases.length, 1, 'Standalone relief and the overlay share one neutral raster cache');
  assert.equal(createElevationRenderer(world).drawMask(context), false);
}));
