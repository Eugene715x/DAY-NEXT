import test from 'node:test';
import assert from 'node:assert/strict';
import { findPath, terrainAt } from '../world.js';
import { prepareMovementGeometry } from '../movement-geometry.js';
import {
  BASE_WALK_METERS_PER_MINUTE, MOVEMENT_FACTORS, biomeSpeedMultiplier, roadSpeedMultiplier,
  cellMovementMultiplier, movementAt, segmentTravel, advanceAlongRoute,
} from '../movement-model.js';

const point = (x, y) => ({ x, y });
function fixture(columns, rows, makeCell = () => ({}), options = {}) {
  const cellSize = options.cellSize || 20;
  return {
    width: columns * cellSize, height: rows * cellSize,
    cols: columns, rows, cellSize, metersPerUnit: options.metersPerUnit || 1,
    movementPrepared: true,
    cells: Array.from({ length: columns * rows }, (_, index) => ({
      type: 'plain', walkable: true, cost: 1, biome: 'wasteland',
      roadClass: null, surface: null, elevationMeters: null,
      ...makeCell(index % columns, Math.floor(index / columns)),
    })),
    ...(options.elevationAt ? { movementElevationAt: options.elevationAt } : {}),
  };
}
const center = (world, x, y) => point((x + .5) * world.cellSize, (y + .5) * world.cellSize);
function sampledPoints(points, spacing = 1) {
  const samples = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / spacing));
    for (let sample = 0; sample <= steps; sample++) {
      const t = sample / steps;
      samples.push(point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
    }
  }
  return samples;
}
function measuredRoute(world, points) {
  let durationMinutes = 0, distance = 0;
  for (let index = 1; index < points.length; index++) {
    const segment = segmentTravel(world, points[index - 1], points[index]);
    assert.equal(segment.walkable, true, 'Every delivered route segment must be traversable');
    durationMinutes += segment.durationMinutes;
    distance += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return { durationMinutes, distance };
}
function gridDijkstra(world, from, to) {
  const start = Math.floor(from.y / world.cellSize) * world.cols + Math.floor(from.x / world.cellSize);
  const target = Math.floor(to.y / world.cellSize) * world.cols + Math.floor(to.x / world.cellSize);
  const durations = Array(world.cells.length).fill(Infinity), closed = new Set();
  durations[start] = 0;
  while (closed.size < world.cells.length) {
    let current = -1;
    for (let i = 0; i < durations.length; i++) if (!closed.has(i) && (current < 0 || durations[i] < durations[current])) current = i;
    if (current < 0 || !Number.isFinite(durations[current])) return Infinity;
    if (current === target) return durations[current];
    closed.add(current);
    const x = current % world.cols, y = Math.floor(current / world.cols);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= world.cols || ny >= world.rows) continue;
      const next = ny * world.cols + nx;
      if (closed.has(next) || !world.cells[next].walkable) continue;
      if (dx && dy && (!world.cells[y * world.cols + nx].walkable || !world.cells[ny * world.cols + x].walkable)) continue;
      const edge = segmentTravel(world, center(world, x, y), center(world, nx, ny));
      if (edge.walkable) durations[next] = Math.min(durations[next], durations[current] + edge.durationMinutes);
    }
  }
  return Infinity;
}

test('paved surfaces and difficult ground contribute distinct, bounded walking multipliers', () => {
  assert.equal(BASE_WALK_METERS_PER_MINUTE, 4000 / 60);
  assert(roadSpeedMultiplier('road', 'asphalt') > roadSpeedMultiplier('road', 'ground'));
  assert(biomeSpeedMultiplier('wasteland') > biomeSpeedMultiplier('sand'));
  assert(biomeSpeedMultiplier('wasteland') > biomeSpeedMultiplier('wetland'));
  const paved = { type: 'road', walkable: true, biome: 'sand', roadClass: 'road', surface: 'asphalt' };
  const loose = { type: 'plain', walkable: true, biome: 'sand' };
  assert(cellMovementMultiplier(paved) > cellMovementMultiplier(loose), 'A road adds its bonus while retaining the underlying sandy biome');
  const world = fixture(2, 2);
  const movement = movementAt(world, 10, 10, point(30, 10));
  assert(Number.isFinite(movement.multiplier) && movement.multiplier > 0 && movement.multiplier < 2);
});

