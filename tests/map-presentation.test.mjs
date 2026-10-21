import test from 'node:test';
import assert from 'node:assert/strict';
import { ROAD_CLASSES, roadClass, mergeNetworkLines, mergeConnectedNetworks, coalesceWaterwaySources } from '../map-presentation.js';
import nevadaMap from '../maps/usa.js';

const points = coordinates => coordinates.map(([x, y]) => ({ x, y }));
const line = (id, coordinates, tags = {}, extra = {}) => ({ id, points: points(coordinates), tags, ...extra });
const flattenedIds = features => features.flatMap(feature => feature.memberIds).sort();
const close = (a, b) => assert(Math.abs(a - b) < Math.max(1, a) * 1e-12, `${a} differs from ${b}`);

test('waterway relations use exact native geometry facts without losing original tags or rendering duplicate paths', () => {
  const native = line('way-1', [[0, 0], [10, 0]], { waterway: 'river', intermittent: 'yes', tunnel: 'culvert', layer: '-1' }, { sourceId: 'way-1', width: 3 });
  const relation = line('relation-2-member-0', [[10, 0], [0, 0]], { type: 'waterway', waterway: 'river' }, { sourceId: 'relation-2', width: 99 });
  const distant = line('relation-3-member-0', [[0, 10], [10, 10]], { type: 'waterway', waterway: 'river' }, { sourceId: 'relation-3', width: 2 });
  const sources = [relation, distant, native], before = structuredClone(sources);
  const prepared = coalesceWaterwaySources(sources);
  assert.equal(prepared.coalesced, 1); assert.equal(prepared.features.length, 2);
  assert.deepEqual(sources, before);
  const merged = mergeConnectedNetworks(prepared.features, { kind: 'water' }).features;
  const local = merged.find(feature => feature.sourceIds.includes('way-1'));
  assert.equal(local.width, 3, 'A relation-level duplicate width cannot override the measured native way');
  assert.deepEqual(local.paths, [native.points]);
  assert.deepEqual(local.tags, native.tags);
  assert.deepEqual(local.memberIds, ['relation-2-member-0', 'way-1']);
  assert.deepEqual(local.members.find(member => member.id === relation.id), relation);
  assert.equal(merged.find(feature => feature.sourceIds.includes('relation-3')).tags.intermittent, undefined, 'An unmatched relation does not acquire invented seasonal facts');
});

test('ambiguous native waterways and nonmatching relation paths are never coalesced by name or proximity', () => {
  const sources = [
    line('way-1', [[0, 0], [10, 0]], { waterway: 'river', intermittent: 'yes' }, { name: 'Amargosa River' }),
    line('way-2', [[0, 0], [10, 0]], { waterway: 'river' }),
    line('relation-3-member-0', [[0, 0], [10, 0]], { type: 'waterway', waterway: 'river' }, { sourceId: 'relation-3', name: 'Amargosa River' }),
    line('relation-4-member-0', [[0, .001], [10, .001]], { type: 'waterway', waterway: 'river' }, { sourceId: 'relation-4', name: 'Amargosa River' }),
  ];
  assert.equal(coalesceWaterwaySources(sources).coalesced, 0);
});

