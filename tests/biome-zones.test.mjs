import test from 'node:test';
import assert from 'node:assert/strict';
import map from '../maps/usa.js';
import { buildGameplayBiomes, buildAircraftParkingZones, groupNearbyZones } from '../biome-zones.js';
import { polygonIntersection } from '../polygon-geometry.js';

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
  const density = first.features.filter(feature => feature.urbanFiller);
  assert(density.length > 0);
  assert(density.every(feature => feature.provenance.method === 'building-density-contours' && feature.provenance.sampleSpacingMeters === 15 && feature.sourceIds.length));
  for (let i = 0; i < density.length; i++) for (let j = i + 1; j < density.length; j++) assert.deepEqual(polygonIntersection(density[i].parts, density[j].parts), [], 'Smoothed density classes remain geometrically exclusive');
  for (let y = 30; y < input.height; y += 60) for (let x = 30; x < input.width; x += 60) assert(density.filter(feature => contains(feature, x, y)).length <= 1, 'Density classes must not overlap');
  assert(input.buildings.every(building => building.tags.building === 'yes'), 'The original unknown-purpose buildings remain unknown');
});

test('every explicit natural zone and permanent water is cut from generated settlement fillers', () => {
  const buildings = [...cluster('lake', 150, 300, 24), ...cluster('forest', 750, 300, 24), ...cluster('desert', 1350, 300, 24)];
  const lake = rect('lake', 50, 200, 250, 400, { natural: 'water' });
  const forest = rect('forest', 650, 200, 850, 400, { natural: 'wood' });
  const desert = rect('desert', 1200, 150, 1500, 450, { natural: 'desert' });
  const result = buildGameplayBiomes(world({ buildings, details: [lake, forest, desert] }));
  const density = result.features.filter(feature => !feature.fallback);
  assert(!density.some(feature => contains(feature, 150, 300)), 'A lake must not become an urban biome');
  assert(!density.some(feature => contains(feature, 750, 300)), 'An explicit forest must remain natural');
  assert(!density.some(feature => contains(feature, 1350, 300)), 'Even a broad desert polygon is an existing zone, not unzoned city space');
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
  assert(result.features.reduce((total, feature) => total + feature.parts.flat(2).length, 0) < 15000, 'Compact continuous contours, not a polygon per density sample');
  assert(performance.now() - start < 3000, 'Generation belongs to map construction and must remain practical');
});


test('isolated settlement ground has a rounded vector outline rather than square sample-cell steps', () => {
  const result = buildGameplayBiomes(world({ buildings: [house('alone', 300, 300)] }));
  const zone = result.features.find(feature => feature.urbanFiller);
  const ring = zone.parts[0][0], radii = ring.slice(0, -1).map(p => Math.hypot(p.x - 300, p.y - 300));
  assert(ring.length >= 24, 'The outline has enough real polygon vertices for a round perimeter');
  assert(Math.max(...radii) - Math.min(...radii) < 2, 'An isolated building produces a near-circular 40m envelope');
  const diagonal = ring.slice(1).filter((point, i) => Math.abs(point.x - ring[i].x) > .001 && Math.abs(point.y - ring[i].y) > .001).length;
  assert(diagonal / (ring.length - 1) > .9, 'The actual fill/pick geometry is rounded, not axis-aligned cell edges');
  assert.equal(zone.provenance.smoothingIterations, 2);
});

test('settlement filler is exactly removed from residential, parking, service footprints and park ground while real holes stay available', () => {
  const park = rect('park', 335, 280, 365, 320, { leisure: 'park' });
  park.rings.push(rect('park-hole', 344, 290, 356, 310).points);
  const residential = rect('residential', 255, 280, 270, 300, { landuse: 'residential' });
  const parking = rect('parking', 290, 280, 310, 300, { amenity: 'parking' });
  const clinic = { ...house('clinic', 320, 320), tags: { building: 'yes', amenity: 'clinic' } };
  const substation = rect('substation', 300, 330, 315, 345, { power: 'substation' });
  const input = world({ buildings: [...cluster('dense', 300, 300, 24), clinic], details: [park, residential, parking, substation] });
  const before = JSON.stringify(input), zones = buildGameplayBiomes(input).features.filter(feature => feature.urbanFiller);
  for (const occupied of [park, residential, parking, clinic, substation]) for (const zone of zones) {
    assert.deepEqual(polygonIntersection(zone.parts, [occupied.rings]), [], `Filler overlaps occupied ${occupied.id}`);
  }
  assert(zones.some(feature => contains(feature, 350, 300)), 'A real hole inside a mapped park is still unzoned and can be filled');
  assert(zones.some(feature => contains(feature, 280, 300)), 'Unzoned space between measured plots remains filled');
  assert.equal(JSON.stringify(input), before, 'Existing zone/building geometry must remain untouched');
});

test('thin diagonal masks remove only their exact footprint and deferred renderer cuts preserve the uncut envelope', () => {
  const strip = { id: 'strip', geometry: 'polygon', tags: { amenity: 'parking' }, rings: [[point(280.125, 220), point(281.325, 220), point(321.325, 380), point(320.125, 380), point(280.125, 220)]] };
  strip.points = strip.rings[0];
  const input = world({ buildings: cluster('dense', 300, 300, 24), details: [strip] });
  const cut = buildGameplayBiomes(input).features.filter(feature => feature.urbanFiller);
  const deferred = buildGameplayBiomes(input, { deferOccupiedCuts: true }).features.filter(feature => feature.urbanFiller);
  assert(deferred.some(feature => polygonIntersection(feature.parts, [strip.rings]).length), 'The renderer can receive a smooth uncut envelope for one authoritative final subtraction');
  assert(cut.every(feature => !polygonIntersection(feature.parts, [strip.rings]).length), 'A 1.2m diagonal source strip is exactly excluded, not raster approximated');
  assert(cut.some(feature => contains(feature, 299.5, 300)));
  assert(cut.some(feature => contains(feature, 302, 300)), 'The remaining strip outside the mask is not thrown away as a whole density cell');
  assert(cut.every(feature => feature.provenance.sourceZoneExclusion));
  assert(deferred.every(feature => !feature.provenance.sourceZoneExclusion));
});