test('every road class adds a positive bonus and absent roads contribute exactly one', () => {
  assert.equal(roadSpeedMultiplier(null), 1);
  assert.equal(roadSpeedMultiplier(undefined, 'asphalt'), 1);
  assert.equal(roadSpeedMultiplier('', 'mud'), 1);
  for (const roadClass of ['highway', 'road', 'street', 'track', 'trail', 'railway']) {
    const base = MOVEMENT_FACTORS.roads[roadClass];
    assert(base > 1);
    assert.equal(roadSpeedMultiplier(roadClass), base);
    for (const surface of Object.keys(MOVEMENT_FACTORS.surfaceQuality)) {
      const multiplier = roadSpeedMultiplier(roadClass, surface);
      assert(multiplier > 1, `${roadClass}/${surface} must preserve a positive road bonus`);
      assert(multiplier <= base, 'Loose material weakens the road bonus without replacing the biome');
    }
  }
});

test('road, biome and landscape factors multiply independently without clipping a normal city highway', () => {
  assert.equal(biomeSpeedMultiplier('city'), 1.05);
  assert.equal(biomeSpeedMultiplier('wasteland'), 1);
  assert.equal(biomeSpeedMultiplier('sand'), .67);
  const make = biome => fixture(2, 2, () => ({ biome, roadClass: 'road', surface: 'asphalt', landscapeMultiplier: .52 }));
  const sand = movementAt(make('sand'), 10, 10), city = movementAt(make('city'), 10, 10);
  assert.equal(sand.biomeMultiplier, .67); assert.equal(city.biomeMultiplier, 1.05);
  assert.equal(sand.roadMultiplier, 1.35); assert.equal(city.roadMultiplier, 1.35);
  assert.equal(sand.landscapeMultiplier, .52);
  assert(Math.abs(sand.multiplier - .67 * 1.35 * .52) < 1e-12);
  assert(Math.abs(city.multiplier - 1.05 * 1.35 * .52) < 1e-12);
  assert(Math.abs(city.multiplier / sand.multiplier - 1.05 / .67) < 1e-12, 'The same road cannot erase the city/sand difference');
  const highway = movementAt(fixture(2, 2, () => ({ biome: 'city', roadClass: 'highway', surface: 'asphalt' })), 10, 10);
  assert(Math.abs(highway.multiplier - 1.05 * 1.5) < 1e-12, 'Independent regular bonuses must not hit the old ×1.5 cap');
  const absent = movementAt(fixture(2, 2, () => ({ biome: 'sand', landscapeMultiplier: .52 })), 10, 10);
  assert.equal(absent.roadMultiplier, 1);
  assert(Math.abs(sand.multiplier / absent.multiplier - 1.35) < 1e-12);
});

test('one road crossing city and sand retains both analytic biome times during actual walking', () => {
  const make = road => fixture(10, 1, x => ({ biome: x < 5 ? 'city' : 'sand', landscapeMultiplier: .52,
    ...(road ? { type: 'road', roadClass: 'road', surface: 'asphalt' } : {}),
  }));
  const world = make(true), from = point(10, 10), to = point(190, 10);
  const cityMinutes = 90 / (BASE_WALK_METERS_PER_MINUTE * 1.05 * 1.35 * .52);
  const sandMinutes = 90 / (BASE_WALK_METERS_PER_MINUTE * .67 * 1.35 * .52);
  const plan = findPath(world, from, to), direct = segmentTravel(world, from, to);
  assert(plan); assert(Math.abs(plan.durationMinutes - cityMinutes - sandMinutes) < 1e-10);
  assert(Math.abs(direct.durationMinutes - plan.durationMinutes) < 1e-10);
  assert(Math.abs(segmentTravel(make(false), from, to).durationMinutes / plan.durationMinutes - 1.35) < 1e-10);
  const player = { ...from }, route = { ...plan, index: 1 };
  const first = advanceAlongRoute(world, route, player, cityMinutes);
  assert(Math.abs(player.x - 100) < 1e-8, 'The full city budget must stop at the biome boundary on the same road');
  assert(Math.abs(first.remainingDurationMinutes - sandMinutes) < 1e-8);
  const last = advanceAlongRoute(world, route, player, sandMinutes + 1);
  assert(last.arrived); assert.deepEqual(player, to);
  assert(Math.abs(first.elapsedMinutes + last.elapsedMinutes - plan.durationMinutes) < 1e-8);
});

