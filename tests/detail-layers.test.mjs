import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailRenderer } from '../detail-renderer.js';

// Picking uses the same cached source geometry in browsers. Node has no Canvas
// Path2D; only its inert construction methods are needed for these hit tests.
globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} ellipse() {} };
const ring = (x1, y1, x2, y2) => [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }, { x: x1, y: y1 }];
const world = changes => ({ width: 400, height: 300, metersPerUnit: 1, roads: [], buildings: [], areas: [], rivers: [], lakes: [], details: [], ...changes });

test('a present road on a former rail alignment has one selectable path with every source tag', () => {
  const points = [{ x: 20, y: 50 }, { x: 350, y: 50 }], tags = { highway: 'track', railway: 'abandoned', surface: 'dirt' };
  const input = world({ roads: [{ id: 'way-10-0', points, type: 'track', tags }], details: [{ id: 'way-10-0', points, geometry: 'line', kind: 'railway', tags }] });
  const before = structuredClone(input), renderer = createDetailRenderer(input);
  assert.equal(renderer.getFeatures().length, 1);
  assert.equal(renderer.pick(150, 50).kind, 'road');
  assert.equal(renderer.pick(150, 50).source.tags.railway, 'abandoned');
  renderer.setLayers({ roads: false });
  assert.equal(renderer.pick(150, 50), null, 'A duplicate railway style must not leak through the details layer');
  assert.deepEqual(input, before);
});

test('natural points, zone polygons and water follow their own switches during selection', () => {
  const renderer = createDetailRenderer(world({
    roads: [{ id: 'street', points: [{ x: 30, y: 50 }, { x: 370, y: 50 }], width: 6 }],
    details: [
      { id: 'zone', geometry: 'polygon', points: ring(0, 0, 400, 300), tags: { natural: 'grassland' }, kind: 'grassland' },
      { id: 'tree', geometry: 'point', points: [{ x: 60, y: 100 }], kind: 'tree', tags: { natural: 'tree' } },
      { id: 'pool', geometry: 'polygon', points: ring(150, 150, 250, 250), kind: 'pool', tags: { leisure: 'swimming_pool' } },
      { id: 'fountain', geometry: 'point', points: [{ x: 100, y: 100 }], kind: 'fountain', tags: { amenity: 'fountain' } },
      { id: 'cliff', geometry: 'line', points: [{ x: 250, y: 100 }, { x: 350, y: 100 }], kind: 'cliff', tags: { natural: 'cliff' } },
    ],
  }));
  assert.equal(renderer.pick(200, 50).layer, 'roads', 'Road stroke sits above a residential biome');
  assert.equal(renderer.pick(60, 100).layer, 'landscape');
  assert.equal(renderer.pick(300, 100).layer, 'landscape');
  assert.equal(renderer.pick(200, 200).layer, 'water');
  assert.equal(renderer.pick(100, 100).layer, 'details');
  assert.equal(renderer.pick(300, 200).biome, 'grassland');
  renderer.setLayers({ landscape: false });
  assert.equal(renderer.pick(60, 100), null);
  assert.equal(renderer.pick(300, 100), null);
  assert.equal(renderer.pick(200, 200).layer, 'water');
  assert.equal(renderer.pick(100, 100).layer, 'details');
  renderer.setLayers({ water: false, roads: false, details: false, buildings: false });
  for (const point of [[200, 50], [60, 100], [300, 100], [200, 200], [100, 100]]) assert.equal(renderer.pick(...point), null);
  assert(renderer.getFeatures().every(feature => !feature.enabled));
});

test('water holes remain land and generic seasonal waterways cannot escape the water switch', () => {
  const outer = ring(150, 130, 270, 250), inner = ring(190, 170, 230, 210);
  const renderer = createDetailRenderer(world({ details: [
    { id: 'biome', geometry: 'polygon', points: ring(0, 0, 400, 300), tags: { landuse: 'grass' } },
    { id: 'lake', geometry: 'polygon', points: outer, rings: [outer, inner], tags: { natural: 'water' } },
    { id: 'wash', geometry: 'line', points: [{ x: 50, y: 70 }, { x: 350, y: 70 }], tags: { waterway: 'river', intermittent: 'yes' } },
  ] }));
  assert.equal(renderer.pick(175, 155).layer, 'water');
  assert.equal(renderer.pick(210, 190).layer, 'landscape', 'The lake island cannot become a filled water hit target');
  assert.equal(renderer.pick(200, 70).layer, 'water');
  assert.equal(renderer.pick(200, 70).description, 'Сезонное русло');
  renderer.setLayers({ water: false });
  assert.equal(renderer.pick(200, 70).layer, 'landscape');
  assert.equal(renderer.pick(175, 155).layer, 'landscape');
});

