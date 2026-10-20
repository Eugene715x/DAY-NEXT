import { mapBiome, mapFeatureLayer, mapZoneBiome, shouldRenderFeature } from './map-layers.js';
import { polygonDifference, polygonUnion, polygonIntersection } from './polygon-geometry.js';

// Gameplay geography derived from mapped geometry. No source feature is edited.
const bzClone = value => Array.isArray(value) ? value.map(bzClone) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bzClone(entry)])) : value;
const bzSourceId = feature => feature.sourceId || feature.id?.match(/^(?:node|way|relation)-\d+/)?.[0] || feature.id;
const bzPoint = (x, y) => ({ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 });
const bzParts = feature => feature.parts || (feature.rings?.length ? [feature.rings] : feature.points?.length >= 3 ? [[feature.points]] : []);
const bzArea = ring => ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]; return sum + p.x * q.y - q.x * p.y; }, 0) / 2;
function bzInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function bzInParts(point, parts) { return parts.some(rings => bzInRing(point, rings[0]) && !rings.slice(1).some(ring => bzInRing(point, ring))); }
const bzBounds = points => points.reduce((b, p) => ({ minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y), maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
const bzOverlap = (a, b, padding = 0) => a.minX <= b.maxX + padding && a.maxX >= b.minX - padding && a.minY <= b.maxY + padding && a.maxY >= b.minY - padding;
function bzNearest(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, denominator = dx * dx + dy * dy;
  const t = denominator ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / denominator)) : 0;
  const nearest = { x: a.x + dx * t, y: a.y + dy * t };
  return { point: nearest, distance: Math.hypot(point.x - nearest.x, point.y - nearest.y) };
}
function bzSegmentsCross(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const first = cross(a, b, c), second = cross(a, b, d), third = cross(c, d, a), fourth = cross(c, d, b);
  return first * second <= 0 && third * fourth <= 0 && bzOverlap(bzBounds([a, b]), bzBounds([c, d]));
}
function bzRectTouchesParts(rect, parts) {
  const corners = [{ x: rect.minX, y: rect.minY }, { x: rect.maxX, y: rect.minY }, { x: rect.maxX, y: rect.maxY }, { x: rect.minX, y: rect.maxY }];
  if (corners.some(point => bzInParts(point, parts))) return true;
  for (const rings of parts) for (const ring of rings) {
    if (ring.some(point => point.x >= rect.minX && point.x <= rect.maxX && point.y >= rect.minY && point.y <= rect.maxY)) return true;
    for (let i = 1; i < ring.length; i++) for (let j = 0; j < 4; j++) if (bzSegmentsCross(ring[i - 1], ring[i], corners[j], corners[(j + 1) % 4])) return true;
  }
  return false;
}
function bzDry(feature) { const tags = feature.tags || {}; return [feature.intermittent, feature.seasonal, tags.intermittent, tags.seasonal].some(value => value === true || value === 'yes'); }
function bzWaterLines(world) {
  return ['rivers', 'details'].flatMap(collection => (world[collection] || []).flatMap(feature => {
    if (bzDry(feature) || !feature.points?.length || feature.geometry === 'polygon' || mapFeatureLayer(feature, collection === 'rivers' ? 'river' : 'detail') !== 'water') return [];
    return [{ feature, bounds: bzBounds(feature.points), radius: Math.max(.1, Number(feature.width) || 1) / 2 }];
  }));
}
function bzRectTouchesLine(rect, record) {
  const expanded = { minX: rect.minX - record.radius, minY: rect.minY - record.radius, maxX: rect.maxX + record.radius, maxY: rect.maxY + record.radius };
  if (!bzOverlap(expanded, record.bounds)) return false;
  const corners = [{ x: expanded.minX, y: expanded.minY }, { x: expanded.maxX, y: expanded.minY }, { x: expanded.maxX, y: expanded.maxY }, { x: expanded.minX, y: expanded.maxY }];
  const points = record.feature.points;
  if (points.some(point => point.x >= expanded.minX && point.x <= expanded.maxX && point.y >= expanded.minY && point.y <= expanded.maxY)) return true;
  return points.slice(1).some((point, index) => corners.some((corner, side) => bzSegmentsCross(points[index], point, corner, corners[(side + 1) % 4])));
}
function bzPolygonRecords(world) {
  return ['areas', 'details', 'lakes'].flatMap(collection => (world[collection] || []).flatMap(feature => {
    if (feature.geometry && feature.geometry !== 'polygon') return [];
    const parts = bzParts(feature);
    if (!parts.length) return [];
    const group = { areas: 'area', details: 'detail', lakes: 'lake' }[collection];
    return [{ feature, parts, biome: mapBiome(feature), layer: mapFeatureLayer(feature, group), bounds: bzBounds(parts.flat(2)) }];
  }));
}
function bzSmoothRing(ring, iterations = 2) {
  let points = ring.slice(0, -1);
  for (let pass = 0; pass < iterations; pass++) {
    const rounded = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      rounded.push({ x: a.x * .75 + b.x * .25, y: a.y * .75 + b.y * .25 }, { x: a.x * .25 + b.x * .75, y: a.y * .25 + b.y * .75 });
    }
    points = rounded;
  }
  return [...points, { ...points[0] }];
}
function bzSimplifyLine(points, tolerance) {
  if (points.length <= 2) return points;
  const a = points[0], b = points.at(-1);
  let selected = -1, maximum = tolerance;
  for (let i = 1; i < points.length - 1; i++) {
    const distance = bzNearest(points[i], a, b).distance;
    if (distance > maximum) { maximum = distance; selected = i; }
  }
  return selected < 0 ? [a, b] : [...bzSimplifyLine(points.slice(0, selected + 1), tolerance).slice(0, -1), ...bzSimplifyLine(points.slice(selected), tolerance)];
}
function bzSmoothParts(parts, metersPerUnit) {
  return parts.map(rings => rings.map(ring => {
    const rounded = bzSmoothRing(ring), half = Math.floor((rounded.length - 1) / 2);
    return [...bzSimplifyLine(rounded.slice(0, half + 1), .35 / metersPerUnit).slice(0, -1), ...bzSimplifyLine(rounded.slice(half), .35 / metersPerUnit)];
  }));
}