test('roads use five broad classes and a railway class while original OSM types remain explicit', () => {
  const classes = {
    highway: ['motorway', 'motorway_link', 'trunk', 'primary', 'primary_link'],
    road: ['secondary', 'secondary_link', 'tertiary', 'tertiary_link'],
    street: ['residential', 'unclassified', 'service', 'living_street'],
    track: ['track'], trail: ['footway', 'path', 'cycleway', 'bridleway', 'steps', 'pedestrian'], railway: [],
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
  assert.equal(roadClass({ tags: { railway: 'abandoned' }, kind: 'railway' }), 'railway');
  assert.equal(roadClass({ tags: { railway: 'rail' } }), 'railway');
  assert.equal(roadClass({ tags: { railway: 'abandoned', highway: 'track' } }), 'track', 'A current road retains its highway class');
  const railway = mergeConnectedNetworks([line('rail', [[0, 0], [10, 0]], { railway: 'rail' })]).features[0];
  assert.equal(railway.roadClass, 'railway');
  assert.equal(railway.sourceType, 'rail');
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

test('connected branched roads become one selectable object without adding paths across a junction', () => {
  const source = [
    line('way-30-0', [[10, 0], [10, 10]], { highway: 'residential', name: 'North' }, { sourceId: 'way-30', name: 'North' }),
    line('way-10-0', [[0, 0], [10, 0], [20, 0]], { highway: 'service', name: 'Main' }, { sourceId: 'way-10', name: 'Main' }),
    line('way-20-0', [[20, 0], [30, 0]], { highway: 'residential' }, { sourceId: 'way-20' }),
    line('path', [[10, 0], [10, -10]], { highway: 'path' }),
  ];
  const original = structuredClone(source), result = mergeConnectedNetworks(source);
  assert.equal(result.features.length, 2, 'Only the same broad road class merges through its junction');
  const network = result.features.find(feature => feature.roadClass === 'street');
  assert.equal(network.geometry, 'line');
  assert.equal(network.paths.length, 3);
  assert.deepEqual(network.paths, [original[1].points, original[2].points, original[0].points]);
  assert.deepEqual(network.points, network.paths[0]);
  assert.deepEqual(network.memberIds, ['way-10-0', 'way-20-0', 'way-30-0']);
  assert.deepEqual(network.sourceIds, ['way-10', 'way-20', 'way-30']);
  assert.deepEqual(network.members, [original[1], original[2], original[0]]);
  assert.deepEqual(network.names, ['Main', 'North']);
  assert.equal(network.merged, true);
  close(result.report.sourceLength, result.report.displayLength);
  assert.deepEqual(mergeConnectedNetworks([...source].reverse()), result, 'Component IDs and all geometry are deterministic');
  network.paths[0][0].x = 999; network.members[0].tags.name = 'tampered';
  assert.deepEqual(source, original, 'Selection metadata cannot edit original navigation geometry');
});

test('network connections include exact T endpoints but exclude gaps, unmarked crossings and different grades', () => {
  const spine = line('a', [[0, 0], [20, 0]], { highway: 'residential' });
  const touching = line('b', [[10, 0], [10, 10]], { highway: 'service' });
  const joined = mergeConnectedNetworks([spine, touching]);
  assert.equal(joined.features.length, 1, 'A source endpoint on the interior of an actual segment connects');
  assert.deepEqual(joined.features[0].paths, [spine.points, touching.points], 'No vertex or connector is fabricated');
  for (const other of [
    line('b', [[10, -5], [10, 5]], { highway: 'residential' }),
    line('b', [[20.0001, 0], [30, 0]], { highway: 'residential' }),
    line('b', [[20, 0], [30, 0]], { highway: 'residential', bridge: 'yes' }),
    line('b', [[20, 0], [30, 0]], { highway: 'residential', tunnel: 'yes' }),
    line('b', [[20, 0], [30, 0]], { highway: 'residential', layer: '1' }),
  ]) assert.equal(mergeConnectedNetworks([spine, other]).features.length, 2);
  const source = [line('a', [[0, 0], [10, 0], [20, 0]]), line('b', [[10, -5], [10, 0], [10, 5]])];
  assert.equal(mergeConnectedNetworks(source).features.length, 1, 'A shared interior source vertex is an explicit network junction');
});

test('same-type electrical branches form one object while voltage and power type remain separate', () => {
  const tags = { power: 'minor_line', voltage: '12000', cables: '3' };
  const source = [
    line('a', [[0, 0], [10, 0], [20, 0]], tags),
    line('b', [[10, 0], [10, 10]], tags),
    line('c', [[20, 0], [30, 0]], { ...tags, voltage: '138000' }),
    line('d', [[20, 0], [20, -10]], { ...tags, power: 'line' }),
    line('e', [[20, 0], [20, 10]], { ...tags, power: 'cable' }),
  ];
  const { features, report } = mergeConnectedNetworks(source, { kind: 'power' });
  assert.equal(features.length, 4);
  assert.deepEqual(features.find(feature => feature.merged).memberIds, ['a', 'b']);
  assert.deepEqual(flattenedIds(features), ['a', 'b', 'c', 'd', 'e']);
  close(report.sourceLength, report.displayLength);
});

test('connected watercourses retain kind, dry-state and every original branch separately', () => {
  const tags = { waterway: 'stream', intermittent: 'yes' };
  const source = [
    line('a', [[0, 0], [10, 0], [20, 0]], tags, { intermittent: true, seasonal: false }),
    line('b', [[10, 0], [10, 10]], { ...tags, seasonal: 'no' }),
    line('c', [[20, 0], [30, 0]], { waterway: 'stream' }),
    line('d', [[20, 0], [20, -10]], { waterway: 'river', intermittent: 'yes' }),
    line('e', [[0, 0], [-10, 0]], { natural: 'water', water: 'lake', intermittent: 'yes' }),
  ];
  const result = mergeConnectedNetworks(source, { kind: 'water' });
  assert.equal(result.features.length, 4);
  const network = result.features.find(feature => feature.merged);
  assert.deepEqual(network.memberIds, ['a', 'b']);
  assert.equal(network.sourceType, 'stream');
  assert.equal(network.intermittent, true);
  assert.deepEqual(network.paths, [source[0].points, source[1].points]);
  close(result.report.sourceLength, result.report.displayLength);
});

test('real connected Nevada networks preserve source geometry, metadata and total length', () => {
  const sources = {
    road: nevadaMap.roads,
    power: nevadaMap.details.filter(feature => feature.geometry === 'line' && ['line', 'minor_line', 'cable'].includes(feature.tags?.power)),
    water: nevadaMap.rivers,
  };
  const before = JSON.stringify(nevadaMap);
  for (const [kind, source] of Object.entries(sources)) {
    const result = mergeConnectedNetworks(source, { kind });
    assert.deepEqual(flattenedIds(result.features), source.map(feature => feature.id).sort());
    close(result.report.sourceLength, result.report.displayLength);
    assert.equal(result.features.reduce((total, feature) => total + feature.paths.length, 0), source.length);
    for (const feature of result.features) for (const member of feature.members) assert.deepEqual(member, source.find(original => original.id === member.id));
  }
  const connectedRoads = mergeConnectedNetworks(sources.road);
  assert(connectedRoads.report.displayFeatures < mergeNetworkLines(sources.road).report.displayFeatures, 'Same-class branches join into larger selectable objects');
  const connectedPower = mergeConnectedNetworks(sources.power, { kind: 'power' });
  assert(connectedPower.features.some(feature => feature.memberIds.length > 1), 'Real electrical branches are combined');
  assert.equal(JSON.stringify(nevadaMap), before);
});
