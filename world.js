/** Deterministic world generation and weighted, water-aware navigation. */
const WIDTH = 3000;
const HEIGHT = 2200;
const CELL_SIZE = 25;
const SEED = 715;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hash(x, y, seed = SEED) {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function noise(x, y, scale, seed = SEED) {
  x /= scale;
  y /= scale;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = hash(ix, iy, seed) * (1 - sx) + hash(ix + 1, iy, seed) * sx;
  const bottom = hash(ix, iy + 1, seed) * (1 - sx) + hash(ix + 1, iy + 1, seed) * sx;
  return top * (1 - sy) + bottom * sy;
}

function segmentDistance(x, y, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? clamp(((x - a.x) * dx + (y - a.y) * dy) / lengthSquared, 0, 1) : 0;
  return Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
}

function polylineDistance(x, y, points) {
  let distance = Infinity;
  for (let i = 1; i < points.length; i++) {
    distance = Math.min(distance, segmentDistance(x, y, points[i - 1], points[i]));
  }
  return distance;
}

export function createWorld() {
  const cols = WIDTH / CELL_SIZE;
  const rows = HEIGHT / CELL_SIZE;
  const riverPoints = [];
  for (let y = -160; y <= HEIGHT + 160; y += 80) {
    riverPoints.push({ x: 2200 - y * 0.43 + Math.sin(y / 280) * 150, y });
  }
  const rivers = [{ name: 'Река Серая', points: riverPoints, width: 86 }];
  const lakes = [
    { name: 'Тихое озеро', x: 620, y: 570, rx: 290, ry: 180 },
    { name: 'Чёрная вода', x: 2600, y: 1280, rx: 145, ry: 100 },
  ];
  const roads = [
    { points: [{ x: 160, y: 1470 }, { x: 800, y: 1300 }, { x: 1250, y: 1160 }, { x: 1660, y: 1120 }, { x: 2150, y: 950 }, { x: 2820, y: 910 }], width: 18 },
    { points: [{ x: 730, y: 170 }, { x: 1000, y: 670 }, { x: 1250, y: 1160 }, { x: 1240, y: 1610 }, { x: 1100, y: 2070 }], width: 14 },
    { points: [{ x: 2400, y: 170 }, { x: 2310, y: 740 }, { x: 2150, y: 950 }, { x: 2050, y: 1550 }, { x: 2390, y: 2020 }], width: 14 },
    { points: [{ x: 1100, y: 2070 }, { x: 1430, y: 1840 }, { x: 1800, y: 1650 }, { x: 2050, y: 1550 }], width: 14 },
    { points: [{ x: 1000, y: 670 }, { x: 1330, y: 430 }, { x: 1820, y: 440 }, { x: 2310, y: 740 }], width: 11 },
  ];
  const radiationZones = [
    { x: 2550, y: 1730, radius: 280, strength: 0.8 },
    { x: 440, y: 1880, radius: 190, strength: 0.45 },
  ];
  const cells = new Array(cols * rows);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x = (gx + 0.5) * CELL_SIZE;
      const y = (gy + 0.5) * CELL_SIZE;
      const height = noise(x, y, 330) * 0.62 + noise(x, y, 105, SEED + 1) * 0.26 + noise(x, y, 40, SEED + 2) * 0.12;
      const moisture = noise(x + 1300, y - 700, 230, SEED + 3) * 0.72 + noise(x, y, 70, SEED + 4) * 0.28;
      const riverDistance = polylineDistance(x, y, riverPoints);
      let inLake = false;
      let lakeshore = false;
      for (const lake of lakes) {
        const distortion = 1 + Math.sin(x / 85) * 0.055 + Math.cos(y / 61) * 0.04;
        const ellipse = ((x - lake.x) / lake.rx) ** 2 + ((y - lake.y) / lake.ry) ** 2;
        if (ellipse < distortion) inLake = true;
        if (ellipse < distortion + 0.4) lakeshore = true;
      }
      let type = 'plain';
      let cost = 1;
      if (height > 0.64) { type = 'hill'; cost = 1.7; }
      if (moisture > 0.46 && height < 0.68) { type = 'forest'; cost = 1.45; }
      if ((riverDistance < 100 || lakeshore) && moisture > 0.45) { type = 'swamp'; cost = 2.1; }
      if (inLake || riverDistance < 43) { type = 'water'; cost = Infinity; }
      // The raster corridor is wider than the ink road so bridge cells stay connected.
      const onRoad = roads.some(road => polylineDistance(x, y, road.points) <= Math.max(19, road.width));
      if (onRoad) { type = type === 'water' ? 'bridge' : 'road'; cost = 0.75; }
      let radiation = 0;
      for (const zone of radiationZones) {
        radiation = Math.max(radiation, Math.max(0, 1 - Math.hypot(x - zone.x, y - zone.y) / zone.radius) * zone.strength);
      }
      cells[gy * cols + gx] = { type, height, cost, walkable: type !== 'water', radiation };
    }
  }
  const pois = [
    { id: 'rubezh', name: 'РУБЕЖ', x: 1250, y: 1160, kind: 'shelter', description: 'Тёплый свет за частоколом. Здесь начинается твой путь.', discovered: true },
    { id: 'kordon', name: 'ЛЕСНОЙ КОРДОН', x: 800, y: 1300, kind: 'camp', description: 'Заброшенный дом лесника на краю елового леса.', discovered: true },
    { id: 'north', name: 'СЕВЕРНАЯ-8', x: 1330, y: 600, kind: 'station', description: 'Станция, откуда больше не уходят поезда.', discovered: false },
    { id: 'stekolny', name: 'СТЕКОЛЬНЫЙ', x: 2310, y: 740, kind: 'town', description: 'Пустые улицы заводского городка. Окна смотрят на восток.', discovered: false },
    { id: 'crossing', name: 'ПЕРЕПРАВА', x: 1640, y: 1120, kind: 'bridge', description: 'Уцелевший мост через Серую. На перилах — свежие зарубки.', discovered: true },
    { id: 'tikhaya', name: 'ТИХАЯ ПРИСТАНЬ', x: 730, y: 800, kind: 'ruin', description: 'Рыбацкие лодки застыли у потемневших свай.', discovered: false },
    { id: 'weather', name: 'МЕТЕОСТАНЦИЯ', x: 730, y: 180, kind: 'tower', description: 'Ржавая антенна всё ещё ловит ветер.', discovered: false },
    { id: 'south', name: 'ЮЖНЫЙ ПОСТ', x: 1100, y: 2070, kind: 'camp', description: 'Дорожный блокпост. Костёр давно остыл.', discovered: false },
    { id: 'depot', name: 'СТАРОЕ ДЕПО', x: 2050, y: 1550, kind: 'ruin', description: 'Пустые ангары и колея, уходящая в траву.', discovered: false },
    { id: 'vector', name: 'ОБЪЕКТ «ВЕКТОР»', x: 2550, y: 1730, kind: 'danger', description: 'За бетоном тихо щёлкает дозиметр. Долго здесь не задерживайся.', discovered: false },
    { id: 'redhill', name: 'КРАСНЫЙ ХОЛМ', x: 460, y: 1880, kind: 'danger', description: 'Выжженный склон. Пыль здесь лучше не поднимать.', discovered: false },
    { id: 'east', name: 'ВОСТОЧНЫЙ ТРАКТ', x: 2780, y: 910, kind: 'station', description: 'Старая дорога уходит за край карты. Пока ты остаёшься здесь.', discovered: false },
  ];
  const world = { width: WIDTH, height: HEIGHT, cols, rows, cellSize: CELL_SIZE, cells, pois, roads, rivers, lakes, radiationZones, seed: SEED, start: { x: 1125, y: 1125 } };
  for (const poi of pois) {
    if (!terrainAt(world, poi.x, poi.y)?.walkable) Object.assign(poi, nearestWalkable(world, poi.x, poi.y));
  }
  world.start = nearestWalkable(world, world.start.x, world.start.y);
  return world;
}