// Trace level-set segments, rather than exposed square cell edges. Shared edge
// identities join neighboring samples exactly; interpolation makes the contour
// continuous even though the density calculation uses a bounded sample lattice.
function bzDensityContours(field, activeCells, cols, rows, cellSize, threshold) {
  const stride = cols + 1, nodes = new Map(), edges = new Map();
  const pointFor = (index) => ({ x: (index % stride - 1) * cellSize, y: (Math.floor(index / stride) - 1) * cellSize });
  const intersection = (first, second) => {
    const av = field[first], bv = field[second];
    const key = Math.abs(av - threshold) < 1e-10 ? `n${first}` : Math.abs(bv - threshold) < 1e-10 ? `n${second}` : first < second ? `${first}:${second}` : `${second}:${first}`;
    if (!nodes.has(key)) {
      const a = pointFor(first), b = pointFor(second), ratio = (threshold - av) / (bv - av);
      nodes.set(key, { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio });
    }
    return key;
  };
  const add = (a, b) => {
    if (a === b) return;
    if (!edges.has(a)) edges.set(a, new Set()); if (!edges.has(b)) edges.set(b, new Set());
    edges.get(a).add(b); edges.get(b).add(a);
  };
  for (const cell of activeCells) {
    const x = cell % cols, y = Math.floor(cell / cols);
    if (x < 0 || x >= cols || y < 0 || y >= rows) continue;
    const corners = [y * stride + x, y * stride + x + 1, (y + 1) * stride + x + 1, (y + 1) * stride + x];
    const crossings = [];
    for (let edge = 0; edge < 4; edge++) {
      const a = corners[edge], b = corners[(edge + 1) % 4];
      if ((field[a] >= threshold) !== (field[b] >= threshold)) crossings.push({ edge, key: intersection(a, b) });
    }
    if (crossings.length === 2) add(crossings[0].key, crossings[1].key);
    else if (crossings.length === 4) {
      const centerInside = corners.reduce((sum, index) => sum + field[index], 0) / 4 >= threshold;
      const diagonalFirst = field[corners[0]] >= threshold;
      const pairs = centerInside === diagonalFirst ? [[0, 1], [2, 3]] : [[0, 3], [1, 2]];
      for (const [a, b] of pairs) add(crossings[a].key, crossings[b].key);
    }
  }
  const rings = [];
  while (edges.size) {
    const start = edges.keys().next().value, ring = [nodes.get(start)];
    let current = start, iterations = 0;
    do {
      const choices = edges.get(current);
      if (!choices?.size || iterations++ > activeCells.size * 2 + 4) throw new Error('Invalid gameplay density contour.');
      const next = choices.values().next().value;
      choices.delete(next); if (!choices.size) edges.delete(current);
      const reverse = edges.get(next); reverse.delete(current); if (!reverse.size) edges.delete(next);
      ring.push(nodes.get(next)); current = next;
    } while (current !== start);
    if (ring.length >= 4 && Math.abs(bzArea(ring)) > 1e-9) rings.push(ring);
  }
  // The interpolated graph has arbitrary winding. Nesting, not trace direction,
  // distinguishes holes and islands before the boolean geometry normalizes it.
  rings.sort((a, b) => Math.abs(bzArea(b)) - Math.abs(bzArea(a)));
  const entries = [];
  for (const ring of rings) {
    let parent = -1;
    for (let i = entries.length - 1; i >= 0; i--) if (bzInRing(ring[0], entries[i].ring)) { parent = i; break; }
    entries.push({ ring, parent, depth: parent < 0 ? 0 : entries[parent].depth + 1 });
  }
  return entries.flatMap((entry, index) => entry.depth % 2 ? [] : [[entry.ring, ...entries.filter(other => other.parent === index && other.depth % 2).map(other => other.ring)]]);
}

