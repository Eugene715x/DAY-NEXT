import { polygonUnion } from './polygon-geometry.js';

// A semantic river footprint is the native-width stroke of its mapped paths.
// Round joints/caps are approximated by inscribed 16-gons. No screen-zoom width
// or invented links between independent paths enter this world-space geometry.
const ribbonSides = 16;
const ribbonCircle = (point, radius) => {
  const ring = Array.from({ length: ribbonSides }, (_, index) => {
    const angle = index / ribbonSides * Math.PI * 2;
    return { x: point.x + Math.cos(angle) * radius, y: point.y + Math.sin(angle) * radius };
  });
  ring.push({ ...ring[0] });
  return [ring];
};
const ribbonPointKey = point => `${point.x},${point.y}`;

/** Return polygon parts for the union of separate native-width stroked paths. */
export function buildWaterRibbonParts(paths = [], width = 1) {
  if (!Array.isArray(paths)) throw new TypeError('Water paths must be an array.');
  if (!Number.isFinite(width) || width <= 0) throw new RangeError('Water ribbon width must be finite and positive.');
  const radius = width / 2, shapes = [], joints = new Map();
  for (const input of paths) {
    if (!Array.isArray(input)) throw new TypeError('Each water path must be an array.');
    const points = [];
    for (const point of input) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new TypeError('Water path coordinates must be finite.');
      if (!points.length || point.x !== points.at(-1).x || point.y !== points.at(-1).y) points.push(point);
    }
    if (!points.length) continue;
    for (const point of points) joints.set(ribbonPointKey(point), point);
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1], b = points[index], dx = b.x - a.x, dy = b.y - a.y;
      const scale = radius / Math.hypot(dx, dy), nx = -dy * scale, ny = dx * scale;
      const ring = [{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }];
      ring.push({ ...ring[0] }); shapes.push([ring]);
    }
  }
  // One sweep unions every segment and joint together; an incremental union per
  // vertex would repeatedly rebuild the entire preceding stroke.
  for (const point of joints.values()) shapes.push(ribbonCircle(point, radius));
  return shapes.length ? polygonUnion(shapes) : [];
}