export function terrainAt(world, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= world.width || y >= world.height) return null;
  return world.cells[Math.floor(y / world.cellSize) * world.cols + Math.floor(x / world.cellSize)];
}

export function nearestWalkable(world, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  x = clamp(x, 0, world.width - 0.001);
  y = clamp(y, 0, world.height - 0.001);
  if (terrainAt(world, x, y)?.walkable) return { x, y };
  let nearest = null;
  let distance = Infinity;
  for (let i = 0; i < world.cells.length; i++) {
    if (!world.cells[i].walkable) continue;
    const point = { x: ((i % world.cols) + 0.5) * world.cellSize, y: (Math.floor(i / world.cols) + 0.5) * world.cellSize };
    const d = (point.x - x) ** 2 + (point.y - y) ** 2;
    if (d < distance) { distance = d; nearest = point; }
  }
  return nearest;
}

class MinHeap {
  constructor() { this.items = []; }
  push(item) {
    const a = this.items;
    let i = a.length;
    a.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent].f <= item.f) break;
      a[i] = a[parent];
      i = parent;
    }
    a[i] = item;
  }
  pop() {
    const a = this.items;
    const root = a[0];
    const last = a.pop();
    if (a.length) {
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let child = i * 2 + 1;
        if (child + 1 < a.length && a[child + 1].f < a[child].f) child++;
        if (a[child].f >= last.f) break;
        a[i] = a[child];
        i = child;
      }
      a[i] = last;
    }
    return root;
  }
}