test('city and service grounds retire while overlapping natural biomes retain their holes and memberships', () => {
  const outer = ring(100, 50, 300, 250), hole = ring(150, 100, 250, 200);
  const input = world({ details: [
    { id: 'housing', geometry: 'polygon', points: ring(0, 0, 400, 300), tags: { landuse: 'residential' } },
    { id: 'parking', geometry: 'polygon', points: outer, tags: { amenity: 'parking' } },
    { id: 'school', geometry: 'polygon', points: outer, tags: { amenity: 'school' } },
    { id: 'grass', geometry: 'polygon', points: ring(0, 0, 400, 300), tags: { natural: 'grassland' } },
    { id: 'forest', geometry: 'polygon', points: outer, rings: [outer, hole], tags: { natural: 'wood' } },
  ] });
  const before = structuredClone(input), renderer = createDetailRenderer(input);
  const memberships = (x, y) => renderer.zonesAt(x, y).map(zone => zone.biome).sort();
  assert.deepEqual(memberships(120, 80), ['forest', 'grassland']);
  assert.deepEqual(memberships(200, 150), ['grassland']);
  assert(!renderer.getFeatures().some(feature => ['housing', 'parking', 'school'].includes(feature.id)));
  renderer.setLayers({ landscape: false });
  assert.equal(renderer.pick(120, 80), null);
  assert.deepEqual(memberships(120, 80), ['forest', 'grassland']);
  assert.deepEqual(input, before);
  for (const point of [[-1, 10], [401, 10], [NaN, 10], [10, Infinity]]) assert.deepEqual(renderer.zonesAt(...point), []);
});

test('institution buildings retain native holes and carry their role without a redundant footprint biome', () => {
  const outer = ring(50, 50, 150, 150), inner = ring(80, 80, 120, 120);
  const input = world({ buildings: [{ id: 'way-700', sourceId: 'way-700', name: 'Mapped church', points: outer, rings: [outer, inner], type: 'church', tags: { building: 'church', amenity: 'place_of_worship' } }] });
  const before = structuredClone(input), renderer = createDetailRenderer(input), features = renderer.getFeatures();
  assert.equal(features.length, 1);
  const building = features[0];
  assert.equal(building.layer, 'buildings');
  assert.equal(building.typeId, 'building.religious');
  assert(building.gameplayAssignment);
  assert.equal(building.gameplayAssignment.roleOrigin, 'mapped');
  assert.deepEqual(building.rings, [outer, inner]);
  assert.equal(renderer.pick(60, 60).layer, 'buildings');
  assert.equal(renderer.pick(100, 100, 0), null, 'Courtyard remains empty');
  assert.deepEqual(renderer.zonesAt(60, 60), []);
  renderer.setLayers({ buildings: false });
  assert.equal(renderer.pick(60, 60), null);
  assert.deepEqual(input, before);
});

test('institution grounds and markers inform building roles but never become extra city biomes', () => {
  const input = world({ buildings: [{ id: 'clinic-house', points: ring(70, 70, 120, 120), tags: { building: 'yes' } }], details: [
    { id: 'campus', geometry: 'polygon', points: ring(50, 50, 180, 180), tags: { amenity: 'hospital' } },
    { id: 'clinic-point', geometry: 'point', points: [{ x: 90, y: 90 }], tags: { amenity: 'clinic' }, kind: 'clinic' },
    { id: 'park', geometry: 'polygon', points: ring(200, 30, 350, 200), tags: { leisure: 'park' } },
  ] });
  const renderer = createDetailRenderer(input), building = renderer.pick(90, 90, 0);
  assert.equal(building.layer, 'buildings');
  assert.equal(building.gameplayAssignment.roleOrigin, 'mapped');
  assert.equal(building.gameplayAssignment.categoryId, 'category.medical');
  assert.equal(building.typeId, 'building.unknown', 'Mapped point informs gameplay role without editing original building facts');
  assert.deepEqual(renderer.zonesAt(90, 90), []);
  assert.deepEqual(renderer.zonesAt(250, 100).map(zone => zone.biome), ['park']);
  assert(!renderer.getFeatures().some(feature => ['campus', 'clinic-point'].includes(feature.id)));
});

