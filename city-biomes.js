import { polygonUnion, polygonIntersection, polygonDifference } from './polygon-geometry.js';

// A city is a gameplay envelope of measured development, not an administrative
// boundary. Source plots, building footprints and their roles remain untouched.
const cbSourceId = feature => feature.sourceId || feature.id?.match(/^(?:node|way|relation)-\d+/)?.[0] || feature.id;
const cbParts = feature => feature.parts || (feature.rings?.length ? [feature.rings] : feature.points?.length >= 3 ? [[feature.points]] : []);
const cbBounds = points => points.reduce((b, p) => ({ minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y), maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
const cbArea = ring => ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]; return sum + p.x * q.y - q.x * p.y; }, 0) / 2;
function cbInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
const cbInParts = (point, parts) => parts.some(rings => cbInRing(point, rings[0]) && !rings.slice(1).some(ring => cbInRing(point, ring)));
function cbNearest(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, denominator = dx * dx + dy * dy;
  const t = denominator ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / denominator)) : 0;
  const nearest = { x: a.x + dx * t, y: a.y + dy * t };
  return { point: nearest, distance: Math.hypot(point.x - nearest.x, point.y - nearest.y) };
}
const cbBoxDistance = (point, bounds) => Math.hypot(Math.max(bounds.minX - point.x, 0, point.x - bounds.maxX), Math.max(bounds.minY - point.y, 0, point.y - bounds.maxY));
const cbUrbanUses = new Set(['residential', 'commercial', 'retail', 'industrial']);
const cbSettlements = new Set(['city', 'town', 'village', 'hamlet', 'isolated_dwelling']);
function cbHash(text) { let hash = 2166136261; for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0; return hash.toString(36); }
function cbSmoothRing(ring, iterations = 2) {
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
function cbSimplifyLine(points, tolerance) {
  if (points.length <= 2) return points;
  const a = points[0], b = points.at(-1);
  let selected = -1, maximum = tolerance;
  for (let i = 1; i < points.length - 1; i++) {
    const distance = cbNearest(points[i], a, b).distance;
    if (distance > maximum) { maximum = distance; selected = i; }
  }
  return selected < 0 ? [a, b] : [...cbSimplifyLine(points.slice(0, selected + 1), tolerance).slice(0, -1), ...cbSimplifyLine(points.slice(selected), tolerance)];
}
function cbSmoothParts(parts, metersPerUnit) {
  return parts.map(rings => rings.map(ring => {
    const rounded = cbSmoothRing(ring), half = Math.floor((rounded.length - 1) / 2);
    return [...cbSimplifyLine(rounded.slice(0, half + 1), .35 / metersPerUnit).slice(0, -1), ...cbSimplifyLine(rounded.slice(half), .35 / metersPerUnit)];
  }));
}

// Trace level-set segments, rather than exposed square cell edges. Shared edge
// identities join neighboring samples exactly; interpolation makes the contour
// continuous even though the density calculation uses a bounded sample lattice.
function cbDensityContours(field, activeCells, cols, rows, cellSize, threshold) {
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
    if (ring.length >= 4 && Math.abs(cbArea(ring)) > 1e-9) rings.push(ring);
  }
  // The interpolated graph has arbitrary winding. Nesting, not trace direction,
  // distinguishes holes and islands before the boolean geometry normalizes it.
  rings.sort((a, b) => Math.abs(cbArea(b)) - Math.abs(cbArea(a)));
  const entries = [];
  for (const ring of rings) {
    let parent = -1;
    for (let i = entries.length - 1; i >= 0; i--) if (cbInRing(ring[0], entries[i].ring)) { parent = i; break; }
    entries.push({ ring, parent, depth: parent < 0 ? 0 : entries[parent].depth + 1 });
  }
  return entries.flatMap((entry, index) => entry.depth % 2 ? [] : [[entry.ring, ...entries.filter(other => other.parent === index && other.depth % 2).map(other => other.ring)]]);
}


function cbBuildingClusters(buildings, places, metersPerUnit) {
  const distance = 220 / metersPerUnit, bins = new Map();
  buildings.forEach((building, index) => { const key = `${Math.floor(building.point.x / distance)},${Math.floor(building.point.y / distance)}`; if (!bins.has(key)) bins.set(key, []); bins.get(key).push(index); });
  const visited = new Set(), clusters = [];
  for (let start = 0; start < buildings.length; start++) {
    if (visited.has(start)) continue;
    const queue = [start]; visited.add(start);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const point = buildings[queue[cursor]].point, bx = Math.floor(point.x / distance), by = Math.floor(point.y / distance);
      for (let y = by - 1; y <= by + 1; y++) for (let x = bx - 1; x <= bx + 1; x++) for (const index of bins.get(`${x},${y}`) || []) {
        if (!visited.has(index) && Math.hypot(buildings[index].point.x - point.x, buildings[index].point.y - point.y) <= distance) { visited.add(index); queue.push(index); }
      }
    }
    const group = queue.map(index => buildings[index]);
    const anchors = places.filter(place => group.some(building => Math.hypot(building.point.x - place.point.x, building.point.y - place.point.y) * metersPerUnit <= (place.settlement ? 800 : 600)));
    const significant = group.length >= 12 || group.length >= 5 && (!places.length || anchors.length) || group.length >= 2 && anchors.some(place => place.settlement && group.some(building => Math.hypot(building.point.x - place.point.x, building.point.y - place.point.y) * metersPerUnit <= 300));
    if (significant) clusters.push({ buildings: group, anchors });
  }
  return clusters;
}

