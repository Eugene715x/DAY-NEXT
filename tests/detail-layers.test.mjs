import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailRenderer } from '../detail-renderer.js';
import { polygonIntersection } from '../polygon-geometry.js';

globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} ellipse() {} };
const ring = (x1, y1, x2, y2) => [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }, { x: x1, y: y1 }];
const world = changes => ({ width: 400, height: 300, metersPerUnit: 1, roads: [], buildings: [], areas: [], rivers: [], lakes: [], details: [], ...changes });
const objects = renderer => renderer.getFeatures().filter(feature => feature.layer !== 'biomes');
const membership = (renderer, x, y) => renderer.zonesAt(x, y).map(zone => zone.biome);

// Navigation/source facts remain unchanged while presentation uses connected paths.
test('a former rail alignment has one road path with its source tags and no duplicate detail', () => {
  const points = [{ x: 20, y: 50 }, { x: 350, y: 50 }], tags = { highway: 'track', railway: 'abandoned', surface: 'dirt' };
  const input = world({ roads: [{ id: 'way-10-0', points, type: 'track', tags }], details: [{ id: 'way-10-0', points, geometry: 'line', kind: 'railway', tags }] });
  const before = structuredClone(input), renderer = createDetailRenderer(input);
  assert.equal(objects(renderer).length, 1);
  assert.equal(renderer.pick(150, 50).kind, 'road');
  assert.equal(renderer.pick(150, 50).source.tags.railway, 'abandoned');
  renderer.setLayers({ roads: false, biomes: false });
  assert.equal(renderer.pick(150, 50), null);
  assert.deepEqual(input, before);
});

test('one canonical biome switch controls ground, water and nature decorations, independently of roads and details', () => {
  const renderer = createDetailRenderer(world({
    roads: [{ id: 'street', points: [{ x: 30, y: 50 }, { x: 370, y: 50 }], width: 6 }],
    details: [
      { id: 'grass', geometry: 'polygon', points: ring(0, 0, 400, 300), tags: { natural: 'grassland' } },
      { id: 'tree', geometry: 'point', points: [{ x: 60, y: 100 }], kind: 'tree', tags: { natural: 'tree' } },
      { id: 'pool', geometry: 'polygon', points: ring(150, 150, 250, 250), kind: 'pool', tags: { leisure: 'swimming_pool' } },
      { id: 'fountain', geometry: 'point', points: [{ x: 100, y: 100 }], kind: 'fountain', tags: { amenity: 'fountain' } },
      { id: 'cliff', geometry: 'line', points: [{ x: 250, y: 100 }, { x: 350, y: 100 }], kind: 'cliff', tags: { natural: 'cliff' } },
    ],
  }));
  assert.deepEqual(Object.keys(renderer.getLayers()), ['biomes', 'roads', 'power', 'buildings', 'details']);
  assert.equal(renderer.pick(200, 50).layer, 'roads');
  for (const p of [[60, 100], [300, 100], [200, 200], [300, 200]]) assert.equal(renderer.pick(...p).layer, 'biomes');
  assert.equal(renderer.pick(200, 200).water, true);
  assert.equal(renderer.pick(100, 100).layer, 'details');
  const zones = renderer.zonesAt(200, 200);
  renderer.setLayers({ biomes: false });
  for (const p of [[60, 100], [300, 100], [200, 200], [300, 200]]) assert.equal(renderer.pick(...p), null);
  assert.deepEqual(renderer.zonesAt(200, 200), zones, 'Visibility does not change physical membership');
  assert.equal(renderer.pick(200, 50).layer, 'roads');
  assert.equal(renderer.pick(100, 100).layer, 'details');
});

