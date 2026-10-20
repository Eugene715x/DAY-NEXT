import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealWorld } from '../real-world.js';
import { findPath, terrainAt } from '../world.js';

const ring = (left, top, right, bottom) => [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }, { x: left, y: top }];
const sourceMap = (overrides = {}) => ({
  version: 1, id: 'test-usa', name: 'Test river valley', bbox: [-122, 47, -121.9, 47.1],
  width: 300, height: 200, cellSize: 10, metersPerUnit: 2,
  source: { provider: 'OpenStreetMap', copyright: '© OpenStreetMap contributors', license: 'ODbL-1.0' },
  areas: [{ id: 'river-area', type: 'water', rings: [ring(130, -10, 170, 210)] }],
  roads: [{ id: 'crossing-road', points: [{ x: 50, y: 95 }, { x: 250, y: 95 }], width: 4, bridge: false }],
  rivers: [], buildings: [], labels: [],
  pois: [{ id: 'west', name: 'West bank', x: 80, y: 95 }, { id: 'east', name: 'East bank', x: 230, y: 95 }],
  start: { x: 80, y: 95 }, ...overrides,
});

test('an untagged road cannot turn a real river into an invented bridge', () => {
  const world = createRealWorld(sourceMap());
  assert.equal(terrainAt(world, 150, 95).type, 'water');
  assert.equal(findPath(world, { x: 80, y: 95 }, { x: 230, y: 95 }), null);
  const ownBank = world.pois.find(poi => poi.reachable);
  const otherBank = world.pois.find(poi => !poi.reachable);
  assert.ok(ownBank && otherBank);
  assert.deepEqual({ x: otherBank.x, y: otherBank.y }, { x: otherBank.sourceX, y: otherBank.sourceY });
});

test('an explicitly tagged bridge reconnects the banks and path avoids water', () => {
  const map = sourceMap(); map.roads[0].bridge = true;
  const world = createRealWorld(map);
  const route = findPath(world, { x: 80, y: 95 }, { x: 230, y: 95 });
  assert.ok(route);
  assert.equal(terrainAt(world, 150, 95).type, 'bridge');
  assert.equal(terrainAt(world, 150, 35).type, 'water', 'Bridge must not unblock the rest of the river');
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1], b = route.points[i], steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
    for (let j = 0; j <= steps; j++) assert.ok(terrainAt(world, a.x + (b.x - a.x) * j / steps, a.y + (b.y - a.y) * j / steps).walkable);
  }
  assert.ok(world.pois.every(poi => poi.reachable));
});

test('a narrow explicit diagonal bridge remains navigable without corner cutting', () => {
  const world = createRealWorld(sourceMap({
    roads: [{ id: 'diagonal', points: [{ x: 100, y: 65 }, { x: 200, y: 135 }], width: 2, bridge: true }],
  }));
  assert.ok(findPath(world, { x: 80, y: 65 }, { x: 230, y: 135 }));
});

test('inner polygon rings preserve real islands and clearings', () => {
  const world = createRealWorld(sourceMap({
    areas: [
      { id: 'forest', type: 'forest', rings: [ring(0, 0, 300, 200), ring(20, 20, 70, 70)] },
      { id: 'lake', type: 'water', rings: [ring(90, 30, 210, 170), ring(120, 60, 180, 140)] },
    ], roads: [],
  }));
  assert.equal(terrainAt(world, 35, 35).type, 'plain');
  assert.equal(terrainAt(world, 15, 15).type, 'forest');
  assert.equal(terrainAt(world, 100, 50).type, 'water');
  assert.equal(terrainAt(world, 150, 100).type, 'forest');
});

test('intermittent desert washes stay traversable while permanent waterways block movement', () => {
  const river = { id: 'amargosa-wash', points: [{ x: 150, y: -10 }, { x: 150, y: 210 }], width: 4, intermittent: true };
  const dry = createRealWorld(sourceMap({ areas: [], rivers: [river], roads: [] }));
  assert.equal(terrainAt(dry, 150, 95).type, 'plain');
  assert.ok(findPath(dry, { x: 80, y: 95 }, { x: 230, y: 95 }));
  const wet = createRealWorld(sourceMap({ areas: [], rivers: [{ ...river, intermittent: false }], roads: [] }));
  assert.equal(terrainAt(wet, 150, 95).type, 'water');
  assert.equal(findPath(wet, { x: 80, y: 95 }, { x: 230, y: 95 }), null);
});