function cbClose(mask, cols, rows, radius) {
  const stride = cols + 1, offsets = [];
  for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) if (x * x + y * y <= radius * radius) offsets.push([x, y]);
  const expanded = new Set();
  for (const index of mask) {
    const px = index % stride, py = Math.floor(index / stride);
    for (const [dx, dy] of offsets) { const x = px + dx, y = py + dy; if (x > 0 && y > 0 && x < cols && y < rows) expanded.add(y * stride + x); }
  }
  const closed = new Set();
  for (const index of expanded) {
    const px = index % stride, py = Math.floor(index / stride);
    if (offsets.every(([dx, dy]) => { const x = px + dx, y = py + dy; return x <= 0 || y <= 0 || x >= cols || y >= rows || expanded.has(y * stride + x); })) closed.add(index);
  }
  return closed;
}

function cbFillHoles(mask, cols, rows) {
  if (!mask.size) return mask;
  const stride = cols + 1, bounds = cbBounds([...mask].map(index => ({ x: index % stride, y: Math.floor(index / stride) })));
  const minX = Math.max(0, bounds.minX - 1), maxX = Math.min(cols, bounds.maxX + 1), minY = Math.max(0, bounds.minY - 1), maxY = Math.min(rows, bounds.maxY + 1);
  const exterior = new Set(), queue = [];
  const add = (x, y) => { const index = y * stride + x; if (!mask.has(index) && !exterior.has(index)) { exterior.add(index); queue.push(index); } };
  for (let x = minX; x <= maxX; x++) { add(x, minY); add(x, maxY); }
  for (let y = minY; y <= maxY; y++) { add(minX, y); add(maxX, y); }
  for (let cursor = 0; cursor < queue.length; cursor++) { const index = queue[cursor], x = index % stride, y = Math.floor(index / stride); if (x > minX) add(x - 1, y); if (x < maxX) add(x + 1, y); if (y > minY) add(x, y - 1); if (y < maxY) add(x, y + 1); }
  const result = new Set(mask);
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) { const index = y * stride + x; if (!exterior.has(index)) result.add(index); }
  return result;
}