test('water holes are land biomes and seasonal waterways are actual exclusive biome ribbons', () => {
  const outer = ring(150, 130, 270, 250), inner = ring(190, 170, 230, 210);
  const renderer = createDetailRenderer(world({ details: [
    { id: 'grass', geometry: 'polygon', points: ring(0, 0, 400, 300), tags: { natural: 'grassland' } },
    { id: 'lake', geometry: 'polygon', points: outer, rings: [outer, inner], tags: { natural: 'water' } },
    { id: 'wash', geometry: 'line', width: 4, points: [{ x: 50, y: 70 }, { x: 350, y: 70 }], tags: { waterway: 'river', intermittent: 'yes' } },
  ] }));
  assert.deepEqual(membership(renderer, 175, 155), ['water']);
  assert.deepEqual(membership(renderer, 210, 190), ['grassland']);
  assert.deepEqual(membership(renderer, 200, 70), ['seasonal_river']);
  const selected = renderer.pick(200, 70, 0);
  assert.equal(selected.waterKind, 'seasonal_river');
  assert.equal(selected.geometry, 'polygon');
  assert.equal(selected.semanticGeometry, 'line');
  assert.equal(selected.paths.length, 1);
  assert(selected.parts.length);
  assert(selected.description.includes('Сезонное русло'));
  assert.deepEqual(membership(renderer, 200, 80), ['grassland']);
  renderer.setLayers({ biomes: false });
  assert.equal(renderer.pick(200, 70), null);
  assert.deepEqual(membership(renderer, 200, 70), ['seasonal_river']);
});

test('nature and city are partitioned rather than stacked, while native source holes remain untouched', () => {
  const outer = ring(100, 50, 300, 250), hole = ring(150, 100, 250, 200);
  const input = world({ details: [
    { id: 'housing', geometry: 'polygon', points: ring(0, 0, 400, 300), tags: { landuse: 'residential' } },
    { id: 'grass', geometry: 'polygon', points: ring(0, 0, 400, 300), tags: { natural: 'grassland' } },
    { id: 'forest', geometry: 'polygon', points: outer, rings: [outer, hole], tags: { natural: 'wood' } },
  ] });
  const before = structuredClone(input), renderer = createDetailRenderer(input);
  assert.deepEqual(membership(renderer, 120, 80), ['forest']);
  assert.deepEqual(membership(renderer, 200, 150), ['grassland']);
  const biomes = renderer.getFeatures().filter(feature => feature.exclusive);
  for (let i = 0; i < biomes.length; i++) for (let j = i + 1; j < biomes.length; j++) {
    assert.deepEqual(polygonIntersection(biomes[i].parts, biomes[j].parts), [], 'No pair of area biomes can share a positive area');
  }
  renderer.setLayers({ biomes: false });
  assert.equal(renderer.pick(120, 80), null);
  assert.deepEqual(membership(renderer, 120, 80), ['forest']);
  assert.deepEqual(input, before);
  for (const p of [[-1, 10], [401, 10], [NaN, 10], [10, Infinity]]) assert.deepEqual(renderer.zonesAt(...p), []);
});

test('institution buildings keep their native holes, factual type and separate gameplay role', () => {
  const outer = ring(50, 50, 150, 150), inner = ring(80, 80, 120, 120);
  const input = world({ buildings: [{ id: 'way-700', sourceId: 'way-700', name: 'Mapped church', points: outer, rings: [outer, inner], type: 'church', tags: { building: 'church', amenity: 'place_of_worship' } }] });
  const before = structuredClone(input), renderer = createDetailRenderer(input), building = objects(renderer)[0];
  assert.equal(building.typeId, 'building.religious');
  assert.equal(building.gameplayAssignment.roleOrigin, 'mapped');
  assert.deepEqual(building.rings, [outer, inner]);
  assert.equal(renderer.pick(60, 60).layer, 'buildings');
  assert.equal(renderer.pick(100, 100, 0).layer, 'biomes', 'A courtyard exposes the ground, not the roof');
  assert.equal(renderer.zonesAt(60, 60).length, 1);
  renderer.setLayers({ buildings: false, biomes: false });
  assert.equal(renderer.pick(60, 60), null);
  assert.deepEqual(input, before);
});

