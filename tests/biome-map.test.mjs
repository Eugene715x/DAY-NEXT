import test from 'node:test';
import assert from 'node:assert/strict';
import map from '../maps/usa.js';
import { buildBiomeMap } from '../biome-map.js';
import { polygonIntersection } from '../polygon-geometry.js';
import { createWorld } from '../world.js';

const p = (x, y) => ({ x, y });
const ring = (left, top, right, bottom) => [p(left, top), p(right, top), p(right, bottom), p(left, bottom), p(left, top)];
const area = parts => parts.reduce((total, polygon) => total + polygon.reduce((sum, points, index) => {
  let value = 0; const origin = points[0];
  for (let i = 1; i < points.length - 1; i++) value += (points[i].x - origin.x) * (points[i + 1].y - origin.y) - (points[i + 1].x - origin.x) * (points[i].y - origin.y);
  return sum + Math.abs(value / 2) * (index ? -1 : 1);
}, 0), 0);
const inRing = (x, y, points) => {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};
const at = (features, x, y) => features.filter(feature => feature.parts.some(polygon => inRing(x, y, polygon[0]) && !polygon.slice(1).some(hole => inRing(x, y, hole))));
const polygon = (id, biome, outer, holes = []) => ({ id, biome, kind: biome, geometry: 'polygon', parts: [[outer, ...holes]], tags: { natural: biome } });
const baseWorld = { geographic: true, width: 100, height: 100, metersPerUnit: 1, areas: [], details: [], buildings: [] };
const empty = { natureSources: [], waterLines: [], waterAreas: [], cityFeatures: [] };
const verifyPartition = (features, expectedArea) => {
  assert(Math.abs(features.reduce((sum, feature) => sum + area(feature.parts), 0) - expectedArea) < 1e-6, 'Every part of the map has one ground area');
  for (let a = 0; a < features.length; a++) for (let b = a + 1; b < features.length; b++) {
    assert(area(polygonIntersection(features[a].parts, features[b].parts)) < 1e-6, `No overlap: ${features[a].id} / ${features[b].id}`);
  }
};

const fixture = () => ({
  natureSources: [polygon('region', 'desert', ring(0, 0, 100, 100)), polygon('wood', 'forest', ring(20, 20, 80, 80)), polygon('small-sand', 'sand', ring(25, 25, 35, 35))],
  cityFeatures: [polygon('town', 'city', ring(10, 10, 90, 90))],
  waterAreas: [polygon('lake', 'water', ring(55, 55, 75, 75), [ring(61, 61, 69, 69)])],
  waterLines: [{ id: 'wash', kind: 'stream', geometry: 'line', paths: [[p(5, 45), p(95, 45)]], width: 4, intermittent: 'yes', tags: { waterway: 'stream', intermittent: 'yes' }, sourceIds: ['way-1', 'way-2'], memberIds: ['way-1', 'way-2'], members: [{ id: 'way-1' }, { id: 'way-2' }] }],
});

test('exclusive full ground cover puts coherent city over regional nature and specific nature above city', () => {
  const options = fixture(), before = structuredClone(options);
  const { features, report } = buildBiomeMap(baseWorld, options);
  verifyPartition(features, 10000);
  for (const [x, y, biome] of [[5, 5, 'desert'], [15, 15, 'city'], [40, 40, 'forest'], [30, 30, 'forest'], [60, 60, 'water'], [65, 65, 'forest'], [50, 45, 'seasonal_river']]) {
    assert.equal(at(features, x, y).length, 1); assert.equal(at(features, x, y)[0].biome, biome);
  }
  assert(report.coverageError < 1e-6); assert.equal(report.cityFeatures, 1);
  const cutForest = features.find(feature => feature.sourceId === 'wood');
  assert.notDeepEqual(cutForest.parts, options.natureSources[1].parts, 'Higher priority water cuts the displayed forest');
  assert.deepEqual(cutForest.members, [options.natureSources[1]], 'The entire uncut source footprint remains inspectable');
  assert.notEqual(cutForest.members[0], options.natureSources[1], 'Source snapshots are independent objects');
  assert.deepEqual(options, before, 'Derived partition cannot edit source facts or source geometry');
});

test('city replaces sand inside its outline while parks and water keep their own ground', () => {
  const options = {
    ...empty,
    natureSources: [polygon('regional-sand', 'sand', ring(0, 0, 100, 100)), polygon('city-park', 'park', ring(25, 25, 45, 45))],
    cityFeatures: [polygon('town', 'city', ring(10, 10, 90, 90))],
    waterAreas: [polygon('pond', 'water', ring(55, 55, 65, 65))],
  };
  const { features } = buildBiomeMap(baseWorld, options);
  verifyPartition(features, 10000);
  for (const [x, y, biome] of [[5, 5, 'sand'], [15, 15, 'city'], [30, 30, 'park'], [60, 60, 'water'], [80, 80, 'city']]) {
    assert.equal(at(features, x, y).length, 1); assert.equal(at(features, x, y)[0].biome, biome);
  }
  const city = features.find(feature => feature.biome === 'city');
  const sand = features.find(feature => feature.biome === 'sand');
  assert.deepEqual(polygonIntersection(city.parts, sand.parts), [], 'Sand has an actual geometric cut around town, not an overlapping paint order');
});

