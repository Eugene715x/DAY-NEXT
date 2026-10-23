import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealWorld, prepareTravelWorld } from '../real-world.js';
import { terrainAt } from '../world.js';
import { cellMovementMultiplier } from '../movement-model.js';
import { buildBiomeMap } from '../biome-map.js';
import { createElevationRenderer } from '../elevation-renderer.js';
import map from '../maps/usa.js';
import elevation from '../maps/beatty-elevation.js';

const ring = (left, top, right, bottom) => [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }, { x: left, y: top }];
const polygon = (biome, rings, extras = {}) => ({ id: biome, biome, geometry: 'polygon', parts: [rings], exclusive: true, ...extras });
const fixture = (extra = {}) => ({ version: 1, id: 'travel-prep', name: 'Test travel', bbox: [-117, 36, -116.9, 36.1], width: 300, height: 200, cellSize: 10, metersPerUnit: 2, areas: [], roads: [], rivers: [], buildings: [], details: [], pois: [], start: { x: 25, y: 95 }, ...extra });
const byPosition = (world, x, y) => terrainAt(world, x, y);

test('runtime refinement preserves source geometry and adapts to the navigation node limit', () => {
  const source = fixture(), before = structuredClone(source);
  const old = createRealWorld(source), fine = createRealWorld(source, { navigationCellSize: 2.5 });
  assert.equal(old.cellSize, 10);
  assert.equal(fine.cellSize, 2.5); assert.equal(fine.cells.length, 9600);
  assert.equal(fine.metadata.navigationResolutionMeters, 5); assert.equal(fine.metadata.navigationSubdivision, 4);
  assert.deepEqual(source, before);
  const capped = createRealWorld(fixture({ width: 1000, height: 1000, cellSize: 5 }), { navigationCellSize: .5 });
  assert.equal(capped.cellSize, 2.5); assert.equal(capped.cells.length, 160000);
  assert(capped.cells.length <= 250000);
  assert.throws(() => createRealWorld(source, { navigationCellSize: 0 }), /navigation cell/);
});

test('exclusive biome scanlines preserve holes and use the same movement table as travel', () => {
  const world = createRealWorld(fixture());
  const biomes = [
    polygon('wasteland', [ring(0, 0, 300, 200)], { fallback: true }),
    polygon('forest', [ring(10, 10, 180, 160), ring(60, 60, 100, 100)]),
    polygon('sand', [ring(210, 10, 290, 80)]),
    polygon('seasonal_river', [ring(190, 100, 290, 130)], { water: true, waterKind: 'seasonal_river' }),
  ];
  const before = JSON.stringify(biomes), stats = prepareTravelWorld(world, { biomeFeatures: biomes, elevationAt: (x, y) => 1000 + x / 10 + y / 20 });
  assert.equal(byPosition(world, 25, 25).biome, 'forest');
  assert.equal(byPosition(world, 75, 75).biome, 'wasteland', 'A woodland hole belongs to the underlying ground');
  assert.equal(byPosition(world, 235, 35).biome, 'sand');
  const wash = byPosition(world, 235, 115);
  assert.equal(wash.biome, 'seasonal_river'); assert(wash.walkable);
  assert.equal(byPosition(world, 25, 25).elevationMeters, 1003.75);
  for (const cell of world.cells) assert.equal(cell.cost, 1 / cellMovementMultiplier(cell));
  assert.equal(stats.elevationSamples, world.cells.length); assert.equal(world.relief, true);
  assert.equal(JSON.stringify(biomes), before, 'Raster preparation must not edit display/source geometry');
});

