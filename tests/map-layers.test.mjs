import test from 'node:test';
import assert from 'node:assert/strict';
import { mapFeatureLayer, mapBiome, mapZoneBiome, shouldRenderFeature } from '../map-layers.js';
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
    [{ amenity: 'waste_transfer_station' }, 'utilities'],
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
    { amenity: 'waste_disposal' }, { barrier: 'gate' },
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

test('electrical network points, lines and facilities share an independent power layer', () => {
  const cases = [
    [{ power: 'line' }, 'line'], [{ power: 'minor_line' }, 'line'], [{ power: 'cable' }, 'line'],
    [{ power: 'pole' }, 'point'], [{ power: 'tower' }, 'point'], [{ power: 'transformer' }, 'point'],
    [{ power: 'switch' }, 'point'], [{ power: 'generator' }, 'point'],
    [{ man_made: 'utility_pole' }, 'point'], [{ power: 'substation' }, 'polygon'], [{ power: 'plant' }, 'polygon'],
  ];
  for (const [tags, geometry] of cases) {
    const item = feature(tags, geometry), before = structuredClone(item);
    assert.equal(mapFeatureLayer(item, 'detail'), 'power', JSON.stringify(tags));
    assert.deepEqual(item, before, 'Classification cannot rewrite network geometry or source tags');
    if (geometry === 'point') assert.equal(mapFeatureLayer({ ...item, x: 10, y: 20 }, 'poi'), 'power');
  }
  assert.equal(mapFeatureLayer({}, 'power'), 'power');
  assert.equal(mapFeatureLayer({ kind: 'power_pole', geometry: 'point' }, 'detail'), 'power');
  assert.equal(mapFeatureLayer({ kind: 'power_line', geometry: 'line' }, 'detail'), 'power');
  assert.equal(mapZoneBiome(feature({ power: 'substation' })), 'utilities', 'The functional zone remains available separately from physical network visibility');
  assert.equal(mapBiome(feature({ power: 'plant' })), 'utilities');
});

test('power ownership preserves buildings, water and roads while point equipment gets no fake building', () => {
  const station = feature({ building: 'service', power: 'substation' });
  assert.equal(mapFeatureLayer(station, 'building'), 'buildings');
  assert.equal(mapFeatureLayer(station, 'detail'), 'buildings');
  assert.equal(mapFeatureLayer(feature({ building: 'yes', power: 'transformer' }, 'point'), 'detail'), 'power');
  assert.equal(mapFeatureLayer(feature({ building: 'yes', power: 'substation' }, 'point'), 'poi'), 'power');
  assert.equal(mapFeatureLayer(feature({ highway: 'service', power: 'line' }, 'line'), 'detail'), 'roads');
  assert.equal(mapFeatureLayer(feature({ natural: 'water', power: 'line' }), 'detail'), 'water');
  assert.equal(mapFeatureLayer(feature({ power: 'no' }, 'point'), 'detail'), 'details');
  assert.equal(mapFeatureLayer(feature({ man_made: 'tower' }, 'point'), 'detail'), 'details', 'A radio or observation tower is not an electrical tower');
  assert.equal(mapFeatureLayer(feature({ highway: 'street_lamp' }, 'point'), 'detail'), 'details', 'A street light remains a road fixture');
});