function bzLineMask(record) {
  const masks = [], radius = record.radius, points = record.feature.points;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!length) continue;
    const nx = (b.y - a.y) / length * radius, ny = -(b.x - a.x) / length * radius;
    masks.push([[{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }, { x: a.x + nx, y: a.y + ny }]]);
  }
  for (const point of points) {
    const ring = Array.from({ length: 12 }, (_, index) => ({ x: point.x + Math.cos(index / 12 * Math.PI * 2) * radius, y: point.y + Math.sin(index / 12 * Math.PI * 2) * radius }));
    masks.push([[...ring, { ...ring[0] }]]);
  }
  return masks;
}
function bzGeneratedFeature(id, biome, parts, provenance, extra = {}) {
  return { id, sourceId: id, name: { wasteland: 'Пустошь', suburb: 'Пригород', urban: 'Городская застройка', dense: 'Плотная застройка', aircraft_parking: 'Стоянка самолётов' }[biome] || '', type: biome, kind: biome, biome, geometry: 'polygon', points: parts[0][0], rings: parts[0], parts, derived: true, sourceIds: [...(provenance.sourceIds || [])], provenance, ...extra };
}

/** Smooth density inference over unzoned ground, built once per geographic map. */
export function buildGameplayBiomes(world = {}, { deferOccupiedCuts = false } = {}) {
  if (!(world.geographic || Array.isArray(world.bbox)) || !(world.width > 0 && world.height > 0)) return { features: [], report: { enabled: false, generatedZones: 0 } };
  const metersPerUnit = Number(world.metersPerUnit) || 5;
  const cellSize = Math.max(15 / metersPerUnit, world.width / 800, world.height / 800);
  const cols = Math.ceil(world.width / cellSize) + 2, rows = Math.ceil(world.height / cellSize) + 2, stride = cols + 1;
  const polygons = bzPolygonRecords(world);
  const radius = 120 / metersPerUnit;
  const buildings = (world.buildings || []).filter(feature => feature.points?.length >= 3).map(feature => {
    const bounds = bzBounds(feature.points);
    return { point: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }, sourceId: bzSourceId(feature) };
  }).sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId)));
  const bins = new Map(), activeNodes = new Set(), activeCells = new Set(), binSize = radius;
  for (const building of buildings) {
    const bx = Math.floor(building.point.x / binSize), by = Math.floor(building.point.y / binSize), key = `${bx},${by}`;
    if (!bins.has(key)) bins.set(key, []); bins.get(key).push(building);
    const minX = Math.max(1, Math.floor((building.point.x - radius) / cellSize) + 1), maxX = Math.min(cols - 1, Math.ceil((building.point.x + radius) / cellSize) + 1);
    const minY = Math.max(1, Math.floor((building.point.y - radius) / cellSize) + 1), maxY = Math.min(rows - 1, Math.ceil((building.point.y + radius) / cellSize) + 1);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) activeNodes.add(y * stride + x);
  }
  const field = new Float64Array((cols + 1) * (rows + 1));
  for (const index of activeNodes) {
    const x = index % stride, y = Math.floor(index / stride), point = { x: (x - 1) * cellSize, y: (y - 1) * cellSize };
    const bx = Math.floor(point.x / binSize), by = Math.floor(point.y / binSize);
    let density = 0;
    for (let yy = by - 1; yy <= by + 1; yy++) for (let xx = bx - 1; xx <= bx + 1; xx++) {
      for (const building of bins.get(`${xx},${yy}`) || []) {
        const squared = ((building.point.x - point.x) ** 2 + (building.point.y - point.y) ** 2) / radius ** 2;
        if (squared < 1) density += (1 - squared) ** 2;
      }
    }
    field[index] = density;
    for (const [cx, cy] of [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]]) if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) activeCells.add(cy * cols + cx);
  }
  const fallbackRing = [{ x: 0, y: 0 }, { x: world.width, y: 0 }, { x: world.width, y: world.height }, { x: 0, y: world.height }, { x: 0, y: 0 }];
  const features = [bzGeneratedFeature('game-biome-wasteland', 'wasteland', [[fallbackRing]], { method: 'unmapped-ground-fallback', sourceIds: [], notes: 'Gameplay fallback, not a claim about mapped grass or soil.' }, { fallback: true })];
  const aircraft = buildAircraftParkingZones(world, polygons, metersPerUnit);
  const thresholds = { suburb: (1 - (40 / 120) ** 2) ** 2, urban: 4, dense: 10 };
  const envelopes = {};
  for (const biome of ['suburb', 'urban', 'dense']) {
    const contours = bzDensityContours(field, activeCells, cols, rows, cellSize, thresholds[biome]);
    envelopes[biome] = contours.length ? polygonIntersection(polygonUnion(bzSmoothParts(contours, metersPerUnit)), [[fallbackRing]]) : [];
  }
  // Higher-density envelopes take priority, leaving exclusive smooth bands.
  const dense = polygonIntersection(envelopes.dense, envelopes.suburb);
  const urban = polygonDifference(polygonIntersection(envelopes.urban, envelopes.suburb), dense);
  const suburb = polygonDifference(envelopes.suburb, [...dense, ...urban]);
  const sourceMasks = deferOccupiedCuts ? [] : polygons.filter(record => {
    const group = record.layer === 'water' ? 'lake' : 'detail';
    return shouldRenderFeature(record.feature, group) && ['landscape', 'water', 'power'].includes(record.layer);
  }).map(record => ({ parts: record.parts, bounds: record.bounds }));
  if (!deferOccupiedCuts) for (const building of world.buildings || []) if (mapZoneBiome(building)) {
    const parts = bzParts(building); if (parts.length) sourceMasks.push({ parts, bounds: bzBounds(parts.flat(2)) });
  }
  if (!deferOccupiedCuts) for (const feature of aircraft) sourceMasks.push({ parts: feature.parts, bounds: bzBounds(feature.parts.flat(2)) });
  if (!deferOccupiedCuts) for (const record of bzWaterLines(world)) sourceMasks.push({ parts: bzLineMask(record), bounds: { minX: record.bounds.minX - record.radius, minY: record.bounds.minY - record.radius, maxX: record.bounds.maxX + record.radius, maxY: record.bounds.maxY + record.radius } });
  let urbanVertices = 0;
  for (const [biome, parts] of Object.entries({ suburb, urban, dense })) {
    let region = 0;
    for (const part of parts) {
      const bounds = bzBounds(part.flat());
      const masks = sourceMasks.filter(mask => bzOverlap(bounds, mask.bounds)).flatMap(mask => mask.parts);
      const clipped = masks.length ? polygonDifference([part], masks) : [part];
      for (const rings of clipped) {
        if (Math.abs(bzArea(rings[0])) * metersPerUnit ** 2 < 4) continue;
        const extent = bzBounds(rings.flat());
        const sourceIds = buildings.filter(building => building.point.x >= extent.minX - radius && building.point.x <= extent.maxX + radius && building.point.y >= extent.minY - radius && building.point.y <= extent.maxY + radius).map(building => building.sourceId).filter(Boolean);
        urbanVertices += rings.flat().length;
        features.push(bzGeneratedFeature(`game-biome-${biome}-${region++}`, biome, [rings], { method: 'building-density-contours', sampleSpacingMeters: cellSize * metersPerUnit, radiusMeters: 120, kernel: 'compact-biweight', thresholds: { ...thresholds }, smoothingIterations: 2, sourceZoneExclusion: !deferOccupiedCuts, buildingCount: sourceIds.length, sourceIds }, { urbanFiller: true }));
      }
    }
  }
  features.push(...aircraft);
  return { features, report: { enabled: true, method: 'building-density-contours', occupiedCutsDeferred: deferOccupiedCuts, sampleSpacingMeters: cellSize * metersPerUnit, grid: { cols, rows }, sourceBuildings: buildings.length, sampledNodes: activeNodes.size, urbanVertices, generatedZones: features.length, byBiome: Object.fromEntries(['wasteland', 'suburb', 'urban', 'dense', 'aircraft_parking'].map(biome => [biome, features.filter(feature => feature.biome === biome).length])) } };
}

