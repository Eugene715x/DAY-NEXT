import test from 'node:test';
import assert from 'node:assert/strict';
import { ROAD_CLASSES, roadClass, mergeNetworkLines } from '../map-presentation.js';
import nevadaMap from '../maps/usa.js';

const points = coordinates => coordinates.map(([x, y]) => ({ x, y }));
const line = (id, coordinates, tags = {}, extra = {}) => ({ id, points: points(coordinates), tags, ...extra });
const flattenedIds = features => features.flatMap(feature => feature.memberIds).sort();
const close = (a, b) => assert(Math.abs(a - b) < Math.max(1, a) * 1e-12, `${a} differs from ${b}`);

test('roads use five broad classes while their original OSM types remain explicit', () => {
  const classes = {
    highway: ['motorway', 'motorway_link', 'trunk', 'primary', 'primary_link'],
    road: ['secondary', 'secondary_link', 'tertiary', 'tertiary_link'],
    street: ['residential', 'unclassified', 'service', 'living_street'],
    track: ['track'], trail: ['footway', 'path', 'cycleway', 'bridleway', 'steps', 'pedestrian'],
  };
  assert.deepEqual(Object.keys(ROAD_CLASSES), Object.keys(classes));
  for (const [expected, types] of Object.entries(classes)) for (const type of types) {
    assert.equal(roadClass({ tags: { highway: type } }), expected, type);
    assert.equal(roadClass({ geometry: 'polygon', tags: { 'area:highway': type } }), expected, `area:highway=${type}`);
    const feature = mergeNetworkLines([line(type, [[0, 0], [10, 0]], { highway: type })]).features[0];
    assert.equal(feature.roadClass, expected);
    assert.equal(feature.sourceType, type);
    assert.equal(feature.tags.highway, type);
    assert.equal(feature.roadClassName, ROAD_CLASSES[expected].name);
  }
});

test('touching reversed fragments become one continuous trace retaining every source and name', () => {
  const source = [
    line('way-20-0', [[10, 0], [5, 3]], { highway: 'residential', name: 'East Street' }, { sourceId: 'way-20', name: 'East Street' }),
    line('way-10-0', [[0, 0], [3, 2], [5, 3]], { highway: 'service', name: 'West Lane' }, { sourceId: 'way-10', name: 'West Lane' }),
  ];
  const before = structuredClone(source);
  const { features, report } = mergeNetworkLines(source);
  assert.equal(features.length, 1);
  assert.deepEqual(features[0].points, points([[0, 0], [3, 2], [5, 3], [10, 0]]));
  assert.deepEqual(features[0].sourceIds, ['way-10', 'way-20']);
  assert.deepEqual(features[0].names, ['West Lane', 'East Street']);
  assert.deepEqual(features[0].sourceTypes, ['service', 'residential']);
  assert.deepEqual(features[0].members, [before[1], before[0]]);
  assert.equal(report.joinedConnections, 1);
  close(report.sourceLength, report.displayLength);
  assert.deepEqual(mergeNetworkLines([...source].reverse()), { features, report }, 'Input order must not change presentation IDs or geometry');
  features[0].points[0].x = 999;
  features[0].members[0].tags.highway = 'tampered';
  assert.deepEqual(source, before, 'Display geometry and provenance clones cannot mutate navigation or source tags');
});

test('gaps, interior crossings and branch junctions never acquire fabricated links or shortcuts', () => {
  const fixtures = [
    [line('a', [[0, 0], [10, 0]]), line('b', [[10.0001, 0], [20, 0]])],
    [line('a', [[0, 0], [10, 0]]), line('b', [[5, -5], [5, 5]])],
    [line('a', [[0, 0], [10, 0]]), line('b', [[10, 0], [20, 0]]), line('c', [[10, 0], [10, 10]])],
    [line('a', [[0, 0], [10, 0]]), line('b', [[10, 0], [20, 0]]), line('c', [[10, -10], [10, 0], [10, 10]])],
    [line('a', [[0, 0], [10, 0]], { highway: 'residential' }), line('b', [[10, 0], [20, 0]], { highway: 'residential' }), line('trail', [[10, 0], [10, 10]], { highway: 'path' })],
  ];
  for (const source of fixtures) {
    const { features, report } = mergeNetworkLines(source);
    assert.equal(features.length, source.length);
    assert.deepEqual(flattenedIds(features), source.map(feature => feature.id).sort());
    close(report.sourceLength, report.displayLength);
  }
});

