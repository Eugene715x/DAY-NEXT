import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { convertOSM, createProjection, mergeOSMSources, parseOSM, projectPoint, validateBbox } from '../scripts/lib/osm-converter.mjs';
import { loadLocalSandSupplement } from '../scripts/refresh-map.mjs';
import nevadaMap from '../maps/usa.js';

const bbox = [-122, 47, -121.98, 47.015];
const options = { bbox, id: 'fixture', name: 'Test Valley', region: 'Washington', country: 'US', downloadedAt: '2026-10-20T00:00:00.000Z' };
const nodes = [
  { type: 'node', id: 1, lon: -121.999, lat: 47.001 },
  { type: 'node', id: 2, lon: -121.981, lat: 47.014 },
  { type: 'node', id: 3, lon: -121.999, lat: 47.014 },
  { type: 'node', id: 4, lon: -121.981, lat: 47.001 },
];
const fixture = extra => ({ elements: [...nodes, ...extra] });
const road = (id, tags = {}, extra = {}) => ({ type: 'way', id, nodes: [1, 2], tags: { highway: 'residential', name: 'River & Pine Road', ...tags }, ...extra });

test('projection uses local metre scale, north is up, dimensions fit the grid', () => {
  const p = createProjection(bbox);
  assert.equal(p.width % 25, 0); assert.equal(p.height % 25, 0);
  assert(Math.max(p.width, p.height) <= 3000);
  assert.deepEqual(projectPoint(bbox[0], bbox[3], p), { x: 0, y: 0 });
  const southEast = projectPoint(bbox[2], bbox[1], p);
  assert(southEast.x > 0 && southEast.x <= p.width && southEast.y > 0 && southEast.y <= p.height);
  const horizontal = projectPoint(-121.99, 47.01, p).x - projectPoint(-122, 47.01, p).x;
  const vertical = projectPoint(-121.99, 47, p).y - projectPoint(-121.99, 47.01, p).y;
  assert(Math.abs(horizontal / vertical - Math.cos((bbox[1] + bbox[3]) / 2 * Math.PI / 180)) < 1e-9);
});

test('bbox validation refuses huge, inverted, malformed or degenerate imports', () => {
  for (const value of [[0, 0, 10, 10], [1, 0, 0, 1], [0, 86, 1, 87], '0,0,NaN,1', [0, 0, 0, 0]]) assert.throws(() => validateBbox(value));
  assert.deepEqual(validateBbox(bbox.join(',')), bbox);
});

test('roads preserve real names; only explicit bridge tags become bridges', () => {
  const map = convertOSM(fixture([road(10), road(11, { bridge: 'yes' }), road(12, { bridge: 'no' }), road(13, { tunnel: 'yes' })]), options);
  assert.equal(map.roads.length, 4);
  assert.equal(map.roads[0].name, 'River & Pine Road');
  assert.deepEqual(map.roads.map(r => r.bridge), [false, true, false, false]);
  assert.equal(map.roads[3].tunnel, true);
  assert(map.roads.every(r => r.width >= 2));
  assert.equal(map.source.license, 'ODbL-1.0');
  assert.equal(map.source.copyright, '© OpenStreetMap contributors');
});

test('OSM XML and Overpass JSON produce equivalent projected geometry and decode XML names', () => {
  const xml = `<osm version="0.6">${nodes.map(n => `<node id="${n.id}" lat="${n.lat}" lon="${n.lon}"/>`).join('')}<way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="name" v="River &amp; Pine Road"/></way></osm>`;
  const fromXML = convertOSM(xml, options), fromJSON = convertOSM(fixture([road(10)]), options);
  assert.deepEqual(fromXML.roads, fromJSON.roads);
  assert.deepEqual(fromXML.start, fromJSON.start);
  assert.throws(() => parseOSM('<!DOCTYPE osm [<!ENTITY xx SYSTEM "file:///etc/passwd">]><osm/>'), /entity|DTD/i);
});