function bzHull(points) {
  const unique = [...new Map(points.map(point => [`${point.x},${point.y}`, point])).values()].sort((a, b) => a.x - b.x || a.y - b.y);
  if (unique.length < 3) return unique;
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = list => { const result = []; for (const point of list) { while (result.length > 1 && cross(result.at(-2), result.at(-1), point) <= 0) result.pop(); result.push(point); } return result.slice(0, -1); };
  const hull = [...half(unique), ...half([...unique].reverse())]; return [...hull, { ...hull[0] }];
}
/** Source parking marks become a small derived parking surface, never the whole airport. */
export function buildAircraftParkingZones(world, polygons = bzPolygonRecords(world), metersPerUnit = Number(world.metersPerUnit) || 5) {
  const apron = polygons.filter(record => record.feature.tags?.aeroway === 'apron' || record.biome === 'aircraft_parking');
  const marks = (world.details || []).filter(feature => feature.tags?.aeroway === 'parking_position' || feature.kind === 'parking_position').flatMap(feature => {
    const points = feature.points?.length ? feature.points : Number.isFinite(feature.x) && Number.isFinite(feature.y) ? [{ x: feature.x, y: feature.y }] : [];
    return points.length && !points.every(point => apron.some(record => bzInParts(point, record.parts))) ? [{ feature, points, center: { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length } }] : [];
  });
  const visited = new Set(), zones = [], distance = 50 / metersPerUnit, padding = 5 / metersPerUnit;
  for (let start = 0; start < marks.length; start++) {
    if (visited.has(start)) continue;
    const queue = [start], cluster = []; visited.add(start);
    for (let position = 0; position < queue.length; position++) {
      const index = queue[position]; cluster.push(marks[index]);
      for (let i = 0; i < marks.length; i++) if (!visited.has(i) && Math.hypot(marks[i].center.x - marks[index].center.x, marks[i].center.y - marks[index].center.y) <= distance) { visited.add(i); queue.push(i); }
    }
    const padded = cluster.flatMap(mark => mark.points.flatMap(point => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([dx, dy]) => bzPoint(Math.max(0, Math.min(world.width, point.x + dx * padding)), Math.max(0, Math.min(world.height, point.y + dy * padding))))));
    const hull = bzHull(padded);
    if (hull.length >= 4) zones.push(bzGeneratedFeature(`game-aircraft-parking-${cluster.map(mark => mark.feature.id).sort().join('-')}`, 'aircraft_parking', [[hull]], { method: 'aircraft-parking-mark-buffer', paddingMeters: 5, sourceIds: cluster.map(mark => bzSourceId(mark.feature)).filter(Boolean).sort() }));
  }
  return zones;
}

