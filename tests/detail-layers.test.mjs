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
      { id: 'zone', geometry: 'polygon', points: ring(0, 0, 400, 300), tags: { landuse: 'residential' }, kind: 'residential' },
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
  assert.equal(renderer.pick(300, 200).biome, 'residential');
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

test('overlapping service and land-use polygons retain every biome independently of visibility', () => {
  const parking = ring(100, 50, 300, 250), hole = ring(150, 100, 250, 200);
  const renderer = createDetailRenderer(world({ details: [
    { id: 'way-100', sourceId: 'way-100', geometry: 'polygon', points: ring(0, 0, 400, 300), tags: { landuse: 'residential' } },
    { id: 'way-200', sourceId: 'way-200', geometry: 'polygon', points: parking, rings: [parking, hole], tags: { amenity: 'parking' } },
    { id: 'way-300', sourceId: 'way-300', name: 'Campus', geometry: 'polygon', points: ring(50, 20, 350, 270), tags: { amenity: 'school' } },
  ] }));
  const memberships = point => renderer.zonesAt(...point).map(zone => zone.biome).sort();
  assert.deepEqual(memberships([120, 80]), ['education', 'parking', 'residential']);
  assert.deepEqual(memberships([200, 150]), ['education', 'residential'], 'A courtyard/hole cannot grant parking membership');
  const zones = renderer.zonesAt(120, 80);
  assert.equal(zones.find(zone => zone.biome === 'education').name, 'Campus');
  assert.equal(zones.find(zone => zone.biome === 'education').biomeName, 'Образовательная зона');
  renderer.setLayers({ landscape: false });
  assert.equal(renderer.pick(120, 80), null);
  assert.deepEqual(memberships([120, 80]), ['education', 'parking', 'residential'], 'Hiding a layer cannot change physical biome membership');
  zones[0].name = 'Changed by caller';
  assert.notEqual(renderer.zonesAt(120, 80)[0].name, 'Changed by caller');
  for (const point of [[-1, 10], [401, 10], [NaN, 10], [10, Infinity]]) assert.deepEqual(renderer.zonesAt(...point), []);
});

test('institution buildings retain native geometry and gain only an exact measured zone footprint', () => {
  const outer = ring(50, 50, 150, 150), inner = ring(80, 80, 120, 120);
  const input = world({ buildings: [{ id: 'way-700', sourceId: 'way-700', name: 'Mapped church', points: outer, rings: [outer, inner], type: 'church', tags: { building: 'church', amenity: 'place_of_worship' } }] });
  const before = structuredClone(input), renderer = createDetailRenderer(input);
  const features = renderer.getFeatures(), building = features.find(feature => feature.group === 'building'), zone = features.find(feature => feature.group === 'zone');
  assert.equal(features.length, 2);
  assert.equal(building.layer, 'buildings');
  assert.equal(zone.layer, 'landscape');
  assert.equal(zone.biome, 'religious');
  assert.equal(zone.sourceId, building.sourceId);
  assert.equal(zone.footprintOnly, true);
  assert.deepEqual(zone.rings, building.rings);
  assert.notEqual(zone.key, building.key);
  assert.equal(renderer.pick(60, 60).layer, 'buildings');
  assert.deepEqual(renderer.zonesAt(60, 60).map(item => item.biome), ['religious']);
  assert.deepEqual(renderer.zonesAt(100, 100), [], 'The building courtyard is not part of its footprint zone');
  renderer.setLayers({ buildings: false });
  assert.equal(renderer.pick(60, 60).layer, 'landscape');
  renderer.setLayers({ landscape: false });
  assert.equal(renderer.pick(60, 60), null);
  assert.deepEqual(renderer.zonesAt(60, 60).map(item => item.biome), ['religious']);
  assert.deepEqual(input, before);
});