test('split relation outer ways and island holes reconstruct into a water polygon', () => {
  const outer = [
    { lon: -121.997, lat: 47.003 }, { lon: -121.983, lat: 47.003 },
    { lon: -121.983, lat: 47.012 }, { lon: -121.997, lat: 47.012 },
  ];
  const inner = [
    { lon: -121.993, lat: 47.006 }, { lon: -121.988, lat: 47.006 },
    { lon: -121.988, lat: 47.009 }, { lon: -121.993, lat: 47.009 },
  ];
  const map = convertOSM(fixture([
    { type: 'way', id: 20, geometry: [outer[0], outer[1], outer[2]], tags: {} },
    { type: 'way', id: 21, geometry: [outer[0], outer[3], outer[2]], tags: {} },
    { type: 'way', id: 22, geometry: [...inner, inner[0]], tags: {} },
    { type: 'relation', id: 30, tags: { type: 'multipolygon', natural: 'water', name: 'Island Lake' }, members: [{ type: 'way', ref: 20, role: 'outer' }, { type: 'way', ref: 21, role: 'outer' }, { type: 'way', ref: 22, role: 'inner' }] },
  ]), options);
  assert.equal(map.areas.length, 1); assert.equal(map.areas[0].name, 'Island Lake');
  assert.equal(map.areas[0].rings.length, 2);
  for (const ring of map.areas[0].rings) assert.deepEqual(ring[0], ring.at(-1));
});

test('geometry is clipped to selected bounds rather than scaled or replaced', () => {
  const map = convertOSM(fixture([road(10, {}, { geometry: [{ lon: -122.02, lat: 47.007 }, { lon: -121.96, lat: 47.007 }] }), { type: 'way', id: 40, tags: { natural: 'wood' }, geometry: [{ lon: -122.01, lat: 47.002 }, { lon: -121.985, lat: 47.002 }, { lon: -121.985, lat: 47.02 }, { lon: -122.01, lat: 47.02 }, { lon: -122.01, lat: 47.002 }] }]), options);
  assert.equal(map.roads[0].points[0].x, 0);
  const p = createProjection(bbox);
  assert(Math.abs(map.roads[0].points.at(-1).x - p.meterWidth / p.metersPerUnit) < .001);
  for (const p of [...map.roads[0].points, ...map.areas[0].rings[0]]) assert(p.x >= 0 && p.x <= map.width && p.y >= 0 && p.y <= map.height);
});

test('intermittent and seasonal waterways retain dryness; seasonal=no stays permanent', () => {
  const map = convertOSM(fixture([
    { type: 'way', id: 50, nodes: [1, 2], tags: { waterway: 'stream', intermittent: 'yes', seasonal: 'no' } },
    { type: 'way', id: 51, nodes: [3, 4], tags: { waterway: 'river', seasonal: 'yes' } },
    { type: 'way', id: 52, nodes: [1, 4], tags: { waterway: 'river', seasonal: 'no' } },
  ]), options);
  assert.deepEqual(map.rivers.map(river => river.intermittent), [true, true, false]);
  assert.deepEqual(map.rivers.map(river => river.seasonal), [false, true, false]);
});

test('real place nodes become named points, unrelated or outside nodes are not invented POIs', () => {
  const map = convertOSM(fixture([road(10), { type: 'node', id: 99, lon: -121.99, lat: 47.007, tags: { place: 'town', name: 'Snoqualmie' } }, { type: 'node', id: 100, lon: -121.99, lat: 47.008, tags: { amenity: 'fuel' } }, { type: 'node', id: 101, lon: -120, lat: 48, tags: { place: 'town', name: 'Outside' } }]), options);
  assert.equal(map.pois.length, 2);
  assert.equal(map.pois[0].name, 'Snoqualmie');
  assert.equal(map.pois[1].kind, 'gas'); assert(map.pois[1].name.includes('100'));
  assert.equal(map.labels[0].name, 'Snoqualmie');
  assert(map.pois.every(p => !p.discovered));
  assert.equal(map.country, 'US');
});