test('institution grounds inform roles without adding redundant service biome categories', () => {
  const renderer = createDetailRenderer(world({ buildings: [{ id: 'clinic-house', points: ring(70, 70, 120, 120), tags: { building: 'yes' } }], details: [
    { id: 'campus', geometry: 'polygon', points: ring(50, 50, 180, 180), tags: { amenity: 'hospital' } },
    { id: 'clinic-point', geometry: 'point', points: [{ x: 90, y: 90 }], tags: { amenity: 'clinic' }, kind: 'clinic' },
    { id: 'park', geometry: 'polygon', points: ring(200, 30, 350, 200), tags: { leisure: 'park' } },
  ] }));
  const building = renderer.pick(90, 90, 0);
  assert.equal(building.gameplayAssignment.categoryId, 'category.medical');
  assert.equal(building.typeId, 'building.unknown');
  assert.equal(renderer.zonesAt(90, 90).length, 1);
  assert.deepEqual(membership(renderer, 250, 100), ['park']);
  assert(!renderer.getFeatures().some(feature => ['healthcare', 'education', 'parking'].includes(feature.biome)));
});

test('overlapping parts from the same natural source yield one membership and preserve source identity', () => {
  const renderer = createDetailRenderer(world({ details: [
    { id: 'relation-1000-0', sourceId: 'relation-1000', geometry: 'polygon', points: ring(50, 50, 200, 200), tags: { natural: 'grassland' } },
    { id: 'relation-1000-1', sourceId: 'relation-1000', geometry: 'polygon', points: ring(100, 100, 250, 250), tags: { natural: 'grassland' } },
  ] }));
  assert.equal(renderer.zonesAt(150, 150).length, 1);
  assert.deepEqual(renderer.zonesAt(150, 150)[0].sourceIds, ['relation-1000']);
  assert.deepEqual(membership(renderer, 220, 220), ['grassland']);
});

test('administrative polygons and their boundary paths never return as selectable borders', () => {
  const input = world({ details: [
    { id: 'town', geometry: 'polygon', points: ring(0, 0, 400, 300), boundaryPaths: [[{ x: 30, y: 50 }, { x: 150, y: 50 }]], tags: { boundary: 'census', name: 'Town' } },
    { id: 'enclosing-town', geometry: 'polygon', points: ring(0, 0, 400, 300), boundaryPaths: [], tags: { boundary: 'administrative' } },
  ] });
  const before = structuredClone(input), renderer = createDetailRenderer(input);
  assert(!renderer.getFeatures().some(feature => ['town', 'enclosing-town'].includes(feature.sourceId)));
  for (const p of [[100, 50], [300, 200], [200, 0], [200, 125]]) {
    assert.equal(renderer.pick(...p, 0).biome, 'wasteland');
    assert.equal(renderer.zonesAt(...p).length, 1);
  }
  assert.deepEqual(input, before);
});

test('presentation omits crossing marks, barriers and power supports while keeping source data', () => {
  const details = [
    { id: 'crossing', geometry: 'point', points: [{ x: 20, y: 50 }], tags: { highway: 'crossing' } },
    { id: 'crossing-line', geometry: 'line', points: [{ x: 20, y: 70 }, { x: 80, y: 70 }], tags: { footway: 'crossing' } },
    { id: 'fence', geometry: 'line', points: [{ x: 20, y: 90 }, { x: 80, y: 90 }], tags: { barrier: 'fence' } },
    { id: 'wall', geometry: 'polygon', points: ring(20, 110, 80, 130), tags: { barrier: 'wall' } },
    { id: 'gate', geometry: 'point', points: [{ x: 20, y: 150 }], kind: 'gate', tags: { barrier: 'gate' } },
    { id: 'pole', geometry: 'point', points: [{ x: 20, y: 190 }], tags: { power: 'pole' } },
    { id: 'tower', geometry: 'point', points: [{ x: 20, y: 210 }], tags: { power: 'tower' } },
    { id: 'bench', geometry: 'point', points: [{ x: 250, y: 150 }], kind: 'bench', tags: { amenity: 'bench' } },
  ];
  const input = world({ details }), before = structuredClone(input), renderer = createDetailRenderer(input);
  assert.deepEqual(objects(renderer).map(feature => feature.id), ['bench']);
  assert.equal(renderer.getStats().filteredFeatures, 7);
  renderer.setLayers({ biomes: false });
  for (const [x, y] of [[20, 50], [50, 70], [50, 90], [50, 120], [20, 150], [20, 190], [20, 210]]) assert.equal(renderer.pick(x, y, 0), null);
  assert.deepEqual(input, before);
});

