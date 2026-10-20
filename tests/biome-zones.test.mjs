import test from 'node:test';
import assert from 'node:assert/strict';
import map from '../maps/usa.js';
import { buildGameplayBiomes, buildAircraftParkingZones, groupNearbyZones } from '../biome-zones.js';

const point = (x, y) => ({ x, y });
const rect = (id, x1, y1, x2, y2, tags = {}) => {
  const ring = [point(x1, y1), point(x2, y1), point(x2, y2), point(x1, y2), point(x1, y1)];
  return { id, geometry: 'polygon', points: ring, rings: [ring], tags };
};
const house = (id, x, y) => rect(id, x - 4, y - 4, x + 4, y + 4, { building: 'yes' });
const world = extra => ({ geographic: true, width: 1800, height: 600, metersPerUnit: 1, buildings: [], roads: [], areas: [], details: [], rivers: [], lakes: [], ...extra });
const inRing = (x, y, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};
const contains = (feature, x, y) => (feature.parts || [feature.rings || [feature.points]]).some(rings => inRing(x, y, rings[0]) && !rings.slice(1).some(ring => inRing(x, y, ring)));
const cluster = (prefix, cx, cy, count, spacing = 12) => Array.from({ length: count }, (_, index) => house(`${prefix}-${index}`, cx + ((index % 5) - 2) * spacing, cy + (Math.floor(index / 5) - 2) * spacing));

test('unknown ground gets an explicitly derived fallback instead of an invented grass or desert claim', () => {
  const input = world(), before = JSON.stringify(input);
  const result = buildGameplayBiomes(input);
  assert.equal(result.features.length, 1);
  const fallback = result.features[0];
  assert.equal(fallback.biome, 'wasteland'); assert.equal(fallback.fallback, true); assert.equal(fallback.derived, true);
  assert.equal(fallback.provenance.method, 'unmapped-ground-fallback');
  assert(contains(fallback, 5, 5)); assert(contains(fallback, 1799, 599));
  assert.deepEqual(fallback.sourceIds, []);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(buildGameplayBiomes({ width: 1800, height: 600 }).features, [], 'Procedural maps keep their own terrain biomes');
});

test('building density yields exclusive suburb, urban and dense regions without inferring building purpose', () => {
  const input = world({ buildings: [house('isolated', 150, 300), ...cluster('town', 750, 300, 8), ...cluster('dense', 1350, 300, 24)] });
  const before = JSON.stringify(input), first = buildGameplayBiomes(input), second = buildGameplayBiomes(input);
  assert.deepEqual(first, second, 'Generated geometry and IDs must be deterministic');
  assert.equal(JSON.stringify(input), before);
  for (const biome of ['suburb', 'urban', 'dense']) assert(first.features.some(feature => feature.biome === biome), `Missing ${biome}`);
  assert(first.features.some(feature => feature.biome === 'suburb' && feature.sourceIds.includes('isolated')));
  assert(!first.features.some(feature => ['urban', 'dense'].includes(feature.biome) && feature.sourceIds.includes('isolated')), 'A lone house cannot create a city');
  const density = first.features.filter(feature => feature.provenance.method === 'building-density-grid');
  assert(density.every(feature => feature.provenance.cellSizeMeters === 60 && feature.sourceIds.length));
  for (let y = 30; y < input.height; y += 60) for (let x = 30; x < input.width; x += 60) assert(density.filter(feature => contains(feature, x, y)).length <= 1, 'Density classes must not overlap');
  assert(input.buildings.every(building => building.tags.building === 'yes'), 'The original unknown-purpose buildings remain unknown');
});

test('known natural areas and permanent water block generated built-up cells while broad desert can coexist', () => {
  const buildings = [...cluster('lake', 150, 300, 24), ...cluster('forest', 750, 300, 24), ...cluster('desert', 1350, 300, 24)];
  const lake = rect('lake', 50, 200, 250, 400, { natural: 'water' });
  const forest = rect('forest', 650, 200, 850, 400, { natural: 'wood' });
  const desert = rect('desert', 1200, 150, 1500, 450, { natural: 'desert' });
  const result = buildGameplayBiomes(world({ buildings, details: [lake, forest, desert] }));
  const density = result.features.filter(feature => !feature.fallback);
  assert(!density.some(feature => contains(feature, 150, 300)), 'A lake must not become an urban biome');
  assert(!density.some(feature => contains(feature, 750, 300)), 'An explicit forest must remain natural');
  assert(density.some(feature => contains(feature, 1350, 300)), 'A broad desert region must not prevent actual settlement inference');
  const line = { id: 'river', geometry: 'line', points: [point(1350, 0), point(1350, 600)], width: 8, tags: { waterway: 'river' } };
  const wet = buildGameplayBiomes(world({ buildings, rivers: [line] })).features.filter(feature => !feature.fallback);
  assert(!wet.some(feature => contains(feature, 1350, 300)), 'A permanent river must not be painted over');
  const dry = buildGameplayBiomes(world({ buildings, rivers: [{ ...line, intermittent: true }] })).features.filter(feature => !feature.fallback);
  assert(dry.some(feature => contains(feature, 1350, 300)), 'A seasonal dry wash remains traversable terrain');
});