test('separate natural parts retain measured footprints without duplicating their common source membership', () => {
  const renderer = createDetailRenderer(world({ details: [
    { id: 'relation-1000-0', sourceId: 'relation-1000', geometry: 'polygon', points: ring(50, 50, 200, 200), tags: { natural: 'grassland' } },
    { id: 'relation-1000-1', sourceId: 'relation-1000', geometry: 'polygon', points: ring(100, 100, 250, 250), tags: { natural: 'grassland' } },
  ] }));
  assert.equal(renderer.getFeatures().length, 2, 'Native nature is not inflated by gameplay corridors');
  assert.equal(renderer.zonesAt(150, 150).length, 1);
  assert.deepEqual(renderer.zonesAt(150, 150)[0].sourceIds, ['relation-1000']);
});

test('administrative boundaries disappear from draw registry, selection and biome membership', () => {
  const outer = ring(20, 20, 380, 280), inner = ring(120, 100, 180, 180);
  const boundary = { id: 'relation-42', geometry: 'polygon', name: 'Beatty', points: outer, rings: [outer, inner], tags: { boundary: 'census', name: 'Beatty' } };
  const input = world({ details: [boundary,
    { id: 'residential', geometry: 'polygon', points: ring(200, 200, 300, 250), tags: { landuse: 'residential' } },
  ] });
  const before = structuredClone(input), renderer = createDetailRenderer(input);
  assert.deepEqual(renderer.getFeatures(), []);
  for (const point of [[20, 150], [70, 60], [250, 150]]) assert.equal(renderer.pick(...point, 0), null);
  assert.deepEqual(renderer.zonesAt(250, 150), []);
  assert.equal(renderer.pick(250, 220, 0), null);
  assert.deepEqual(renderer.zonesAt(250, 220), []);
  assert.deepEqual(input, before, 'Administrative source data is retained for future imports');
});

test('removed administrative polygons cannot reappear through source boundary paths or map-frame closure', () => {
  const input = world({ details: [
    { id: 'town', geometry: 'polygon', points: ring(0, 0, 400, 300), boundaryPaths: [
      [{ x: 30, y: 50 }, { x: 150, y: 50 }], [{ x: 250, y: 200 }, { x: 350, y: 200 }],
    ], tags: { boundary: 'census' } },
    { id: 'enclosing-town', geometry: 'polygon', points: ring(0, 0, 400, 300), boundaryPaths: [], tags: { boundary: 'administrative' } },
  ] });
  const before = structuredClone(input), renderer = createDetailRenderer(input);
  assert.equal(renderer.getFeatures().length, 0);
  for (const point of [[100, 50], [300, 200], [200, 0], [200, 125]]) assert.equal(renderer.pick(...point, 0), null);
  assert.deepEqual(renderer.zonesAt(100, 50), []);
  assert.deepEqual(input, before);
});

test('presentation hides crossing marks, every barrier geometry and power supports without editing their source', () => {
  const details = [
    { id: 'crossing', geometry: 'point', points: [{ x: 20, y: 50 }], tags: { highway: 'crossing' } },
    { id: 'crossing-line', geometry: 'line', points: [{ x: 20, y: 70 }, { x: 80, y: 70 }], tags: { footway: 'crossing' } },
    { id: 'fence', geometry: 'line', points: [{ x: 20, y: 90 }, { x: 80, y: 90 }], tags: { barrier: 'fence' } },
    { id: 'wall', geometry: 'polygon', points: ring(20, 110, 80, 130), tags: { barrier: 'wall' } },
    { id: 'gate', geometry: 'point', points: [{ x: 20, y: 150 }], kind: 'gate', tags: { barrier: 'gate' } },
    { id: 'cattle-grid', geometry: 'point', points: [{ x: 20, y: 170 }], kind: 'cattle_grid', tags: { barrier: 'cattle_grid' } },
    { id: 'pole', geometry: 'point', points: [{ x: 20, y: 190 }], tags: { power: 'pole' } },
    { id: 'tower', geometry: 'point', points: [{ x: 20, y: 210 }], tags: { power: 'tower' } },
    { id: 'bench', geometry: 'point', points: [{ x: 250, y: 150 }], kind: 'bench', tags: { amenity: 'bench' } },
  ];
  const input = world({ details }), before = structuredClone(input), renderer = createDetailRenderer(input);
  assert.deepEqual(renderer.getFeatures().map(feature => feature.id), ['bench']);
  for (const [x, y] of [[20, 50], [50, 70], [50, 90], [50, 120], [20, 150], [20, 170], [20, 190], [20, 210]]) assert.equal(renderer.pick(x, y, 0), null);
  assert.equal(renderer.getStats().filteredFeatures, 8);
  assert.equal(renderer.getStats().inputFeatures, 9);
  assert.deepEqual(input, before);
});

