import test from 'node:test';
import assert from 'node:assert/strict';
import { mapFeatureLayer, mapBiome, mapZoneBiome } from '../map-layers.js';
import nevadaMap from '../maps/usa.js';

const feature = (tags, geometry = 'polygon', extra = {}) => ({ tags, geometry, ...extra });

test('road surfaces and all facets of a road follow the roads layer', () => {
  for (const highway of ['residential', 'service', 'track', 'footway', 'path', 'cycleway', 'pedestrian', 'steps']) {
    for (const geometry of ['line', 'polygon']) {
      assert.equal(mapFeatureLayer(feature({ highway }, geometry), 'detail'), 'roads', `${highway} ${geometry}`);
    }
  }
  assert.equal(mapFeatureLayer(feature({ 'area:highway': 'pedestrian' }), 'detail'), 'roads');
  assert.equal(mapFeatureLayer(feature({ highway: 'track', railway: 'abandoned' }, 'line', { kind: 'railway' }), 'detail'), 'roads', 'A former railway used as a track must disappear with the other road facets');
  assert.equal(mapFeatureLayer(feature({ highway: 'street_lamp' }, 'point', { kind: 'lamp' }), 'detail'), 'details');
  assert.equal(mapFeatureLayer(feature({ highway: 'traffic_signals' }, 'point'), 'detail'), 'details');
});

test('natural features and land-use zones belong to landscape without swallowing buildings', () => {
  for (const natural of ['wood', 'scrub', 'heath', 'grassland', 'sand', 'bare_rock', 'wetland', 'tree', 'peak', 'cliff']) {
    const geometry = ['tree', 'peak'].includes(natural) ? 'point' : natural === 'cliff' ? 'line' : 'polygon';
    assert.equal(mapFeatureLayer(feature({ natural }, geometry), 'detail'), 'landscape', natural);
  }
  for (const landuse of ['residential', 'industrial', 'commercial', 'retail', 'forest', 'farmland', 'meadow', 'orchard', 'cemetery', 'quarry', 'construction', 'brownfield']) {
    assert.equal(mapFeatureLayer(feature({ landuse }), 'detail'), 'landscape', landuse);
  }
  for (const leisure of ['park', 'garden', 'pitch', 'playground', 'recreation_ground', 'nature_reserve']) {
    assert.equal(mapFeatureLayer(feature({ leisure }), 'detail'), 'landscape', leisure);
  }
  assert.equal(mapFeatureLayer(feature({ landuse: 'residential', building: 'apartments' }), 'building'), 'buildings');
  assert.equal(mapFeatureLayer(feature({ building: 'warehouse', landuse: 'industrial' }), 'detail'), 'buildings');
});

test('water bodies and channels have an independent layer while wetland remains a biome', () => {
  for (const tags of [
    { natural: 'water', water: 'lake' }, { water: 'pond' },
    { landuse: 'reservoir' }, { landuse: 'basin' }, { waterway: 'riverbank' },
    { leisure: 'swimming_pool' }, { amenity: 'swimming_pool' },
  ]) assert.equal(mapFeatureLayer(feature(tags), 'detail'), 'water', JSON.stringify(tags));
  for (const waterway of ['river', 'stream', 'canal', 'drain', 'ditch']) {
    assert.equal(mapFeatureLayer(feature({ waterway }, 'line'), 'detail'), 'water', waterway);
    assert.equal(mapFeatureLayer(feature({ waterway, intermittent: 'yes', seasonal: 'yes' }, 'line', { intermittent: true, seasonal: true }), 'river'), 'water', 'Visibility categorization must not recategorize a dry wash as land');
  }
  assert.equal(mapFeatureLayer(feature({ natural: 'wetland', wetland: 'marsh' }), 'area'), 'landscape');
  for (const tags of [{ amenity: 'fountain' }, { amenity: 'drinking_water' }, { man_made: 'water_well' }]) {
    assert.equal(mapFeatureLayer(feature(tags, 'point'), 'detail'), 'details', 'A water-related fixture is not a water body');
  }
});