test('newly represented permanent water blocks travel except at an explicitly mapped bridge', () => {
  const biomes = [polygon('water', [ring(130, 0, 170, 200)], { water: true, waterKind: 'lake' })];
  for (const bridge of [false, true]) {
    const source = fixture({ roads: [{ id: 'crossing', type: 'residential', surface: 'asphalt', width: 3, bridge, points: [{ x: 50, y: 95 }, { x: 250, y: 95 }] }], pois: [{ id: 'east', name: 'East bank', x: 235, y: 95 }] });
    const before = JSON.stringify(source), world = createRealWorld(source);
    prepareTravelWorld(world, { biomeFeatures: biomes });
    const crossing = byPosition(world, 145, 95);
    assert.equal(crossing.walkable, bridge);
    assert.equal(crossing.type, bridge ? 'bridge' : 'water');
    assert.equal(crossing.biome, 'water');
    assert.equal(Number.isFinite(crossing.cost), bridge);
    assert.equal(world.pois[0].reachable, bridge);
    assert.equal(byPosition(world, 145, 35).walkable, false);
    assert.equal(JSON.stringify(source), before);
  }
});

test('native road classes, surfaces and centreline anchors survive with a positive bonus on every corridor', () => {
  const source = fixture({
    roads: [
      { id: 'asphalt', type: 'primary', surface: 'asphalt', width: 3, points: [{ x: 10, y: 35 }, { x: 290, y: 35 }] },
      { id: 'gravel', type: 'secondary', surface: 'gravel', width: 3, points: [{ x: 10, y: 85 }, { x: 290, y: 85 }] },
      { id: 'dirt', type: 'track', surface: 'dirt', width: 3, points: [{ x: 10, y: 135 }, { x: 290, y: 135 }] },
    ],
    details: [{ id: 'rail', geometry: 'line', kind: 'railway', tags: { railway: 'abandoned' }, points: [{ x: 10, y: 175 }, { x: 290, y: 175 }] }],
  });
  const before = JSON.stringify(source), world = createRealWorld(source);
  const report = prepareTravelWorld(world);
  const asphalt = byPosition(world, 55, 35), gravel = byPosition(world, 55, 85), dirt = byPosition(world, 55, 135), rail = byPosition(world, 55, 175);
  assert.equal(asphalt.roadClass, 'highway'); assert.equal(asphalt.surface, 'asphalt');
  assert.equal(gravel.roadClass, 'road'); assert.equal(dirt.roadClass, 'track'); assert.equal(rail.roadClass, 'railway');
  assert(asphalt.cost < gravel.cost); assert(asphalt.cost < dirt.cost); assert(rail.cost > asphalt.cost);
  for (const cell of [asphalt, gravel, dirt, rail]) assert(cell.cost < 1, 'Every road corridor must improve its underlying neutral biome');
  assert.deepEqual(asphalt.roadAnchor, { x: 55, y: 35 });
  for (let index = 0; index < world.cells.length; index++) if (world.cells[index].roadAnchor) {
    const point = world.cells[index].roadAnchor, left = index % world.cols * world.cellSize, top = Math.floor(index / world.cols) * world.cellSize;
    assert(point.x >= left && point.x < left + world.cellSize && point.y >= top && point.y < top + world.cellSize);
  }
  assert.equal(report.roadSources, 4); assert.equal(report.elevationSamples, 0); assert.equal(world.relief, false);
  assert(world.cells.every(cell => cell.elevationMeters === null), 'Unavailable DEM cannot become fabricated zero elevations');
  assert.equal(JSON.stringify(source), before);
});