test('close same-use zones become one source-traceable region with a bounded derived corridor', () => {
  const input = [rect('left', 0, 0, 10, 10, { landuse: 'residential' }), rect('right', 20, 0, 30, 10, { landuse: 'residential' }), rect('far', 200, 0, 210, 10, { landuse: 'residential' }), rect('industrial', 35, 0, 40, 10, { landuse: 'industrial' })];
  const before = JSON.stringify(input), result = groupNearbyZones(input, { metersPerUnit: 1, maxDistanceMeters: 35 });
  assert.equal(result.features.length, 3); assert.equal(result.report.addedCorridors, 1);
  const joined = result.features.find(feature => feature.zoneFusion);
  assert.deepEqual(joined.memberIds, ['left', 'right']); assert.deepEqual(joined.sourceIds, ['left', 'right']);
  assert.equal(joined.parts.length, 3); assert(contains(joined, 15, 2)); assert(contains(joined, 15, 8), 'Facing plot edges close as a coherent gap, not a thin corner string');
  assert.equal(joined.provenance.method, 'nearby-zone-fusion'); assert.equal(joined.provenance.maxDistanceMeters, 35);
  assert.equal(JSON.stringify(input), before);
  const separated = groupNearbyZones(input, { metersPerUnit: 1, maxDistanceMeters: 35, blockers: [rect('water', 12, -10, 18, 20, { natural: 'water' })] });
  assert.equal(separated.features.length, 4, 'A short gap across permanent water must stay a gap');
  const river = { id: 'river', geometry: 'line', points: [point(15, -10), point(15, 20)], width: 1, tags: { waterway: 'stream' } };
  assert.equal(groupNearbyZones(input, { metersPerUnit: 1, blockers: [river] }).features.length, 4, 'A narrow water line must also block a derived land bridge');
  assert.equal(groupNearbyZones(input, { metersPerUnit: 1, blockers: [{ ...river, intermittent: true }] }).features.length, 3, 'A dry wash does not pretend to be permanent water');
  const footprints = input.slice(0, 2).map(feature => ({ ...feature, footprintOnly: true }));
  assert.equal(groupNearbyZones(footprints, { metersPerUnit: 1 }).features[0].footprintOnly, false, 'An added land corridor is no longer just a building footprint');
});

test('joining polygon parts preserves mapped holes rather than using XOR across unrelated parts', () => {
  const donut = rect('donut', 0, 0, 100, 100, { landuse: 'residential' });
  donut.rings.push(rect('hole', 20, 20, 80, 80).points);
  const result = groupNearbyZones([donut, rect('neighbor', 105, 0, 115, 10, { landuse: 'residential' })], { metersPerUnit: 1, maxDistanceMeters: 10 });
  assert.equal(result.features.length, 1);
  assert(contains(result.features[0], 5, 5)); assert(contains(result.features[0], 110, 5));
  assert(!contains(result.features[0], 50, 50), 'The original courtyard remains a hole');
});

test('aircraft positions create a small derived parking zone only when no measured apron already covers them', () => {
  const mark = { id: 'node-1', geometry: 'point', x: 100, y: 100, tags: { aeroway: 'parking_position' } };
  const next = { ...mark, id: 'node-2', x: 120 };
  const input = world({ details: [mark, next] }), before = JSON.stringify(input);
  const generated = buildAircraftParkingZones(input);
  assert.equal(generated.length, 1); assert.equal(generated[0].biome, 'aircraft_parking');
  assert.equal(generated[0].provenance.paddingMeters, 5); assert.deepEqual(generated[0].sourceIds, ['node-1', 'node-2']);
  const bounds = generated[0].points.reduce((b, p) => ({ minX: Math.min(b.minX, p.x), maxX: Math.max(b.maxX, p.x), minY: Math.min(b.minY, p.y), maxY: Math.max(b.maxY, p.y) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  assert.deepEqual(bounds, { minX: 95, maxX: 125, minY: 95, maxY: 105 });
  const apron = rect('apron', 90, 90, 130, 110, { aeroway: 'apron' });
  assert.equal(buildAircraftParkingZones(world({ details: [mark, next, apron] })).length, 0);
  assert.equal(JSON.stringify(input), before);
});

test('the actual Nevada source retains every building and gets compact derived settlement regions', () => {
  const before = JSON.stringify(map), start = performance.now(), result = buildGameplayBiomes(map);
  assert.equal(JSON.stringify(map), before); assert.equal(result.report.sourceBuildings, map.buildings.length);
  assert(result.features.some(feature => feature.biome === 'urban')); assert(result.features.some(feature => feature.biome === 'dense'));
  assert(result.features.every(feature => feature.parts.flat(2).every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0 && point.x <= map.width && point.y <= map.height)));
  assert(result.features.reduce((total, feature) => total + feature.parts.flat(2).length, 0) < 15000, 'Compact shared cell contours, not a polygon per cell');
  assert(performance.now() - start < 3000, 'Generation belongs to map construction and must remain practical');
});
