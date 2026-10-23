/** Raster navigation over imported OSM geometry. No terrain or elevation is invented. */
import { roadClass } from './map-presentation.js';
import { cellMovementMultiplier, roadSpeedMultiplier } from './movement-model.js';
import { prepareMovementGeometry } from './movement-geometry.js';

function rwPointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function rwInArea(x, y, rings) {
  let inside = false;
  for (const ring of rings) if (rwPointInRing(x, y, ring)) inside = !inside;
  return inside;
}

function rwDistanceToSegment(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const denominator = dx * dx + dy * dy;
  const t = denominator ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / denominator)) : 0;
  return Math.hypot(x - a.x - dx * t, y - a.y - dy * t);
}

function rwBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

function rwRasterBounds(world, bounds, padding, visit) {
  const minX = Math.max(0, Math.floor((bounds.minX - padding) / world.cellSize));
  const maxX = Math.min(world.cols - 1, Math.floor((bounds.maxX + padding) / world.cellSize));
  const minY = Math.max(0, Math.floor((bounds.minY - padding) / world.cellSize));
  const maxY = Math.min(world.rows - 1, Math.floor((bounds.maxY + padding) / world.cellSize));
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    visit(y * world.cols + x, (x + .5) * world.cellSize, (y + .5) * world.cellSize);
  }
}

function rwTerrain(world, index, type) {
  const cell = world.cells[index];
  cell.type = type;
  cell.walkable = type !== 'water';
  cell.cost = { plain: 1, forest: 1.45, swamp: 2.1, road: .75, bridge: .75, water: Infinity }[type];
}

function rwRasterLine(world, geometry, visit, minimumRadius = 0) {
  if (!geometry.points || geometry.points.length < 2) return;
  const radius = Math.max(minimumRadius, Number(geometry.width || 2) / 2);
  for (let i = 1; i < geometry.points.length; i++) {
    const a = geometry.points[i - 1], b = geometry.points[i];
    rwRasterBounds(world, rwBounds([a, b]), radius, (index, x, y) => {
      if (rwDistanceToSegment(x, y, a, b) <= radius) visit(index);
    });
  }
}

function rwIndexAt(world, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= world.width || point.y >= world.height) return -1;
  return Math.floor(point.y / world.cellSize) * world.cols + Math.floor(point.x / world.cellSize);
}

function rwFindComponents(world) {
  const ids = new Int32Array(world.cells.length); ids.fill(-1);
  const queue = new Int32Array(world.cells.length);
  const components = [];
  for (let start = 0; start < world.cells.length; start++) {
    if (!world.cells[start].walkable || ids[start] !== -1) continue;
    const id = components.length;
    let head = 0, tail = 1, roads = 0;
    queue[0] = start; ids[start] = id;
    while (head < tail) {
      const index = queue[head++], x = index % world.cols, y = Math.floor(index / world.cols);
      if (world.cells[index].type === 'road' || world.cells[index].type === 'bridge') roads++;
      const neighbors = [];
      if (x > 0) neighbors.push(index - 1);
      if (x + 1 < world.cols) neighbors.push(index + 1);
      if (y > 0) neighbors.push(index - world.cols);
      if (y + 1 < world.rows) neighbors.push(index + world.cols);
      for (const next of neighbors) if (ids[next] === -1 && world.cells[next].walkable) { ids[next] = id; queue[tail++] = next; }
    }
    components.push({ id, size: tail, roads });
  }
  // Prefer a connected landmass that contains roads; never fabricate crossings.
  const withRoads = components.filter(component => component.roads > 0);
  const main = (withRoads.length ? withRoads : components).sort((a, b) => b.size - a.size)[0];
  return { ids, components, main: main?.id ?? -1 };
}