const bzFusionBiomes = new Set(['residential', 'industrial', 'commercial', 'retail', 'parking', 'religious', 'healthcare', 'education', 'civic', 'emergency', 'accommodation', 'camping', 'food_service', 'service', 'utilities', 'construction', 'brownfield', 'aircraft_parking', 'suburb', 'urban', 'dense']);
function bzClosestParts(first, second) {
  let best = { distance: Infinity };
  for (const partA of first) for (const partB of second) {
    if (bzInParts(partA[0][0], [partB]) || bzInParts(partB[0][0], [partA])) return { distance: 0, a: partA[0][0], b: partA[0][0] };
    for (const ringA of partA) for (const ringB of partB) for (let i = 1; i < ringA.length; i++) for (let j = 1; j < ringB.length; j++) {
      const a = ringA[i - 1], b = ringA[i], c = ringB[j - 1], d = ringB[j];
      if (bzSegmentsCross(a, b, c, d)) return { distance: 0, a, b: a };
      for (const [point, s, t, reverse] of [[a, c, d, false], [b, c, d, false], [c, a, b, true], [d, a, b, true]]) {
        const nearest = bzNearest(point, s, t);
        if (nearest.distance < best.distance) best = { distance: nearest.distance, a: reverse ? nearest.point : point, b: reverse ? point : nearest.point };
      }
    }
  }
  return best;
}
function bzParallelGap(first, second, maxDistance) {
  let best = null, bestSpan = 0;
  for (const partA of first) for (const partB of second) for (const ringA of partA) for (const ringB of partB) {
    for (let i = 1; i < ringA.length; i++) for (let j = 1; j < ringB.length; j++) {
      const a = ringA[i - 1], b = ringA[i], c = ringB[j - 1], d = ringB[j];
      const length = Math.hypot(b.x - a.x, b.y - a.y), otherLength = Math.hypot(d.x - c.x, d.y - c.y);
      if (!length || !otherLength) continue;
      const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length;
      if (Math.abs(((d.x - c.x) * ux + (d.y - c.y) * uy) / otherLength) < .98) continue;
      const pc = (c.x - a.x) * ux + (c.y - a.y) * uy, pd = (d.x - a.x) * ux + (d.y - a.y) * uy;
      const low = Math.max(0, Math.min(pc, pd)), high = Math.min(length, Math.max(pc, pd));
      if (high - low <= bestSpan + .001) continue;
      const firstA = { x: a.x + low * ux, y: a.y + low * uy }, firstB = { x: a.x + high * ux, y: a.y + high * uy };
      const nearA = bzNearest(firstA, c, d), nearB = bzNearest(firstB, c, d);
      if (Math.max(nearA.distance, nearB.distance) > maxDistance || Math.max(nearA.distance, nearB.distance) < .001) continue;
      const ring = [bzPoint(firstA.x, firstA.y), bzPoint(firstB.x, firstB.y), bzPoint(nearB.point.x, nearB.point.y), bzPoint(nearA.point.x, nearA.point.y), bzPoint(firstA.x, firstA.y)];
      if (Math.abs(bzArea(ring)) < .001) continue;
      best = ring; bestSpan = high - low;
    }
  }
  return best;
}
function bzCorridor(a, b, halfWidth) {
  const distance = Math.hypot(b.x - a.x, b.y - a.y), nx = -(b.y - a.y) / distance * halfWidth, ny = (b.x - a.x) / distance * halfWidth;
  const ring = [bzPoint(a.x + nx, a.y + ny), bzPoint(b.x + nx, b.y + ny), bzPoint(b.x - nx, b.y - ny), bzPoint(a.x - nx, a.y - ny)]; return [...ring, { ...ring[0] }];
}
/** Join nearby functional plots; retain exact source parts and identify added corridors. */
export function groupNearbyZones(features = [], { metersPerUnit = 5, maxDistanceMeters = 35, blockers = [] } = {}) {
  const records = features.map((feature, index) => ({ feature, index, biome: feature.biome || mapBiome(feature), parts: bzParts(feature) })).filter(record => record.parts.length && bzFusionBiomes.has(record.biome) && !record.feature.fallback);
  records.forEach(record => { record.bounds = bzBounds(record.parts.flat(2)); });
  const parent = records.map((_, index) => index), root = index => parent[index] === index ? index : parent[index] = root(parent[index]);
  const joins = [], maxDistance = maxDistanceMeters / metersPerUnit;
  const blocked = blockers.filter(feature => !bzDry(feature)).flatMap(feature => {
    const isLine = feature.geometry === 'line' || feature.tags?.waterway && !feature.rings;
    if (isLine) return (feature.paths || [feature.points || []]).filter(points => points.length > 1).map(points => ({ parts: [], bounds: bzBounds(points), line: { feature: { ...feature, points }, bounds: bzBounds(points), radius: Math.max(.1, Number(feature.width) || 1) / 2 } }));
    const parts = bzParts(feature); return parts.length ? [{ parts, bounds: bzBounds(parts.flat(2)) }] : [];
  });
  for (let i = 0; i < records.length; i++) for (let j = i + 1; j < records.length; j++) {
    const a = records[i], b = records[j];
    if (a.biome !== b.biome || !bzOverlap(a.bounds, b.bounds, maxDistance)) continue;
    const nearest = bzClosestParts(a.parts, b.parts);
    if (nearest.distance > maxDistance) continue;
    const corridor = nearest.distance > .001 ? bzParallelGap(a.parts, b.parts, maxDistance) || bzCorridor(nearest.a, nearest.b, Math.min(5 / metersPerUnit, Math.max(1 / metersPerUnit, nearest.distance / 3))) : null;
    if (corridor && blocked.some(record => record.line ? bzRectTouchesLine(bzBounds(corridor), record.line) : bzOverlap(bzBounds(corridor), record.bounds) && (corridor.some(point => bzInParts(point, record.parts)) || record.parts.flat(2).some(point => bzInRing(point, corridor)) || corridor.slice(1).some((point, position) => record.parts.some(rings => rings.some(ring => ring.slice(1).some((target, targetIndex) => bzSegmentsCross(corridor[position], point, ring[targetIndex], target)))))))) continue;
    const ra = root(i), rb = root(j);
    if (ra === rb) continue;
    parent[rb] = ra; joins.push({ first: i, second: j, corridor });
  }
  const groups = new Map();
  records.forEach((record, index) => { const key = root(index); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(record); });
  const replacements = new Map(), removed = new Set();
  for (const [groupRoot, group] of groups) {
    if (group.length < 2) continue;
    const members = group.map(record => bzClone(record.feature)), memberIds = members.map(feature => feature.id).sort();
    const sourceIds = [...new Set(members.flatMap(feature => feature.sourceIds || [bzSourceId(feature)]).filter(Boolean))].sort();
    const corridors = joins.filter(join => root(join.first) === groupRoot && join.corridor).map(join => [join.corridor]);
    const parts = [...group.flatMap(record => bzClone(record.parts)), ...corridors];
    const biome = group[0].biome;
    let hash = 2166136261; for (const char of memberIds.join('|')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    const id = `game-zone-${biome}-${hash.toString(36)}`;
    const feature = { ...bzClone(group[0].feature), id, sourceId: id, geometry: 'polygon', points: parts[0][0], rings: parts[0], parts, biome, type: biome, footprintOnly: corridors.length === 0 && members.every(member => member.footprintOnly === true), derived: true, zoneFusion: true, merged: true, members, memberIds, sourceIds, names: [...new Set(members.flatMap(feature => feature.names || [feature.name].filter(Boolean)))], provenance: { method: 'nearby-zone-fusion', maxDistanceMeters, corridorCount: corridors.length, sourceIds } };
    replacements.set(group[0].index, feature); group.slice(1).forEach(record => removed.add(record.index));
  }
  return { features: features.flatMap((feature, index) => removed.has(index) ? [] : [replacements.get(index) || bzClone(feature)]), report: { inputFeatures: features.length, displayFeatures: features.length - removed.size, mergedGroups: replacements.size, joinedFeatures: removed.size, addedCorridors: joins.filter(join => join.corridor).length, maxDistanceMeters } };
}