test('grade is directional, steep descent is slower than level walking, and missing elevations stay neutral', () => {
  const from = point(10, 30), to = point(190, 30);
  const flat = fixture(10, 3), rising = fixture(10, 3, () => ({}), { elevationAt: x => 1000 + x * .2 });
  const steepDescent = fixture(10, 3, () => ({}), { elevationAt: x => 1000 - x * .65 });
  const baseline = segmentTravel(flat, from, to), uphill = segmentTravel(rising, from, to), downhill = segmentTravel(rising, to, from);
  assert.equal(uphill.walkable, true); assert.equal(downhill.walkable, true);
  assert(uphill.durationMinutes > baseline.durationMinutes);
  assert(uphill.durationMinutes > downhill.durationMinutes, 'Climbing and descending the same slope have different travel times');
  const steep = segmentTravel(steepDescent, from, to);
  assert.equal(steep.walkable, true, 'A game speed penalty is not an invented impassable cliff');
  assert(steep.durationMinutes > baseline.durationMinutes);
  const missing = fixture(10, 3, () => ({ elevationMeters: null }), { elevationAt: () => null });
  assert(Math.abs(segmentTravel(missing, from, to).durationMinutes - baseline.durationMinutes) < 1e-8);
});

test('a nearby asphalt corridor beats a shorter off-road walk', () => {
  const world = fixture(15, 7, (_, y) => y === 2 ? { type: 'road', roadClass: 'road', surface: 'asphalt' } : {});
  const from = center(world, 0, 3), to = center(world, 14, 3);
  const route = findPath(world, from, to), direct = segmentTravel(world, from, to);
  assert(route);
  assert(route.durationMinutes < direct.durationMinutes, 'Routing minimizes walking time, not geometric distance');
  assert(sampledPoints(route.points).some(p => terrainAt(world, p.x, p.y)?.surface === 'asphalt'));
  const measured = measuredRoute(world, route.points);
  assert(Math.abs(route.durationMinutes - measured.durationMinutes) < 1e-5);
});

test('a broad loose-sand patch produces a faster detour instead of a slow straight shortcut', () => {
  const world = fixture(15, 9, (x, y) => x >= 3 && x <= 11 && y >= 2 && y <= 6 ? { biome: 'sand' } : {});
  const from = center(world, 0, 4), to = center(world, 14, 4);
  const original = JSON.stringify(world.cells);
  const route = findPath(world, from, to), direct = segmentTravel(world, from, to);
  assert(route); assert(route.distance > Math.hypot(to.x - from.x, to.y - from.y));
  assert(route.durationMinutes < direct.durationMinutes * .99);
  assert(sampledPoints(route.points).some(p => p.y < 40 || p.y >= 140), 'The route goes around the large patch');
  assert.equal(JSON.stringify(world.cells), original, 'Route planning cannot change the prepared terrain or facts');
});

test('real directional elevation costs can route around a steep mound without making it a hard barrier', () => {
  const elevationAt = (x, y) => 1000 + 110 * Math.exp(-((x - 150) ** 2 + (y - 90) ** 2) / (2 * 38 ** 2));
  const world = fixture(15, 9, () => ({}), { elevationAt });
  const from = center(world, 0, 4), to = center(world, 14, 4);
  const direct = segmentTravel(world, from, to), route = findPath(world, from, to);
  assert.equal(direct.walkable, true); assert(route);
  assert(route.durationMinutes < direct.durationMinutes * .95);
  assert(sampledPoints(route.points).some(p => Math.abs(p.y - from.y) > 20));
});

test('A* and safe route smoothing cannot produce a slower route than the independently solved grid optimum', () => {
  const world = fixture(7, 6, (x, y) => ({
    ...(x === 2 && y > 0 && y < 5 ? { biome: 'sand' } : {}),
    ...(y === 0 ? { type: 'road', roadClass: 'road', surface: 'asphalt' } : {}),
    ...(x === 4 && y === 3 ? { type: 'water', walkable: false, cost: Infinity } : {}),
    ...(x === 4 && y === 4 ? { biome: 'wetland' } : {}),
  }));
  const from = center(world, 0, 3), to = center(world, 6, 3);
  const optimum = gridDijkstra(world, from, to), route = findPath(world, from, to);
  assert(Number.isFinite(optimum)); assert(route);
  assert(route.durationMinutes <= optimum * 1.005 + 1e-6, `Delivered route ${route.durationMinutes} must respect grid optimum ${optimum}`);
  const measured = measuredRoute(world, route.points);
  assert(Math.abs(route.durationMinutes - measured.durationMinutes) < 1e-5);
  assert(Math.abs(route.distance - measured.distance) < 1e-5);
});

