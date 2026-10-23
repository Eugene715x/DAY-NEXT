// Shared travel-time model for route search, smoothing, ETA and the moving actor.
// Multipliers describe a walking game character, not a real-world hiking forecast.
export const BASE_WALK_METERS_PER_MINUTE = 4000 / 60;
export const MAX_MOVEMENT_MULTIPLIER = 2;
const mmClamp = (value, low, high) => Math.max(low, Math.min(high, value));
const mmDistance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const mmScale = world => Number(world.metersPerUnit) > 0 ? Number(world.metersPerUnit) : 1;
const mmCell = (world, x, y) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < world.width && y < world.height
  ? world.cells[Math.floor(y / world.cellSize) * world.cols + Math.floor(x / world.cellSize)] : null;
const mmBiomes = Object.freeze({
  plain: 1, wasteland: 1, city: 1.05, desert: .94, grassland: .94, park: .94, recreation: .94,
  garden: .9, farmland: .84, orchard: .82, vineyard: .82, cemetery: .88,
  sand: .67, beach: .67, scrub: .75, forest: .65, rock: .58, hill: .72, quarry: .58,
  wetland: .44, swamp: .44, glacier: .5, landfill: .65, construction: .72, brownfield: .82,
  seasonal_river: 1, dry_riverbed: 1, gully: .7, valley: 1, water: 0,
});
const mmRoads = Object.freeze({ highway: 1.5, road: 1.35, street: 1.25, track: 1.16, trail: 1.12, railway: 1.08 });
const mmSurfaces = Object.freeze({
  asphalt: 1, concrete: 1, 'concrete:plates': .97, 'concrete:lanes': .97, paved: 1,
  paving_stones: .94, sett: .88, cobblestone: .84, metal: .91, wood: .9,
  compacted: .94, fine_gravel: .9, gravel: .83, pebblestone: .8, unpaved: .79,
  ground: .77, dirt: .77, earth: .77, grass: .74, sand: .58, mud: .44, rock: .62,
});

// Biome and road bonuses are independent. A poor surface reduces the bonus
// supplied by a road; it never turns the road layer itself into a penalty.
// Seasonal rivers are charged once by the exact ribbon factor below.
export const MOVEMENT_FACTORS = Object.freeze({
  baseSpeedKmh: 4, minimumMultiplier: .005, maximumMultiplier: MAX_MOVEMENT_MULTIPLIER,
  biomes: mmBiomes, roads: mmRoads, surfaceQuality: mmSurfaces,
  buildingMultiplier: .08, seasonalRiverMultiplier: .12,
});

export function biomeSpeedMultiplier(biome) { return mmBiomes[biome] ?? 1; }

export function roadSpeedMultiplier(roadClass, surface) {
  if (!roadClass) return 1;
  const base = mmRoads[roadClass] ?? 1.16;
  const material = typeof surface === 'string' ? surface.split(';')[0].trim().toLowerCase() : '';
  const quality = material ? mmClamp(mmSurfaces[material] ?? 1, .05, 1) : 1;
  return 1 + (base - 1) * quality;
}

const mmLandscapeMultiplier = cell => Number.isFinite(cell?.landscapeMultiplier) && cell.landscapeMultiplier > 0 ? cell.landscapeMultiplier : 1;
const mmDryBiome = biome => biome === 'seasonal_river' || biome === 'dry_riverbed';
const mmCellRoadMultiplier = cell => roadSpeedMultiplier(cell?.roadClass || (cell?.type === 'bridge' && cell.biome !== undefined ? 'road' : null), cell?.surface);

function mmBiomeMultiplier(cell, bridge = false) {
  if (!cell?.walkable) return 0;
  // A mapped bridge has a dry deck. Its underlying water biome cannot veto it;
  // exact bridge geometry limits this exception to the real bridge corridor.
  if (bridge && cell.biome === 'water') return 1;
  if (cell.biome !== undefined) return Math.max(0, biomeSpeedMultiplier(cell.biome));
  // Historic fixtures/imports can supply a weighted grid without explicit
  // biomes/roads. Their original cost stays a neutral-road ground coefficient.
  if (Number.isFinite(cell.cost) && cell.cost > 0) return mmClamp(1 / cell.cost, .01, MAX_MOVEMENT_MULTIPLIER);
  return Math.max(0, biomeSpeedMultiplier(cell.type));
}