function rwNearestInComponent(world, components, source, componentId, maxDistance = Infinity) {
  const index = rwIndexAt(world, source);
  if (index >= 0 && world.cells[index].walkable && components.ids[index] === componentId) return { x: source.x, y: source.y };
  let nearest = null, minimum = maxDistance;
  for (let i = 0; i < world.cells.length; i++) {
    if (components.ids[i] !== componentId) continue;
    const x = (i % world.cols + .5) * world.cellSize, y = (Math.floor(i / world.cols) + .5) * world.cellSize;
    const distance = Math.hypot(x - source.x, y - source.y);
    if (distance <= minimum) { minimum = distance; nearest = { x, y }; }
  }
  return nearest;
}

function rwCopyGeometry(geometry) {
  // Imported maps are JSON data. Copy every additive metadata field as well as
  // geometry so inspecting/styling a roof, address or OSM tag cannot mutate it.
  if (Array.isArray(geometry)) return geometry.map(rwCopyGeometry);
  if (geometry !== null && typeof geometry === 'object') return Object.fromEntries(
    Object.entries(geometry).map(([key, value]) => [key, rwCopyGeometry(value)]),
  );
  return geometry;
}

function rwValidateMap(map) {
  if (!map || map.version !== 1) throw new Error('Unsupported map format: expected version 1');
  const { width, height, cellSize, metersPerUnit, bbox } = map;
  if (![width, height, cellSize, metersPerUnit].every(value => Number.isFinite(value) && value > 0)
    || width > 10000 || height > 10000 || width * height > 20000000
    || width % cellSize !== 0 || height % cellSize !== 0 || width / cellSize * (height / cellSize) > 250000) throw new Error('Invalid map dimensions, scale or grid size');
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)
    || bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -90 || bbox[3] > 90 || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new Error('Invalid geographic bbox');
  const arrays = ['roads', 'rivers', 'areas', 'buildings', 'details', 'pois', 'labels', 'relations'];
  for (const key of arrays) if (map[key] !== undefined && !Array.isArray(map[key])) throw new Error(`Invalid map ${key}`);
  const validatePoints = points => {
    if (!Array.isArray(points)) throw new Error('Invalid geometry coordinate array');
    if (points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || Math.abs(point.x) > 10000000 || Math.abs(point.y) > 10000000)) throw new Error('Invalid geometry coordinate');
  };
  for (const feature of [...(map.roads || []), ...(map.rivers || []), ...(map.areas || []), ...(map.buildings || []), ...(map.details || [])]) {
    if (!feature || typeof feature !== 'object') throw new Error('Invalid geometry feature');
    if (feature.width !== undefined && (!Number.isFinite(feature.width) || feature.width <= 0)) throw new Error('Invalid geometry width');
    if (feature.points !== undefined) validatePoints(feature.points);
    if (feature.rings !== undefined) {
      if (!Array.isArray(feature.rings)) throw new Error('Invalid geometry rings');
      for (const ring of feature.rings) validatePoints(ring);
    }
  }
  for (const detail of map.details || []) {
    if (!['point', 'line', 'polygon'].includes(detail.geometry)) throw new Error('Invalid detail geometry type');
    const minimumPoints = { point: 1, line: 2, polygon: 3 }[detail.geometry];
    const points = detail.points || detail.rings?.[0];
    if (!points || points.length < minimumPoints) throw new Error('Invalid detail geometry coordinate count');
  }
  for (const poi of map.pois || []) if (!Number.isFinite(poi.x) || !Number.isFinite(poi.y)) throw new Error('Invalid location coordinate');
}

