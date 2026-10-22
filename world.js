import { segmentTravel, BASE_WALK_METERS_PER_MINUTE, MAX_MOVEMENT_MULTIPLIER } from './movement-model.js';

/** Weighted, water-aware navigation shared by imported real maps. */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function navigationPoint(world, id) {
  const x = id % world.cols, y = Math.floor(id / world.cols), size = world.cellSize;
  const anchor = world.cells[id].roadAnchor;
  if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
    && anchor.x > x * size && anchor.x < (x + 1) * size && anchor.y > y * size && anchor.y < (y + 1) * size) return { x: anchor.x, y: anchor.y };
  return { x: (x + .5) * size, y: (y + .5) * size };
}

const routeDistance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
function describeRoute(world, points, search = {}) {
  const compact = points.filter((point, index) => !index || routeDistance(point, points[index - 1]) > 1e-8).map(point => ({ x: point.x, y: point.y }));
  if (compact.length === 1) compact.push({ ...compact[0] });
  const segments = [];
  let distance = 0, durationMinutes = 0;
  for (let index = 1; index < compact.length; index++) {
    const segment = segmentTravel(world, compact[index - 1], compact[index]);
    if (!segment.walkable) return null;
    distance += segment.distance; durationMinutes += segment.durationMinutes;
    segments.push({ ...segment, from: { ...compact[index - 1] }, to: { ...compact[index] } });
  }
  return { points: compact, distance, durationMinutes, segments, search };
}

function smoothRoute(world, points) {
  if (points.length < 3) return points;
  const prefix = [0];
  for (let i = 1; i < points.length; i++) prefix.push(prefix.at(-1) + segmentTravel(world, points[i - 1], points[i], { detailed: false }).durationMinutes);
  const result = [points[0]];
  let index = 0;
  while (index < points.length - 1) {
    let selected = index + 1;
    // Bounded string pulling removes grid zigzags without a quadratic full-map
    // visibility search. Each shortcut must respect both water and travel time.
    for (let candidate = Math.min(points.length - 1, index + 48); candidate > index + 1; candidate--) {
      const direct = segmentTravel(world, points[index], points[candidate], { detailed: false });
      const originalTime = prefix[candidate] - prefix[index];
      if (direct.walkable && direct.durationMinutes <= originalTime * 1.001 + 1e-9) { selected = candidate; break; }
    }
    result.push(points[selected]); index = selected;
  }
  return result;
}

/**
 * Directed least-time A* over the navigation grid. Real road-centre anchors keep
 * road legs on mapped geometry; visibility smoothing cannot cut expensive ground
 * or water corners. All returned times use the actor's shared movement model.
 */
export function findPath(world, from, to) {
  if (!from || !to || !terrainAt(world, from.x, from.y)?.walkable || !terrainAt(world, to.x, to.y)?.walkable) return null;
  const size = world.cellSize;
  const sx = Math.floor(from.x / size), sy = Math.floor(from.y / size);
  const tx = Math.floor(to.x / size), ty = Math.floor(to.y / size);
  const start = sy * world.cols + sx, target = ty * world.cols + tx;
  if (start === target) return describeRoute(world, [{ x: from.x, y: from.y }, { x: to.x, y: to.y }], { visited: 0, rawPoints: 2 });
  const scores = new Float64Array(world.cells.length); scores.fill(Infinity);
  const parents = new Int32Array(world.cells.length); parents.fill(-1);
  const closed = new Uint8Array(world.cells.length), heap = new MinHeap();
  const nodePoints = new Map();
  const pointAt = id => { if (!nodePoints.has(id)) nodePoints.set(id, navigationPoint(world, id)); return nodePoints.get(id); };
  const scale = Number(world.metersPerUnit) > 0 ? Number(world.metersPerUnit) : 1;
  const lowerBound = point => routeDistance(point, to) * scale / (BASE_WALK_METERS_PER_MINUTE * MAX_MOVEMENT_MULTIPLIER);
  const beginning = segmentTravel(world, from, pointAt(start), { detailed: false });
  if (!beginning.walkable) return null;
  scores[start] = beginning.durationMinutes;
  heap.push({ id: start, f: scores[start] + lowerBound(pointAt(start)) });
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  let visited = 0;
  while (heap.items.length) {
    const current = heap.pop().id;
    if (closed[current]) continue;
    if (current === target) {
      const ids = [];
      for (let id = target; id !== -1; id = parents[id]) ids.push(id);
      ids.reverse();
      const raw = [{ x: from.x, y: from.y }, ...ids.map(pointAt), { x: to.x, y: to.y }]
        .filter((point, index, all) => !index || routeDistance(point, all[index - 1]) > 1e-8);
      const smooth = smoothRoute(world, raw);
      return describeRoute(world, smooth, { visited, rawPoints: raw.length, smoothedPoints: smooth.length, gridCellMeters: size * scale });
    }
    closed[current] = 1; visited++;
    const cx = current % world.cols, cy = Math.floor(current / world.cols), here = pointAt(current);
    for (const [dx, dy] of directions) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= world.cols || ny >= world.rows) continue;
      const next = ny * world.cols + nx;
      if (closed[next] || !world.cells[next].walkable) continue;
      if (dx && dy && (!world.cells[cy * world.cols + nx].walkable || !world.cells[ny * world.cols + cx].walkable)) continue;
      const edge = segmentTravel(world, here, pointAt(next), { detailed: false });
      if (!edge.walkable) continue;
      const score = scores[current] + edge.durationMinutes;
      if (score < scores[next]) {
        parents[next] = current; scores[next] = score;
        heap.push({ id: next, f: score + lowerBound(pointAt(next)) });
      }
    }
  }
  return null;
}