test('source-free procedural geometry and markers use the same semantic layer contract', () => {
  for (const [group, expected] of [['road', 'roads'], ['building', 'buildings'], ['river', 'water'], ['lake', 'water']]) {
    assert.equal(mapFeatureLayer({}, group), expected, group);
  }
  for (const type of ['forest', 'plain', 'swamp']) assert.equal(mapFeatureLayer({ type }, 'area'), 'landscape');
  assert.equal(mapFeatureLayer({ type: 'water' }, 'area'), 'water');
  assert.equal(mapFeatureLayer({ kind: 'tree', tags: { natural: 'tree' }, x: 10, y: 20 }, 'poi'), 'landscape');
  assert.equal(mapFeatureLayer({ kind: 'town', tags: { building: 'retail', shop: 'convenience' }, x: 10, y: 20 }, 'poi'), 'landscape', 'The service marker follows its zone while the physical shop building remains in buildings');
  assert.equal(mapFeatureLayer({ tags: { landuse: 'residential' }, x: 10, y: 20 }, 'poi'), 'landscape');
  assert.equal(mapFeatureLayer({ kind: 'camp', tags: { amenity: 'shelter' }, x: 10, y: 20 }, 'poi'), 'details');
  assert.equal(mapFeatureLayer({ kind: 'bench', tags: { amenity: 'bench' }, geometry: 'point' }, 'detail'), 'details');
});

test('parking and institutional grounds become functional zones rather than miscellaneous objects', () => {
  const cases = [
    [{ amenity: 'parking' }, 'parking'], [{ amenity: 'parking_space' }, 'parking'],
    [{ amenity: 'place_of_worship', religion: 'christian' }, 'religious'],
    [{ amenity: 'hospital' }, 'healthcare'], [{ amenity: 'clinic' }, 'healthcare'],
    [{ healthcare: 'dentist' }, 'healthcare'], [{ amenity: 'pharmacy' }, 'healthcare'],
    [{ amenity: 'school' }, 'education'], [{ amenity: 'college' }, 'education'],
    [{ amenity: 'kindergarten' }, 'education'], [{ amenity: 'library' }, 'education'],
    [{ amenity: 'courthouse' }, 'civic'], [{ amenity: 'townhall' }, 'civic'],
    [{ amenity: 'community_centre' }, 'civic'], [{ amenity: 'post_office' }, 'civic'],
    [{ amenity: 'police' }, 'emergency'], [{ amenity: 'fire_station' }, 'emergency'],
    [{ amenity: 'fuel' }, 'service'], [{ amenity: 'car_wash' }, 'service'],
    [{ amenity: 'restaurant' }, 'food_service'], [{ shop: 'confectionery' }, 'retail'],
    [{ aeroway: 'aerodrome' }, 'transport'], [{ aeroway: 'apron' }, 'transport'],
    [{ aeroway: 'helipad' }, 'transport'], [{ tourism: 'motel' }, 'accommodation'],
    [{ tourism: 'camp_site' }, 'camping'], [{ tourism: 'caravan_site' }, 'camping'],
    [{ tourism: 'museum' }, 'heritage'], [{ historic: 'ruins' }, 'heritage'],
    [{ amenity: 'waste_transfer_station' }, 'utilities'], [{ power: 'substation' }, 'utilities'],
  ];
  for (const [tags, expected] of cases) {
    const item = feature(tags);
    assert.equal(mapZoneBiome(item), expected, JSON.stringify(tags));
    assert.equal(mapFeatureLayer(item, 'detail'), 'landscape', JSON.stringify(tags));
    assert.equal(mapBiome(item), expected, JSON.stringify(tags));
  }
});

test('an institution retains its building and can also identify an exact-footprint zone', () => {
  const points = [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }, { x: 10, y: 10 }];
  const church = { id: 'church', tags: { building: 'church', amenity: 'place_of_worship' }, points, rings: [points] };
  const before = structuredClone(church);
  assert.equal(mapFeatureLayer(church, 'building'), 'buildings');
  assert.equal(mapZoneBiome(church), 'religious');
  assert.deepEqual(church, before, 'Identifying a zone must not enlarge, replace or mutate its source footprint');
  assert.equal(mapFeatureLayer({ ...church, x: 15, y: 15 }, 'poi'), 'landscape', 'The related institution label follows the zone');
  assert.equal(mapFeatureLayer({ tags: church.tags, geometry: 'point', points: [{ x: 15, y: 15 }] }, 'detail'), 'landscape', 'A node-only institution remains a point in the zone layer');
  const hospital = feature({ amenity: 'hospital', landuse: 'residential' });
  assert.equal(mapBiome(hospital), 'healthcare', 'The specific medical use must not disappear beneath a generic land-use tag');
  assert.equal(mapBiome(feature({ landuse: 'residential' })), 'residential', 'A separately mapped overlapping residential zone keeps its own role');
});