test('smoothing preserves shorelines and cannot squeeze through blocked diagonal corners', () => {
  const layout = ['.......', '..###..', '..#.#..', '..###..', '.......'];
  const world = fixture(7, 5, (x, y) => layout[y][x] === '#' ? { type: 'water', walkable: false, cost: Infinity } : {});
  const route = findPath(world, center(world, 0, 2), center(world, 6, 2));
  assert(route);
  for (const sample of sampledPoints(route.points, .5)) assert.equal(terrainAt(world, sample.x, sample.y)?.walkable, true);
  measuredRoute(world, route.points);
  const sealed = fixture(2, 2, (x, y) => x !== y ? { type: 'water', walkable: false, cost: Infinity } : {});
  assert.equal(findPath(sealed, center(sealed, 0, 0), center(sealed, 1, 1)), null);
  assert.equal(segmentTravel(sealed, center(sealed, 0, 0), center(sealed, 1, 1)).walkable, false);
});

test('same-cell exact endpoints have a nonzero valid travel time and physical map scale is honored', () => {
  const world = fixture(2, 2), from = point(2, 3), to = point(16, 17);
  const route = findPath(world, from, to);
  assert(route); assert.deepEqual(route.points[0], from); assert.deepEqual(route.points.at(-1), to);
  assert(route.durationMinutes > 0); assert.equal(route.distance, Math.hypot(to.x - from.x, to.y - from.y));
  assert(Math.abs(route.durationMinutes - segmentTravel(world, from, to).durationMinutes) < 1e-8);
  const largerScale = { ...world, metersPerUnit: 4 };
  assert(Math.abs(segmentTravel(largerScale, from, to).durationMinutes - route.durationMinutes * 4) < 1e-8);
});

test('actual walking consumes the same weighted minutes as the planned ETA across changing ground', () => {
  const world = fixture(25, 1, x => x < 5 ? { type: 'road', roadClass: 'road', surface: 'asphalt' } : x < 15 ? { biome: 'sand' } : {});
  const from = point(10, 10), to = point(490, 10), plan = findPath(world, from, to);
  assert(plan && plan.durationMinutes > 2);
  const route = { ...plan, points: plan.points.map(p => ({ ...p })), index: 1 }, player = { ...from };
  const step = advanceAlongRoute(world, route, player, 2);
  assert(Math.abs(step.elapsedMinutes - 2) < 1e-6);
  assert(Math.abs(step.remainingDurationMinutes - (plan.durationMinutes - 2)) < 1e-3);
  assert(player.x > 100 && player.x < 190, 'A frame crossing the asphalt/sand boundary must spend both surfaces’ time');
  const finish = advanceAlongRoute(world, route, player, plan.durationMinutes + 10);
  assert.equal(finish.arrived, true); assert.deepEqual(player, to);
  assert(Math.abs(step.walkedDistance + finish.walkedDistance - plan.distance) < 1e-4);
  assert(Math.abs(step.elapsedMinutes + finish.elapsedMinutes - plan.durationMinutes) < 1e-3);
  assert.equal(finish.remainingDurationMinutes, 0);
});

test('splitting the same walking-time budget into frames does not change arrival or total game minutes', () => {
  const world = fixture(20, 1, x => x > 3 && x < 13 ? { biome: 'sand' } : {});
  const from = point(10, 10), to = point(390, 10), plan = findPath(world, from, to);
  const a = { ...from }, b = { ...from };
  const routeA = { ...plan, points: plan.points.map(p => ({ ...p })), index: 1 }, routeB = { ...plan, points: plan.points.map(p => ({ ...p })), index: 1 };
  const once = advanceAlongRoute(world, routeA, a, plan.durationMinutes + .1);
  let elapsed = 0, distance = 0;
  for (let i = 0; i < 100 && Math.hypot(b.x - to.x, b.y - to.y) > 1e-7; i++) {
    const step = advanceAlongRoute(world, routeB, b, plan.durationMinutes / 37);
    elapsed += step.elapsedMinutes; distance += step.walkedDistance;
  }
  assert.deepEqual(a, to); assert.deepEqual(b, to);
  assert(Math.abs(elapsed - once.elapsedMinutes) < 1e-3);
  assert(Math.abs(distance - once.walkedDistance) < 1e-4);
});