test('census and administrative boundary geometry is a jurisdiction overlay rather than urban land use', () => {
  for (const boundary of ['census', 'administrative']) {
    for (const geometry of ['polygon', 'line']) {
      const item = feature({ boundary, name: 'Town territory' }, geometry);
      assert.equal(mapFeatureLayer(item, 'detail'), 'landscape');
      assert.equal(mapBiome(item), 'administrative');
      assert.equal(mapZoneBiome(item), null, 'A jurisdiction is not a service or residential site');
    }
  }
  assert.equal(mapFeatureLayer(feature({ boundary: 'census' }, 'point'), 'detail'), 'details', 'A bare boundary point never becomes a fabricated zone');
  assert.equal(mapFeatureLayer(feature({ boundary: 'maritime' }, 'line'), 'detail'), 'details');
  assert.equal(mapFeatureLayer(feature({ boundary: 'political' }, 'polygon'), 'detail'), 'details');
  assert.equal(mapBiome(feature({ boundary: 'census', landuse: 'residential' })), 'administrative', 'Administrative extents do not grant residential resource semantics');
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
  const valid = new Set(['roads', 'water', 'power', 'landscape', 'buildings', 'details']);
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

test('crossing and barrier fixtures are omitted without deleting source features or changing their layer', () => {
  for (const geometry of ['point', 'line', 'polygon']) {
    for (const tags of [{ highway: 'crossing' }, { crossing: 'marked' }, { 'crossing:markings': 'zebra' }, { footway: 'crossing' }]) {
      const item = feature(tags, geometry);
      assert.equal(shouldRenderFeature(item, 'detail'), false, `${geometry} ${JSON.stringify(tags)}`);
    }
    for (const barrier of ['fence', 'wall', 'gate', 'cattle_grid', 'hedge', 'bollard', 'unrecognized_barrier']) {
      const item = feature({ barrier }, geometry), before = structuredClone(item);
      assert.equal(shouldRenderFeature(item, 'detail'), false, `${geometry} ${barrier}`);
      assert.equal(mapFeatureLayer(item, 'detail'), 'details', 'Visibility is separate from source categorization');
      assert.deepEqual(item, before, 'Omitted fixtures remain unchanged in imported data');
    }
  }
  for (const kind of ['crossing', 'fence', 'wall', 'gate', 'cattle_grid', 'cycle_barrier']) {
    assert.equal(shouldRenderFeature({ kind, geometry: 'point' }, 'detail'), false, kind);
    assert.equal(shouldRenderFeature({ kind, x: 10, y: 20 }, 'poi'), false, `${kind} marker`);
  }
  for (const barrier of ['no', 'false', '0']) assert.equal(shouldRenderFeature(feature({ barrier }, 'point'), 'detail'), true, barrier);
});

test('fixture metadata cannot erase real roads, crossing footways or building footprints', () => {
  const points = [{ x: 10, y: 10 }, { x: 20, y: 20 }];
  const fixtures = [
    [feature({ highway: 'footway', footway: 'crossing', crossing: 'uncontrolled' }, 'line', { points, kind: 'crossing', sourceId: 'way/footway' }), 'road'],
    [feature({ highway: 'footway', crossing: 'marked' }, 'line', { points }), 'detail'],
    [feature({ highway: 'service', barrier: 'gate' }, 'line', { points }), 'road'],
    [feature({ highway: 'track', barrier: 'fence' }, 'line', { points }), 'detail'],
    [feature({ 'area:highway': 'pedestrian', crossing: 'marked' }), 'detail'],
    [feature({ building: 'church', barrier: 'fence' }), 'building'],
    [feature({ building: 'church', barrier: 'fence' }), 'detail'],
    [{ points, kind: 'road', tags: { barrier: 'gate' } }, 'road'],
    [{ points, tags: { barrier: 'fence' } }, 'building'],
  ];
  for (const [item, group] of fixtures) {
    const before = structuredClone(item);
    assert.equal(shouldRenderFeature(item, group), true, `${group} ${JSON.stringify(item.tags)}`);
    assert.deepEqual(item, before, 'A visibility decision cannot replace the source footprint or identity');
  }
  assert.equal(shouldRenderFeature(feature({ highway: 'crossing' }, 'point'), 'road'), false, 'A crossing node is a fixture even if passed through a road group');
  assert.equal(shouldRenderFeature(feature({ barrier: 'gate' }, 'point'), 'road'), false, 'A gate node is not the road that passes through it');
});

test('electrical strips and facilities remain while point network equipment is omitted', () => {
  for (const power of ['pole', 'tower', 'transformer', 'switch', 'generator', 'substation']) {
    const item = feature({ power }, 'point');
    assert.equal(shouldRenderFeature(item, 'detail'), false, power);
    assert.equal(mapFeatureLayer(item, 'detail'), 'power', 'Hidden electrical points still belong to their original layer');
  }
  assert.equal(shouldRenderFeature(feature({ man_made: 'utility_pole' }, 'point'), 'detail'), false);
  assert.equal(shouldRenderFeature({ kind: 'power_pole', x: 10, y: 20 }, 'poi'), false);
  assert.equal(shouldRenderFeature(feature({ building: 'yes', power: 'transformer' }, 'point'), 'detail'), false, 'Equipment nodes do not fabricate building footprints');
  for (const [power, geometry] of [['line', 'line'], ['minor_line', 'line'], ['cable', 'line'], ['substation', 'line'], ['substation', 'polygon'], ['plant', 'polygon']]) {
    assert.equal(shouldRenderFeature(feature({ power }, geometry), 'detail'), true, `${power} ${geometry}`);
  }
  assert.equal(shouldRenderFeature(feature({ building: 'service', power: 'substation' }), 'building'), true);
});

test('unrequested street furniture, institution labels and natural points remain available', () => {
  for (const tags of [
    { highway: 'stop' }, { highway: 'give_way' }, { highway: 'street_lamp' }, { highway: 'traffic_signals' },
    { amenity: 'bench' }, { amenity: 'clinic' }, { natural: 'tree' }, { man_made: 'tower' },
  ]) assert.equal(shouldRenderFeature(feature(tags, 'point'), 'detail'), true, JSON.stringify(tags));
});

test('Nevada cleanup removes 93 crossing/barrier details and 258 electrical points without editing the map', () => {
  const before = JSON.stringify(nevadaMap);
  const details = nevadaMap.details.filter(item => mapFeatureLayer(item, 'detail') === 'details');
  const power = nevadaMap.details.filter(item => mapFeatureLayer(item, 'detail') === 'power');
  const visibleDetails = details.filter(item => shouldRenderFeature(item, 'detail'));
  const visiblePower = power.filter(item => shouldRenderFeature(item, 'detail'));
  assert.equal(details.length, 241);
  assert.equal(visibleDetails.length, 148);
  assert.equal(details.filter(item => item.tags.barrier).length, 65);
  assert.equal(details.filter(item => item.tags.highway === 'crossing').length, 28);
  assert.equal(power.length, 272);
  assert.equal(visiblePower.length, 14);
  assert(visiblePower.every(item => item.geometry !== 'point'), 'Every retained electrical object has actual line/area geometry');
  assert(nevadaMap.buildings.every(item => shouldRenderFeature(item, 'building')));
  assert(nevadaMap.roads.every(item => shouldRenderFeature(item, 'road')));
  assert.equal(JSON.stringify(nevadaMap), before, 'Game cleanup cannot delete or rewrite original OSM records');
});
