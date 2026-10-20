import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailRenderer } from '../detail-renderer.js';
import { polygonIntersection } from '../polygon-geometry.js';

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
  assert.equal(renderer.getFeatures().length, 1, 'Connected parts form one selectable zone');
  assert.equal(renderer.getFeatures()[0].parts.length, 2, 'Both source footprints remain in the union');
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
  assert.deepEqual(renderer.getFeatures().map(feature => feature.id), ['residential']);
  for (const point of [[20, 150], [70, 60], [250, 150]]) assert.equal(renderer.pick(...point, 0), null);
  assert.deepEqual(renderer.zonesAt(250, 150), []);
  assert.equal(renderer.pick(250, 220, 0).biome, 'residential');
  assert.deepEqual(renderer.zonesAt(250, 220).map(zone => zone.biome), ['residential']);
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

test('nearby functional zones share a small game corridor without erasing overlapping service biomes', () => {
  const renderer = createDetailRenderer(world({ details: [
    { id: 'west-housing', geometry: 'polygon', points: ring(20, 20, 120, 120), tags: { landuse: 'residential' } },
    { id: 'east-housing', geometry: 'polygon', points: ring(140, 20, 240, 120), tags: { landuse: 'residential' } },
    { id: 'clinic-site', geometry: 'polygon', points: ring(40, 40, 100, 100), tags: { amenity: 'clinic' } },
    { id: 'far-housing', geometry: 'polygon', points: ring(300, 20, 380, 120), tags: { landuse: 'residential' } },
  ] }));
  const west = renderer.pick(30, 30, 0), east = renderer.pick(230, 30, 0);
  assert.equal(west.key, east.key);
  assert.equal(west.derived, true);
  assert.equal(west.provenance.method, 'nearby-zone-fusion');
  assert(renderer.zonesAt(130, 20).some(zone => zone.biome === 'residential'), 'The short gap has an explicit derived connecting corridor');
  assert.deepEqual(renderer.zonesAt(60, 60).map(zone => zone.biome).sort(), ['healthcare', 'residential']);
  assert.notEqual(renderer.pick(350, 30, 0).key, west.key);
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

const urbanArea = (id, biome, points) => ({ id, type: biome, kind: biome, biome, derived: true, urbanFiller: true, geometry: 'polygon', points, rings: [points], provenance: { method: 'test-density-contour' } });
const urbanMembership = (renderer, x, y) => renderer.zonesAt(x, y).filter(zone => zone.urbanFiller);

test('city filler is actually cut by oblique parking, source zones, footprint sites and water with native holes left free', () => {
  const park = { id: 'park', geometry: 'polygon', rings: [ring(180, 40, 280, 140), ring(210, 70, 250, 110)], tags: { leisure: 'park' } };
  const input = world({ areas: [urbanArea('city', 'urban', ring(5, 5, 390, 290))], details: [
    { id: 'housing', geometry: 'polygon', points: ring(20, 20, 90, 80), tags: { landuse: 'residential' } },
    { id: 'retail', geometry: 'polygon', points: ring(50, 50, 110, 100), tags: { landuse: 'retail' } },
    { id: 'diagonal-parking', geometry: 'polygon', points: [{ x: 80, y: 0 }, { x: 84, y: 0 }, { x: 244, y: 280 }, { x: 240, y: 280 }, { x: 80, y: 0 }], tags: { amenity: 'parking' } },
    park,
    { id: 'power-site', geometry: 'polygon', points: ring(250, 220, 280, 250), tags: { power: 'substation' } },
    { id: 'lake', geometry: 'polygon', points: ring(20, 220, 50, 250), tags: { natural: 'water' } },
  ], buildings: [{ id: 'clinic', points: ring(320, 180, 350, 210), tags: { building: 'yes', amenity: 'clinic' } }], rivers: [
    { id: 'wet-stream', points: [{ x: 100, y: 200 }, { x: 160, y: 200 }], width: 4, tags: { waterway: 'stream' } },
  ] });
  const before = structuredClone(input), renderer = createDetailRenderer(input), features = renderer.getFeatures();
  const urban = features.filter(feature => feature.urbanFiller);
  assert.equal(urban.length, 1);
  const occupied = features.filter(feature => feature.geometry === 'polygon' && !feature.urbanFiller && !feature.fallback).flatMap(feature => feature.parts);
  assert.deepEqual(polygonIntersection(urban.flatMap(feature => feature.parts), occupied), [], 'The registered geometry, not only drawing order, excludes occupied land');
  for (const [x, y] of [[60, 60], [139, 100], [190, 90], [265, 235], [35, 235], [335, 195], [130, 200]]) assert.deepEqual(urbanMembership(renderer, x, y), [], `Occupied point ${x},${y} must not inherit urban resources`);
  assert.deepEqual(renderer.zonesAt(60, 60).map(zone => zone.biome).sort(), ['residential', 'retail'], 'Original mapped zone overlaps are still allowed');
  assert.equal(urbanMembership(renderer, 225, 90).length, 1, 'An actual park hole is available for city filler');
  assert.equal(urbanMembership(renderer, 150, 150).length, 1, 'Unzoned city space remains filled');
  assert.equal(renderer.pick(150, 150, 0).id, 'city');
  assert.equal(renderer.pick(139, 100, 0).biome, 'parking');
  assert.equal(urban[0].provenance.method, 'test-density-contour');
  assert.equal(urban[0].provenance.fillOnlyUnzoned, true);
  const memberships = renderer.zonesAt(225, 90);
  renderer.setLayers({ landscape: false, water: false, power: false, buildings: false });
  assert.deepEqual(renderer.zonesAt(225, 90), memberships, 'Hidden zones still reserve their space');
  assert.deepEqual(urbanMembership(renderer, 139, 100), []);
  assert.deepEqual(input, before, 'Clipping cannot mutate imported geometry');
});

test('city filler is subtracted after functional zone fusion so the added corridor cannot paint it back', () => {
  const renderer = createDetailRenderer(world({ areas: [urbanArea('city', 'suburb', ring(0, 0, 400, 300))], details: [
    { id: 'west', geometry: 'polygon', points: ring(20, 20, 100, 100), tags: { landuse: 'residential' } },
    { id: 'east', geometry: 'polygon', points: ring(120, 20, 200, 100), tags: { landuse: 'residential' } },
  ] }));
  assert.deepEqual(renderer.zonesAt(110, 70).map(zone => zone.biome), ['residential']);
  assert.deepEqual(urbanMembership(renderer, 110, 70), []);
  assert.equal(urbanMembership(renderer, 110, 140).length, 1);
  const filler = renderer.getFeatures().find(feature => feature.urbanFiller);
  const housing = renderer.getFeatures().find(feature => feature.biome === 'residential');
  assert.deepEqual(polygonIntersection(filler.parts, housing.parts), []);
  assert.equal(filler.provenance.exclusionStage, 'after-zone-fusion');
  assert(renderer.getStats().urbanFillerClipping.afterArea < renderer.getStats().urbanFillerClipping.beforeArea);
});

test('urban density classes remain exclusive and fully occupied filler records disappear from selection', () => {
  const renderer = createDetailRenderer(world({ areas: [
    urbanArea('suburb', 'suburb', ring(10, 10, 390, 290)),
    urbanArea('urban', 'urban', ring(100, 100, 300, 260)),
    urbanArea('dense', 'dense', ring(160, 160, 240, 230)),
    urbanArea('occupied-city', 'urban', ring(20, 20, 60, 60)),
  ], details: [{ id: 'native-plot', geometry: 'polygon', points: ring(15, 15, 65, 65), tags: { landuse: 'commercial' } }] }));
  assert.deepEqual(urbanMembership(renderer, 200, 200).map(zone => zone.biome), ['dense']);
  assert.deepEqual(urbanMembership(renderer, 120, 120).map(zone => zone.biome), ['urban']);
  assert.deepEqual(urbanMembership(renderer, 350, 250).map(zone => zone.biome), ['suburb']);
  assert.deepEqual(urbanMembership(renderer, 40, 40), []);
  assert(!renderer.getFeatures().some(feature => feature.id === 'occupied-city'));
  assert.equal(renderer.getStats().urbanFillerClipping.removedFeatures, 1);
});