test('one prepared highway retains distinct city and sand factors while multiplying landscape', () => {
  const source = fixture({ roads: [{ id: 'one-road', type: 'primary', surface: 'asphalt', width: 3,
    points: [{ x: 10, y: 95 }, { x: 290, y: 95 }] }] });
  const before = JSON.stringify(source), world = createRealWorld(source);
  const biomeFeatures = [polygon('city', [ring(0, 0, 150, 200)]), polygon('sand', [ring(150, 0, 300, 200)])];
  const landscape = { getAt: () => ({ id: 'hills', multiplier: .52, slopePercent: 12, reliefMeters: 100 }) };
  prepareTravelWorld(world, { biomeFeatures, landscape });
  const cityRoad = byPosition(world, 55, 95), sandRoad = byPosition(world, 235, 95);
  assert.equal(cityRoad.biome, 'city'); assert.equal(sandRoad.biome, 'sand');
  assert.equal(cityRoad.roadClass, 'highway'); assert.equal(sandRoad.roadClass, 'highway');
  assert.equal(cityRoad.landscape, 'hills'); assert.equal(sandRoad.landscape, 'hills');
  assert(Math.abs(cityRoad.cost - 1 / (1.05 * 1.5 * .52)) < 1e-10);
  assert(Math.abs(sandRoad.cost - 1 / (.67 * 1.5 * .52)) < 1e-10);
  assert(cityRoad.cost < sandRoad.cost, 'The road remains a bonus instead of replacing both biomes with one cost');
  assert.equal(JSON.stringify(source), before);
});

test('visual visibility flags never remove physical movement costs or barriers', () => {
  const source = fixture(), polygons = [polygon('sand', [ring(0, 0, 300, 200)])];
  const on = createRealWorld(source), off = createRealWorld(source);
  prepareTravelWorld(on, { biomeFeatures: polygons });
  prepareTravelWorld(off, { biomeFeatures: polygons.map(feature => ({ ...feature, enabled: false })) });
  assert.deepEqual(off.cells, on.cells);
});

test('the real Nevada map prepares 24 metre navigation from exact source biomes and real DEM', () => {
  const sourceBefore = JSON.stringify(map), world = createRealWorld(map, { navigationCellSize: 6.25 });
  const sampler = createElevationRenderer(world, elevation), biomes = buildBiomeMap(world).features;
  const report = prepareTravelWorld(world, { biomeFeatures: biomes, elevationAt: sampler.sampleAt });
  assert.equal(world.cells.length, 178560); assert.equal(report.elevationSamples, 178560);
  assert(report.resolutionMeters > 24 && report.resolutionMeters < 25);
  assert.equal(world.buildings.length, 893); assert.equal(world.roads.length, map.roads.length);
  assert.equal(report.biomeCounts.city > 0, true); assert.equal(report.biomeCounts.sand > 0, true);
  assert.equal(report.biomeCounts.seasonal_river > 0, true);
  assert(world.cells.some(cell => cell.roadClass === 'railway'));
  assert(world.cells.every(cell => cell.walkable ? Number.isFinite(cell.cost) && cell.cost > 0 : cell.cost === Infinity));
  assert(byPosition(world, world.start.x, world.start.y).walkable);
  assert.equal(world.metadata.startSnapDistanceMeters, 0);
  assert.equal(JSON.stringify(map), sourceBefore);
});


test('independent landscape samples enter navigation multiplicatively while unknown coverage stays neutral', () => {
  const source = fixture({ buildings: [{ id: 'tiny-building', points: ring(23, 23, 24, 24) }] });
  const world = createRealWorld(source), before = JSON.stringify(source);
  const landscape = { getAt: (x, y) => x < 150 ? { id: 'hills', multiplier: .52, slopePercent: 12, reliefMeters: 100 } : null };
  const report = prepareTravelWorld(world, { landscape });
  const hills = byPosition(world, 25, 25), unknown = byPosition(world, 225, 25);
  assert.equal(hills.landscape, 'hills'); assert.equal(hills.landscapeMultiplier, .52);
  assert.equal(hills.landscapeSlopePercent, 12); assert.equal(hills.landscapeReliefMeters, 100);
  assert.equal(unknown.landscape, null); assert.equal(unknown.landscapeMultiplier, 1);
  assert(Math.abs(hills.cost - 1 / .52) < 1e-10);
  assert.equal(report.landscapeSamples, world.cells.length / 2);
  assert.equal(report.geometry.buildings, 1);
  assert.equal(world.movementGeometry.queryPoint(23.5, 23.5).building, true);
  assert.equal(world.movementGeometry.queryPoint(25, 25).building, false);
  assert.equal(JSON.stringify(source), before);
});