test('seasonal and intermittent water polygons are dry terrain rather than permanent lakes', () => {
  for (const flag of ['seasonal', 'intermittent']) {
    const map = sourceMap({ roads: [] }); map.areas[0][flag] = true;
    const world = createRealWorld(map);
    assert.equal(terrainAt(world, 150, 95).type, 'plain', `${flag} area should be a dry wash`);
    assert.ok(findPath(world, { x: 80, y: 95 }, { x: 230, y: 95 }), `${flag} area should be traversable`);
    assert.equal(world.areas[0].type, 'water', 'Source feature tags must be preserved');
    assert.equal(world.areas[0][flag], true);
  }
  const permanent = createRealWorld(sourceMap({ roads: [] }));
  assert.equal(terrainAt(permanent, 150, 95).type, 'water');
});

test('imported maps preserve attribution, geometry, scale and explicitly flat elevation', () => {
  const input = sourceMap();
  const before = structuredClone(input);
  const world = createRealWorld(input);
  assert.deepEqual(input, before, 'Runtime conversion must not mutate imported source');
  assert.deepEqual(world.source, input.source);
  assert.deepEqual(world.roads[0].points, input.roads[0].points);
  assert.deepEqual(world.bbox, input.bbox);
  assert.equal(world.metersPerUnit, 2);
  assert.equal(world.metadata.navigationResolutionMeters, 20);
  assert.equal(world.relief, false);
  assert.ok(world.cells.every(cell => cell.height === 0 && cell.radiation === 0));
  assert.deepEqual(createRealWorld(input), world, 'Same source must reproduce the same playable map');
});

test('water POIs may snap at most 100 real meters and inaccessible markers are retained honestly', () => {
  const world = createRealWorld(sourceMap({
    width: 500,
    areas: [{ type: 'water', rings: [ring(200, -10, 500, 210)] }], roads: [],
    pois: [{ id: 'shore', name: 'Pier', x: 210, y: 95 }, { id: 'island', name: 'Far offshore', x: 400, y: 95 }],
  }));
  const pier = world.pois.find(poi => poi.id === 'shore'), far = world.pois.find(poi => poi.id === 'island');
  assert.equal(pier.reachable, true);
  assert.ok(pier.snapDistanceMeters > 0 && pier.snapDistanceMeters <= 100);
  assert.equal(far.reachable, false);
  assert.equal(far.x, 400);
  assert.equal(world.metadata.unreachablePoiCount, 1);
});

test('mapped building holes, roofs, road metadata and small objects survive without changing strategic navigation', () => {
  const base = sourceMap({ areas: [] });
  const input = sourceMap({
    areas: [],
    roads: [{ ...base.roads[0], type: 'footway', surface: 'gravel', widthMeters: 2 }],
    buildings: [{
      id: 'building-courtyard', name: 'Courtyard house', type: 'house',
      points: ring(20, 20, 80, 80), rings: [ring(20, 20, 80, 80), ring(40, 40, 60, 60)],
      ruins: false, roofShape: 'gabled', levels: 2, heightMeters: 7.5, material: 'brick',
      address: { street: 'Main Street', housenumber: '12' },
    }],
    details: [
      { id: 'tree', kind: 'tree', geometry: 'point', points: [{ x: 35, y: 45 }], tags: { natural: 'tree' } },
      { id: 'fence', kind: 'fence', geometry: 'line', points: [{ x: 20, y: 100 }, { x: 280, y: 100 }], tags: { barrier: 'fence' } },
      { id: 'parking', kind: 'parking', geometry: 'polygon', points: ring(180, 20, 270, 80), rings: [ring(180, 20, 270, 80), ring(210, 40, 240, 60)] },
    ],
  });
  const before = structuredClone(input), world = createRealWorld(input);
  assert.deepEqual(world.buildings, input.buildings);
  assert.deepEqual(world.details, input.details);
  assert.deepEqual(world.roads, input.roads);
  assert.deepEqual(world.cells, createRealWorld(base).cells, 'Detail footprints must not become 25-unit navigation walls');
  assert.ok(findPath(world, { x: 80, y: 95 }, { x: 230, y: 95 }));

  world.buildings[0].rings[1][0].x = 0;
  world.buildings[0].address.street = 'Changed in runtime';
  world.details[0].tags.natural = 'Changed in runtime';
  world.details[1].points[0].y = 0;
  world.details[2].rings[1][0].x = 0;
  assert.deepEqual(input, before, 'Runtime detail geometry and metadata must not retain writable source references');
});