test('zone classification never fabricates an extent for source points or consumes small fixtures', () => {
  const point = { id: 'node-clinic', geometry: 'point', points: [{ x: 12, y: 23 }], tags: { amenity: 'clinic' } };
  const before = structuredClone(point);
  assert.equal(mapFeatureLayer(point, 'detail'), 'landscape');
  assert.equal(mapZoneBiome(point), 'healthcare');
  assert.deepEqual(point, before);
  for (const tags of [
    { amenity: 'bench' }, { amenity: 'atm' }, { amenity: 'toilets' }, { amenity: 'charging_station' },
    { amenity: 'waste_disposal' }, { barrier: 'gate' }, { power: 'pole' }, { power: 'tower' },
    { aeroway: 'windsock' }, { aeroway: 'parking_position' }, { tourism: 'artwork' },
  ]) {
    const fixture = feature(tags, 'point');
    assert.equal(mapZoneBiome(fixture), null, JSON.stringify(tags));
    assert.equal(mapFeatureLayer(fixture, 'detail'), 'details', JSON.stringify(tags));
  }
  for (const aeroway of ['runway', 'taxiway', 'taxilane', 'holding_position']) {
    assert.equal(mapFeatureLayer(feature({ aeroway }, 'line'), 'detail'), 'details', 'An airport zone does not absorb each runway and taxiway');
  }
});

test('specific physical road and water roles retain precedence over service zones', () => {
  assert.equal(mapFeatureLayer(feature({ highway: 'pedestrian', amenity: 'parking' }), 'detail'), 'roads');
  assert.equal(mapFeatureLayer(feature({ natural: 'water', amenity: 'parking' }), 'detail'), 'water');
  assert.equal(mapFeatureLayer(feature({ leisure: 'hot_tub' }), 'detail'), 'water');
  assert.equal(mapFeatureLayer(feature({ man_made: 'tailings_pond' }), 'detail'), 'water');
});

test('biome styling distinguishes urban use, forest, wetland and open countryside', () => {
  const fixtures = [
    [{ landuse: 'residential' }, 'residential'], [{ landuse: 'industrial' }, 'industrial'],
    [{ natural: 'wood' }, 'forest'], [{ landuse: 'forest' }, 'forest'],
    [{ natural: 'wetland', wetland: 'marsh' }, 'wetland'],
    [{ natural: 'grassland' }, 'grassland'], [{ landuse: 'farmland' }, 'farmland'],
  ];
  for (const [tags, expected] of fixtures) assert.equal(mapBiome(feature(tags)), expected);
  assert.notEqual(mapBiome(feature({ landuse: 'residential' })), mapBiome(feature({ landuse: 'industrial' })), 'Different zone semantics must not collapse to the same generic polygon style');
});

test('fresh Nevada geometry is fully categorized and former railway road facets stay together', () => {
  const before = JSON.stringify(nevadaMap);
  const valid = new Set(['roads', 'water', 'landscape', 'buildings', 'details']);
  const groups = { roads: 'road', rivers: 'river', areas: 'area', buildings: 'building', details: 'detail' };
  for (const [collection, group] of Object.entries(groups)) {
    for (const item of nevadaMap[collection]) assert(valid.has(mapFeatureLayer(item, group)), `Uncategorized ${collection} ${item.id}`);
  }
  assert(nevadaMap.buildings.every(item => mapFeatureLayer(item, 'building') === 'buildings'));
  assert(nevadaMap.roads.every(item => mapFeatureLayer(item, 'road') === 'roads'));
  assert(nevadaMap.rivers.every(item => mapFeatureLayer(item, 'river') === 'water'));
  const roadIds = new Set(nevadaMap.roads.map(item => item.sourceId));
  const sharedRailFacets = nevadaMap.details.filter(item => item.tags?.highway && item.tags?.railway && roadIds.has(item.sourceId));
  assert(sharedRailFacets.length > 0, 'The real extract must exercise shared road/rail geometry');
  for (const item of sharedRailFacets) assert.equal(mapFeatureLayer(item, 'detail'), 'roads', item.id);
  const zoneFacets = nevadaMap.details.filter(item => item.tags?.landuse && !['reservoir', 'basin'].includes(item.tags.landuse) && !item.tags.building && !item.tags.highway);
  assert(zoneFacets.length > 0, 'The real extract must exercise non-natural zones');
  for (const item of zoneFacets) assert.equal(mapFeatureLayer(item, 'detail'), 'landscape', item.id);
  assert.equal(JSON.stringify(nevadaMap), before, 'Layer selection must not mutate source data or navigation metadata');
});