test('joined roads expose all members as one object and respect class and master switches', () => {
  const tags = { highway: 'track', railway: 'abandoned', surface: 'dirt' };
  const input = world({ roads: [
    { id: 'way-10-0', points: [{ x: 20, y: 50 }, { x: 150, y: 50 }], type: 'track', tags },
    { id: 'way-20-0', points: [{ x: 150, y: 50 }, { x: 350, y: 50 }], type: 'track', tags },
  ] });
  input.details = input.roads.map(road => ({ ...road, kind: 'railway', geometry: 'line' }));
  const before = structuredClone(input), renderer = createDetailRenderer(input), features = objects(renderer);
  assert.equal(features.length, 1);
  assert.equal(features[0].roadClass, 'track');
  assert.deepEqual(features[0].sourceIds.sort(), ['way-10', 'way-20']);
  const first = renderer.pick(60, 50, 0);
  assert.equal(renderer.pick(300, 50, 0).key, first.key);
  assert.deepEqual(first.memberIds.sort(), ['way-10-0', 'way-20-0']);
  assert(first.source.members.every(member => member.tags.railway === 'abandoned'));
  renderer.setLayers({ biomes: false }); renderer.setRoadClasses({ track: false });
  assert.equal(renderer.pick(60, 50, 0), null);
  renderer.setLayers({ roads: false }); renderer.setRoadClasses({ track: true });
  assert.equal(renderer.pick(60, 50, 0), null);
  renderer.setLayers({ roads: true });
  assert.equal(renderer.pick(60, 50, 0).key, first.key);
  assert.deepEqual(input, before);
});

test('water networks retain all branches, merged lakes preserve islands, and different water kinds stay distinct', () => {
  const renderer = createDetailRenderer(world({ rivers: [
    { id: 'river-main', points: [{ x: 20, y: 50 }, { x: 200, y: 50 }, { x: 380, y: 50 }], tags: { waterway: 'stream' }, width: 3 },
    { id: 'river-branch', points: [{ x: 200, y: 50 }, { x: 200, y: 120 }], tags: { waterway: 'stream' }, width: 3 },
    { id: 'dry-branch', points: [{ x: 200, y: 50 }, { x: 300, y: 120 }], tags: { waterway: 'stream', intermittent: 'yes' }, width: 3 },
  ], details: [
    { id: 'lake-west', geometry: 'polygon', rings: [ring(20, 160, 140, 280), ring(40, 180, 60, 200)], tags: { natural: 'water', water: 'lake' } },
    { id: 'lake-east', geometry: 'polygon', points: ring(100, 160, 230, 280), tags: { natural: 'water', water: 'lake' } },
    { id: 'pond', geometry: 'polygon', points: ring(230, 160, 350, 280), tags: { natural: 'water', water: 'pond' } },
  ] }));
  const main = renderer.pick(100, 50, 0), branch = renderer.pick(200, 90, 0);
  assert.equal(main.key, branch.key);
  assert.equal(main.paths.length, 2);
  assert.deepEqual(main.memberIds.sort(), ['river-branch', 'river-main']);
  assert.notEqual(renderer.pick(250, 85, 0).key, main.key);
  const west = renderer.pick(80, 240, 0);
  assert.equal(renderer.pick(120, 240, 0).key, west.key);
  assert.equal(renderer.pick(180, 240, 0).key, west.key);
  assert.equal(renderer.pick(50, 190, 0).water, false);
  assert.notEqual(renderer.pick(280, 240, 0).key, west.key);
  renderer.setLayers({ biomes: false });
  assert.equal(renderer.pick(100, 50, 0), null);
  assert.equal(renderer.pick(180, 240, 0), null);
});