export function cellMovementMultiplier(cell) {
  if (!cell?.walkable) return 0;
  const bridge = cell.type === 'bridge';
  const biomeMultiplier = mmBiomeMultiplier(cell, bridge);
  if (!(biomeMultiplier > 0)) return 0;
  const seasonalMultiplier = mmDryBiome(cell.biome) && !bridge ? MOVEMENT_FACTORS.seasonalRiverMultiplier : 1;
  return mmClamp(biomeMultiplier * mmCellRoadMultiplier(cell) * mmLandscapeMultiplier(cell) * seasonalMultiplier, MOVEMENT_FACTORS.minimumMultiplier, MAX_MOVEMENT_MULTIPLIER);
}

function mmSlopeMultiplier(grade) {
  if (!Number.isFinite(grade)) return 1;
  if (grade >= 0) return Math.exp(-7.5 * Math.min(grade, 2));
  const descent = Math.min(-grade, 2);
  // Even modest uphill grades now matter; steep descents also require care.
  return Math.exp(.8 * descent - 10 * descent * descent);
}

function mmElevation(world, x, y) {
  const source = world.movementElevationAt || world.elevationAt;
  if (typeof source === 'function') {
    const value = source(x, y);
    return Number.isFinite(value) ? value : null;
  }
  // Bilinear interpolation of genuine elevation samples stored at cell centres.
  // Legacy cell.height may be synthetic/normalised, so it is never treated as m.
  const gx = mmClamp(x / world.cellSize - .5, 0, world.cols - 1), gy = mmClamp(y / world.cellSize - .5, 0, world.rows - 1);
  const ix = Math.floor(gx), iy = Math.floor(gy), rx = gx - ix, ry = gy - iy;
  const x2 = Math.min(ix + 1, world.cols - 1), y2 = Math.min(iy + 1, world.rows - 1);
  const corners = [[ix, iy, (1 - rx) * (1 - ry)], [x2, iy, rx * (1 - ry)], [ix, y2, (1 - rx) * ry], [x2, y2, rx * ry]];
  let height = 0, weight = 0;
  for (const [cx, cy, part] of corners) {
    if (part <= 1e-12) continue;
    const value = world.cells[cy * world.cols + cx]?.elevationMeters;
    if (!Number.isFinite(value)) return null;
    height += value * part; weight += part;
  }
  return weight > 0 ? height / weight : null;
}

function mmFactors(cell, grade = 0, geometry = null, exactSeasonal = false) {
  const building = Boolean(geometry?.building);
  const bridge = geometry ? Boolean(geometry.bridge) : cell?.type === 'bridge';
  const biomeMultiplier = mmBiomeMultiplier(cell, bridge);
  const roadMultiplier = mmCellRoadMultiplier(cell);
  const landscapeMultiplier = mmLandscapeMultiplier(cell);
  const slopeMultiplier = mmSlopeMultiplier(grade);
  // Exact ribbons take precedence over centre-cell approximations: a narrow
  // wash cannot vanish between grid samples or be bypassed by road paint.
  const seasonal = exactSeasonal ? Boolean(geometry?.seasonal) : mmDryBiome(cell?.biome);
  const buildingMultiplier = building ? MOVEMENT_FACTORS.buildingMultiplier : 1;
  const seasonalMultiplier = seasonal && !bridge ? MOVEMENT_FACTORS.seasonalRiverMultiplier : 1;
  // terrainMultiplier remains an alias for existing diagnostics. The road
  // multiplier is always separate and never replaces the underlying biome.
  const terrainMultiplier = biomeMultiplier;
  const factors = { biomeMultiplier, terrainMultiplier, roadMultiplier, landscapeMultiplier, buildingMultiplier, seasonalMultiplier, slopeMultiplier, grade, building, seasonal, bridge };
  if (!(biomeMultiplier > 0)) return { multiplier: 0, ...factors, walkable: false };
  const multiplier = mmClamp(biomeMultiplier * roadMultiplier * landscapeMultiplier * slopeMultiplier * buildingMultiplier * seasonalMultiplier, MOVEMENT_FACTORS.minimumMultiplier, MAX_MOVEMENT_MULTIPLIER);
  return { multiplier, ...factors, walkable: true };
}