test('roads at different levels or of different classes and incompatible electrical systems stay separate', () => {
  const base = line('a', [[0, 0], [10, 0]], { highway: 'residential' });
  for (const tags of [{ highway: 'track' }, { highway: 'residential', bridge: 'yes' }, { highway: 'residential', tunnel: 'yes' }, { highway: 'residential', layer: '1' }]) {
    assert.equal(mergeNetworkLines([base, line('b', [[10, 0], [20, 0]], tags)]).features.length, 2);
  }
  const power = line('a', [[0, 0], [10, 0]], { power: 'line', voltage: '138000', cables: '3' });
  for (const change of [{ voltage: '12000' }, { cables: '6' }, { power: 'cable' }, { layer: '1' }]) {
    const second = line('b', [[10, 0], [20, 0]], { ...power.tags, ...change });
    assert.equal(mergeNetworkLines([power, second], { kind: 'power' }).features.length, 2);
  }
  const second = line('b', [[10, 0], [20, 5]], { ...power.tags, power: 'minor_line' });
  const joined = mergeNetworkLines([second, power], { kind: 'power' });
  assert.equal(joined.features.length, 1);
  assert.deepEqual(joined.features[0].sourceTypes, ['line', 'minor_line']);
  assert.deepEqual(joined.features[0].points, points([[0, 0], [10, 0], [20, 5]]));
});

test('genuine closed loops remain closed and a spur does not turn a loop into a shortcut', () => {
  const loop = [line('a', [[0, 0], [10, 0]]), line('b', [[10, 10], [10, 0]]), line('c', [[10, 10], [0, 0]])];
  const joined = mergeNetworkLines(loop);
  assert.equal(joined.features.length, 1);
  const feature = joined.features[0];
  assert.deepEqual(feature.points[0], feature.points.at(-1));
  assert.equal(feature.points.length, 4);
  close(joined.report.sourceLength, joined.report.displayLength);
  const withSpur = mergeNetworkLines([...loop, line('d', [[0, 0], [-10, 0]])]);
  assert.equal(withSpur.features.length, 2);
  assert(withSpur.features.some(feature => feature.memberIds.length === 3 && pointKey(feature.points[0]) === pointKey(feature.points.at(-1))));
  assert.deepEqual(flattenedIds(withSpur.features), ['a', 'b', 'c', 'd']);
});

const pointKey = point => `${point.x},${point.y}`;

test('real Nevada roads and electrical lines retain all original fragments and exactly the original total length', () => {
  const before = JSON.stringify(nevadaMap);
  const roads = mergeNetworkLines(nevadaMap.roads);
  assert.equal(roads.report.sourceFeatures, 658);
  assert(roads.report.displayFeatures < 658, 'Actual connected source fragments should join');
  assert.deepEqual(flattenedIds(roads.features), nevadaMap.roads.map(feature => feature.id).sort());
  close(roads.report.sourceLength, roads.report.displayLength);
  const powerSource = nevadaMap.details.filter(feature => feature.geometry === 'line' && ['line', 'minor_line', 'cable'].includes(feature.tags?.power));
  const power = mergeNetworkLines(powerSource, { kind: 'power' });
  assert.equal(power.report.sourceFeatures, 13);
  assert.deepEqual(flattenedIds(power.features), powerSource.map(feature => feature.id).sort());
  close(power.report.sourceLength, power.report.displayLength);
  for (const network of [roads, power]) assert.equal(new Set(network.features.map(feature => feature.id)).size, network.features.length);
  assert.equal(JSON.stringify(nevadaMap), before, 'The source map remains byte-for-byte unchanged');
});