test('a seasonal river removes all ground beneath its physical ribbon while retaining native width and original paths', () => {
  const options = fixture(), source = options.waterLines[0];
  const { features } = buildBiomeMap(baseWorld, options);
  const water = features.find(feature => feature.waterKind === 'seasonal_river');
  assert.equal(water.geometry, 'polygon'); assert.equal(water.semanticGeometry, 'line');
  assert.equal(water.width, 4); assert.equal(water.nativeWidth, 4); assert.equal(water.sourceKind, 'stream');
  assert.deepEqual(water.paths, source.paths); assert.deepEqual(water.sourceIds, source.sourceIds); assert.deepEqual(water.members, source.members);
  assert.equal(at(features, 50, 46.9)[0].id, water.id); assert.equal(at(features, 50, 47.1)[0].biome, 'forest');
  for (const x of [12, 20.1, 36, 42, 61, 79.9, 89]) assert.equal(at(features, x, 45)[0].id, water.id, 'Dash gaps are still the same semantic river biome');
});

test('water priority clips a crossing seasonal ribbon and keeps lake islands eligible for ground', () => {
  const options = fixture();
  options.waterLines.push({ id: 'permanent', kind: 'river', geometry: 'line', paths: [[p(50, 5), p(50, 95)]], width: 6 });
  options.waterAreas.push(polygon('crossing-lake', 'water', ring(49, 44, 52, 48)));
  const { features } = buildBiomeMap(baseWorld, options);
  verifyPartition(features, 10000);
  assert.equal(at(features, 50, 45)[0].waterKind, 'lake');
  assert.equal(at(features, 48, 45)[0].waterKind, 'river');
  assert.equal(at(features, 45, 45)[0].waterKind, 'seasonal_river');
  assert.equal(at(features, 65, 65)[0].biome, 'forest');
  const wash = features.find(feature => feature.waterKind === 'seasonal_river');
  assert(wash.inkExclusionParts.length > 0); assert.equal(wash.paths.length, 1); assert.deepEqual(wash.paths[0], options.waterLines[0].paths[0]);
});

test('deterministic priority and smaller equal-priority areas do not depend on input ordering', () => {
  const options = fixture();
  options.natureSources.push(polygon('large-rock', 'rock', ring(15, 15, 85, 85)), polygon('small-scrub', 'scrub', ring(24, 24, 38, 38)));
  const first = buildBiomeMap(baseWorld, options);
  const reversed = Object.fromEntries(Object.entries(options).map(([key, values]) => [key, [...values].reverse()]));
  assert.deepEqual(buildBiomeMap(baseWorld, reversed), first);
  assert.equal(at(first.features, 30, 30)[0].biome, 'scrub');
  assert.equal(at(first.features, 37, 37)[0].biome, 'scrub');
});

test('fallback covers a blank map and non-area natural records never invent circles', () => {
  const result = buildBiomeMap(baseWorld, { ...empty, natureSources: [
    { id: 'tree', biome: 'forest', geometry: 'point', points: [p(50, 50)] },
    { id: 'cliff', biome: 'rock', geometry: 'line', points: [p(10, 10), p(30, 30), p(50, 10)] },
  ] });
  assert.equal(result.features.length, 1); assert.equal(result.features[0].fallback, true); assert.equal(result.features[0].biome, 'wasteland');
  verifyPartition(result.features, 10000);
});

test('prepared empty renderer inputs still preserve generated forest, rocky hills, and wetland ground', () => {
  const world = createWorld(), before = structuredClone(world.terrainCells);
  const { features, report } = buildBiomeMap(world, empty);
  assert(report.byBiome.forest.area > 0); assert(report.byBiome.rock.area > 0); assert(report.byBiome.wetland.area > 0);
  assert(Math.abs(report.coveredArea - world.width * world.height) < 1e-6);
  assert.deepEqual(world.terrainCells, before);
  assert(features.some(feature => feature.provenance?.method === 'procedural-ground-cells'));
});

test('the actual Nevada source produces complete exclusive biomes without changing its 893 roofs or any source metadata', () => {
  const before = JSON.stringify(map), { features, report } = buildBiomeMap(map);
  assert.equal(JSON.stringify(map), before); assert.equal(map.buildings.length, 893);
  assert.equal(report.cityFeatures, 3); assert(report.byBiome.seasonal_river.features > 0); assert(report.coverageError < 1e-6);
  assert.equal(report.waterLineFeatures, 33);
  assert(!features.some(feature => feature.waterKind === 'river'), 'Generic Amargosa relation duplicates cannot turn mapped seasonal native ways into permanent water');
  const originalRelation = features.flatMap(feature => feature.members || []).find(feature => feature.sourceId === 'relation-19574302');
  assert(originalRelation); assert.equal(originalRelation.tags.intermittent, undefined, 'The relation source facts remain unchanged');
  assert.equal(new Set(features.map(feature => feature.id)).size, features.length);
  const sand = features.find(feature => feature.sourceId === 'relation-15569711');
  const originalSand = sand.members.find(feature => feature.sourceId === 'relation-15569711');
  assert(originalSand, 'Original multipolygon remains available after its display geometry is cut');
  assert.equal(originalSand.rings.length, 14, 'All 14 original sand rings remain in source metadata');
  // Polygon operators already have exact-area fixture tests above. Real-world
  // sample ownership also catches disconnected cuts, islands and fallback gaps.
  for (let y = 17.13; y < map.height; y += 141.17) for (let x = 13.71; x < map.width; x += 137.23) assert.equal(at(features, x, y).length, 1, `${x}, ${y} has one ground biome`);
});