test('all small road types retain their complete geometry and explicit surface/width metadata', () => {
  const map = convertOSM(fixture([
    road(201, { highway: 'footway', width: '4 ft', surface: 'gravel', access: 'private' }, { nodes: [1, 3, 2] }),
    road(202, { highway: 'track', tracktype: 'grade3' }),
    road(203, { highway: 'service', service: 'driveway' }),
    road(204, { highway: 'cycleway' }),
  ]), options);
  assert.deepEqual(map.roads.map(r => r.type), ['footway', 'track', 'service', 'cycleway']);
  assert.equal(map.roads[0].points.length, 3);
  assert.equal(map.roads[0].surface, 'gravel');
  assert.equal(map.roads[0].access, 'private');
  assert.equal(map.roads[0].widthSource, 'tag');
  assert(Math.abs(map.roads[0].widthMeters - 1.2192) < 1e-9);
  assert.equal(map.roads[1].widthSource, 'highway-default');
  assert.equal(map.roads[1].tracktype, 'grade3');
  assert.equal(map.roads[2].service, 'driveway');
});

test('individual buildings keep exact footprints and only mapped roof/height/address facts', () => {
  const ring = [nodes[0], nodes[2], nodes[1], nodes[3], nodes[0]].map(({ lon, lat }) => ({ lon, lat }));
  const map = convertOSM(fixture([
    { type: 'way', id: 210, geometry: ring, tags: { building: 'house', name: 'Mapped House', 'roof:shape': 'gabled', 'building:levels': '2', height: `10' 6"`, 'building:material': 'brick', 'roof:material': 'metal', 'addr:housenumber': '18', 'addr:street': 'Main Street' } },
    { type: 'way', id: 211, geometry: ring, tags: { building: 'yes' } },
  ]), options);
  assert.equal(map.buildings.length, 2);
  assert.equal(map.buildings[0].points.length, ring.length);
  assert.equal(map.buildings[0].rings.length, 1);
  assert.equal(map.buildings[0].type, 'house');
  assert.equal(map.buildings[0].roofShape, 'gabled');
  assert.equal(map.buildings[0].levels, 2);
  assert(Math.abs(map.buildings[0].heightMeters - 3.2004) < 1e-9);
  assert.equal(map.buildings[0].material, 'brick');
  assert.equal(map.buildings[0].roofMaterial, 'metal');
  assert.equal(map.buildings[0].address, '18 Main Street');
  for (const key of ['roofShape', 'levels', 'heightMeters', 'material', 'address', 'ruins']) assert.equal(Object.hasOwn(map.buildings[1], key), false);
});

test('courtyard building multipolygons retain holes without duplicating their component ways', () => {
  const outer = [{ lon: -121.997, lat: 47.003 }, { lon: -121.983, lat: 47.003 }, { lon: -121.983, lat: 47.012 }, { lon: -121.997, lat: 47.012 }];
  const inner = [{ lon: -121.993, lat: 47.006 }, { lon: -121.988, lat: 47.006 }, { lon: -121.988, lat: 47.009 }, { lon: -121.993, lat: 47.009 }];
  const map = convertOSM(fixture([
    { type: 'way', id: 220, geometry: [...outer, outer[0]], tags: { building: 'yes' } },
    { type: 'way', id: 221, geometry: [...inner, inner[0]], tags: {} },
    { type: 'relation', id: 222, tags: { type: 'multipolygon', building: 'apartments', name: 'Courtyard House' }, members: [{ type: 'way', ref: 220, role: 'outer' }, { type: 'way', ref: 221, role: 'inner' }] },
  ]), options);
  assert.equal(map.buildings.length, 1);
  assert.equal(map.buildings[0].rings.length, 2);
  assert.equal(map.buildings[0].type, 'apartments');
  assert.deepEqual(map.buildings[0].rings[0], map.buildings[0].points);
});

