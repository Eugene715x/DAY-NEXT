/** Raster navigation over imported OSM geometry. No terrain or elevation is invented. */

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
  return {
    ...geometry,
    ...(geometry.points ? { points: geometry.points.map(point => ({ ...point })) } : {}),
    ...(geometry.rings ? { rings: geometry.rings.map(ring => ring.map(point => ({ ...point }))) } : {}),
  };
}

function rwValidateMap(map) {
  if (!map || map.version !== 1) throw new Error('Unsupported map format: expected version 1');
  const { width, height, cellSize, metersPerUnit, bbox } = map;
  if (![width, height, cellSize, metersPerUnit].every(value => Number.isFinite(value) && value > 0)
    || width % cellSize !== 0 || height % cellSize !== 0 || width / cellSize * (height / cellSize) > 250000) throw new Error('Invalid map dimensions, scale or grid size');
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)
    || bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -90 || bbox[3] > 90 || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new Error('Invalid geographic bbox');
  const arrays = ['roads', 'rivers', 'areas', 'buildings', 'pois', 'labels'];
  for (const key of arrays) if (map[key] !== undefined && !Array.isArray(map[key])) throw new Error(`Invalid map ${key}`);
  for (const feature of [...(map.roads || []), ...(map.rivers || []), ...(map.areas || []), ...(map.buildings || [])]) {
    if (feature.width !== undefined && (!Number.isFinite(feature.width) || feature.width <= 0)) throw new Error('Invalid geometry width');
    const points = feature.points || feature.rings?.flat() || [];
    if (points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new Error('Invalid geometry coordinate');
  }
  for (const poi of map.pois || []) if (!Number.isFinite(poi.x) || !Number.isFinite(poi.y)) throw new Error('Invalid location coordinate');
}

/** Convert projected source geometry to the same world interface as createWorld(). */
export function createRealWorld(map) {
  rwValidateMap(map);
  const { width, height, cellSize, metersPerUnit } = map;
  let seed = 2166136261;
  for (const character of String(map.id || map.name || 'osm')) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  const world = {
    width, height, cellSize, cols: width / cellSize, rows: height / cellSize, metersPerUnit,
    cells: Array.from({ length: width / cellSize * (height / cellSize) }, () => ({ type: 'plain', height: 0, cost: 1, walkable: true, radiation: 0 })),
    pois: [], roads: (map.roads || []).map(rwCopyGeometry), rivers: (map.rivers || []).map(rwCopyGeometry),
    areas: (map.areas || []).map(rwCopyGeometry), buildings: (map.buildings || []).map(rwCopyGeometry),
    labels: (map.labels || []).map(label => ({ ...label })), lakes: [], radiationZones: [], seed,
    id: map.id, name: map.name, region: map.region, country: map.country, bbox: [...map.bbox],
    source: { ...map.source }, geographic: true, relief: false,
    metadata: { type: 'osm', version: map.version, relief: false, navigationResolutionMeters: cellSize * metersPerUnit, maxPoiSnapMeters: 100 },
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
  world.start = rwNearestInComponent(world, components, desiredStart, components.main);
  world.metadata.componentCount = components.components.length;
  world.metadata.startSnapDistanceMeters = Math.hypot(world.start.x - desiredStart.x, world.start.y - desiredStart.y) * metersPerUnit;

  for (const original of map.pois || []) {
    const poi = { ...original, sourceX: original.x, sourceY: original.y };
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
