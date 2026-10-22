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