test('joined roads coalesce former-rail facets first and expose every source through one selection', () => {
  const tags = { highway: 'track', railway: 'abandoned', surface: 'dirt' };
  const input = world({ roads: [
    { id: 'way-10-0', points: [{ x: 20, y: 50 }, { x: 150, y: 50 }], type: 'track', tags },
    { id: 'way-20-0', points: [{ x: 150, y: 50 }, { x: 350, y: 50 }], type: 'track', tags },
  ] });
  input.details = input.roads.map(road => ({ ...road, kind: 'railway', geometry: 'line' }));
  const before = structuredClone(input), renderer = createDetailRenderer(input), features = renderer.getFeatures();
  assert.equal(features.length, 1);
  assert.equal(features[0].roadClass, 'track');
  assert.equal(features[0].merged, true);
  assert.deepEqual(features[0].sourceIds.sort(), ['way-10', 'way-20']);
  const first = renderer.pick(60, 50, 0), last = renderer.pick(300, 50, 0);
  assert.equal(first.key, last.key);
  assert.deepEqual(first.memberIds.sort(), ['way-10-0', 'way-20-0']);
  assert(first.source.members.every(member => member.tags.railway === 'abandoned'));
  assert.equal(renderer.getStats().coalescedFeatures, 2);
  assert.equal(renderer.getStats().sourceRoads, 2);
  assert.equal(renderer.getStats().displayRoads, 1);
  renderer.setRoadClasses({ track: false });
  assert.equal(renderer.getFeatures()[0].enabled, false);
  assert.equal(renderer.pick(60, 50, 0), null);
  renderer.setLayers({ roads: false });
  renderer.setRoadClasses({ track: true });
  assert.equal(renderer.pick(60, 50, 0), null, 'The master road switch still applies');
  renderer.setLayers({ roads: true });
  assert.equal(renderer.pick(60, 50, 0).key, first.key);
  assert.deepEqual(input, before, 'Display joining cannot modify roads used by navigation');
});


test('water branches and matching touching lake parts form whole selectable objects while dry channels stay separate', () => {
  const renderer = createDetailRenderer(world({ rivers: [
    { id: 'river-main', points: [{ x: 20, y: 50 }, { x: 200, y: 50 }, { x: 380, y: 50 }], tags: { waterway: 'stream' }, width: 3 },
    { id: 'river-branch', points: [{ x: 200, y: 50 }, { x: 200, y: 120 }], tags: { waterway: 'stream' }, width: 3 },
    { id: 'dry-branch', points: [{ x: 200, y: 50 }, { x: 300, y: 120 }], tags: { waterway: 'stream', intermittent: 'yes' }, width: 3 },
  ], details: [
    { id: 'lake-west', geometry: 'polygon', rings: [ring(20, 160, 140, 280), ring(40, 180, 60, 200)], tags: { natural: 'water', water: 'lake' } },
    { id: 'lake-east', geometry: 'polygon', points: ring(100, 160, 230, 280), tags: { natural: 'water', water: 'lake' } },
    { id: 'separate-pond', geometry: 'polygon', points: ring(230, 160, 350, 280), tags: { natural: 'water', water: 'pond' } },
  ] }));
  const main = renderer.pick(100, 50, 0), branch = renderer.pick(200, 90, 0);
  assert.equal(main.key, branch.key);
  assert.equal(main.paths.length, 2);
  assert.deepEqual(main.memberIds.sort(), ['river-branch', 'river-main']);
  assert.notEqual(renderer.pick(250, 85, 0).key, main.key, 'Dryness is a semantic boundary');
  const west = renderer.pick(80, 240, 0), overlap = renderer.pick(120, 240, 0), east = renderer.pick(180, 240, 0);
  assert.equal(west.key, overlap.key);
  assert.equal(west.key, east.key);
  assert.equal(west.parts.length, 2);
  assert.equal(renderer.pick(50, 190, 0), null, 'A source island remains a hole');
  assert.notEqual(renderer.pick(280, 240, 0).key, west.key, 'A different kind of water remains a separate object');
  renderer.setLayers({ water: false });
  assert.equal(renderer.pick(100, 50, 0), null);
  assert.equal(renderer.pick(180, 240, 0), null);
});

test('retired urban grounds cannot leave their old gameplay corridors in the map registry', () => {
  const input = world({ details: [
    { id: 'west', geometry: 'polygon', points: ring(20, 20, 100, 100), tags: { landuse: 'residential' } },
    { id: 'east', geometry: 'polygon', points: ring(120, 20, 200, 100), tags: { landuse: 'residential' } },
    { id: 'clinic', geometry: 'polygon', points: ring(50, 50, 90, 90), tags: { amenity: 'clinic' } },
    { id: 'garden', geometry: 'polygon', points: ring(250, 40, 350, 150), tags: { leisure: 'garden' } },
  ] });
  const renderer = createDetailRenderer(input);
  assert.equal(renderer.pick(110, 70, 0), null);
  assert.deepEqual(renderer.zonesAt(60, 60), []);
  assert.deepEqual(renderer.zonesAt(300, 100).map(zone => zone.biome), ['garden']);
  assert.equal(renderer.getStats().zoneMerging.addedCorridors, 0);
});

