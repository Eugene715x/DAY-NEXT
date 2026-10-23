import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMovementGeometry } from '../movement-geometry.js';

const point = (x, y) => ({ x, y });
const ring = (left, top, right, bottom) => [point(left, top), point(right, top), point(right, bottom), point(left, bottom), point(left, top)];
const fixture = overrides => ({ cellSize: 25, buildings: [], roads: [], ...overrides });
const ribbon = rings => ({ biome: 'seasonal_river', geometry: 'polygon', parts: [rings] });
const occupiedLength = (geometry, from, to, kind) => {
  const regions = geometry.segmentRegions(from, to);
  let fraction = 0;
  for (let i = 1; i < regions.cuts.length; i++) {
    const a = regions.cuts[i - 1], b = regions.cuts[i];
    if (regions.at((a + b) / 2)[kind]) fraction += b - a;
  }
  return fraction * Math.hypot(to.x - from.x, to.y - from.y);
};

test('exact building boundaries split a sub-cell footprint without changing the source', () => {
  const world = fixture({ buildings: [{ id: 'tiny', rings: [ring(11, 6, 12, 14)] }] }), before = structuredClone(world);
  const geometry = prepareMovementGeometry(world);
  assert.deepEqual(geometry.segmentCuts(point(0, 10), point(50, 10)), [0, .22, .24, 1]);
  assert(Math.abs(occupiedLength(geometry, point(0, 10), point(50, 10), 'building') - 1) < 1e-9);
  assert.equal(geometry.queryPoint(11.5, 10).building, true);
  assert.equal(geometry.queryPoint(13, 10).building, false);
  assert.deepEqual(world, before);
});

test('courtyard holes remain clear and collinear roof edges are partitioned', () => {
  const geometry = prepareMovementGeometry(fixture({ buildings: [{ rings: [ring(10, 5, 40, 35), ring(20, 10, 30, 30)] }] }));
  assert.equal(geometry.queryPoint(15, 20).building, true);
  assert.equal(geometry.queryPoint(25, 20).building, false);
  assert(Math.abs(occupiedLength(geometry, point(0, 20), point(50, 20), 'building') - 20) < 1e-9);
  assert(Math.abs(occupiedLength(geometry, point(0, 5), point(50, 5), 'building') - 30) < 1e-9);
});

test('narrow seasonal ribbons apply independently from the navigation grid and visibility', () => {
  const feature = { ...ribbon([ring(14, -20, 15, 80)]), enabled: false }, before = structuredClone(feature);
  const geometry = prepareMovementGeometry(fixture(), { biomeFeatures: [feature] });
  assert.equal(geometry.hasSeasonalGeometry, true);
  assert(Math.abs(occupiedLength(geometry, point(0, 10), point(50, 10), 'seasonal') - 1) < 1e-9);
  assert.equal(geometry.queryPoint(14.5, 10).seasonal, true);
  assert.deepEqual(feature, before);
  assert.equal(prepareMovementGeometry(fixture()).hasSeasonalGeometry, false);
});

test('only the true bridge width exempts a river crossing; neighbouring points do not inherit a whole-cell bridge', () => {
  const geometry = prepareMovementGeometry(fixture({ roads: [{ bridge: true, width: 2, points: [point(0, 10), point(50, 10)] }] }), { biomeFeatures: [ribbon([ring(14, -20, 16, 80)])] });
  assert.deepEqual(geometry.queryPoint(15, 10), { building: false, seasonal: true, bridge: true });
  assert.deepEqual(geometry.queryPoint(15, 12), { building: false, seasonal: true, bridge: false });
  assert(Math.abs(occupiedLength(geometry, point(15, 0), point(15, 20), 'bridge') - 2) < 1e-9);
});

test('bridge bends and rounded native endpoints split exact corridor boundaries', () => {
  const geometry = prepareMovementGeometry(fixture({ roads: [{ tags: { bridge: 'yes' }, width: 4, points: [point(10, 10), point(20, 10), point(20, 20)] }, { bridge: false, width: 20, points: [point(0, 0), point(50, 0)] }] }));
  assert.equal(geometry.queryPoint(20, 11).bridge, true);
  assert.equal(geometry.queryPoint(8.5, 10).bridge, true);
  assert.equal(geometry.queryPoint(7.5, 10).bridge, false);
  assert.equal(geometry.queryPoint(10, 0).bridge, false);
  assert(Math.abs(occupiedLength(geometry, point(0, 10), point(30, 10), 'bridge') - 14) < 1e-9);
});

test('multipart source geometry and overlapping footprints are a union, not repeated penalties', () => {
  const geometry = prepareMovementGeometry(fixture({ buildings: [{ parts: [[ring(5, 5, 15, 15)], [ring(25, 5, 35, 15)]] }, { points: ring(10, 5, 20, 15) }] }));
  assert(Math.abs(occupiedLength(geometry, point(0, 10), point(40, 10), 'building') - 25) < 1e-9);
  assert.equal(geometry.queryPoint(22, 10).building, false);
  assert.equal(geometry.getStats().buildings, 3);
});


test('bridge paths preserve disconnected spans and convert native metre widths using map scale', () => {
  const source = fixture({ metersPerUnit: 4, roads: [{ bridge: true, width: 20, widthMeters: 8, paths: [[point(10, 10), point(20, 10)], [point(40, 10), point(50, 10)]] }] });
  const geometry = prepareMovementGeometry(source);
  assert.equal(geometry.getStats().bridgeSegments, 2);
  assert.equal(geometry.queryPoint(15, 10.9).bridge, true);
  assert.equal(geometry.queryPoint(15, 11.1).bridge, false, '8 metre source width is two world units, overriding the style width');
  assert.equal(geometry.queryPoint(45, 10).bridge, true);
  assert.equal(geometry.queryPoint(30, 10).bridge, false, 'Disconnected source paths cannot fabricate a bridge between spans');
  assert(Math.abs(occupiedLength(geometry, point(15, 0), point(15, 20), 'bridge') - 2) < 1e-9);
});