test('terrain cells retain the actual ground beneath road and bridge navigation corridors', () => {
  const input = sourceMap();
  input.areas.unshift({ id: 'forest', type: 'forest', rings: [ring(0, 0, 300, 200)] });
  input.roads[0].bridge = true;
  const world = createRealWorld(input);
  const index = (x, y) => Math.floor(y / world.cellSize) * world.cols + Math.floor(x / world.cellSize);
  const landIndex = index(80, 95), bridgeIndex = index(150, 95);

  assert.equal(world.cells[landIndex].type, 'road');
  assert.equal(world.terrainCells[landIndex].type, 'forest');
  assert.equal(world.cells[bridgeIndex].type, 'bridge');
  assert.equal(world.terrainCells[bridgeIndex].type, 'water');
  assert.equal(world.terrainCells[bridgeIndex].walkable, false);
  assert.ok(world.terrainCells.every(cell => !['road', 'bridge'].includes(cell.type)));
  assert.equal(world.terrainCells.length, world.cells.length);
  assert.ok(findPath(world, { x: 80, y: 95 }, { x: 230, y: 95 }), 'Separating render terrain must preserve navigation');

  world.cells[landIndex].type = 'swamp';
  assert.equal(world.terrainCells[landIndex].type, 'forest', 'Navigation edits cannot repaint the ground');
  world.terrainCells[bridgeIndex].walkable = true;
  assert.equal(world.cells[bridgeIndex].type, 'bridge', 'Render terrain edits cannot remove a navigation bridge');
  assert.notStrictEqual(world.terrainCells[bridgeIndex], world.cells[bridgeIndex]);
});

test('coverage reports and nested source identities survive runtime conversion without sharing references', () => {
  const input = sourceMap({
    coverage: { eligibleInBounds: 3, representedSourceElements: 2, partialRelations: [{ type: 'relation', id: '700' }], omittedCounts: { outsideBounds: 1 } },
    source: { provider: 'OpenStreetMap', provenance: { sourceId: 'historical-extract' } },
    labels: [{ name: 'Main Street', x: 50, y: 50, source: { type: 'way', id: '123' } }],
    pois: [{ id: 'west', name: 'West bank', x: 80, y: 95, source: { type: 'node', id: '42' }, tags: { amenity: 'bench' } }],
    relations: [{ id: 'relation-700', name: 'Incomplete boundary', tags: { type: 'boundary' }, members: [{ type: 'way', ref: '123', role: 'outer' }], availableMemberIds: ['way-123'], missingMemberIds: ['way-456'], geometryComplete: false }],
  });
  const before = structuredClone(input), world = createRealWorld(input);
  assert.deepEqual(world.coverage, input.coverage);
  assert.deepEqual(world.labels, input.labels);
  assert.deepEqual(world.pois[0].source, input.pois[0].source);
  assert.deepEqual(world.pois[0].tags, input.pois[0].tags);
  assert.deepEqual(world.relations, input.relations, 'Logical relations must survive without inventing closed geometry');

  world.coverage.partialRelations[0].id = 'changed';
  world.source.provenance.sourceId = 'changed';
  world.labels[0].source.id = 'changed';
  world.pois[0].source.id = 'changed';
  world.pois[0].tags.amenity = 'changed';
  world.relations[0].tags.type = 'changed';
  world.relations[0].members[0].ref = 'changed';
  world.relations[0].availableMemberIds[0] = 'changed';
  world.relations[0].missingMemberIds[0] = 'changed';
  assert.deepEqual(input, before, 'Inspecting copied layer metadata cannot change the source map or coverage report');
});

test('invalid geographic bounds, unsafe grid sizes and malformed geometry are rejected', () => {
  assert.throws(() => createRealWorld(sourceMap({ bbox: [-121, 47, -122, 48] })), /bbox/);
  assert.throws(() => createRealWorld(sourceMap({ bbox: [-122, 47, -121, 91] })), /bbox/);
  assert.throws(() => createRealWorld(sourceMap({ width: 301 })), /dimensions/);
  assert.throws(() => createRealWorld(sourceMap({ width: 1e8 })), /dimensions/);
  assert.throws(() => createRealWorld(sourceMap({ width: 20000, height: 100, cellSize: 100 })), /dimensions/);
  assert.throws(() => createRealWorld(sourceMap({ width: 5000, height: 5000, cellSize: 100 })), /dimensions/);
  assert.throws(() => createRealWorld(sourceMap({ metersPerUnit: 0 })), /dimensions/);
  assert.throws(() => createRealWorld(sourceMap({ roads: [{ points: [{ x: NaN, y: 10 }, { x: 20, y: 20 }] }] })), /coordinate/);
  assert.throws(() => createRealWorld(sourceMap({ roads: [{ points: [{ x: 10, y: 10 }, { x: 20, y: 20 }], width: Infinity }] })), /width/);
  assert.throws(() => createRealWorld(sourceMap({ buildings: [{ points: ring(10, 10, 20, 20), rings: [[{ x: Infinity, y: 10 }]] }] })), /coordinate/);
  assert.throws(() => createRealWorld(sourceMap({ details: [{ geometry: 'line', points: [{ x: 20, y: 20 }] }] })), /coordinate count/);
  assert.throws(() => createRealWorld(sourceMap({ details: [{ geometry: 'point', points: [{ x: 1e308, y: 20 }] }] })), /coordinate/);
  assert.throws(() => createRealWorld(sourceMap({ details: {} })), /details/);
});
