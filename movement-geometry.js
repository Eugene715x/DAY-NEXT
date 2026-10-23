/** Exact travel effects over indexed, unchanged source footprints and river ribbons. */
const mgEpsilon = 1e-9;
const mgCross = (ax, ay, bx, by) => ax * by - ay * bx;
const mgValidPoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
const mgInBounds = (x, y, bounds) => x >= bounds.minX - mgEpsilon && x <= bounds.maxX + mgEpsilon && y >= bounds.minY - mgEpsilon && y <= bounds.maxY + mgEpsilon;
const mgOverlap = (a, b) => a.minX <= b.maxX + mgEpsilon && a.maxX >= b.minX - mgEpsilon && a.minY <= b.maxY + mgEpsilon && a.maxY >= b.minY - mgEpsilon;
const mgBounds = (a, b) => ({ minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) });

function mgIndex(bucketSize) {
  const buckets = new Map();
  const each = (bounds, callback) => {
    const left = Math.floor((bounds.minX - mgEpsilon) / bucketSize), right = Math.floor((bounds.maxX + mgEpsilon) / bucketSize);
    const top = Math.floor((bounds.minY - mgEpsilon) / bucketSize), bottom = Math.floor((bounds.maxY + mgEpsilon) / bucketSize);
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) callback(`${x},${y}`);
  };
  return {
    insert(item) { each(item.bounds, key => { if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(item); }); },
    query(bounds) {
      const found = new Set();
      each(bounds, key => { for (const item of buckets.get(key) || []) if (mgOverlap(item.bounds, bounds)) found.add(item); });
      return [...found];
    },
    bucketCount: () => buckets.size,
  };
}

function mgPolygon(rings, kind, bucketSize) {
  const valid = rings.filter(ring => Array.isArray(ring) && ring.length >= 3 && ring.every(mgValidPoint));
  if (!valid.length) return null;
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, edges = [], bands = new Map();
  for (const ring of valid) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (a.x === b.x && a.y === b.y) continue;
      const edge = { a, b, bounds: mgBounds(a, b) };
      edges.push(edge);
      bounds.minX = Math.min(bounds.minX, edge.bounds.minX); bounds.minY = Math.min(bounds.minY, edge.bounds.minY);
      bounds.maxX = Math.max(bounds.maxX, edge.bounds.maxX); bounds.maxY = Math.max(bounds.maxY, edge.bounds.maxY);
      for (let band = Math.floor((edge.bounds.minY - mgEpsilon) / bucketSize); band <= Math.floor((edge.bounds.maxY + mgEpsilon) / bucketSize); band++) {
        if (!bands.has(band)) bands.set(band, []);
        bands.get(band).push(edge);
      }
    }
  }
  if (!edges.length) return null;
  return { kind, bounds, edges, contains(x, y) {
    if (!mgInBounds(x, y, bounds)) return false;
    let inside = false;
    // Only edges crossing this horizontal band can participate in the ray test.
    // Even/odd parity preserves courtyard holes and nested rings.
    for (const { a, b, bounds: edgeBounds } of bands.get(Math.floor(y / bucketSize)) || []) {
      const dx = b.x - a.x, dy = b.y - a.y;
      if (mgInBounds(x, y, edgeBounds) && Math.abs(mgCross(x - a.x, y - a.y, dx, dy)) <= mgEpsilon * Math.max(1, Math.hypot(dx, dy))) return true;
      if ((a.y > y) !== (b.y > y) && x < a.x + (y - a.y) * dx / dy) inside = !inside;
    }
    return inside;
  } };
}

function mgParts(feature) {
  if (Array.isArray(feature.parts) && feature.parts.length) return feature.parts;
  if (Array.isArray(feature.rings) && feature.rings.length) return [feature.rings];
  if (Array.isArray(feature.points) && feature.points.length >= 3) return [[feature.points]];
  return [];
}

function mgEdgeCuts(from, dx, dy, edge, cuts) {
  const ex = edge.b.x - edge.a.x, ey = edge.b.y - edge.a.y;
  const ax = edge.a.x - from.x, ay = edge.a.y - from.y, denominator = mgCross(dx, dy, ex, ey);
  if (Math.abs(denominator) > 1e-12) {
    const t = mgCross(ax, ay, ex, ey) / denominator, u = mgCross(ax, ay, dx, dy) / denominator;
    if (t > 0 && t < 1 && u >= -mgEpsilon && u <= 1 + mgEpsilon) cuts.push(t);
  } else if (Math.abs(mgCross(ax, ay, dx, dy)) < mgEpsilon * Math.max(1, Math.hypot(dx, dy))) {
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return;
    for (const p of [edge.a, edge.b]) {
      const t = ((p.x - from.x) * dx + (p.y - from.y) * dy) / lengthSquared;
      if (t > 0 && t < 1) cuts.push(t);
    }
  }
}