/** Convert projected source geometry to the same world interface as createWorld(). */
export function createRealWorld(map, options = {}) {
  rwValidateMap(map);
  const { width, height, metersPerUnit } = map;
  const sourceCellSize = map.cellSize;
  const requestedCellSize = options.navigationCellSize;
  if (requestedCellSize !== undefined && (!Number.isFinite(requestedCellSize) || requestedCellSize <= 0)) throw new Error('Invalid navigation cell size');
  let subdivision = 1;
  const sourceCells = width / sourceCellSize * (height / sourceCellSize);
  // Refine only the runtime navigation, preserving the source's coordinates and
  // grid declaration. A power-of-two subdivision keeps map edges exact and the
  // same node limit also bounds unusually large imported maps.
  while (requestedCellSize !== undefined && sourceCellSize / subdivision > requestedCellSize && sourceCells * (subdivision * 2) ** 2 <= 250000) subdivision *= 2;
  const cellSize = sourceCellSize / subdivision;
  let seed = 2166136261;
  for (const character of String(map.id || map.name || 'osm')) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  const world = {
    width, height, cellSize, cols: width / cellSize, rows: height / cellSize, metersPerUnit,
    cells: Array.from({ length: width / cellSize * (height / cellSize) }, () => ({ type: 'plain', height: 0, cost: 1, walkable: true, radiation: 0 })),
    pois: [], roads: (map.roads || []).map(rwCopyGeometry), rivers: (map.rivers || []).map(rwCopyGeometry),
    areas: (map.areas || []).map(rwCopyGeometry), buildings: (map.buildings || []).map(rwCopyGeometry),
    details: (map.details || []).map(rwCopyGeometry),
    labels: (map.labels || []).map(rwCopyGeometry), relations: (map.relations || []).map(rwCopyGeometry), lakes: [], radiationZones: [], seed,
    id: map.id, name: map.name, region: map.region, country: map.country, bbox: [...map.bbox],
    source: rwCopyGeometry(map.source || {}), coverage: rwCopyGeometry(map.coverage || null), geographic: true, relief: false,
    metadata: { type: 'osm', version: map.version, relief: false, navigationResolutionMeters: cellSize * metersPerUnit, sourceCellSize, navigationSubdivision: subdivision, maxPoiSnapMeters: 100 },
  };
  // Elevation deliberately stays flat: OSM surface tags do not supply a DEM.
  const priorities = { plain: 0, forest: 1, swamp: 2, water: 3 };
  for (const area of [...world.areas].sort((a, b) => (priorities[a.type] || 0) - (priorities[b.type] || 0))) {
    if (!Object.hasOwn(priorities, area.type) || !area.rings?.length) continue;
    const type = area.type === 'water' && (area.intermittent === true || area.seasonal === true) ? 'plain' : area.type;
    rwRasterBounds(world, rwBounds(area.rings.flat()), 0, (index, x, y) => {
      if (rwInArea(x, y, area.rings)) rwTerrain(world, index, type);
    });
  }
  // Seasonal desert washes are geometry for the atlas, not permanent navigation barriers.
  for (const river of world.rivers) if (river.intermittent !== true && river.seasonal !== true) {
    rwRasterLine(world, river, index => rwTerrain(world, index, 'water'), cellSize * .55);
  }
  // Rendering the ground must never inherit the wider navigation corridors
  // painted below. Keep the original land/water beneath roads and bridges.
  world.terrainCells = world.cells.map(rwCopyGeometry);
  // Paint roads on land first. Missing/false bridge tags must never unblock water.
  for (const road of world.roads) rwRasterLine(world, road, index => {
    if (world.cells[index].type !== 'water') rwTerrain(world, index, 'road');
  }, cellSize * .72);
  for (const road of world.roads) if (road.bridge === true) rwRasterLine(world, road, index => {
    if (world.cells[index].type === 'water') rwTerrain(world, index, 'bridge');
  }, cellSize * .72);

  const components = rwFindComponents(world);
  if (components.main === -1) throw new Error('Map has no walkable land');
  const desiredStart = map.start && Number.isFinite(map.start.x) && Number.isFinite(map.start.y) ? map.start : { x: width / 2, y: height / 2 };
  world.metadata.requestedStart = { x: desiredStart.x, y: desiredStart.y };
  world.start = rwNearestInComponent(world, components, desiredStart, components.main);
  world.metadata.componentCount = components.components.length;
  world.metadata.startSnapDistanceMeters = Math.hypot(world.start.x - desiredStart.x, world.start.y - desiredStart.y) * metersPerUnit;

  for (const original of map.pois || []) {
    const poi = { ...rwCopyGeometry(original), sourceX: original.x, sourceY: original.y };
    const originalIndex = rwIndexAt(world, poi);
    // Preserve locations on the other bank. Only snap water/on-edge markers to a nearby accessible landing.
    if (originalIndex >= 0 && world.cells[originalIndex].walkable) poi.reachable = components.ids[originalIndex] === components.main;
    else {
      const snapped = rwNearestInComponent(world, components, poi, components.main, 100 / metersPerUnit);
      if (snapped) { poi.x = snapped.x; poi.y = snapped.y; poi.reachable = true; }
      else poi.reachable = false;
    }
    poi.snapDistanceMeters = Math.hypot(poi.x - original.x, poi.y - original.y) * metersPerUnit;
    poi.discovered = Boolean(original.discovered) || poi.reachable && Math.hypot(poi.x - world.start.x, poi.y - world.start.y) * metersPerUnit <= 100;
    world.pois.push(poi);
  }
  world.metadata.unreachablePoiCount = world.pois.filter(poi => !poi.reachable).length;
  return world;
}