const costRing = (left, top, right, bottom) => [point(left, top), point(right, top), point(right, bottom), point(left, bottom), point(left, top)];
const attachGeometry = (world, buildings = [], seasonalParts = [], roads = []) => {
  world.buildings = buildings; world.roads = roads;
  world.movementGeometry = prepareMovementGeometry(world, { biomeFeatures: seasonalParts.map((parts, index) => ({ id: `wash-${index}`, biome: 'seasonal_river', geometry: 'polygon', parts })) });
  return world;
};

test('landscape multiplies biome and road speed while uphill penalties are substantially stronger', () => {
  const world = fixture(10, 2, () => ({ biome: 'sand', landscape: 'mountains', landscapeMultiplier: .28 }));
  const flat = movementAt(world, 30, 10);
  assert(Math.abs(flat.multiplier - .67 * .28) < 1e-12);
  assert.equal(flat.landscape, 'mountains'); assert.equal(flat.landscapeMultiplier, .28);
  assert(Math.abs(cellMovementMultiplier(world.cells[0]) - .67 * .28) < 1e-12);
  const rising = fixture(10, 2, () => ({ landscape: 'hills', landscapeMultiplier: .52 }), { elevationAt: x => 1000 + x * .2 });
  const uphill = movementAt(rising, 50, 10, point(190, 10));
  assert(Math.abs(uphill.slopeMultiplier - Math.exp(-7.5 * .2)) < 1e-10);
  assert(Math.abs(uphill.multiplier - .52 * Math.exp(-1.5)) < 1e-10);
  assert(uphill.speedKmh < .5, 'A 20% uphill hill route must be a slow climb');
  const road = fixture(2, 2, () => ({ roadClass: 'road', surface: 'asphalt', landscapeMultiplier: .52 }));
  assert(Math.abs(movementAt(road, 10, 10).multiplier - 1.35 * .52) < 1e-12);
});

test('a narrow building between navigation centres contributes its full exact crossing time', () => {
  const world = attachGeometry(fixture(8, 5), [{ id: 'small', points: costRing(65, 45, 67, 55) }]);
  const from = point(10, 50), to = point(150, 50), direct = segmentTravel(world, from, to);
  const expected = (138 + 2 / .08) / BASE_WALK_METERS_PER_MINUTE;
  assert(Math.abs(direct.durationMinutes - expected) < 1e-9, 'A 2m footprint cannot disappear between 20m grid centres');
  assert.equal(movementAt(world, 66, 50).buildingMultiplier, .08);
  assert.equal(movementAt(world, 64, 50).buildingMultiplier, 1);
  const route = findPath(world, from, to);
  assert(route && route.durationMinutes < direct.durationMinutes);
  assert(route.points.some(p => p.y !== 50));
  assert(route.segments.every(segment => segment.pieces.every(piece => !piece.building)), 'Smoothing cannot restore a cut through the expensive roof');
});

test('building courtyard holes are free of the footprint penalty and targeted buildings remain reachable', () => {
  const world = attachGeometry(fixture(10, 5), [{ id: 'courtyard', rings: [costRing(50, 30, 130, 70), costRing(70, 40, 110, 60)] }]);
  const from = point(10, 50), to = point(190, 50), direct = segmentTravel(world, from, to);
  const expected = (140 + 40 / .08) / BASE_WALK_METERS_PER_MINUTE;
  assert(Math.abs(direct.durationMinutes - expected) < 1e-9);
  assert.equal(movementAt(world, 90, 50).building, false);
  assert.equal(movementAt(world, 60, 50).building, true);
  const targetInside = findPath(world, from, point(60, 50));
  assert(targetInside && Number.isFinite(targetInside.durationMinutes), 'Building penalties must not make entrances or loot targets unreachable');
  const actor = { ...from }, route = { ...targetInside, index: 1 };
  const result = advanceAlongRoute(world, route, actor, targetInside.durationMinutes + 1);
  assert(result.arrived); assert.deepEqual(actor, point(60, 50));
});

