import test from 'node:test';
import assert from 'node:assert/strict';
import map from '../maps/usa.js';
import { buildCityBiomes } from '../city-biomes.js';
import { createRealWorld } from '../real-world.js';

const point = (x, y) => ({ x, y });
const rect = (id, x1, y1, x2, y2, tags = {}) => {
  const ring = [point(x1, y1), point(x2, y1), point(x2, y2), point(x1, y2), point(x1, y1)];
  return { id, geometry: 'polygon', points: ring, rings: [ring], tags };
};
const house = (id, x, y) => rect(id, x - 4, y - 4, x + 4, y + 4, { building: 'yes' });
const cluster = (prefix, x, y, count = 8) => Array.from({ length: count }, (_, i) => house(`${prefix}-${i}`, x + (i % 4) * 45, y + Math.floor(i / 4) * 45));
const world = extra => ({ geographic: true, width: 2400, height: 1200, metersPerUnit: 1, buildings: [], details: [], areas: [], pois: [], ...extra });
const inRing = (p, ring) => {
  let value = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) value = !value;
  }
  return value;
};
const contains = (features, x, y) => features.some(f => f.parts.some(rings => inRing(point(x, y), rings[0]) && !rings.slice(1).some(ring => inRing(point(x, y), ring))));

test('one coherent gray city envelope fills connected development instead of individual plots', () => {
  const input = world({ buildings: cluster('house', 350, 350), details: [rect('left', 330, 320, 400, 430, { landuse: 'residential' }), rect('right', 430, 320, 505, 430, { landuse: 'commercial' }), rect('park', 400, 350, 440, 390, { leisure: 'park' })] });
  const before = structuredClone(input), { features, report } = buildCityBiomes(input);
  assert.equal(features.length, 1); assert.equal(report.sourceClusters, 1);
  assert.equal(features[0].biome, 'city'); assert.equal(features[0].fill, '#969b99');
  assert.equal(features[0].derived, true); assert.equal(features[0].provenance.sourceBoundary, false);
  assert(contains(features, 415, 365), 'The street/plot gap is part of the overall town');
  assert(contains(features, 420, 370), 'Specific nature is resolved later by the biome partition, not per-plot city holes');
  assert.deepEqual(input, before);
  assert(features[0].sourceIds.includes('left') && features[0].sourceIds.includes('right'));
});

test('an angular whole-town polygon fills internal development gaps without a square-cell stair', () => {
  const buildings = Array.from({ length: 10 }, (_, i) => house(`ring-${i}`, 600 + Math.cos(i / 10 * Math.PI * 2) * 180, 600 + Math.sin(i / 10 * Math.PI * 2) * 180));
  const { features } = buildCityBiomes(world({ buildings }));
  assert.equal(features.length, 1); assert(contains(features, 600, 600), 'The town does not have a spurious unzoned doughnut');
  assert.equal(features[0].rings.length, 1);
  assert(features[0].points.length <= 20, 'A settlement uses deliberate polygon corners rather than many rounded contour samples');
  assert.equal(features[0].provenance.contourStyle, 'angular');
  const edges = features[0].points.slice(1).map((p, i) => ({ dx: p.x - features[0].points[i].x, dy: p.y - features[0].points[i].y }));
  assert(edges.filter(e => Math.abs(e.dx) > 1e-6 && Math.abs(e.dy) > 1e-6).length / edges.length > .8);
});

test('distant settlements remain separate while isolated homes and airport hangars do not become towns', () => {
  const airport = rect('airfield', 1350, 150, 1750, 650, { aeroway: 'aerodrome' });
  const input = world({ buildings: [...cluster('town-a', 300, 300), ...cluster('town-b', 1750, 850), ...cluster('hangar', 1450, 300), house('isolated', 2150, 300)], details: [airport] });
  const { features, report } = buildCityBiomes(input);
  assert.equal(features.length, 2); assert(!contains(features, 1150, 600));
  assert(!contains(features, 1500, 320)); assert(!contains(features, 2150, 300));
  assert.equal(report.excludedAirportBuildings, 8);
});

test('mapped settlements can retain their measured urban plots when the building extract is sparse', () => {
  const name = { id: 'node-1', geometry: 'point', points: [point(500, 500)], name: 'Small Town', tags: { place: 'village', name: 'Small Town' } };
  const { features } = buildCityBiomes(world({ details: [name, rect('residential', 400, 400, 600, 600, { landuse: 'residential' })] }));
  assert.equal(features.length, 1); assert(contains(features, 500, 500)); assert.equal(features[0].name, 'Small Town');
  const adminOnly = buildCityBiomes(world({ details: [rect('admin', 0, 0, 2400, 1200, { boundary: 'census' })] }));
  assert.equal(adminOnly.features.length, 0, 'A census extent is not evidence of built-up land');
});

test('city geometry and IDs do not depend on source ordering or edit the source map', () => {
  const input = world({ buildings: [...cluster('left', 250, 250), ...cluster('right', 1700, 700)], details: [rect('one', 250, 250, 350, 350, { landuse: 'residential' }), rect('two', 1700, 700, 1800, 800, { landuse: 'commercial' })] });
  const before = JSON.stringify(input), first = buildCityBiomes(input);
  assert.deepEqual(buildCityBiomes({ ...input, buildings: [...input.buildings].reverse(), details: [...input.details].reverse() }), first);
  assert.equal(JSON.stringify(input), before);
});

test('actual Nevada map produces compact whole-town contours without changing any mapped facts', () => {
  const before = JSON.stringify(map), start = performance.now(), { features, report } = buildCityBiomes(map);
  assert.equal(JSON.stringify(map), before); assert.equal(report.sourceBuildings, 893);
  assert.deepEqual(buildCityBiomes(createRealWorld(map)), { features, report }, 'Runtime navigation snaps do not change city geometry or evidence');
  assert.equal(features.length, 3); assert.deepEqual(new Set(features.map(f => f.name)), new Set(['Beatty', 'Rhyolite', 'Gold Center']));
  assert(contains(features, 2341.664, 888.292)); assert(contains(features, 718.068, 1043.936));
  assert(!contains(features, 1665.382, 1935.753), 'The separate airfield is outside the city envelope');
  assert(features.every(f => f.rings.length === 1 && f.points.every(p => p.x >= 0 && p.y >= 0 && p.x <= map.width && p.y <= map.height)));
  assert(report.vertices < 100, 'Whole settlements have compact angular outlines, not densely rounded halos'); assert(performance.now() - start < 3000);
});