test('small mapped objects retain point/line/polygon geometry without inventing buildings', () => {
  const ring = [nodes[0], nodes[2], nodes[1], nodes[3], nodes[0]].map(({ lon, lat }) => ({ lon, lat }));
  const map = convertOSM(fixture([
    road(230),
    { type: 'way', id: 231, nodes: [1, 2], tags: { barrier: 'fence' } },
    { type: 'way', id: 232, nodes: [3, 4], tags: { railway: 'abandoned', name: 'Old Branch' } },
    { type: 'way', id: 233, geometry: ring, tags: { amenity: 'parking' } },
    { type: 'way', id: 234, geometry: ring, tags: { leisure: 'pitch', sport: 'tennis' } },
    { type: 'node', id: 235, lon: -121.99, lat: 47.008, tags: { historic: 'ruins' } },
    { type: 'node', id: 236, lon: -121.99, lat: 47.009, tags: { natural: 'tree' } },
    { type: 'node', id: 237, lon: -121.99, lat: 47.01, tags: { amenity: 'bench' } },
  ]), options);
  assert.equal(map.details.length, 7);
  assert.equal(map.buildings.length, 0, 'A point ruin has no known house footprint');
  const byKind = Object.fromEntries(map.details.map(d => [d.kind, d]));
  assert.equal(byKind.fence.geometry, 'line');
  assert.equal(byKind.railway.tags.railway, 'abandoned');
  assert.equal(byKind.parking.geometry, 'polygon');
  assert.equal(byKind.parking.rings.length, 1);
  assert.equal(byKind.pitch.tags.sport, 'tennis');
  assert.equal(byKind.ruins.geometry, 'point');
  assert.equal(byKind.ruins.points.length, 1);
  assert.equal(byKind.tree.geometry, 'point');
  assert.equal(byKind.bench.geometry, 'point');
  assert.equal(map.statistics.details, 7);
});

test('Nevada source keeps every complete in-bounds house and small path without inventing source features', async () => {
  const raw = parseOSM(await readFile(new URL('../maps/source/beatty.osm', import.meta.url), 'utf8'));
  const map = convertOSM(raw, { ...options, bbox: nevadaMap.bbox });
  const [west, south, east, north] = nevadaMap.bbox;
  const inside = point => point && Number.isFinite(point.lon) && Number.isFinite(point.lat)
    && point.lon >= west && point.lon <= east && point.lat >= south && point.lat <= north;
  const sourceById = new Map(raw.elements.map(element => [`${element.type}-${element.id}`, element]));
  const pointsOf = way => way.geometry || (way.nodes || []).map(id => sourceById.get(`node-${id}`));
  const buildingMembers = new Set(raw.elements
    .filter(element => element.type === 'relation' && element.tags.type === 'multipolygon' && element.tags.building && element.tags.building !== 'no')
    .flatMap(relation => relation.members.filter(member => member.type === 'way').map(member => `way-${member.ref}`)));
  const sourceBuildings = raw.elements.filter(element => {
    if (element.type !== 'way' || !element.tags.building || element.tags.building === 'no' || buildingMembers.has(`way-${element.id}`)) return false;
    const points = pointsOf(element);
    return points.length >= 4 && String(element.nodes[0]) === String(element.nodes.at(-1)) && points.every(inside);
  });
  assert(sourceBuildings.length > 0, 'The real city extract must contain mapped house footprints');
  const buildingIds = new Set(map.buildings.map(building => building.sourceId));
  for (const building of sourceBuildings) assert(buildingIds.has(`way-${building.id}`), `Dropped in-bounds house way-${building.id}`);

  // Counts can change when OSM is refreshed; actual eligible source identities cannot disappear.
  const roadIds = new Set(map.roads.map(road => road.sourceId));
  const smallPaths = raw.elements.filter(element => element.type === 'way'
    && ['footway', 'path', 'cycleway', 'track', 'steps', 'service'].includes(element.tags.highway)
    && element.tags.area !== 'yes' && pointsOf(element).length >= 2 && pointsOf(element).every(Boolean) && pointsOf(element).some(inside));
  assert(smallPaths.length > 0, 'The city extract must contain small roads or paths');
  for (const path of smallPaths) assert(roadIds.has(`way-${path.id}`), `Dropped small road way-${path.id}`);
  for (const feature of [...map.roads, ...map.rivers, ...map.areas, ...map.buildings, ...map.details]) {
    const source = sourceById.get(feature.sourceId);
    assert(source, `Invented source feature ${feature.id}`);
    assert.deepEqual(feature.tags, { ...source.tags }, `Changed source tags for ${feature.id}`);
  }
});

