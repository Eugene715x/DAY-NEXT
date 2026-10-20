import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, findPath, nearestWalkable, terrainAt } from '../world.js';

const world = createWorld();

function sampleRoute(route, targetWorld = world) {
  const samples = [];
  for (let i = 1; i < route.points.length; i++) {
    const from = route.points[i - 1];
    const to = route.points[i];
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(distance / (targetWorld.cellSize / 8)));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      samples.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
  }
  return samples;
}

function smallWorld(layout) {
  const cellSize = 10;
  const cols = layout[0].length;
  const rows = layout.length;
  return {
    width: cols * cellSize,
    height: rows * cellSize,
    cellSize,
    cols,
    rows,
    cells: layout.flatMap(row => [...row].map(character => ({
      type: character === '#' ? 'water' : character === '~' ? 'swamp' : 'plain',
      height: 0,
      walkable: character !== '#',
      cost: character === '#' ? Infinity : character === '~' ? 8 : 1,
      radiation: 0,
    }))),
  };
}

test('один seed воспроизводит ту же карту, локации и старт', () => {
  const fresh = createWorld();
  assert.deepEqual(fresh, world);
  // Changing exploration in one game cannot leak into a new game.
  fresh.pois[0].discovered = !fresh.pois[0].discovered;
  assert.notEqual(fresh.pois[0].discovered, world.pois[0].discovered);
  assert.deepEqual(createWorld(), world);
});

test('от старта можно дойти до каждой локации с точным прибытием', () => {
  for (const poi of world.pois) {
    const route = findPath(world, world.start, poi);
    assert.ok(route, `Недоступная локация: ${poi.name}`);
    assert.deepEqual(route.points[0], world.start, `Неверная начальная точка: ${poi.name}`);
    assert.deepEqual(route.points.at(-1), { x: poi.x, y: poi.y }, `Неверная конечная точка: ${poi.name}`);
    const measuredDistance = route.points.slice(1).reduce((sum, point, index) => {
      const previous = route.points[index];
      return sum + Math.hypot(point.x - previous.x, point.y - previous.y);
    }, 0);
    assert.ok(Number.isFinite(route.distance) && route.distance > 0);
    assert.ok(Math.abs(route.distance - measuredDistance) < 0.001, `Неверная длина пути: ${poi.name}`);
  }
});

test('отрезки маршрутов между поворотами не пересекают воду', () => {
  for (const poi of world.pois) {
    const route = findPath(world, world.start, poi);
    assert.ok(route, `Нет маршрута к ${poi.name}`);
    for (const sample of sampleRoute(route)) {
      assert.equal(terrainAt(world, sample.x, sample.y)?.walkable, true,
        `Маршрут к ${poi.name} пересекает воду: ${sample.x}, ${sample.y}`);
    }
  }
});

test('переход на восточный берег проходит по мосту', () => {
  const easternTown = world.pois.find(poi => poi.id === 'stekolny');
  const route = findPath(world, world.start, easternTown);
  assert.ok(route, 'Нет маршрута на восточный берег');
  const terrain = sampleRoute(route).map(point => terrainAt(world, point.x, point.y)?.type);
  assert.ok(terrain.includes('bridge'), 'Река должна пересекаться через мост');
  assert.ok(!terrain.includes('water'), 'Пересечение реки не должно вести по воде');
});

test('вода и точки за пределами карты отклоняются без ложного маршрута', () => {
  const index = world.cells.findIndex(cell => !cell.walkable);
  assert.ok(index >= 0, 'Для проверки нужна вода на карте');
  const water = {
    x: (index % world.cols + 0.5) * world.cellSize,
    y: (Math.floor(index / world.cols) + 0.5) * world.cellSize,
  };
  for (const target of [water, { x: -1, y: 10 }, { x: world.width, y: 10 }, { x: 10, y: world.height }, { x: NaN, y: 10 }]) {
    assert.equal(findPath(world, world.start, target), null, `Неверная цель принята: ${JSON.stringify(target)}`);
  }
  const shore = nearestWalkable(world, water.x, water.y);
  assert.ok(shore && terrainAt(world, shore.x, shore.y)?.walkable, 'Поиск берега должен возвращать сушу');
  assert.ok(findPath(world, world.start, shore), 'Найденный берег должен быть доступен пешком');
});

test('по диагонали нельзя протиснуться между непроходимыми клетками', () => {
  const sealedCorner = smallWorld(['.#', '#.']);
  assert.equal(findPath(sealedCorner, { x: 5, y: 5 }, { x: 15, y: 15 }), null);

  const oneBlockedCorner = smallWorld(['.#', '..']);
  const route = findPath(oneBlockedCorner, { x: 5, y: 5 }, { x: 15, y: 15 });
  assert.ok(route, 'Обход через нижнюю клетку должен оставаться доступным');
  assert.ok(route.distance >= 20, 'Диагональный срез угла короче допустимого обхода');
  for (const point of sampleRoute(route, oneBlockedCorner)) {
    assert.equal(terrainAt(oneBlockedCorner, point.x, point.y)?.walkable, true);
  }
});

test('пешеход предпочитает короткий обход тяжёлого болота прямому пути через него', () => {
  const swamp = smallWorld(['.....', '.~~~.', '.....']);
  const from = { x: 5, y: 15 };
  const to = { x: 45, y: 15 };
  const route = findPath(swamp, from, to);
  assert.ok(route);
  assert.ok(route.distance > Math.hypot(to.x - from.x, to.y - from.y), 'Маршрут должен делать обход');
  // A diagonal can touch a traversable swamp cell's corner without entering it.
  const interiorSamples = sampleRoute(route, swamp).filter(point =>
    Math.abs(point.x / swamp.cellSize - Math.round(point.x / swamp.cellSize)) > 1e-9 &&
    Math.abs(point.y / swamp.cellSize - Math.round(point.y / swamp.cellSize)) > 1e-9);
  assert.ok(interiorSamples.every(point => terrainAt(swamp, point.x, point.y)?.type !== 'swamp'),
    'На этом участке обход по суше быстрее, чем переход болота');
});