test('a narrow seasonal river retains its huge penalty over road paint, with an exact bridge exception', () => {
  const seasonal = [[[costRing(65, 0, 67, 100)]]];
  const make = roads => attachGeometry(fixture(8, 5, x => ({ biome: x === 3 ? 'seasonal_river' : 'wasteland', roadClass: 'road', surface: 'asphalt', landscapeMultiplier: .52 })), [], seasonal, roads);
  const from = point(10, 50), to = point(150, 50);
  const unbridged = make([]), crossing = segmentTravel(unbridged, from, to);
  const expected = (138 + 2 / .12) / (BASE_WALK_METERS_PER_MINUTE * 1.35 * .52);
  assert(Math.abs(crossing.durationMinutes - expected) < 1e-9);
  assert.equal(movementAt(unbridged, 66, 50).biomeMultiplier, 1, 'The dry-river biome must not charge the same seasonal penalty twice');
  assert.equal(movementAt(unbridged, 66, 50).seasonalMultiplier, .12);
  assert.equal(movementAt(unbridged, 70, 50).seasonalMultiplier, 1, 'A coarse river cell cannot enlarge its exact physical penalty');
  const bridged = make([{ id: 'bridge', bridge: true, width: 4, points: [point(60, 50), point(72, 50)] }]);
  assert.equal(movementAt(bridged, 66, 50).seasonalMultiplier, 1);
  assert.equal(movementAt(bridged, 66, 55).seasonalMultiplier, .12, 'A bridge cannot erase river difficulty across an entire coarse navigation cell');
  assert(Math.abs(segmentTravel(bridged, from, to).durationMinutes - 140 / (BASE_WALK_METERS_PER_MINUTE * 1.35 * .52)) < 1e-9);
  const plan = findPath(unbridged, from, to), actor = { ...from }, route = { ...plan, index: 1 };
  const step = advanceAlongRoute(unbridged, route, actor, plan.durationMinutes + 1);
  assert(step.arrived); assert(Math.abs(step.elapsedMinutes - plan.durationMinutes) < 1e-8);
});

test('independent city and road bonuses retain exact building and seasonal penalties once each', () => {
  const world = attachGeometry(fixture(8, 5, () => ({ biome: 'city', roadClass: 'road', surface: 'asphalt', landscapeMultiplier: .52 })),
    [{ id: 'small', points: costRing(65, 45, 67, 55) }], [[[costRing(95, 0, 97, 100)]]]);
  const from = point(10, 50), to = point(150, 50);
  const crossing = segmentTravel(world, from, to);
  const expected = (136 + 2 / .08 + 2 / .12) / (BASE_WALK_METERS_PER_MINUTE * 1.05 * 1.35 * .52);
  assert(Math.abs(crossing.durationMinutes - expected) < 1e-9, 'Road and city benefits must not overwrite exact narrow obstacles');
  const building = movementAt(world, 66, 50), wash = movementAt(world, 96, 50);
  assert.equal(building.biomeMultiplier, 1.05); assert.equal(building.roadMultiplier, 1.35); assert.equal(building.buildingMultiplier, .08);
  assert.equal(wash.biomeMultiplier, 1.05); assert.equal(wash.roadMultiplier, 1.35); assert.equal(wash.seasonalMultiplier, .12);
  assert.equal(wash.buildingMultiplier, 1);
  assert(Math.abs(wash.multiplier - 1.05 * 1.35 * .52 * .12) < 1e-12);
});


test('landscape lower-bound search and its edge cache preserve the independent weighted optimum', () => {
  const world = fixture(32, 32, (x, y) => ({
    landscape: x >= 10 && x <= 21 && y >= 2 && y <= 29 ? 'mountains' : 'plain',
    landscapeMultiplier: x >= 10 && x <= 21 && y >= 2 && y <= 29 ? .28 : 1,
    ...(x === 18 && y === 30 ? { walkable: false, type: 'water', cost: Infinity } : {}),
  }));
  world.metadata = { movement: { landscapeSamples: world.cells.length } }; world.movementRevision = 1;
  const from = center(world, 0, 16), to = center(world, 31, 16);
  for (const destination of [to, center(world, 31, 7), to]) {
    const optimum = gridDijkstra(world, from, destination), route = findPath(world, from, destination);
    assert(route); assert.equal(route.search.heuristic, 'landscape-lower-bound');
    assert(route.durationMinutes <= optimum * 1.001 + 1e-8);
    assert(Math.abs(measuredRoute(world, route.points).durationMinutes - route.durationMinutes) < 1e-8);
  }
  for (const cell of world.cells) cell.landscapeMultiplier = 1;
  world.movementRevision++;
  const revised = findPath(world, from, to), optimum = gridDijkstra(world, from, to);
  assert(revised.durationMinutes <= optimum * 1.001 + 1e-8, 'Map preparation revision invalidates cached costs');
});