export function movementAt(world, x, y, toward = null) {
  const cell = mmCell(world, x, y);
  let grade = 0;
  if (cell?.walkable && toward && Number.isFinite(toward.x) && Number.isFinite(toward.y)) {
    const dx = toward.x - x, dy = toward.y - y, distance = Math.hypot(dx, dy);
    if (distance > 1e-8) {
      const probe = Math.min(world.cellSize * .5, 12 / mmScale(world));
      const ax = mmClamp(x - dx / distance * probe, 0, world.width - 1e-8), ay = mmClamp(y - dy / distance * probe, 0, world.height - 1e-8);
      const bx = mmClamp(x + dx / distance * probe, 0, world.width - 1e-8), by = mmClamp(y + dy / distance * probe, 0, world.height - 1e-8);
      const a = mmElevation(world, ax, ay), b = mmElevation(world, bx, by), meters = Math.hypot(bx - ax, by - ay) * mmScale(world);
      if (a !== null && b !== null && meters > 1e-6) grade = (b - a) / meters;
    }
  }
  const geometry = world.movementGeometry?.queryPoint(x, y) || null;
  const factors = mmFactors(cell, grade, geometry, Boolean(world.movementGeometry?.hasSeasonalGeometry));
  return { ...factors, landscape: cell?.landscape || null, speedKmh: factors.multiplier * 4,
    biome: cell?.biome || cell?.type || null, roadClass: cell?.roadClass || null, surface: cell?.surface || null,
    elevationMeters: mmElevation(world, x, y), slopePercent: grade * 100,
  };
}

/** Integrate a line through exact grid-boundary intervals, never skipping a cell. */
export function segmentTravel(world, from, to, options = {}) {
  const distance = from && to ? mmDistance(from, to) : Infinity, meters = distance * mmScale(world);
  const invalid = () => ({ walkable: false, distance, meters, durationMinutes: Infinity, cost: Infinity, pieces: [] });
  if (!from || !to || !mmCell(world, from.x, from.y)?.walkable || !mmCell(world, to.x, to.y)?.walkable || !Number.isFinite(distance)) return invalid();
  if (distance <= 1e-10) return { walkable: true, distance: 0, meters: 0, durationMinutes: 0, cost: 0, pieces: [] };
  const detailed = options.detailed !== false, size = world.cellSize, dx = to.x - from.x, dy = to.y - from.y;
  const regions = world.movementGeometry?.segmentRegions(from, to) || null;
  const cuts = regions ? [...regions.cuts] : [0, 1];
  if (Math.abs(dx) > 1e-12) for (let edge = (Math.floor(Math.min(from.x, to.x) / size) + 1) * size; edge < Math.max(from.x, to.x) - 1e-9; edge += size) cuts.push((edge - from.x) / dx);
  if (Math.abs(dy) > 1e-12) for (let edge = (Math.floor(Math.min(from.y, to.y) / size) + 1) * size; edge < Math.max(from.y, to.y) - 1e-9; edge += size) cuts.push((edge - from.y) / dy);
  cuts.sort((a, b) => a - b);
  const unique = cuts.filter((cut, index) => !index || cut - cuts[index - 1] > 1e-10);
  // At simultaneous x/y crossings, both orthogonal cells must be walkable.
  if (Math.abs(dx) > 1e-12 && Math.abs(dy) > 1e-12) for (let i = 1; i < unique.length - 1; i++) {
    const t = unique[i], x = from.x + dx * t, y = from.y + dy * t;
    if (Math.abs(x / size - Math.round(x / size)) > 1e-8 || Math.abs(y / size - Math.round(y / size)) > 1e-8) continue;
    const beforeX = Math.floor((x - Math.sign(dx) * size * 1e-8) / size), beforeY = Math.floor((y - Math.sign(dy) * size * 1e-8) / size);
    const afterX = beforeX + Math.sign(dx), afterY = beforeY + Math.sign(dy);
    if (!world.cells[beforeY * world.cols + afterX]?.walkable || !world.cells[afterY * world.cols + beforeX]?.walkable) return invalid();
  }
  const pieces = [], scale = mmScale(world);
  let durationMinutes = 0;
  for (let index = 1; index < unique.length; index++) {
    const start = unique[index - 1], end = unique[index];
    const count = Math.max(1, Math.ceil(distance * (end - start) / (size * .5)));
    for (let part = 0; part < count; part++) {
      const a = start + (end - start) * part / count, b = start + (end - start) * (part + 1) / count, middle = (a + b) / 2;
      const cell = mmCell(world, from.x + dx * middle, from.y + dy * middle);
      if (!cell?.walkable) return invalid();
      const ax = from.x + dx * a, ay = from.y + dy * a, bx = from.x + dx * b, by = from.y + dy * b;
      const length = distance * (b - a), physical = length * scale;
      const ha = mmElevation(world, ax, ay), hb = mmElevation(world, bx, by);
      const grade = ha !== null && hb !== null && physical > 1e-8 ? (hb - ha) / physical : 0;
      const factors = mmFactors(cell, grade, regions ? regions.at(middle) : null, Boolean(world.movementGeometry?.hasSeasonalGeometry));
      if (!factors.walkable) return invalid();
      const duration = physical / (BASE_WALK_METERS_PER_MINUTE * factors.multiplier);
      durationMinutes += duration;
      if (detailed) pieces.push({ from: { x: ax, y: ay }, to: { x: bx, y: by }, distance: length, meters: physical, durationMinutes: duration, ...factors,
        biome: cell.biome || cell.type, landscape: cell.landscape || null, roadClass: cell.roadClass || null, surface: cell.surface || null });
    }
  }
  return { walkable: true, distance, meters, durationMinutes, cost: durationMinutes, pieces };
}