function rwParts(feature) {
  if (feature.parts?.length) return feature.parts;
  if (feature.rings?.length) return [feature.rings];
  if (feature.points?.length >= 3) return [[feature.points]];
  return [];
}

// Paint centre samples by scanline rather than testing every map cell against
// every vertex of a regional polygon and all of its holes.
function rwRasterParts(world, parts, visit) {
  const size = world.cellSize;
  for (const rings of parts) {
    if (!rings[0]?.length) continue;
    const bounds = rwBounds(rings[0]);
    const firstRow = Math.max(0, Math.ceil(bounds.minY / size - .5));
    const lastRow = Math.min(world.rows - 1, Math.floor(bounds.maxY / size - .5));
    for (let row = firstRow; row <= lastRow; row++) {
      const y = (row + .5) * size, crossings = [];
      for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j], b = ring[i];
        if ((a.y > y) !== (b.y > y)) crossings.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
      }
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const firstCol = Math.max(0, Math.ceil(crossings[i] / size - .5));
        const lastCol = Math.min(world.cols - 1, Math.ceil(crossings[i + 1] / size - .5) - 1);
        for (let col = firstCol; col <= lastCol; col++) visit(row * world.cols + col);
      }
    }
  }
}

const rwFlag = value => value !== undefined && value !== null && !['', 'no', 'false', '0'].includes(String(value));
const rwDryBiome = feature => ['seasonal_river', 'dry_riverbed'].includes(feature.biome) || String(feature.waterKind || '').startsWith('seasonal_') || rwFlag(feature.intermittent) || rwFlag(feature.seasonal) || rwFlag(feature.tags?.intermittent) || rwFlag(feature.tags?.seasonal);
const rwGroundBiome = cell => ({ forest: 'forest', swamp: 'wetland', hill: 'rock', water: 'water' })[cell?.type] || 'wasteland';

/**
 * Prepare the same physical costs for route search and travel. This runs once
 * per loaded map and never consults layer visibility. Input geometry and DEM
 * samples are retained as source facts; only runtime navigation cells change.
 */