/** Build coherent city envelopes once; nature and water are cut by the partition. */
export function buildCityBiomes(world = {}) {
  if (!(world.width > 0 && world.height > 0)) return { features: [], report: { method: 'coherent-development-envelope', cities: 0 } };
  const metersPerUnit = Number(world.metersPerUnit) || 5, procedural = !world.geographic && !Array.isArray(world.bbox);
  const polygonSources = ['areas', 'details'].flatMap(collection => (world[collection] || []).map(feature => ({ feature, parts: cbParts(feature) })).filter(record => record.parts.length && (!record.feature.geometry || record.feature.geometry === 'polygon')));
  const airports = polygonSources.filter(record => record.feature.tags?.aeroway === 'aerodrome').flatMap(record => record.parts);
  const placeById = new Map();
  for (const feature of [...(world.details || []), ...(world.pois || [])]) {
    const tags = feature.tags || {}, settlement = cbSettlements.has(tags.place) || cbSettlements.has(tags['abandoned:place']) || procedural && ['town', 'village', 'city', 'settlement'].includes(feature.kind);
    if (!settlement && tags.place !== 'locality') continue;
    const point = feature.points?.[0] || feature;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const id = cbSourceId(feature); if (!placeById.has(id)) placeById.set(id, { id, name: tags.name || feature.name || '', point: { x: point.x, y: point.y }, settlement });
  }
  const places = [...placeById.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const buildings = (world.buildings || []).filter(feature => feature.points?.length >= 3).map(feature => { const bounds = cbBounds(feature.points); return { id: cbSourceId(feature), point: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 } }; }).filter(building => !cbInParts(building.point, airports)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const clusters = cbBuildingClusters(buildings, places, metersPerUnit), selected = clusters.flatMap(cluster => cluster.buildings);
  const plots = polygonSources.filter(record => {
    if (!cbUrbanUses.has(record.feature.tags?.landuse)) return false;
    const bounds = cbBounds(record.parts.flat(2));
    return selected.some(building => cbBoxDistance(building.point, bounds) * metersPerUnit <= 120)
      || places.some(place => place.settlement && cbBoxDistance(place.point, bounds) * metersPerUnit <= 500);
  });
  if (!selected.length && !plots.length) return { features: [], report: { method: 'coherent-development-envelope', cities: 0, sourceBuildings: (world.buildings || []).length, eligibleBuildings: buildings.length, selectedBuildings: 0 } };
  const cellSize = Math.max(15 / metersPerUnit, world.width / 800, world.height / 800), cols = Math.ceil(world.width / cellSize) + 2, rows = Math.ceil(world.height / cellSize) + 2, stride = cols + 1;
  const mask = new Set(), radius = 110 / metersPerUnit;
  for (const building of selected) {
    const minX = Math.max(1, Math.floor((building.point.x - radius) / cellSize) + 1), maxX = Math.min(cols - 1, Math.ceil((building.point.x + radius) / cellSize) + 1), minY = Math.max(1, Math.floor((building.point.y - radius) / cellSize) + 1), maxY = Math.min(rows - 1, Math.ceil((building.point.y + radius) / cellSize) + 1);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (Math.hypot((x - 1) * cellSize - building.point.x, (y - 1) * cellSize - building.point.y) <= radius) mask.add(y * stride + x);
  }
  for (const record of plots) {
    const bounds = cbBounds(record.parts.flat(2)), minX = Math.max(1, Math.floor(bounds.minX / cellSize) + 1), maxX = Math.min(cols - 1, Math.ceil(bounds.maxX / cellSize) + 1), minY = Math.max(1, Math.floor(bounds.minY / cellSize) + 1), maxY = Math.min(rows - 1, Math.ceil(bounds.maxY / cellSize) + 1);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (cbInParts({ x: (x - 1) * cellSize, y: (y - 1) * cellSize }, record.parts)) mask.add(y * stride + x);
  }
  const closed = cbFillHoles(cbClose(mask, cols, rows, Math.max(1, Math.round(60 / metersPerUnit / cellSize))), cols, rows);
  let field = new Float64Array((cols + 1) * (rows + 1));
  for (const index of closed) field[index] = 1;
  const extent = cbBounds([...closed].map(index => ({ x: index % stride, y: Math.floor(index / stride) })));
  const minX = Math.max(1, extent.minX - 3), maxX = Math.min(cols - 1, extent.maxX + 3), minY = Math.max(1, extent.minY - 3), maxY = Math.min(rows - 1, extent.maxY + 3);
  for (let pass = 0; pass < 2; pass++) {
    const horizontal = new Float64Array(field.length), vertical = new Float64Array(field.length);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) { const index = y * stride + x; horizontal[index] = (field[index - 1] + field[index] * 2 + field[index + 1]) / 4; }
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) { const index = y * stride + x; vertical[index] = (horizontal[index - stride] + horizontal[index] * 2 + horizontal[index + stride]) / 4; }
    field = vertical;
  }
  const activeCells = new Set();
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (field[y * stride + x]) for (const [cx, cy] of [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]]) activeCells.add(cy * cols + cx);
  const contours = cbDensityContours(field, activeCells, cols, rows, cellSize, .48);
  const rectangle = [[[{ x: 0, y: 0 }, { x: world.width, y: 0 }, { x: world.width, y: world.height }, { x: 0, y: world.height }, { x: 0, y: 0 }]]];
  let parts = polygonIntersection(polygonUnion(cbSmoothParts(contours.map(part => [part[0]]), metersPerUnit)), rectangle);
  if (airports.length) parts = polygonDifference(parts, airports);
  const features = parts.filter(part => Math.abs(cbArea(part[0])) * metersPerUnit ** 2 >= 1500).map(part => {
    const bounds = cbBounds(part[0]), related = selected.filter(building => cbBoxDistance(building.point, bounds) * metersPerUnit <= 110), center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    const nearbyPlaces = places.map(place => ({ ...place, distance: Math.hypot(place.point.x - center.x, place.point.y - center.y) * metersPerUnit })).filter(place => place.distance <= 1500).sort((a, b) => a.distance - b.distance || String(a.id).localeCompare(String(b.id)));
    const sourceIds = [...new Set([...related.map(building => building.id), ...plots.filter(record => record.parts.flat(2).some(point => point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY)).map(record => cbSourceId(record.feature)), ...nearbyPlaces.slice(0, 1).map(place => place.id)])].filter(Boolean).sort();
    const id = `game-city-${cbHash(sourceIds.join('|'))}`, name = nearbyPlaces[0]?.name || 'Городская местность';
    return { id, sourceId: id, sourceIds, name, biome: 'city', type: 'city', kind: 'city', geometry: 'polygon', points: part[0], rings: part, parts: [part], derived: true, city: true, fill: '#939797', provenance: { method: 'coherent-development-envelope', sourceIds, buildingCount: related.length, sampleSpacingMeters: cellSize * metersPerUnit, buildingHaloMeters: 110, closeGapsMeters: 120, filledInteriorGaps: true, sourceBoundary: false } };
  });
  return { features, report: { method: 'coherent-development-envelope', cities: features.length, sourceBuildings: (world.buildings || []).length, eligibleBuildings: buildings.length, excludedAirportBuildings: (world.buildings || []).length - buildings.length, selectedBuildings: selected.length, sourcePlots: plots.length, sourceClusters: clusters.length, sampleSpacingMeters: cellSize * metersPerUnit, vertices: features.reduce((sum, feature) => sum + feature.parts.flat(2).length, 0), byCity: features.map(feature => ({ id: feature.id, name: feature.name, buildingCount: feature.provenance.buildingCount })) } };
}