const mmRouteCaches = new WeakMap();
function mmRouteCache(world, route, player) {
  let cache = mmRouteCaches.get(route);
  if (cache && cache.world === world && cache.points === route.points && mmDistance(cache.position, player) < 1e-6) return cache;
  const pieces = [], firstIndex = Math.max(0, Number(route.index) || 0);
  let from = { x: player.x, y: player.y }, remainingDistance = 0, remainingDurationMinutes = 0;
  for (let index = firstIndex; index < route.points.length; index++) {
    const to = route.points[index], segment = segmentTravel(world, from, to);
    if (!segment.walkable) return null;
    for (const piece of segment.pieces) pieces.push({ ...piece, pointIndex: index });
    remainingDistance += segment.distance; remainingDurationMinutes += segment.durationMinutes;
    from = to;
  }
  cache = { world, points: route.points, pieces, pieceIndex: 0, fraction: 0, remainingDistance, remainingDurationMinutes, position: { x: player.x, y: player.y } };
  mmRouteCaches.set(route, cache);
  return cache;
}

/** Spend game minutes, mutating actor/route once with the same costs used by A*. */
export function advanceAlongRoute(world, route, player, gameMinutes) {
  const cache = route && player && Array.isArray(route.points) ? mmRouteCache(world, route, player) : null;
  if (!cache) return { walkedDistance: 0, walkedMeters: 0, elapsedMinutes: 0, remainingDurationMinutes: Infinity, remainingDistance: Infinity, currentMultiplier: 0, arrived: false, blocked: true };
  let budget = Number.isFinite(gameMinutes) ? Math.max(0, gameMinutes) : 0, walkedDistance = 0, elapsedMinutes = 0, currentMultiplier = 1;
  while (cache.pieceIndex < cache.pieces.length && budget > 1e-12) {
    const piece = cache.pieces[cache.pieceIndex], remainingFraction = 1 - cache.fraction;
    const remainingTime = piece.durationMinutes * remainingFraction, spent = Math.min(budget, remainingTime);
    const fraction = remainingTime > 1e-12 ? spent / piece.durationMinutes : remainingFraction;
    cache.fraction = Math.min(1, cache.fraction + fraction);
    const walked = piece.distance * fraction;
    walkedDistance += walked; elapsedMinutes += spent; budget -= spent;
    cache.remainingDistance = Math.max(0, cache.remainingDistance - walked);
    cache.remainingDurationMinutes = Math.max(0, cache.remainingDurationMinutes - spent);
    player.x = piece.from.x + (piece.to.x - piece.from.x) * cache.fraction;
    player.y = piece.from.y + (piece.to.y - piece.from.y) * cache.fraction;
    currentMultiplier = piece.multiplier; route.index = piece.pointIndex;
    if (cache.fraction >= 1 - 1e-10) {
      cache.pieceIndex++; cache.fraction = 0;
      const next = cache.pieces[cache.pieceIndex];
      if (!next || next.pointIndex !== piece.pointIndex) route.index = piece.pointIndex + 1;
    }
  }
  const arrived = cache.pieceIndex >= cache.pieces.length;
  if (arrived) {
    const destination = route.points.at(-1);
    if (destination) { player.x = destination.x; player.y = destination.y; }
    route.index = route.points.length; cache.remainingDistance = cache.remainingDurationMinutes = 0;
  } else if (cache.pieces[cache.pieceIndex]) currentMultiplier = cache.pieces[cache.pieceIndex].multiplier;
  cache.position = { x: player.x, y: player.y };
  route.remaining = route.remainingDistance = cache.remainingDistance;
  route.remainingDurationMinutes = cache.remainingDurationMinutes;
  return { walkedDistance, walkedMeters: walkedDistance * mmScale(world), elapsedMinutes, remainingDurationMinutes: cache.remainingDurationMinutes,
    remainingDistance: cache.remainingDistance, currentMultiplier, arrived, blocked: false };
}