test('geographic empty land receives a named fallback biome while mapped zones and permanent water override it', () => {
  const input = world({ geographic: true, details: [
    { id: 'grass', geometry: 'polygon', points: ring(20, 20, 80, 80), tags: { natural: 'grassland' } },
    { id: 'lake', geometry: 'polygon', points: ring(150, 150, 250, 250), tags: { natural: 'water', water: 'lake' } },
  ] });
  const before = structuredClone(input), renderer = createDetailRenderer(input);
  const empty = renderer.zonesAt(350, 250);
  assert.deepEqual(empty.map(zone => zone.biome), ['wasteland']);
  assert.equal(empty[0].derived, true);
  assert.equal(empty[0].typeId, 'biome.wasteland');
  assert.deepEqual(empty[0].sourceIds, []);
  assert.deepEqual(renderer.zonesAt(50, 50).map(zone => zone.biome), ['grassland']);
  assert.deepEqual(renderer.zonesAt(200, 200), [], 'Permanent water is not unzoned ground');
  renderer.setLayers({ landscape: false });
  assert.deepEqual(renderer.zonesAt(350, 250).map(zone => zone.biome), ['wasteland']);
  assert.equal(renderer.pick(350, 250), null);
  assert.deepEqual(input, before);
});

test('imported city fillers and service zoning retire while every building keeps an explicit gameplay role', () => {
  const city = (id, biome) => ({ id, type: biome, kind: biome, biome, derived: true, urbanFiller: true, geometry: 'polygon', points: ring(0, 0, 400, 300), provenance: { method: 'test-density-contour' } });
  const input = world({ areas: [city('suburb', 'suburb'), city('urban', 'urban'), city('dense', 'dense')], buildings: [
    { id: 'home', points: ring(20, 20, 60, 60), tags: { building: 'yes' } },
    { id: 'school', points: ring(100, 100, 200, 200), tags: { building: 'school', amenity: 'school' } },
  ], details: [
    { id: 'retail-zone', geometry: 'polygon', points: ring(80, 80, 220, 220), tags: { landuse: 'retail' } },
    { id: 'school-ground', geometry: 'polygon', points: ring(80, 80, 220, 220), tags: { amenity: 'school' } },
    { id: 'sand', geometry: 'polygon', points: ring(250, 30, 380, 250), tags: { natural: 'sand' } },
  ] });
  const before = structuredClone(input), renderer = createDetailRenderer(input), features = renderer.getFeatures();
  assert(!features.some(feature => feature.urbanFiller || ['suburb', 'urban', 'dense', 'retail', 'education'].includes(feature.biome)));
  assert.equal(features.filter(feature => feature.layer === 'buildings').length, 2);
  assert(features.filter(feature => feature.layer === 'buildings').every(feature => feature.roleId && feature.roleName && feature.color));
  assert.deepEqual(renderer.zonesAt(40, 40), []);
  assert.deepEqual(renderer.zonesAt(150, 150), []);
  assert.deepEqual(renderer.zonesAt(300, 100).map(zone => zone.biome), ['sand']);
  assert.equal(renderer.getStats().urbanFillerClipping.inputFeatures, 0);
  assert.deepEqual(input, before);
});

test('airport and apron retain physical measured surfaces instead of urban biome membership', () => {
  const renderer = createDetailRenderer(world({ details: [
    { id: 'airport', geometry: 'polygon', points: ring(10, 10, 390, 290), tags: { aeroway: 'aerodrome' }, kind: 'aerodrome' },
    { id: 'apron', geometry: 'polygon', points: ring(40, 40, 180, 160), tags: { aeroway: 'apron' }, kind: 'apron' },
  ] }));
  assert.deepEqual(renderer.zonesAt(100, 100), []);
  assert.equal(renderer.pick(100, 100, 0).layer, 'details');
  assert.equal(renderer.getFeatures().filter(feature => feature.layer === 'details').length, 2);
  renderer.setLayers({ landscape: false });
  assert.equal(renderer.pick(100, 100, 0).layer, 'details');
  renderer.setLayers({ details: false });
  assert.equal(renderer.pick(100, 100, 0), null);
});