test('unlisted meaningful OSM features survive with original tags instead of disappearing', () => {
  const map = convertOSM(fixture([
    road(301),
    { type: 'way', id: 302, nodes: [1, 2], tags: { aeroway: 'runway', ref: '16/34' } },
    { type: 'way', id: 303, nodes: [3, 4], tags: { aeroway: 'taxiway' } },
    { type: 'way', id: 304, nodes: [1, 3, 2, 4, 1], tags: { aeroway: 'apron' } },
    { type: 'way', id: 305, nodes: [1, 2], tags: { highway: 'construction', construction: 'residential' } },
    { type: 'node', id: 306, lon: -121.99, lat: 47.008, tags: { shop: 'bakery', name: 'Bread', opening_hours: '08:00-18:00' } },
    { type: 'node', id: 307, lon: -121.99, lat: 47.009, tags: { natural: 'peak', ele: '1812' } },
    { type: 'node', id: 308, lon: -121.99, lat: 47.01, tags: { man_made: 'monitoring_station' } },
  ]), options);
  const byId = new Map(map.details.map(feature => [feature.sourceId, feature]));
  assert.equal(map.roads.length, 1, 'A planned/construction way is not a usable road');
  assert.equal(byId.get('way-302').kind, 'runway');
  assert.equal(byId.get('way-302').geometry, 'line');
  assert.equal(byId.get('way-303').kind, 'taxiway');
  assert.equal(byId.get('way-304').geometry, 'polygon');
  assert.equal(byId.get('way-305').tags.construction, 'residential');
  assert.equal(byId.get('node-306').tags.opening_hours, '08:00-18:00');
  assert.equal(byId.get('node-307').tags.ele, '1812');
  assert.equal(byId.get('node-308').kind, 'monitoring_station');
  assert.equal(map.coverage.eligibleInBounds, map.coverage.representedSourceElements);
});

test('closed fences and roundabouts stay lines, and complete generic areas retain their holes', () => {
  const outer = [{ lon: -121.997, lat: 47.003 }, { lon: -121.983, lat: 47.003 }, { lon: -121.983, lat: 47.012 }, { lon: -121.997, lat: 47.012 }];
  const inner = [{ lon: -121.993, lat: 47.006 }, { lon: -121.988, lat: 47.006 }, { lon: -121.988, lat: 47.009 }, { lon: -121.993, lat: 47.009 }];
  const ring = [...outer, outer[0]];
  const map = convertOSM(fixture([
    { type: 'way', id: 320, geometry: ring, tags: { barrier: 'fence' } },
    { type: 'way', id: 321, geometry: ring, tags: { highway: 'residential', junction: 'roundabout' } },
    { type: 'way', id: 322, geometry: ring, tags: {} },
    { type: 'way', id: 323, geometry: [...inner, inner[0]], tags: {} },
    { type: 'relation', id: 324, tags: { type: 'multipolygon', landuse: 'industrial', name: 'Works' }, members: [{ type: 'way', ref: 322, role: 'outer' }, { type: 'way', ref: 323, role: 'inner' }] },
  ]), options);
  assert.equal(map.details.find(d => d.kind === 'fence').geometry, 'line');
  assert.equal(map.details.some(d => d.sourceId === 'way-321'), false);
  assert.equal(map.roads.find(r => r.sourceId === 'way-321').points.length, 5);
  const area = map.details.find(d => d.sourceId === 'relation-324');
  assert.equal(area.kind, 'industrial'); assert.equal(area.geometry, 'polygon'); assert.equal(area.rings.length, 2);
});

