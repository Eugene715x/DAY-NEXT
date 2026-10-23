import { segmentTravel, biomeSpeedMultiplier, MOVEMENT_FACTORS, BASE_WALK_METERS_PER_MINUTE, MAX_MOVEMENT_MULTIPLIER } from './movement-model.js';

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

const navigationDirections = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
const landscapeLowerBoundGraphs = new WeakMap();

// Expensive exact DEM/footprint edges should only be expanded when promising.
// This cheap relaxed graph ignores those penalties and assumes the fastest
// surface and downhill factor in every crossed cell. Its reverse distance field
// is therefore an admissible, consistent heuristic for the exact directed A*.
function landscapeLowerBound(world, target, destination, scale) {
  if (!(world.metadata?.movement?.landscapeSamples > 0) || world.cells.length < 1024) return null;
  let graph = landscapeLowerBoundGraphs.get(world);
  const revision = world.movementRevision || 0;
  if (!graph || graph.revision !== revision || graph.cells !== world.cells) {
    const points = world.cells.map((cell, id) => navigationPoint(world, id));
    const weights = new Float32Array(world.cells.length * 8);
    // Biome and road bonuses multiply. Bound both independently; using only
    // the road maximum would overestimate the remaining time in a fast city.
    // Historic weighted grids can also supply a custom biome-like ground cost.
    let bestBiome = Math.max(1, ...Object.values(MOVEMENT_FACTORS.biomes));
    for (const cell of world.cells) if (cell.biome === undefined) {
      const legacy = Number.isFinite(cell.cost) && cell.cost > 0 ? Math.min(MAX_MOVEMENT_MULTIPLIER, Math.max(.01, 1 / cell.cost)) : biomeSpeedMultiplier(cell.type);
      bestBiome = Math.max(bestBiome, legacy);
    }
    const bestRoad = Math.max(1, ...Object.values(MOVEMENT_FACTORS.roads));
    // exp(.016) is the maximum of exp(.8*d - 10*d*d). The floor is
    // respected even for custom tiny landscape multipliers.
    const bestSurfaceAndSlope = bestBiome * bestRoad * Math.exp(.016);
    const fastest = landscape => Math.min(MAX_MOVEMENT_MULTIPLIER, Math.max(.005, bestSurfaceAndSlope * landscape));
    for (let id = 0; id < world.cells.length; id++) {
      if (!world.cells[id].walkable) continue;
      const x = id % world.cols, y = Math.floor(id / world.cols), a = points[id];
      const landscape = Number(world.cells[id].landscapeMultiplier) > 0 ? world.cells[id].landscapeMultiplier : 1;
      for (let direction = 0; direction < 8; direction++) {
        const [dx, dy] = navigationDirections[direction], nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= world.cols || ny >= world.rows) continue;
        const next = ny * world.cols + nx;
        if (!world.cells[next].walkable) continue;
        if (dx && dy && (!world.cells[y * world.cols + nx].walkable || !world.cells[ny * world.cols + x].walkable)) continue;
        let fastestLandscape = Math.max(landscape, Number(world.cells[next].landscapeMultiplier) > 0 ? world.cells[next].landscapeMultiplier : 1);
        // Adjacent anchors may pass through either orthogonal cell. Include
        // both, rather than incorrectly charging only their endpoint samples.
        if (dx && dy) for (const cross of [y * world.cols + nx, ny * world.cols + x]) fastestLandscape = Math.max(fastestLandscape, Number(world.cells[cross].landscapeMultiplier) > 0 ? world.cells[cross].landscapeMultiplier : 1);
        const cost = routeDistance(a, points[next]) * scale / (BASE_WALK_METERS_PER_MINUTE * fastest(fastestLandscape));
        // Float32 is deliberately rounded down to preserve the lower bound.
        weights[id * 8 + direction] = Math.fround(cost * (1 - 1e-6));
      }
    }
    const exactWeights = new Float64Array(world.cells.length * 8); exactWeights.fill(NaN);
    graph = { revision, cells: world.cells, points, weights, fastest, exactWeights };
    landscapeLowerBoundGraphs.set(world, graph);
  }
  const distances = new Float64Array(world.cells.length); distances.fill(Infinity);
  const heap = new MinHeap();
  const targetLandscape = Number(world.cells[target].landscapeMultiplier) > 0 ? world.cells[target].landscapeMultiplier : 1;
  distances[target] = routeDistance(graph.points[target], destination) * scale / (BASE_WALK_METERS_PER_MINUTE * graph.fastest(targetLandscape));
  heap.push({ id: target, f: distances[target] });
  let visited = 0;
  while (heap.items.length) {
    const current = heap.pop();
    if (current.f > distances[current.id] + 1e-12) continue;
    visited++;
    const x = current.id % world.cols, y = Math.floor(current.id / world.cols);
    for (let direction = 0; direction < 8; direction++) {
      const edge = graph.weights[current.id * 8 + direction];
      if (!(edge > 0)) continue;
      const [dx, dy] = navigationDirections[direction], next = (y + dy) * world.cols + x + dx;
      const score = current.f + edge;
      if (score + 1e-12 < distances[next]) { distances[next] = score; heap.push({ id: next, f: score }); }
    }
  }
  return { points: graph.points, distances, visited, exactWeights: graph.exactWeights };
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
  const scale = Number(world.metersPerUnit) > 0 ? Number(world.metersPerUnit) : 1;
  const relaxed = landscapeLowerBound(world, target, to, scale);
  const nodePoints = new Map();
  const pointAt = id => { if (relaxed) return relaxed.points[id]; if (!nodePoints.has(id)) nodePoints.set(id, navigationPoint(world, id)); return nodePoints.get(id); };
  const lowerBound = id => relaxed ? relaxed.distances[id] : routeDistance(pointAt(id), to) * scale / (BASE_WALK_METERS_PER_MINUTE * MAX_MOVEMENT_MULTIPLIER);
  const beginning = segmentTravel(world, from, pointAt(start), { detailed: false });
  if (!beginning.walkable) return null;
  scores[start] = beginning.durationMinutes;
  heap.push({ id: start, f: scores[start] + lowerBound(start) });
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
      return describeRoute(world, smooth, { visited, rawPoints: raw.length, smoothedPoints: smooth.length, gridCellMeters: size * scale, heuristic: relaxed ? 'landscape-lower-bound' : 'straight-line', lowerBoundVisited: relaxed?.visited || 0 });
    }
    closed[current] = 1; visited++;
    const cx = current % world.cols, cy = Math.floor(current / world.cols), here = pointAt(current);
    for (let direction = 0; direction < navigationDirections.length; direction++) {
      const [dx, dy] = navigationDirections[direction];
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= world.cols || ny >= world.rows) continue;
      const next = ny * world.cols + nx;
      if (closed[next] || !world.cells[next].walkable) continue;
      if (dx && dy && (!world.cells[cy * world.cols + nx].walkable || !world.cells[ny * world.cols + cx].walkable)) continue;
      const edgeId = current * 8 + direction;
      let duration = relaxed?.exactWeights[edgeId] ?? NaN;
      if (Number.isNaN(duration)) {
        const edge = segmentTravel(world, here, pointAt(next), { detailed: false });
        duration = edge.walkable ? edge.durationMinutes : Infinity;
        if (relaxed) relaxed.exactWeights[edgeId] = duration;
      }
      if (!Number.isFinite(duration)) continue;
      const score = scores[current] + duration;
      if (score < scores[next]) {
        parents[next] = current; scores[next] = score;
        heap.push({ id: next, f: score + lowerBound(next) });
      }
    }
  }
  return null;
}
