import test from 'node:test';
import assert from 'node:assert/strict';
import { convertOSM, createProjection, parseOSM, projectPoint, validateBbox } from '../scripts/lib/osm-converter.mjs';

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
