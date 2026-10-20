import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { convertOSM, joinBoundaryFragments, parseOSM } from '../scripts/lib/osm-converter.mjs';

const point = (x, y) => ({ x, y });
const geo = (lon, lat) => ({ lon, lat });
const options = { bbox: [0, 0, .02, .02], id: 'boundary-test', downloadedAt: '2026-10-20T00:00:00Z' };
const way = (id, geometry) => ({ type: 'way', id, geometry, tags: {} });
const boundary = (members, extra = {}) => ({ type: 'relation', id: 100, members, tags: { type: 'boundary', boundary: 'census', name: 'Measured town', ...extra } });
const member = (ref, role = 'outer', extra = {}) => ({ type: 'way', ref, role, ...extra });

test('boundary assembly joins reversed source endpoints without mutating coordinates', () => {
  const fragments = [
    [point(0, 0), point(10, 0)], [point(10, 10), point(10, 0)],
    [point(0, 10), point(10, 10)], [point(0, 0), point(0, 10)],
  ];
  const before = structuredClone(fragments), result = joinBoundaryFragments(fragments);
  assert.equal(result.rings.length, 1);
  assert.equal(result.chains.length, 0);
  assert.equal(result.joins, 3);
  assert.equal(result.rings[0].length, 5);
  assert.deepEqual(result.rings[0][0], result.rings[0].at(-1));
  assert.deepEqual(fragments, before);
});

test('boundary gaps and ambiguous junctions remain measured lines instead of fabricated zones', () => {
  const gap = joinBoundaryFragments([[point(0, 0), point(10, 0)], [point(10, 0), point(10, 10)], [point(0, 10), point(0, 1)]]);
  assert.equal(gap.rings.length, 0);
  assert.equal(gap.chains.length, 2);
  assert(gap.chains.every(chain => chain[0].x !== chain.at(-1).x || chain[0].y !== chain.at(-1).y));
  const branch = joinBoundaryFragments([
    [point(0, 0), point(10, 0)], [point(10, 0), point(20, 0)], [point(10, 0), point(10, 10)],
  ]);
  assert.equal(branch.rings.length, 0);
  assert.equal(branch.chains.length, 3);
});

test('complete boundary member rings form one real zone with its island hole', () => {
  const outer = [geo(.002, .002), geo(.018, .002), geo(.018, .018), geo(.002, .018), geo(.002, .002)];
  const inner = [geo(.008, .008), geo(.012, .008), geo(.012, .012), geo(.008, .012), geo(.008, .008)];
  const input = { elements: [
    way(1, outer.slice(0, 3)), way(2, [outer[0], outer[3], outer[2]]),
    way(3, inner.slice(0, 3)), way(4, [inner[0], inner[3], inner[2]]),
    boundary([member(1), member(2), member(3, 'inner'), member(4, 'inner')]),
  ] };
  const map = convertOSM(input, options), zone = map.details.find(feature => feature.sourceId === 'relation-100');
  assert.equal(zone.geometry, 'polygon');
  assert.equal(zone.boundaryClosed, true);
  assert.equal(zone.rings.length, 2);
  for (const ring of zone.rings) assert.deepEqual(ring[0], ring.at(-1));
  assert.equal(map.relations[0].geometryComplete, true);
  assert.equal(map.coverage.partialRelations.length, 0);
});

test('an incomplete boundary cannot fill over an unknown missing island', () => {
  const outer = [geo(.002, .002), geo(.018, .002), geo(.018, .018), geo(.002, .018), geo(.002, .002)];
  const map = convertOSM({ elements: [way(1, outer), boundary([member(1), member(999, 'inner')])] }, options);
  const features = map.details.filter(feature => feature.sourceId === 'relation-100');
  assert(features.length > 0);
  assert(features.every(feature => feature.geometry === 'line' && feature.boundaryClosed === false && feature.geometryIncomplete));
  assert.equal(map.relations[0].geometryComplete, false);
  assert.deepEqual(map.relations[0].missingMemberIds, ['way-999']);
});

test('clipping a fully known boundary keeps a closed polygon while bounded member gaps stay open', () => {
  const outer = [geo(.005, .005), geo(.025, .005), geo(.025, .025), geo(.005, .025), geo(.005, .005)];
  const complete = convertOSM({ elements: [way(1, outer), boundary([member(1)])] }, options);
  const zone = complete.details.find(feature => feature.boundaryClosed);
  assert.equal(zone.geometry, 'polygon');
  assert.deepEqual(zone.points[0], zone.points.at(-1));
  assert(zone.points.every(point => point.x >= 0 && point.x <= complete.width && point.y >= 0 && point.y <= complete.height));
  const fragment = [geo(.002, .002), geo(.008, .002), null, geo(.018, .018), geo(.012, .018)];
  const incomplete = convertOSM({ elements: [boundary([member(1, 'outer', { geometry: fragment })])] }, options);
  assert(incomplete.details.length >= 2);
  assert(incomplete.details.every(feature => feature.geometry === 'line'));
  assert(incomplete.details.every(feature => feature.points.every(point => point.y === feature.points[0].y)), 'The two known horizontal fragments cannot be connected across the missing diagonal');
});

test('saved Beatty source yields one complete census zone and one joined but honestly open old boundary', async () => {
  const raw = await readFile(new URL('../maps/source/beatty.osm', import.meta.url), 'utf8');
  const parsed = parseOSM(raw);
  const map = convertOSM(raw, { ...options, bbox: [-116.86, 36.86, -116.73, 36.94] });
  const current = map.details.filter(feature => feature.sourceId === 'relation-19689360');
  assert(current.length > 0);
  assert(current.every(feature => feature.geometry === 'polygon' && feature.boundaryClosed));
  for (const feature of current) assert.deepEqual(feature.points[0], feature.points.at(-1));
  const old = map.details.filter(feature => feature.sourceId === 'relation-170095');
  assert(old.length > 0);
  const oldMetadata = map.relations.find(relation => relation.id === 'relation-170095');
  if (!oldMetadata.geometryComplete) assert(old.every(feature => feature.geometry === 'line' && feature.boundaryClosed === false));
  assert(old.every(feature => Number.isInteger(feature.joinedFragments)));
  const withoutBoundaries = convertOSM({ ...parsed, elements: parsed.elements.filter(element => element.type !== 'relation' || !element.tags.boundary) }, { ...options, bbox: map.bbox });
  assert.deepEqual(map.buildings, withoutBoundaries.buildings, 'Assembling an administrative outline cannot consume physical buildings');
  assert.deepEqual(map.roads, withoutBoundaries.roads, 'A boundary member can also be a real road; its geometry must survive');
});