test('incomplete relations expose actual fragments and omissions without inventing closed areas', () => {
  const map = convertOSM(fixture([
    road(340),
    { type: 'way', id: 341, nodes: [1, 3], tags: {} },
    { type: 'relation', id: 342, tags: { type: 'boundary', boundary: 'administrative', name: 'Partial boundary' }, members: [{ type: 'way', ref: 341, role: 'outer' }, { type: 'way', ref: 999, role: 'outer' }] },
    { type: 'way', id: 343, nodes: [1, 999], tags: { waterway: 'stream' } },
  ]), options);
  const partial = map.details.find(d => d.sourceId === 'relation-342');
  assert.equal(partial.kind, 'boundary'); assert.equal(partial.geometry, 'line');
  assert.equal(partial.geometryIncomplete, true); assert.equal(partial.points.length, 2);
  assert.equal(map.relations.find(r => r.id === 'relation-342').geometryComplete, false);
  assert.deepEqual(map.relations.find(r => r.id === 'relation-342').missingMemberIds, ['way-999']);
  assert(map.coverage.omittedByReason.incompleteGeometry.includes('way-343'));
});

test('checked-in Nevada map and coverage reproduce the exact source file after any refresh', async () => {
  const base = await readFile(new URL('../maps/source/beatty.osm', import.meta.url), 'utf8');
  const supplement = await loadLocalSandSupplement();
  const raw = mergeOSMSources(base, ...(supplement ? [supplement.bytes.toString('utf8')] : []));
  const map = convertOSM(raw, { ...options, bbox: nevadaMap.bbox });
  const report = JSON.parse(await readFile(new URL('../maps/source/coverage.json', import.meta.url), 'utf8'));
  const accounted = map.coverage.representedSourceElements + map.coverage.representedByRelation + Object.values(map.coverage.omittedCounts).reduce((sum, count) => sum + count, 0);
  assert.equal(accounted, map.coverage.sourceTaggedElements);
  assert.equal(map.coverage.sourceTaggedElements + map.coverage.metadataOnlyElements, raw.elements.length);
  assert.equal(map.coverage.inputElements, raw.elements.length);
  assert.equal(map.coverage.eligibleInBounds, map.coverage.representedSourceElements);
  for (const key of ['roads', 'rivers', 'areas', 'buildings', 'details', 'relations', 'coverage', 'statistics', 'start']) {
    assert.deepEqual(nevadaMap[key], map[key], `Checked-in ${key} must match conversion of the saved source`);
  }
  for (const key of Object.keys(map.coverage)) assert.deepEqual(report[key], map.coverage[key], `Stale coverage report field ${key}`);
  assert.equal(report.snapshotAt, nevadaMap.source.snapshotAt);

  const sourceIds = new Set(raw.elements.map(element => `${element.type}-${element.id}`));
  for (const relation of map.relations) {
    const missing = relation.members.filter(member => !sourceIds.has(`${member.type}-${member.ref}`)).map(member => `${member.type}-${member.ref}`);
    assert.deepEqual(relation.missingMemberIds, missing, `Relation ${relation.id} must expose its actual missing members`);
    assert.equal(map.coverage.partialRelations.some(partial => partial.id === relation.id), !relation.geometryComplete);
  }
});

test('bounded Overpass geometry retains known fragments without joining across missing vertices', () => {
  const map = convertOSM(fixture([
    road(360),
    { type: 'way', id: 361, tags: { highway: 'footway' }, geometry: [null, { lon: -121.998, lat: 47.004 }, { lon: -121.994, lat: 47.005 }, null, { lon: -121.988, lat: 47.008 }, { lon: -121.983, lat: 47.01 }, null] },
  ]), options);
  const pieces = map.details.filter(detail => detail.sourceId === 'way-361');
  assert.equal(pieces.length, 2);
  assert(pieces.every(piece => piece.geometry === 'line' && piece.points.length === 2 && piece.geometryIncomplete));
  assert(map.coverage.partialWays.includes('way-361'));
  assert(!map.coverage.omittedByReason.incompleteGeometry.includes('way-361'));
  assert.equal(map.roads.length, 1, 'Unknown segments cannot become a connected navigable road');
});