function heuristic(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * 0.75;
}

/** A route follows terrain costs, never enters water, and cannot cut water corners. */
export function findPath(world, from, to) {
  if (!from || !to || !terrainAt(world, from.x, from.y)?.walkable || !terrainAt(world, to.x, to.y)?.walkable) return null;
  const size = world.cellSize;
  const sx = Math.floor(from.x / size);
  const sy = Math.floor(from.y / size);
  const tx = Math.floor(to.x / size);
  const ty = Math.floor(to.y / size);
  const start = sy * world.cols + sx;
  const target = ty * world.cols + tx;
  if (start === target) return { points: [{ x: from.x, y: from.y }, { x: to.x, y: to.y }], distance: Math.hypot(to.x - from.x, to.y - from.y) };
  const scores = new Float64Array(world.cells.length);
  scores.fill(Infinity);
  const parents = new Int32Array(world.cells.length);
  parents.fill(-1);
  const closed = new Uint8Array(world.cells.length);
  const heap = new MinHeap();
  scores[start] = 0;
  heap.push({ id: start, f: heuristic(sx, sy, tx, ty) });
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (heap.items.length) {
    const current = heap.pop().id;
    if (closed[current]) continue;
    if (current === target) {
      const ids = [];
      for (let id = target; id !== -1; id = parents[id]) ids.push(id);
      ids.reverse();
      const centers = ids.map(id => ({ x: ((id % world.cols) + 0.5) * size, y: (Math.floor(id / world.cols) + 0.5) * size }));
      const simplified = [centers[0]];
      for (let i = 1; i < centers.length - 1; i++) {
        const before = centers[i - 1];
        const here = centers[i];
        const after = centers[i + 1];
        if ((here.x - before.x) * (after.y - here.y) !== (here.y - before.y) * (after.x - here.x)) simplified.push(here);
      }
      simplified.push(centers[centers.length - 1]);
      const points = [{ x: from.x, y: from.y }, ...simplified, { x: to.x, y: to.y }];
      // Exact endpoints connect only within their already-validated start/end cells.
      const compact = points.filter((point, i) => !i || Math.hypot(point.x - points[i - 1].x, point.y - points[i - 1].y) > 0.01);
      let distance = 0;
      for (let i = 1; i < compact.length; i++) distance += Math.hypot(compact[i].x - compact[i - 1].x, compact[i].y - compact[i - 1].y);
      return { points: compact, distance };
    }
    closed[current] = 1;
    const cx = current % world.cols;
    const cy = Math.floor(current / world.cols);
    for (const [dx, dy] of directions) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= world.cols || ny >= world.rows) continue;
      const next = ny * world.cols + nx;
      if (closed[next] || !world.cells[next].walkable) continue;
      if (dx && dy && (!world.cells[cy * world.cols + nx].walkable || !world.cells[ny * world.cols + cx].walkable)) continue;
      const cost = (world.cells[current].cost + world.cells[next].cost) * 0.5 * (dx && dy ? Math.SQRT2 : 1);
      const score = scores[current] + cost;
      if (score < scores[next]) {
        parents[next] = current;
        scores[next] = score;
        heap.push({ id: next, f: score + heuristic(nx, ny, tx, ty) });
      }
    }
  }
  return null;
}