test('mapped institution grounds avoid a redundant building zone and point markers never acquire invented extent', () => {
  const renderer = createDetailRenderer(world({
    buildings: [{ id: 'way-800', points: ring(70, 70, 120, 120), type: 'hospital', tags: { building: 'hospital', amenity: 'hospital' } }],
    details: [
      { id: 'way-801', geometry: 'polygon', points: ring(50, 50, 180, 180), tags: { amenity: 'hospital' } },
      { id: 'node-900', geometry: 'point', points: [{ x: 250, y: 100 }], tags: { amenity: 'clinic' }, kind: 'clinic' },
    ],
  }));
  assert.equal(renderer.getFeatures().filter(feature => feature.group === 'zone').length, 0, 'Measured campus already supplies its medical zone');
  assert.deepEqual(renderer.zonesAt(100, 100).map(item => item.biome), ['healthcare']);
  assert.equal(renderer.pick(250, 100).layer, 'landscape');
  assert.deepEqual(renderer.zonesAt(250, 100), [], 'An OSM clinic node provides a location, not a fabricated campus radius');
  renderer.setLayers({ landscape: false });
  assert.equal(renderer.pick(250, 100), null);

  const outline = ring(50, 50, 150, 150);
  const sameExtent = createDetailRenderer(world({
    buildings: [{ id: 'way-802', points: outline, type: 'hospital', tags: { building: 'hospital', amenity: 'hospital' } }],
    details: [{ id: 'way-803', points: [...outline].reverse(), geometry: 'polygon', tags: { amenity: 'hospital' } }],
  }));
  assert.equal(sameExtent.getFeatures().filter(feature => feature.group === 'zone').length, 0, 'An explicitly mapped zone with the same outline needs no generated twin');
});

test('multiple polygon parts from one source do not duplicate zone memberships', () => {
  const renderer = createDetailRenderer(world({ details: [
    { id: 'relation-1000-0', sourceId: 'relation-1000', geometry: 'polygon', points: ring(50, 50, 200, 200), tags: { amenity: 'parking' } },
    { id: 'relation-1000-1', sourceId: 'relation-1000', geometry: 'polygon', points: ring(100, 100, 250, 250), tags: { amenity: 'parking' } },
  ] }));
  assert.equal(renderer.getFeatures().length, 2, 'Both original polygon parts remain rendered');
  assert.equal(renderer.zonesAt(150, 150).length, 1);
  assert.equal(renderer.zonesAt(150, 150)[0].sourceId, 'relation-1000');
});

test('settlement boundaries have selectable outlines without granting city-wide biome membership', () => {
  const outer = ring(20, 20, 380, 280), inner = ring(120, 100, 180, 180);
  const boundary = { id: 'relation-42', geometry: 'polygon', name: 'Beatty', points: outer, rings: [outer, inner], tags: { boundary: 'census', name: 'Beatty' } };
  const renderer = createDetailRenderer(world({ details: [boundary,
    { id: 'residential', geometry: 'polygon', points: ring(200, 200, 300, 250), tags: { landuse: 'residential' } },
  ] }));
  const selected = renderer.pick(20, 150, 0);
  assert.equal(selected.kind, 'settlement_boundary');
  assert.equal(selected.name, 'Beatty');
  assert.equal(selected.outlineOnly, true);
  assert.equal(selected.biome, null);
  assert.equal(selected.typeId, null);
  assert.deepEqual(selected.resourceProfileIds, []);
  assert.equal(renderer.pick(70, 60, 0), null, 'Separate boundary rings cannot create a fictitious connecting edge');
  assert.equal(renderer.pick(250, 150, 0), null, 'The town interior is not a filled pick target');
  assert.deepEqual(renderer.zonesAt(250, 150), []);
  assert.equal(renderer.pick(250, 220, 0).biome, 'residential');
  assert.deepEqual(renderer.zonesAt(250, 220).map(zone => zone.biome), ['residential']);
  renderer.setLayers({ landscape: false });
  assert.equal(renderer.pick(20, 150, 0), null);
});

test('clipped settlement polygons expose only real source boundary paths and never the map frame', () => {
  const input = world({ details: [
    { id: 'town', geometry: 'polygon', points: ring(0, 0, 400, 300), boundaryPaths: [
      [{ x: 30, y: 50 }, { x: 150, y: 50 }], [{ x: 250, y: 200 }, { x: 350, y: 200 }],
    ], tags: { boundary: 'census' } },
    { id: 'enclosing-town', geometry: 'polygon', points: ring(0, 0, 400, 300), boundaryPaths: [], tags: { boundary: 'administrative' } },
  ] });
  const before = structuredClone(input), renderer = createDetailRenderer(input), [feature] = renderer.getFeatures();
  assert.equal(renderer.getFeatures().length, 1, 'A town whose true boundary is entirely outside the viewport contributes no frame outline');
  assert.equal(feature.geometry, 'line');
  assert.deepEqual(feature.bounds, { minX: 30, minY: 50, maxX: 350, maxY: 200 });
  assert.equal(feature.paths.length, 2);
  assert.equal(renderer.pick(100, 50, 0).kind, 'settlement_boundary');
  assert.equal(renderer.pick(300, 200, 0).kind, 'settlement_boundary');
  assert.equal(renderer.pick(200, 0, 0), null, 'The clipped polygon top edge is not a town boundary');
  assert.equal(renderer.pick(200, 125, 0), null, 'Disjoint clipped paths cannot create a connecting edge');
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