test('every point including map edges receives one biome, with named fallback and water membership', () => {
  const input = world({ geographic: true, details: [
    { id: 'grass', geometry: 'polygon', points: ring(20, 20, 80, 80), tags: { natural: 'grassland' } },
    { id: 'lake', geometry: 'polygon', points: ring(150, 150, 250, 250), tags: { natural: 'water', water: 'lake' } },
  ] });
  const before = structuredClone(input), renderer = createDetailRenderer(input);
  const empty = renderer.zonesAt(350, 250)[0];
  assert.equal(empty.biome, 'wasteland'); assert.equal(empty.typeId, 'biome.wasteland');
  assert.deepEqual(empty.sourceIds, []);
  assert.deepEqual(membership(renderer, 50, 50), ['grassland']);
  assert.deepEqual(membership(renderer, 200, 200), ['water']);
  for (let y = 0; y <= 300; y += 15) for (let x = 0; x <= 400; x += 20) assert.equal(renderer.zonesAt(x, y).length, 1);
  renderer.setLayers({ biomes: false });
  assert.deepEqual(membership(renderer, 350, 250), ['wasteland']);
  assert.equal(renderer.pick(350, 250), null);
  assert.deepEqual(input, before);
});

test('obsolete density fillers stay retired while buildings keep explicit roles over city or nature ground', () => {
  const city = (id, biome) => ({ id, type: biome, kind: biome, biome, derived: true, urbanFiller: true, geometry: 'polygon', points: ring(0, 0, 400, 300) });
  const renderer = createDetailRenderer(world({ areas: [city('suburb', 'suburb'), city('urban', 'urban'), city('dense', 'dense')], buildings: [
    { id: 'home', points: ring(20, 20, 60, 60), tags: { building: 'yes' } },
    { id: 'school', points: ring(100, 100, 200, 200), tags: { building: 'school', amenity: 'school' } },
  ], details: [{ id: 'sand', geometry: 'polygon', points: ring(250, 30, 380, 250), tags: { natural: 'sand' } }] }));
  const features = renderer.getFeatures();
  assert(!features.some(feature => feature.urbanFiller || ['suburb', 'urban', 'dense', 'retail', 'education'].includes(feature.biome)));
  assert.equal(objects(renderer).length, 2);
  assert(objects(renderer).every(feature => feature.roleId && feature.roleName && feature.color));
  assert.equal(renderer.zonesAt(40, 40).length, 1);
  assert.deepEqual(membership(renderer, 300, 100), ['sand']);
});

test('airport and apron keep their measured surface objects above the common ground biome', () => {
  const renderer = createDetailRenderer(world({ details: [
    { id: 'airport', geometry: 'polygon', points: ring(10, 10, 390, 290), tags: { aeroway: 'aerodrome' }, kind: 'aerodrome' },
    { id: 'apron', geometry: 'polygon', points: ring(40, 40, 180, 160), tags: { aeroway: 'apron' }, kind: 'apron' },
  ] }));
  assert.equal(renderer.zonesAt(100, 100).length, 1);
  assert.equal(renderer.pick(100, 100, 0).layer, 'details');
  assert.equal(objects(renderer).length, 2);
  renderer.setLayers({ biomes: false });
  assert.equal(renderer.pick(100, 100, 0).layer, 'details');
  renderer.setLayers({ details: false });
  assert.equal(renderer.pick(100, 100, 0), null);
});