function mgBridge(a, b, radius) {
  const dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy, length = Math.sqrt(lengthSquared);
  if (!(length > 0) || !(radius > 0)) return null;
  const bounds = { minX: Math.min(a.x, b.x) - radius, minY: Math.min(a.y, b.y) - radius, maxX: Math.max(a.x, b.x) + radius, maxY: Math.max(a.y, b.y) + radius };
  return { kind: 'bridge', bounds, contains(x, y) {
    if (!mgInBounds(x, y, bounds)) return false;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared));
    return (x - a.x - t * dx) ** 2 + (y - a.y - t * dy) ** 2 <= radius ** 2 + mgEpsilon;
  }, cuts(from, travelX, travelY, target) {
    // A native bridge has its actual width, with round joins/caps. Splitting at
    // both parallel sides and endpoint circles exactly partitions the capsule.
    const crossStart = mgCross(dx, dy, from.x - a.x, from.y - a.y), crossTravel = mgCross(dx, dy, travelX, travelY);
    if (Math.abs(crossTravel) > 1e-12) for (const side of [-1, 1]) {
      const t = (side * radius * length - crossStart) / crossTravel;
      if (t <= 0 || t >= 1) continue;
      const projection = ((from.x + travelX * t - a.x) * dx + (from.y + travelY * t - a.y) * dy) / lengthSquared;
      if (projection >= -mgEpsilon && projection <= 1 + mgEpsilon) target.push(t);
    }
    const quadratic = travelX * travelX + travelY * travelY;
    if (!(quadratic > 0)) return;
    for (const endpoint of [a, b]) {
      const ox = from.x - endpoint.x, oy = from.y - endpoint.y;
      const linear = 2 * (ox * travelX + oy * travelY), constant = ox * ox + oy * oy - radius * radius;
      const discriminant = linear * linear - 4 * quadratic * constant;
      if (discriminant < 0) continue;
      const root = Math.sqrt(Math.max(0, discriminant));
      for (const t of [(-linear - root) / (2 * quadratic), (-linear + root) / (2 * quadratic)]) if (t > 0 && t < 1) target.push(t);
    }
  } };
}

function mgEffects(records, x, y) {
  let building = false, seasonal = false, bridge = false;
  for (const record of records) {
    if (record.kind === 'building' && building || record.kind === 'seasonal' && seasonal || record.kind === 'bridge' && bridge) continue;
    if (!record.contains(x, y)) continue;
    if (record.kind === 'building') building = true;
    else if (record.kind === 'seasonal') seasonal = true;
    else bridge = true;
  }
  return { building, seasonal, bridge };
}

/** Build once per world; point and line queries never scan every source object. */
export function prepareMovementGeometry(world, { biomeFeatures = [] } = {}) {
  const bucketSize = Math.max(12, Number(world.cellSize) * 8 || 48);
  const recordsIndex = mgIndex(bucketSize), edgesIndex = mgIndex(bucketSize), records = [];
  const add = record => {
    if (!record) return;
    records.push(record); recordsIndex.insert(record);
    for (const edge of record.edges || []) edgesIndex.insert(edge);
  };
  for (const building of world.buildings || []) for (const rings of mgParts(building)) add(mgPolygon(rings, 'building', bucketSize));
  for (const biome of biomeFeatures) {
    if (!['seasonal_river', 'dry_riverbed'].includes(biome.biome || biome.type) && biome.waterKind !== 'seasonal_river') continue;
    for (const rings of mgParts(biome)) add(mgPolygon(rings, 'seasonal', bucketSize));
  }
  for (const road of world.roads || []) {
    const flag = road.bridge ?? road.tags?.bridge;
    if (!(flag === true || flag === 1 || typeof flag === 'string' && !['', 'no', 'false', '0'].includes(flag.toLowerCase()))) continue;
    const metersPerUnit = Number(world.metersPerUnit) > 0 ? Number(world.metersPerUnit) : 1;
    const width = Number(road.widthMeters) > 0 ? Number(road.widthMeters) / metersPerUnit : Number(road.width) > 0 ? Number(road.width) : 2;
    const paths = road.paths?.length ? road.paths : [road.points || []];
    for (const points of paths) for (let i = 1; i < points.length; i++) if (mgValidPoint(points[i - 1]) && mgValidPoint(points[i])) add(mgBridge(points[i - 1], points[i], width / 2));
  }
  const segmentRegions = (from, to) => {
    if (!mgValidPoint(from) || !mgValidPoint(to)) return { cuts: [0, 1], at: () => ({ building: false, seasonal: false, bridge: false }) };
    const bounds = mgBounds(from, to), local = recordsIndex.query(bounds), cuts = [0, 1];
    const dx = to.x - from.x, dy = to.y - from.y;
    if (local.length) {
      for (const edge of edgesIndex.query(bounds)) mgEdgeCuts(from, dx, dy, edge, cuts);
      for (const record of local) if (record.cuts) record.cuts(from, dx, dy, cuts);
    }
    cuts.sort((a, b) => a - b);
    return { cuts: cuts.filter((t, i) => !i || t - cuts[i - 1] > 1e-10), at: t => mgEffects(local, from.x + dx * t, from.y + dy * t) };
  };
  const counts = { buildings: 0, seasonalParts: 0, bridgeSegments: 0, edges: 0, buckets: recordsIndex.bucketCount(), bucketSize };
  for (const record of records) { counts[record.kind === 'building' ? 'buildings' : record.kind === 'seasonal' ? 'seasonalParts' : 'bridgeSegments']++; counts.edges += record.edges?.length || 0; }
  return {
    hasSeasonalGeometry: counts.seasonalParts > 0,
    queryPoint(x, y) { return Number.isFinite(x) && Number.isFinite(y) ? mgEffects(recordsIndex.query({ minX: x, minY: y, maxX: x, maxY: y }), x, y) : { building: false, seasonal: false, bridge: false }; },
    segmentRegions,
    segmentCuts: (from, to) => segmentRegions(from, to).cuts,
    getStats: () => ({ ...counts }),
  };
}
