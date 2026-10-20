import { polygonClipping } from './vendor/polygon-clipping.js';

// Polygon parts use the renderer's native representation:
// [polygon [outerRing, ...holeRings]], with closed {x,y} coordinate rings.
// All operations return independent geometry and preserve coordinate precision.
const pgMaxCoordinate = 1e9, pgMaxPoints = 1000000;
const pgEqual = (a, b) => a.x === b.x && a.y === b.y;
const pgCompare = (a, b) => a.x - b.x || a.y - b.y;
const pgArea = ring => {
  if (ring.length < 4) return 0;
  const origin = ring[0];
  let sum = 0;
  for (let i = 1; i < ring.length - 1; i++) sum += (ring[i].x - origin.x) * (ring[i + 1].y - origin.y) - (ring[i + 1].x - origin.x) * (ring[i].y - origin.y);
  return sum / 2;
};
function pgRing(input, hole, budget) {
  if (!Array.isArray(input)) throw new TypeError('Polygon ring must be an array of coordinate points.');
  const ring = [];
  for (const point of input) {
    if (++budget.points > pgMaxPoints) throw new RangeError('Polygon operation exceeds the coordinate-count limit.');
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > pgMaxCoordinate || Math.abs(point.y) > pgMaxCoordinate) throw new TypeError('Polygon coordinates must be finite and bounded.');
    const next = { x: point.x === 0 ? 0 : point.x, y: point.y === 0 ? 0 : point.y };
    if (!ring.length || !pgEqual(ring.at(-1), next)) ring.push(next);
  }
  if (ring.length > 1 && pgEqual(ring[0], ring.at(-1))) ring.pop();
  if (ring.length < 3) return null;
  ring.push({ ...ring[0] });
  const area = pgArea(ring);
  if (area === 0) {
    // Collinear rings have no area. A self-crossing ring can have zero signed
    // area yet a real filled interior; the clipping engine resolves that case.
    const origin = ring[0], edge = ring.find(point => !pgEqual(point, origin));
    if (!edge || !ring.some(point => (edge.x - origin.x) * (point.y - origin.y) - (edge.y - origin.y) * (point.x - origin.x) !== 0)) return null;
  }
  if (area !== 0 && (area > 0) === hole) ring.reverse();
  // Stable first vertex and ordering make regenerated maps reproducible.
  ring.pop();
  let first = 0;
  for (let i = 1; i < ring.length; i++) if (pgCompare(ring[i], ring[first]) < 0) first = i;
  const result = [...ring.slice(first), ...ring.slice(0, first)];
  result.push({ ...result[0] });
  return result;
}
const pgRingKey = ring => ring.map(point => `${point.x},${point.y}`).join(';');
const pgSort = (a, b) => pgCompare(a[0], b[0]) || pgRingKey(a).localeCompare(pgRingKey(b));

export function normalizePolygonParts(parts = []) {
  if (!Array.isArray(parts)) throw new TypeError('Polygon parts must be an array.');
  const budget = { points: 0 }, result = [];
  for (const polygon of parts) {
    if (!Array.isArray(polygon)) throw new TypeError('Each polygon must contain an outer ring and optional holes.');
    if (!polygon.length) continue;
    const outer = pgRing(polygon[0], false, budget);
    if (!outer) continue;
    const holes = polygon.slice(1).map(ring => pgRing(ring, true, budget)).filter(Boolean).sort(pgSort);
    result.push([outer, ...holes]);
  }
  return result.sort((a, b) => pgSort(a[0], b[0]) || a.length - b.length);
}
const pgCoordinates = parts => parts.map(polygon => polygon.map(ring => ring.map(point => [point.x, point.y])));
const pgPoints = coordinates => normalizePolygonParts(coordinates.map(polygon => polygon.map(ring => ring.map(([x, y]) => ({ x, y })))));
const pgBounds = polygon => polygon[0].reduce((bounds, point) => ({ minX: Math.min(bounds.minX, point.x), minY: Math.min(bounds.minY, point.y), maxX: Math.max(bounds.maxX, point.x), maxY: Math.max(bounds.maxY, point.y) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
const pgOverlap = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
function pgRelevantMasks(subject, masks) {
  const bounds = subject.map(pgBounds);
  return masks.filter(mask => { const maskBounds = pgBounds(mask); return bounds.some(box => pgOverlap(box, maskBounds)); });
}

// Overlapping source/fusion edges can differ by a final floating-point bit.
// Martinez's sweep ordering then occasionally cannot find a coincident segment.
// Retry only that numerical failure in a local integer frame. Normal operation
// keeps every input bit; the retry resolves at most 1e-9 units (1e-8 on a second
// attempt), far below source accuracy. It still performs the full boolean and
// never returns an uncut shape or silently discards a mask.
function pgRun(operation, ...geometries) {
  try { return polygonClipping[operation](...geometries); }
  catch (error) {
    if (!/Unable to find segment|Unable to complete output ring|SweepLine/.test(String(error))) throw error;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const geometry of geometries) for (const polygon of geometry) for (const ring of polygon) for (const [x, y] of ring) {
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    const originX = Math.floor(minX), originY = Math.floor(minY);
    const extent = Math.max(maxX - originX, maxY - originY, 1);
    let lastError = error;
    for (const scale of [1e9, 1e8]) {
      // Integer coordinates remain exactly representable, including for offsets
      // far from world origin. Oversized generic inputs fail instead of losing
      // meaningful precision; game maps are limited to a much smaller extent.
      if (extent * scale > 2 ** 45) continue;
      const translated = geometries.map(geometry => geometry.map(polygon => polygon.map(ring => ring.map(([x, y]) => [Math.round((x - originX) * scale), Math.round((y - originY) * scale)]))));
      try {
        const result = polygonClipping[operation](...translated);
        return result.map(polygon => polygon.map(ring => ring.map(([x, y]) => [x / scale + originX, y / scale + originY])));
      } catch (retryError) {
        if (!/Unable to find segment|Unable to complete output ring|SweepLine/.test(String(retryError))) throw retryError;
        lastError = retryError;
      }
    }
    throw lastError;
  }
}

export function polygonUnion(parts = []) {
  const normalized = normalizePolygonParts(parts);
  return normalized.length ? pgPoints(pgRun('union', pgCoordinates(normalized))) : [];
}

export function polygonDifference(parts = [], masks = []) {
  const subject = normalizePolygonParts(parts);
  if (!subject.length) return [];
  const clips = pgRelevantMasks(subject, normalizePolygonParts(masks));
  return clips.length ? pgPoints(pgRun('difference', pgCoordinates(subject), pgCoordinates(clips))) : subject;
}

export function polygonIntersection(parts = [], clips = []) {
  const subject = normalizePolygonParts(parts);
  if (!subject.length) return [];
  const masks = pgRelevantMasks(subject, normalizePolygonParts(clips));
  return masks.length ? pgPoints(pgRun('intersection', pgCoordinates(subject), pgCoordinates(masks))) : [];
}