export function prepareTravelWorld(world, { elevationAt, biomeFeatures = [], landscape = null } = {}) {
  if (!world || !Array.isArray(world.cells) || !Number.isFinite(world.cellSize) || world.cellSize <= 0) throw new Error('Invalid travel world');
  const ground = world.terrainCells || world.cells;
  for (let index = 0; index < world.cells.length; index++) {
    const cell = world.cells[index];
    cell.biome = rwGroundBiome(ground[index]);
    cell.roadClass = null; cell.surface = null; cell.roadDistanceMeters = null; cell.roadWidthMeters = null; cell.roadId = null;
    delete cell.roadAnchor;
    cell.elevationMeters = null;
    cell.landscape = null; cell.landscapeMultiplier = 1; cell.landscapeSlopePercent = null; cell.landscapeReliefMeters = null;
  }
  const polygons = biomeFeatures.filter(feature => feature?.geometry === 'polygon' && feature.exclusive !== false);
  const fallback = polygons.find(feature => feature.fallback);
  if (fallback?.biome) for (const cell of world.cells) cell.biome = fallback.biome;
  let permanentWaterCells = 0;
  for (const feature of polygons) {
    if (feature.fallback) continue;
    const wet = (feature.water === true || ['water', 'river', 'lake'].includes(feature.biome)) && !rwDryBiome(feature);
    rwRasterParts(world, rwParts(feature), index => {
      const cell = world.cells[index];
      cell.biome = feature.biome || rwGroundBiome(cell);
      if (wet && cell.type !== 'bridge') { cell.type = 'water'; cell.walkable = false; }
    });
  }
  const nearestRoad = new Float64Array(world.cells.length); nearestRoad.fill(Infinity);
  const roadPreference = new Float64Array(world.cells.length);
  const size = world.cellSize, metersPerUnit = world.metersPerUnit || 5;
  const railTypes = new Set(['rail', 'light_rail', 'narrow_gauge', 'tram', 'subway', 'monorail', 'funicular', 'abandoned', 'disused', 'dismantled', 'razed']);
  const roads = new Map((world.roads || []).map((road, index) => [road.id || `road-${index}`, road]));
  for (const detail of world.details || []) if (detail.geometry === 'line' && railTypes.has(detail.tags?.railway || detail.kind) && !roads.has(detail.id)) roads.set(detail.id, detail);
  for (const road of roads.values()) {
    const paths = road.paths?.length ? road.paths : [road.points || []];
    const klass = roadClass(road), surface = road.surface || road.tags?.surface || null;
    const preference = roadSpeedMultiplier(klass, surface);
    const width = Number(road.widthMeters) > 0 ? Number(road.widthMeters) / metersPerUnit : Number(road.width) > 0 ? Number(road.width) : 2;
    const radius = Math.max(width / 2, size * .72);
    const bridge = rwFlag(road.bridge ?? road.tags?.bridge);
    for (const path of paths) for (let segment = 1; segment < path.length; segment++) {
      const a = path[segment - 1], b = path[segment], dx = b.x - a.x, dy = b.y - a.y, square = dx * dx + dy * dy;
      rwRasterBounds(world, rwBounds([a, b]), radius, (index, x, y) => {
        const cell = world.cells[index];
        const fraction = square ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / square)) : 0;
        const px = a.x + fraction * dx, py = a.y + fraction * dy, distance = Math.hypot(x - px, y - py);
        if (distance > radius) return;
        // Only an explicit mapped bridge may override mapped permanent water.
        if (!cell.walkable && !bridge) return;
        if (bridge && !cell.walkable) { cell.type = 'bridge'; cell.walkable = true; }
        if (!cell.walkable) return;
        // At crossings use the better surface; elsewhere favour the closest
        // native centreline, independent of the order of OSM records.
        const normalized = distance / radius;
        const score = normalized + (1 / Math.max(.01, preference)) * .2;
        const old = nearestRoad[index];
        if (score > old + 1e-9 || Math.abs(score - old) < 1e-9 && (preference < roadPreference[index] || preference === roadPreference[index] && cell.roadId !== null && String(road.id || '').localeCompare(String(cell.roadId)) >= 0)) return;
        nearestRoad[index] = score; roadPreference[index] = preference;
        cell.roadClass = klass; cell.surface = surface; cell.roadDistanceMeters = distance * metersPerUnit; cell.roadWidthMeters = width * metersPerUnit; cell.roadId = road.id || null;
        if (cell.type !== 'bridge') cell.type = 'road';
        const left = Math.floor(index % world.cols) * size, top = Math.floor(index / world.cols) * size;
        const epsilon = Math.min(1e-6, size * 1e-6);
        if (px >= left - epsilon && px <= left + size + epsilon && py >= top - epsilon && py <= top + size + epsilon) {
          cell.roadAnchor = { x: Math.max(left + epsilon, Math.min(left + size - epsilon, px)), y: Math.max(top + epsilon, Math.min(top + size - epsilon, py)) };
        } else delete cell.roadAnchor;
      });
    }
  }
  let elevationSamples = 0, roadCells = 0, landscapeSamples = 0;
  const biomeCounts = {}, landscapeCounts = {};
  for (let index = 0; index < world.cells.length; index++) {
    const cell = world.cells[index], x = (index % world.cols + .5) * size, y = (Math.floor(index / world.cols) + .5) * size;
    const height = typeof elevationAt === 'function' ? elevationAt(x, y) : null;
    if (Number.isFinite(height)) { cell.elevationMeters = height; elevationSamples++; }
    const landform = typeof landscape?.getAt === 'function' ? landscape.getAt(x, y) : null;
    if (landform?.id && Number.isFinite(landform.multiplier) && landform.multiplier > 0) {
      cell.landscape = landform.id; cell.landscapeMultiplier = landform.multiplier;
      cell.landscapeSlopePercent = Number.isFinite(landform.slopePercent) ? landform.slopePercent : null;
      cell.landscapeReliefMeters = Number.isFinite(landform.reliefMeters) ? landform.reliefMeters : null;
      landscapeSamples++; landscapeCounts[landform.id] = (landscapeCounts[landform.id] || 0) + 1;
    }
    if (cell.roadClass) roadCells++;
    if (!cell.walkable) permanentWaterCells++;
    biomeCounts[cell.biome] = (biomeCounts[cell.biome] || 0) + 1;
    const multiplier = cellMovementMultiplier(cell);
    cell.cost = cell.walkable && Number.isFinite(multiplier) && multiplier > 0 ? 1 / multiplier : Infinity;
    if (!Number.isFinite(cell.cost)) cell.walkable = false;
  }
  world.movementGeometry = prepareMovementGeometry(world, { biomeFeatures: polygons });
  world.movementPrepared = true;
  world.movementRevision = (world.movementRevision || 0) + 1;
  world.movementElevationAt = typeof elevationAt === 'function' ? elevationAt : null;
  world.relief = elevationSamples > 0;
  const components = rwFindComponents(world);
  if (components.main === -1) throw new Error('Map has no walkable travel ground');
  const requestedStart = world.metadata?.requestedStart || world.start || { x: world.width / 2, y: world.height / 2 };
  world.start = rwNearestInComponent(world, components, requestedStart, components.main);
  for (const poi of world.pois || []) {
    const source = { x: Number.isFinite(poi.sourceX) ? poi.sourceX : poi.x, y: Number.isFinite(poi.sourceY) ? poi.sourceY : poi.y };
    const sourceIndex = rwIndexAt(world, source);
    const landing = sourceIndex >= 0 && world.cells[sourceIndex].walkable ? source : rwNearestInComponent(world, components, source, components.main, 100 / metersPerUnit);
    if (landing) { poi.x = landing.x; poi.y = landing.y; }
    else { poi.x = source.x; poi.y = source.y; }
    const index = rwIndexAt(world, poi);
    poi.reachable = index >= 0 && world.cells[index].walkable && components.ids[index] === components.main;
    poi.snapDistanceMeters = Math.hypot(poi.x - source.x, poi.y - source.y) * metersPerUnit;
    poi.discovered = Boolean(poi.discovered) || poi.reachable && Math.hypot(poi.x - world.start.x, poi.y - world.start.y) * metersPerUnit <= 100;
  }
  const report = {
    cells: world.cells.length, cellSize: size, resolutionMeters: size * metersPerUnit,
    elevationSamples, roadCells, roadSources: roads.size, permanentWaterCells, biomeCounts,
    landscapeSamples, landscapeCounts, geometry: world.movementGeometry.getStats(),
    components: components.components.length, unreachablePois: (world.pois || []).filter(poi => !poi.reachable).length,
  };
  world.metadata = { ...(world.metadata || {}), relief: world.relief, movement: report, componentCount: components.components.length,
    startSnapDistanceMeters: Math.hypot(world.start.x - requestedStart.x, world.start.y - requestedStart.y) * metersPerUnit,
    unreachablePoiCount: report.unreachablePois };
  return report;
}
