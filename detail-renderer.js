import { mapFeatureLayer, mapBiome, mapZoneBiome, shouldRenderFeature } from './map-layers.js';
import { classifyBuilding, classifyBiome } from './gameplay-types.js';
import { ROAD_CLASSES, roadClass, mergeConnectedNetworks } from './map-presentation.js';
import { buildGameplayBiomes, groupNearbyZones } from './biome-zones.js';
import { polygonDifference } from './polygon-geometry.js';

/** Sharp, scale-aware cartography over the original mapped footprints and paths. */
const drClamp = (n, min, max) => Math.max(min, Math.min(max, n));
const drFlag = value => value !== undefined && value !== null && !['', 'no', 'false', '0'].includes(String(value));
const drDry = feature => drFlag(feature.intermittent) || drFlag(feature.seasonal) || drFlag(feature.tags?.intermittent) || drFlag(feature.tags?.seasonal);

function drHash(value) {
  let n = 2166136261;
  for (const character of String(value)) n = Math.imul(n ^ character.charCodeAt(0), 16777619) >>> 0;
  return n;
}

function drBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY };
}

// Geometry remains exact; these buckets only narrow the candidates inspected by
// the renderer and hit tests. Very broad features stay in a separate small list.
function drSpatialIndex(records, cellSize = 128) {
  const buckets = new Map(), broad = [];
  for (const record of records) {
    const b = record.bounds;
    const padding = record.geometry === 'line' ? Math.max(0, record.width) / 2 + 1 : record.geometry === 'point' ? 5 : 1;
    const minX = Math.floor((b.minX - padding) / cellSize), maxX = Math.floor((b.maxX + padding) / cellSize);
    const minY = Math.floor((b.minY - padding) / cellSize), maxY = Math.floor((b.maxY + padding) / cellSize);
    if ((maxX - minX + 1) * (maxY - minY + 1) > 64) { broad.push(record); continue; }
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const key = `${x},${y}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(record);
    }
  }
  return bounds => {
    if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) return records;
    const minX = Math.floor(bounds.minX / cellSize), maxX = Math.floor(bounds.maxX / cellSize);
    const minY = Math.floor(bounds.minY / cellSize), maxY = Math.floor(bounds.maxY / cellSize);
    // At overview scale most of the map is visible. A straight ordered scan is
    // cheaper than collecting and sorting the same records from many buckets.
    if ((maxX - minX + 1) * (maxY - minY + 1) > 32) return records;
    const result = new Set(broad);
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      for (const record of buckets.get(`${x},${y}`) || []) result.add(record);
    }
    return [...result].sort((a, b) => a.order - b.order);
  };
}

function drInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function drInPolygon(x, y, rings) {
  let inside = false;
  for (const ring of rings) if (drInRing(x, y, ring)) inside = !inside;
  return inside;
}

function drNearestOnLine(x, y, points) {
  let result = { distance: Infinity, x, y };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], dx = b.x - a.x, dy = b.y - a.y;
    const t = drClamp(((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    const px = a.x + dx * t, py = a.y + dy * t, distance = Math.hypot(x - px, y - py);
    if (distance < result.distance) result = { distance, x: px, y: py };
  }
  return result;
}

function drNearestOnRings(x, y, rings, closed = false) {
  let nearest = { distance: Infinity, x, y };
  for (const ring of rings) {
    const points = closed && ring.length > 1 && (ring[0].x !== ring.at(-1).x || ring[0].y !== ring.at(-1).y) ? [...ring, ring[0]] : ring;
    const point = drNearestOnLine(x, y, points);
    if (point.distance < nearest.distance) nearest = point;
  }
  return nearest;
}

const drNames = {
  building: 'Здание', house: 'Жилой дом', residential: 'Жилой дом', detached: 'Отдельный дом', apartments: 'Жилой корпус',
  commercial: 'Торговое здание', retail: 'Магазин', industrial: 'Промышленное здание', warehouse: 'Склад', garage: 'Гараж', garages: 'Гаражи',
  school: 'Школа', church: 'Церковь', civic: 'Общественное здание', roof: 'Навес', shed: 'Сарай', ruins: 'Руины',
  footway: 'Пешеходная дорожка', path: 'Тропа', track: 'Грунтовая дорога', service: 'Проезд', residential_road: 'Улица', cycleway: 'Велодорожка', steps: 'Ступени', pedestrian: 'Пешеходная улица',
  fence: 'Ограда', wall: 'Стена', gate: 'Ворота', cattle_grid: 'Скотопрогонная решётка', railway: 'Железная дорога', parking: 'Стоянка',
  pitch: 'Спортплощадка', playground: 'Детская площадка', park: 'Парк', garden: 'Сад', grass: 'Газон', pool: 'Бассейн',
  tree: 'Дерево', bench: 'Скамейка', picnic_table: 'Стол для привала', picnic_site: 'Место для привала', fountain: 'Фонтан', spring: 'Источник',
  well: 'Колодец', drinking_water: 'Питьевая вода', cemetery: 'Кладбище', quarry: 'Карьер', information: 'Информационный знак',
  river: 'Водоток', lake: 'Озеро', water: 'Водоём', forest: 'Лес', swamp: 'Заболоченный участок', plain: 'Участок местности',
  runway: 'Взлётная полоса', taxiway: 'Рулёжная дорожка', apron: 'Перрон аэродрома', aerodrome: 'Аэродром',
  boundary: 'Граница', administrative: 'Административная граница', residential_area: 'Жилая территория', industrial_area: 'Промышленная территория',
  retail_area: 'Торговая территория', farmland: 'Сельскохозяйственный участок', peak: 'Вершина', cliff: 'Обрыв',
  commercial_area: 'Коммерческая зона', grassland: 'Луг', scrub: 'Кустарник', sand: 'Пески', rock: 'Скальная местность',
  wetland: 'Заболоченная местность', orchard: 'Садовые угодья', vineyard: 'Виноградник', recreation: 'Зона отдыха',
  construction: 'Стройплощадка', brownfield: 'Заброшенная территория', landfill: 'Полигон отходов', transport: 'Транспортная зона', glacier: 'Ледник',
  administrative_area: 'Административная территория', utility_pole: 'Коммунальный столб', transformer: 'Трансформатор', substation: 'Электроподстанция',
};

const drBiomeNames = {
  ...drNames, residential: 'Жилая зона', industrial: 'Промышленная зона', commercial: 'Коммерческая зона', retail: 'Торговая зона',
  parking: 'Парковочная зона', religious: 'Религиозная зона', healthcare: 'Медицинская зона', education: 'Образовательная зона',
  civic: 'Общественная зона', emergency: 'Зона экстренных служб', transport: 'Транспортная зона', accommodation: 'Гостиничная зона',
  camping: 'Кемпинг', food_service: 'Зона питания', service: 'Зона обслуживания', utilities: 'Коммунальная зона', heritage: 'Историческая зона',
  forest: 'Лес', garden: 'Сад', landscape: 'Ландшафт', plain: 'Открытая местность',
  administrative: 'Административная территория', wasteland: 'Пустошь', suburb: 'Пригород', urban: 'Городская застройка', dense: 'Плотная застройка', aircraft_parking: 'Стоянка самолётов',
};
const drSourceId = feature => feature.sourceId || String(feature.id || '').match(/^(?:node|way|relation)-\d+/)?.[0] || feature.id;
const drSameFootprint = (a, b) => a.rings.length === b.rings.length && a.rings.every(ring => b.rings.some(other => ring.length === other.length
  && ring.every(point => other.some(candidate => candidate.x === point.x && candidate.y === point.y))));
const drTypeMetadata = record => {
  const type = record.gameplayType;
  if (!type) return { typeId: null, typeName: null, resourceProfileIds: [], gameplayType: null };
  return { typeId: type.typeId, typeName: type.typeName, resourceProfileIds: [...type.resourceProfileIds], gameplayType: { ...type, resourceProfileIds: [...type.resourceProfileIds] } };
};

function drFeatureLabel(feature, group) {
  if (feature.name) return feature.name;
  if (['census', 'administrative'].includes(feature.tags?.boundary)) return 'Граница поселения';
  if (mapFeatureLayer(feature, group) === 'power') {
    const names = { pole: 'Столб электросети', tower: 'Опора ЛЭП', line: 'Линия электропередачи', minor_line: 'Линия местной электросети', cable: 'Электрический кабель', transformer: 'Трансформатор', substation: 'Подстанция', plant: 'Электростанция', switch: 'Выключатель электросети' };
    return feature.tags?.man_made === 'utility_pole' ? 'Коммунальный столб' : names[feature.tags?.power] || 'Объект электросети';
  }
  if (group === 'building') return drNames[feature.ruins ? 'ruins' : feature.type] || drNames.building;
  if (group === 'road' && feature.names?.length > 4) return `${ROAD_CLASSES[roadClass(feature)]?.pluralName || 'Дороги'} · сеть`;
  if (group === 'road') return feature.roadClassName || ROAD_CLASSES[roadClass(feature)]?.name || 'Дорога';
  if (group === 'river') return drDry(feature) ? 'Сезонное русло' : drNames.river;
  if (group === 'lake') return drNames.lake;
  const tags = feature.tags || {};
  if (group === 'zone' || mapFeatureLayer(feature, group) === 'landscape' && (group === 'area' || feature.geometry === 'polygon' || tags.landuse || mapZoneBiome(feature))) {
    const biome = mapBiome(feature);
    return drBiomeNames[biome] || `Зона: ${String(tags.landuse || tags.natural || biome).replaceAll('_', ' ')}`;
  }
  if (group === 'area') return drNames[feature.type] || drNames.plain;
  const value = tags.aeroway || tags.amenity || tags.shop || tags.man_made || tags.natural || tags.landuse || tags.leisure || tags.historic || tags.tourism || tags.boundary;
  if (tags.landuse && ['residential', 'industrial', 'retail'].includes(tags.landuse)) return drNames[`${tags.landuse}_area`];
  return drNames[feature.kind] || drNames[value] || String(value || feature.kind || 'Объект на карте').replaceAll('_', ' ');
}

function drPartContains(record, x, y) {
  return record.parts.some(rings => drInPolygon(x, y, rings));
}

function drSignedArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
  return area / 2;
}

function drCache(original, group, layer, metersPerUnit, index) {
  const feature = original.id ? original : { ...original, id: `${group}-${index}` };
  const outlineOnly = layer === 'landscape' && mapBiome(feature) === 'administrative';
  const boundaryPaths = outlineOnly && Array.isArray(feature.boundaryPaths) ? feature.boundaryPaths.filter(path => path.length > 1) : null;
  const geometry = boundaryPaths ? 'line' : group === 'building' || group === 'area' || group === 'lake' || group === 'zone' ? 'polygon' : feature.geometry || 'line';
  const ellipse = group === 'lake' && [feature.x, feature.y, feature.rx, feature.ry].every(Number.isFinite);
  const ellipseRing = ellipse ? Array.from({ length: 65 }, (_, i) => ({ x: feature.x + Math.cos(i / 64 * Math.PI * 2) * feature.rx, y: feature.y + Math.sin(i / 64 * Math.PI * 2) * feature.ry })) : null;
  const baseRings = ellipseRing ? [ellipseRing] : feature.rings?.length ? feature.rings : feature.points?.length ? [feature.points] : [];
  const parts = geometry === 'polygon' ? (feature.parts?.length ? feature.parts : baseRings.length ? [baseRings] : []) : [];
  const rings = geometry === 'polygon' ? parts.flat() : boundaryPaths || (feature.paths?.length ? feature.paths : baseRings);
  const points = rings.flat();
  if (!points.length) return null;
  const path = new Path2D();
  if (geometry === 'polygon') {
    // All outer rings have one winding and all holes the opposite winding.
    // Nonzero filling therefore unions overlapping parts without XOR cut-outs.
    for (const part of parts) part.forEach((ring, index) => {
      const ordered = (drSignedArea(ring) >= 0) === (index === 0) ? ring : [...ring].reverse();
      ordered.forEach((point, i) => i ? path.lineTo(point.x, point.y) : path.moveTo(point.x, point.y));
      path.closePath();
    });
  } else for (const ring of rings) ring.forEach((point, i) => i ? path.lineTo(point.x, point.y) : path.moveTo(point.x, point.y));
  const bounds = drBounds(points);
  const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
  let longest = null;
  for (const ring of rings) for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i], length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!longest || length > longest.length) longest = { a, b, length, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }
  const actualWidth = Number(feature.widthMeters ?? feature.tags?.width) / metersPerUnit;
  const biome = layer === 'landscape' && !outlineOnly ? feature.biome || mapBiome(feature) : null;
  const gameplayType = group === 'building' ? classifyBuilding(feature) : layer === 'landscape' && !outlineOnly ? classifyBiome(biome) : layer === 'water' ? classifyBiome(drDry(feature) ? 'dry_riverbed' : 'water') : null;
  return { feature, group, layer, sourceOrder: index, biome, gameplayType, outlineOnly, fallback: feature.fallback === true, footprintOnly: feature.footprintOnly === true && feature.zoneFusion !== true, roadClass: layer === 'roads' ? roadClass(feature) : null, geometry, ellipse, key: `${layer}:${group}:${feature.id}`, parts, rings, points, path, fillRule: 'nonzero', bounds, center, longest, hash: drHash(feature.id), width: Number.isFinite(actualWidth) && actualWidth > 0 ? actualWidth : Number(feature.width) || 1 };
}

function drWaterKey(record) {
  const feature = record.feature, tags = feature.tags || {};
  return JSON.stringify([tags.water || tags.waterway || tags.leisure || feature.kind || feature.type || (record.group === 'lake' ? 'lake' : 'water'), drDry(feature), tags.layer || 0, drFlag(feature.bridge ?? tags.bridge), drFlag(feature.tunnel ?? tags.tunnel)]);
}

function drSegmentsTouch(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const on = (p, q, r) => Math.abs(cross(p, q, r)) <= 1e-7 && r.x >= Math.min(p.x, q.x) - 1e-7 && r.x <= Math.max(p.x, q.x) + 1e-7 && r.y >= Math.min(p.y, q.y) - 1e-7 && r.y <= Math.max(p.y, q.y) + 1e-7;
  const ac = cross(a, b, c), ad = cross(a, b, d), ca = cross(c, d, a), cb = cross(c, d, b);
  return ac * ad < 0 && ca * cb < 0 || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}

function drPolygonsTouch(a, b) {
  if (a.bounds.maxX < b.bounds.minX || b.bounds.maxX < a.bounds.minX || a.bounds.maxY < b.bounds.minY || b.bounds.maxY < a.bounds.minY) return false;
  for (const part of a.parts) if (part[0].some(point => drPartContains(b, point.x, point.y))) return true;
  for (const part of b.parts) if (part[0].some(point => drPartContains(a, point.x, point.y))) return true;
  for (const pa of a.parts) for (const pb of b.parts) for (const ra of pa) for (const rb of pb) {
    for (let i = 1; i < ra.length; i++) for (let j = 1; j < rb.length; j++) if (drSegmentsTouch(ra[i - 1], ra[i], rb[j - 1], rb[j])) return true;
  }
  return false;
}

function drMergeWaterPolygons(records) {
  const parents = records.map((_, index) => index), find = index => parents[index] === index ? index : (parents[index] = find(parents[index]));
  for (let i = 0; i < records.length; i++) for (let j = i + 1; j < records.length; j++) if (drWaterKey(records[i]) === drWaterKey(records[j]) && drPolygonsTouch(records[i], records[j])) parents[find(j)] = find(i);
  const groups = new Map();
  records.forEach((record, index) => { const key = find(index); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(record); });
  return [...groups.values()].map(group => {
    if (group.length === 1) { const record = group[0]; return { ...record.feature, geometry: 'polygon', kind: record.feature.kind || record.feature.type || 'lake', parts: record.parts, rings: record.parts[0], points: record.parts[0][0] }; }
    const members = group.map(record => structuredClone(record.feature)), memberIds = members.map(feature => feature.id).sort();
    return { ...members[0], id: `water-area-${drHash(memberIds.join('|'))}`, geometry: 'polygon', kind: members[0].kind || members[0].type || 'water',
      parts: group.flatMap(record => record.parts), points: group[0].parts[0][0], rings: group[0].parts[0], members, memberIds,
      sourceIds: [...new Set(members.flatMap(feature => feature.sourceIds || [drSourceId(feature)]))].sort(), merged: true };
  });
}

const drUrbanBiomes = new Set(['suburb', 'urban', 'dense']);
const drUrbanFiller = record => record.feature.urbanFiller === true || record.feature.derived === true && drUrbanBiomes.has(record.biome);
const drBoundsOverlap = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
const drPartsArea = parts => parts.reduce((total, rings) => total + Math.abs(drSignedArea(rings[0])) - rings.slice(1).reduce((sum, ring) => sum + Math.abs(drSignedArea(ring)), 0), 0);
const drMaskSourceIds = record => record.feature.sourceIds || [drSourceId(record.feature)];

function drWaterLineMask(record) {
  const radius = Math.max(.1, record.width) / 2, parts = [];
  // These masks use physical source width. Their construction happens once per
  // map, and does not change with zoom, visible layers or the selection halo.
  for (const path of record.rings) {
    for (let index = 1; index < path.length; index++) {
      const a = path[index - 1], b = path[index], length = Math.hypot(b.x - a.x, b.y - a.y);
      if (!length) continue;
      const nx = -(b.y - a.y) / length * radius, ny = (b.x - a.x) / length * radius;
      const ring = [{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }];
      ring.push({ ...ring[0] }); parts.push([ring]);
    }
    for (const point of path) {
      const ring = Array.from({ length: 16 }, (_, index) => ({ x: point.x + Math.cos(index / 16 * Math.PI * 2) * radius, y: point.y + Math.sin(index / 16 * Math.PI * 2) * radius }));
      ring.push({ ...ring[0] }); parts.push([ring]);
    }
  }
  return parts.length ? { feature: record.feature, parts, bounds: drBounds(parts.flat(2)) } : null;
}

function drCutUrbanFillers(records, masks, metersPerUnit) {
  const priority = { dense: 0, urban: 1, suburb: 2 };
  const ordered = [...records].sort((a, b) => priority[a.biome] - priority[b.biome] || String(a.feature.id).localeCompare(String(b.feature.id)));
  const clipped = [], previous = [];
  const report = { inputFeatures: records.length, outputFeatures: 0, removedFeatures: 0, sourceMaskCount: masks.length, beforeArea: records.reduce((sum, record) => sum + drPartsArea(record.parts), 0), afterArea: 0 };
  for (const record of ordered) {
    const relevant = masks.filter(mask => drBoundsOverlap(record.bounds, mask.bounds));
    const occupied = previous.filter(mask => drBoundsOverlap(record.bounds, mask.bounds));
    const parts = polygonDifference(record.parts, [...relevant, ...occupied].flatMap(mask => mask.parts));
    if (!parts.length) continue;
    const feature = { ...record.feature, geometry: 'polygon', urbanFiller: true, parts, rings: parts[0], points: parts[0][0],
      provenance: { ...record.feature.provenance, sourceZoneExclusion: true, fillOnlyUnzoned: true, exclusionStage: 'after-zone-fusion',
        maskSourceIds: [...new Set(relevant.flatMap(drMaskSourceIds).filter(Boolean))].sort() } };
    const cached = drCache(feature, record.group, 'landscape', metersPerUnit, clipped.length);
    if (!cached) continue;
    clipped.push(cached); previous.push(cached); report.afterArea += drPartsArea(parts);
  }
  report.outputFeatures = clipped.length; report.removedFeatures = records.length - clipped.length;
  return { records: clipped, report };
}

/** Call draw inside a world transform; view dimensions are CSS screen pixels. */
export function createDetailRenderer(world) {
  const metersPerUnit = world.metersPerUnit || 5;
  const groups = [['roads', 'road'], ['buildings', 'building'], ['areas', 'area'], ['rivers', 'river'], ['lakes', 'lake'], ['details', 'detail']];
  const inputFeatures = groups.reduce((sum, [key]) => sum + (world[key]?.length || 0), 0);
  const filteredFeatures = groups.reduce((sum, [key, group]) => sum + (world[key] || []).filter(feature => !shouldRenderFeature(feature, group)).length, 0);
  const cache = (features, group) => (features || []).filter(feature => shouldRenderFeature(feature, group)).map((feature, index) => drCache(feature, group, mapFeatureLayer(feature, group), metersPerUnit, index)).filter(Boolean);
  const nativeRoads = new Map((world.roads || []).filter(feature => shouldRenderFeature(feature, 'road')).map((feature, index) => {
    const road = feature.id ? feature : { ...feature, id: `road-${index}` };
    return [road.id, road];
  }));
  const buildings = cache(world.buildings, 'building');
  const detailSources = cache(world.details, 'detail');
  const coalescedDetails = detailSources.filter(record => {
    const road = record.layer === 'roads' && nativeRoads.get(record.feature.id);
    return !(road && record.geometry === 'line' && road.points.length === record.points.length
      && road.points.every((point, index) => point.x === record.points[index].x && point.y === record.points[index].y));
  });
  const roadSources = [...nativeRoads.values(), ...coalescedDetails.filter(record => record.layer === 'roads' && record.geometry === 'line').map(record => record.feature)];
  const roadNetwork = mergeConnectedNetworks(roadSources, { kind: 'road' });
  const roads = cache(roadNetwork.features, 'road');
  const powerSources = coalescedDetails.filter(record => record.layer === 'power' && record.geometry === 'line');
  const powerNetwork = mergeConnectedNetworks(powerSources.map(record => record.feature), { kind: 'power' });
  const sourceAreas = cache(world.areas, 'area'), sourceRivers = cache(world.rivers, 'river'), sourceLakes = cache(world.lakes, 'lake');
  const waterSources = [...sourceAreas, ...sourceRivers, ...sourceLakes, ...coalescedDetails].filter(record => record.layer === 'water');
  const waterLines = waterSources.filter(record => record.geometry === 'line');
  const waterNetwork = mergeConnectedNetworks(waterLines.map(record => record.feature), { kind: 'water' });
  const rivers = cache(waterNetwork.features, 'river');
  const waterPolygons = waterSources.filter(record => record.geometry === 'polygon');
  const waterAreas = drMergeWaterPolygons(waterPolygons).map((feature, index) => drCache({ ...feature, geometry: 'polygon', kind: feature.kind || feature.type || 'water' }, 'detail', 'water', metersPerUnit, index));
  const details = [...coalescedDetails.filter(record => !(record.layer === 'power' && record.geometry === 'line') && !(record.layer === 'roads' && record.geometry === 'line') && !(record.layer === 'water' && record.geometry !== 'point')), ...cache(powerNetwork.features, 'detail')];
  const areas = sourceAreas.filter(record => record.layer !== 'water');
  const mappedZones = [...areas, ...details].filter(record => record.layer === 'landscape' && record.geometry === 'polygon' && !record.outlineOnly);
  const footprintZones = buildings.flatMap((building, index) => {
    const biome = mapZoneBiome(building.feature);
    if (!biome) return [];
    if (mappedZones.some(zone => zone.biome === biome && (drSameFootprint(zone, building)
      || building.parts[0][0].every(point => drPartContains(zone, point.x, point.y))))) return [];
    const record = drCache({ ...building.feature, footprintOnly: true }, 'zone', 'landscape', metersPerUnit, index);
    return [record];
  });
  const generated = world.geographic === true || Array.isArray(world.bbox) ? buildGameplayBiomes(world, { deferOccupiedCuts: true }) : { features: [], report: {} };
  const derivedZones = generated.features.map((feature, index) => drCache(feature, 'zone', 'landscape', metersPerUnit, index)).filter(Boolean);
  const allZones = [...mappedZones, ...footprintZones, ...derivedZones];
  const urbanFillers = allZones.filter(drUrbanFiller);
  // Existing use/site zones keep their overlaps. City-density areas fill only
  // what remains after those actual zones and their gameplay unions are final.
  const groupedZones = groupNearbyZones(allZones.filter(record => !drUrbanFiller(record)).map(record => ({ ...record.feature, biome: record.biome, presentationGroup: record.group, footprintOnly: record.footprintOnly })), {
    metersPerUnit, maxDistanceMeters: 35, blockers: waterSources.filter(record => record.geometry !== 'point' && !drDry(record.feature)).map(record => ({ ...record.feature, geometry: record.geometry, parts: record.parts, width: record.width })),
  });
  const existingZones = groupedZones.features.map((feature, index) => drCache(feature, feature.presentationGroup || 'zone', 'landscape', metersPerUnit, index)).filter(Boolean);
  const physicalSites = [...details, ...sourceAreas].filter(record => record.geometry === 'polygon' && ['power', 'roads'].includes(record.layer));
  const waterLineMasks = waterLines.filter(record => !drDry(record.feature)).map(drWaterLineMask).filter(Boolean);
  const masks = [...existingZones.filter(record => !record.fallback), ...waterPolygons, ...physicalSites, ...waterLineMasks];
  const clippedUrban = drCutUrbanFillers(urbanFillers, masks, metersPerUnit);
  const landscapePolygons = [...existingZones, ...clippedUrban.records];
  const nonZoneAreas = areas.filter(record => record.layer !== 'landscape' || record.geometry !== 'polygon');
  const nonZoneDetails = details.filter(record => record.layer !== 'landscape' || record.geometry !== 'polygon');
  const roadPriority = { trail: 0, track: 1, street: 2, road: 3, highway: 4, railway: 5 };
  const roadTier = record => (Number(record.feature.layer ?? record.feature.tags?.layer) || 0) * 4
    + (drFlag(record.feature.bridge ?? record.feature.tags?.bridge) ? 1 : 0) - (drFlag(record.feature.tunnel ?? record.feature.tags?.tunnel) ? 1 : 0);
  const rank = record => record.fallback ? -1 : record.group === 'building' ? 9
    : record.geometry === 'polygon' ? record.layer === 'landscape' ? 0 : record.layer === 'water' ? 1 : record.layer === 'roads' ? 5 : 2
    : record.geometry === 'point' ? 8 : record.layer === 'water' ? 3 : record.layer === 'landscape' ? 4 : record.group === 'road' ? 6 : 7;
  const surfaceSize = record => (record.bounds.maxX - record.bounds.minX) * (record.bounds.maxY - record.bounds.minY);
  const registry = [...nonZoneAreas, ...rivers, ...waterAreas, ...nonZoneDetails, ...landscapePolygons, ...roads, ...buildings]
    .sort((a, b) => rank(a) - rank(b) || (a.group === 'road' && b.group === 'road' ? roadTier(a) - roadTier(b) || roadPriority[a.roadClass] - roadPriority[b.roadClass]
      : a.geometry === 'polygon' && b.geometry === 'polygon' ? surfaceSize(b) - surfaceSize(a) : 0));
  registry.forEach((record, index) => { record.order = index; });
  const queryRecords = drSpatialIndex(registry);
  const recordsByKey = new Map(registry.map(record => [record.key, record]));
  const recordsById = new Map();
  for (const record of registry) {
    recordsById.set(record.feature.id, record);
    for (const memberId of record.feature.memberIds || []) recordsById.set(memberId, record);
  }
  const zonePolygons = registry.filter(record => record.layer === 'landscape' && record.geometry === 'polygon' && !record.outlineOnly);
  const queryZones = drSpatialIndex(zonePolygons);
  const layers = { landscape: true, water: true, roads: true, power: true, buildings: true, details: true };
  const roadClasses = Object.fromEntries(Object.keys(ROAD_CLASSES).map(key => [key, true]));
  const isEnabled = record => layers[record.layer] && (record.layer !== 'roads' || roadClasses[record.roadClass] !== false);
  const stats = { features: registry.length, inputFeatures, filteredFeatures, coalescedFeatures: detailSources.length - coalescedDetails.length,
    sourceRoads: nativeRoads.size, sourceRailwayLines: roadSources.length - nativeRoads.size, displayRoads: roads.length, sourcePowerLines: powerSources.length, displayPowerLines: powerNetwork.features.length, sourceWaterLines: waterLines.length, displayWaterLines: rivers.length, sourceWaterAreas: waterPolygons.length, displayWaterAreas: waterAreas.length, generatedBiomes: generated.features.length, biomeGeneration: generated.report, zoneMerging: groupedZones.report, urbanFillerClipping: clippedUrban.report,
    drawCount: 0, highlightDrawCount: 0, viewCandidates: 0, pickCandidates: 0, zoneCandidates: 0 };
  for (const layer of Object.keys(layers)) {
    stats[layer] = registry.filter(record => record.layer === layer).length;
    stats['visible' + layer[0].toUpperCase() + layer.slice(1)] = 0;
  }
  const greenAreas = new Set(['park', 'garden', 'grass', 'playground', 'pitch', 'cemetery']);
  let lastZoom = 1, lastHoveredId = null;
  let focusPoint = null;

  function inView(record, view, margin = 12) {
    const halfWidth = view.width / (2 * view.zoom), halfHeight = view.height / (2 * view.zoom), b = record.bounds;
    return b.maxX >= view.cameraX - halfWidth - margin && b.minX <= view.cameraX + halfWidth + margin
      && b.maxY >= view.cameraY - halfHeight - margin && b.minY <= view.cameraY + halfHeight + margin;
  }

  const roadStyles = {
    highway: { edge: '#706e54', core: '#c8bb8e', centre: '#eee0ae' },
    road: { edge: '#77775d', core: '#c5b891', centre: '#e4d7ad' },
    street: { edge: '#82816a', core: '#d2c6a1' },
    track: { edge: '#898064', core: '#b4a582' },
    trail: { edge: '#77775b', core: '#d3c6a0' },
    railway: { edge: '#485647', core: '#a29d7c' },
  };

  function roadWidth(record, zoom) {
    const fine = record.roadClass === 'track' || record.roadClass === 'trail';
    const core = Math.max(record.width, (fine ? .75 : 1.2) / zoom);
    const bridge = drFlag(record.feature.bridge ?? record.feature.tags?.bridge);
    return { core, stroke: core + (fine ? .7 / zoom : Math.max(.25, 1.1 / zoom)) + (bridge && zoom >= 2 ? .25 : 0) };
  }

  function paintRoadBatch(ctx, records, zoom, hoveredId) {
    // Finish every casing before painting any interior in the same level. Shared
    // endpoints and junctions then form a continuous surface without end caps.
    const ordered = records;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
    for (let start = 0; start < ordered.length;) {
      let end = start + 1;
      while (end < ordered.length && roadTier(ordered[end]) === roadTier(ordered[start])) end++;
      for (let i = start; i < end; i++) {
        const record = ordered[i];
        if (record.feature.id !== hoveredId) continue;
        ctx.globalAlpha = 1; ctx.strokeStyle = 'rgba(238,238,169,.65)';
        ctx.lineWidth = roadWidth(record, zoom).stroke + 4 / zoom; ctx.stroke(record.path);
      }
      for (const pass of ['edge', 'core']) for (let i = start; i < end; i++) {
        const record = ordered[i], style = roadStyles[record.roadClass] || roadStyles.road;
        const tunnel = drFlag(record.feature.tunnel ?? record.feature.tags?.tunnel);
        ctx.globalAlpha = tunnel ? .58 : 1;
        ctx.strokeStyle = pass === 'edge' && drFlag(record.feature.bridge ?? record.feature.tags?.bridge) ? '#4b5847' : style[pass];
        ctx.lineWidth = roadWidth(record, zoom)[pass === 'edge' ? 'stroke' : 'core']; ctx.stroke(record.path);
      }
      // Only a highway/road centre marking is dashed; the mapped surface stays solid.
      for (let i = start; i < end; i++) {
        const record = ordered[i], width = roadWidth(record, zoom).core, style = roadStyles[record.roadClass] || roadStyles.road;
        ctx.globalAlpha = drFlag(record.feature.tunnel ?? record.feature.tags?.tunnel) ? .58 : 1;
        if (record.roadClass === 'railway' && zoom >= 1.5) {
          ctx.strokeStyle = '#52634d'; ctx.lineWidth = Math.max(width + .6, 4 / zoom);
          ctx.setLineDash([.35 / zoom, 3.5 / zoom]); ctx.stroke(record.path); ctx.setLineDash([]);
        }
        if (style.centre && zoom >= 4 && width * zoom >= 6) {
          ctx.strokeStyle = style.centre; ctx.lineWidth = .65 / zoom;
          ctx.setLineDash([1.8, 1.7]); ctx.stroke(record.path); ctx.setLineDash([]);
        }
        if (record.feature.id === hoveredId) {
          ctx.globalAlpha = 1; ctx.strokeStyle = '#f2efb5'; ctx.lineWidth = Math.max(1.25 / zoom, width * .28); ctx.stroke(record.path);
        }
      }
      start = end;
    }
    ctx.globalAlpha = 1;
  }

  function powerWidth(record, zoom) {
    return Math.max(.55, 1.8 / zoom);
  }

  function paintPowerBatch(ctx, records, zoom, hoveredId) {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
    for (const record of records) if (record.feature.id === hoveredId) {
      ctx.strokeStyle = 'rgba(238,238,169,.65)'; ctx.lineWidth = powerWidth(record, zoom) + 4 / zoom; ctx.stroke(record.path);
    }
    for (const pass of ['edge', 'core']) for (const record of records) {
      ctx.strokeStyle = pass === 'edge' ? '#566049' : record.feature.id === hoveredId ? '#f2efb5' : '#baa86e';
      ctx.lineWidth = pass === 'edge' ? powerWidth(record, zoom) : Math.max(.22, .85 / zoom); ctx.stroke(record.path);
    }
  }

  function boundaryWidth(zoom) { return 1.2 / zoom; }

  function paintBoundary(ctx, record, zoom, hoveredId) {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = hoveredId === record.feature.id ? '#eff0be' : 'rgba(91,113,78,.78)';
    ctx.lineWidth = boundaryWidth(zoom);
    ctx.setLineDash([10 / zoom, 5 / zoom]); ctx.stroke(record.path); ctx.setLineDash([]);
  }

  function paintBuilding(ctx, record, zoom, hoveredId) {
    const { feature, path, bounds: b, center, longest } = record;
    const high = zoom >= 2.5, hovered = hoveredId === feature.id;
    const ruin = feature.ruins === true || feature.type === 'ruins';
    const colors = ['#a39f7c', '#b4a583', '#8b9675', '#b7b18d', '#9b9b7c'];
    const roof = ruin ? '#9a9476' : colors[record.hash % colors.length];
    if (high) {
      ctx.save(); ctx.translate(.55, .8);
      ctx.fillStyle = 'rgba(39,47,32,.3)'; ctx.fill(path, record.fillRule); ctx.restore();
      const gradient = ctx.createLinearGradient(b.minX, b.minY, b.maxX, b.maxY);
      gradient.addColorStop(0, roof); gradient.addColorStop(.5, roof); gradient.addColorStop(1, '#74785b');
      ctx.fillStyle = gradient;
    } else ctx.fillStyle = '#80876a';
    ctx.fill(path, record.fillRule);
    ctx.strokeStyle = hovered ? '#eff0be' : '#3f503c'; ctx.lineWidth = high ? Math.max(.26, .9 / zoom) : .8 / zoom;
    if (ruin) ctx.setLineDash([.7, .4]);
    ctx.stroke(path); ctx.setLineDash([]);
    if (!high) return;
    ctx.save(); ctx.clip(path, record.fillRule);
    const diagonal = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
    ctx.translate(center.x, center.y); ctx.rotate(longest?.angle || 0);
    if (ruin) {
      ctx.fillStyle = 'rgba(59,64,43,.25)';
      for (let i = 0; i < 8; i++) {
        const x = (((record.hash >>> (i * 3 % 24)) & 15) / 15 - .5) * diagonal;
        const y = (((record.hash >>> (i * 2 % 24)) & 15) / 15 - .5) * diagonal;
        ctx.fillRect(x, y, .5 + (i % 3) * .25, .3 + (i % 2) * .3);
      }
    } else if (feature.roofShape !== 'flat') {
      // Roof shading is an illustration clipped to the source footprint, not new map geometry.
      ctx.fillStyle = 'rgba(235,224,179,.12)'; ctx.fillRect(-diagonal, -diagonal, diagonal * 2, diagonal);
      ctx.strokeStyle = 'rgba(51,65,43,.4)'; ctx.lineWidth = Math.max(.1, .65 / zoom);
      ctx.beginPath(); ctx.moveTo(-diagonal, 0); ctx.lineTo(diagonal, 0); ctx.stroke();
      if (zoom >= 6) {
        ctx.strokeStyle = 'rgba(44,61,40,.14)'; ctx.lineWidth = .45 / zoom;
        const spacing = Math.max(.65, diagonal / 18);
        ctx.beginPath();
        for (let x = -diagonal; x < diagonal; x += spacing) { ctx.moveTo(x, -diagonal); ctx.lineTo(x, diagonal); }
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = 'rgba(236,224,180,.4)'; ctx.lineWidth = .35;
      ctx.strokeRect(-diagonal * .28, -diagonal * .22, diagonal * .56, diagonal * .44);
    }
    ctx.restore();
  }

  function paintDetail(ctx, record, zoom, hoveredId) {
    const { feature, path, center } = record;
    const kind = feature.kind, polygon = record.geometry === 'polygon', point = record.geometry === 'point';
    const highlighted = hoveredId === feature.id;
    const aeroway = feature.tags?.aeroway || (['runway', 'taxiway', 'apron', 'aerodrome'].includes(kind) ? kind : null);
    const boundary = kind === 'boundary' || !!feature.tags?.boundary;
    if (polygon) {
      ctx.fillStyle = record.layer === 'power' ? highlighted ? '#d1c68b' : '#8f9770' : highlighted ? 'rgba(217,223,153,.25)' : boundary ? 'rgba(126,143,111,.025)' : aeroway ? 'rgba(117,122,106,.22)' : kind === 'pool' ? '#738f83' : greenAreas.has(kind) ? 'rgba(116,132,88,.38)' : kind === 'parking' ? 'rgba(140,135,107,.32)' : 'rgba(136,127,96,.15)';
      ctx.fill(path, record.fillRule); ctx.strokeStyle = highlighted ? '#eceabb' : aeroway ? '#626d58' : '#7c8060'; ctx.lineWidth = (highlighted ? 1.5 : .7) / zoom;
      if (boundary) ctx.setLineDash([5 / zoom, 5 / zoom]);
      ctx.stroke(path); ctx.setLineDash([]);
      if (zoom >= 5 && kind === 'parking') {
        ctx.save(); ctx.translate(center.x, center.y); ctx.scale(1 / zoom, 1 / zoom);
        ctx.fillStyle = '#737956'; ctx.font = '600 11px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('P', 0, 4); ctx.restore();
      }
      return;
    }
    if (!point) {
      const rail = kind === 'railway' || !!feature.tags?.railway, fence = ['fence', 'wall', 'retaining_wall', 'hedge'].includes(kind);
      ctx.strokeStyle = highlighted ? '#eceabb' : aeroway ? '#606e5c' : boundary ? '#87916f' : rail ? '#626e55' : kind === 'wall' ? '#667152' : '#7c7b58';
      ctx.lineWidth = detailLineWidth(record, zoom) + (highlighted ? 1.5 / zoom : 0);
      if (fence && kind !== 'wall' || boundary) ctx.setLineDash([Math.max(.5, 1 / zoom), Math.max(.7, 2 / zoom)]);
      ctx.stroke(path); ctx.setLineDash([]);
      if (aeroway && zoom >= 2) {
        ctx.strokeStyle = highlighted ? '#edecba' : '#aeb79a'; ctx.lineWidth = .8 / zoom; ctx.setLineDash([4 / zoom, 5 / zoom]); ctx.stroke(path); ctx.setLineDash([]);
      }
      if (rail && zoom >= 3) {
        ctx.lineWidth = Math.max(1.3, 2 / zoom); ctx.setLineDash([.2, 1.1]); ctx.stroke(path); ctx.setLineDash([]);
        ctx.strokeStyle = '#a4a07e'; ctx.lineWidth = .3; ctx.stroke(path);
      }
      return;
    }
    const p = record.points[0], size = Math.max(1.7, Math.min(4, 8 / zoom));
    ctx.save(); ctx.translate(p.x, p.y); ctx.lineWidth = Math.max(.2, 1 / zoom);
    ctx.strokeStyle = highlighted ? '#f0edbe' : '#4c6348'; ctx.fillStyle = '#81906a';
    if (kind === 'tree') {
      ctx.beginPath(); ctx.arc(.3, .5, size, 0, Math.PI * 2); ctx.fillStyle = 'rgba(40,63,39,.18)'; ctx.fill();
      ctx.beginPath(); ctx.arc(0, 0, size, 0, Math.PI * 2); ctx.fillStyle = '#6c805b'; ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-size * .45, -.2); ctx.lineTo(size * .4, .2); ctx.moveTo(0, -size * .4); ctx.lineTo(0, size * .45); ctx.stroke();
    } else if (['bench', 'picnic_table', 'picnic_site'].includes(kind)) {
      ctx.fillStyle = '#a59a75'; ctx.fillRect(-size, -.6, size * 2, 1.2); ctx.strokeRect(-size, -.6, size * 2, 1.2);
      ctx.beginPath(); ctx.moveTo(-size * .65, -1.2); ctx.lineTo(-size * .65, 1.2); ctx.moveTo(size * .65, -1.2); ctx.lineTo(size * .65, 1.2); ctx.stroke();
    } else if (['gate', 'cattle_grid'].includes(kind)) {
      ctx.beginPath(); ctx.moveTo(-size, -1); ctx.lineTo(-size, 1); ctx.moveTo(size, -1); ctx.lineTo(size, 1); ctx.moveTo(-size, 0); ctx.lineTo(size, 0); ctx.stroke();
    } else if (kind === 'ruins') {
      ctx.strokeStyle = '#686f50'; ctx.beginPath(); ctx.moveTo(-size, -size * .5); ctx.lineTo(-size, size * .5); ctx.lineTo(-.3, size * .5);
      ctx.moveTo(.3, size * .5); ctx.lineTo(size, size * .5); ctx.lineTo(size, -size * .5); ctx.stroke();
      ctx.fillRect(-size * .3, -.4, .6, .5);
    } else if (['well', 'fountain', 'spring', 'drinking_water'].includes(kind)) {
      ctx.fillStyle = '#7e9a8a'; ctx.beginPath(); ctx.arc(0, 0, size * .65, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else {
      ctx.fillStyle = '#a8aa7d'; ctx.fillRect(-.7, -.7, 1.4, 1.4); ctx.strokeRect(-.7, -.7, 1.4, 1.4);
    }
    ctx.restore();
  }

  function detailLineWidth(record, zoom) {
    const rail = record.feature.kind === 'railway' || !!record.feature.tags?.railway;
    if (rail && zoom >= 3) return Math.max(1.3, 2 / zoom);
    if (record.feature.tags?.aeroway || ['runway', 'taxiway'].includes(record.feature.kind)) return Math.max(record.width, 1.4 / zoom);
    return Math.max(rail ? .8 : .32, .8 / zoom);
  }

  function waterWidth(record, zoom) {
    const dry = drDry(record.feature);
    return Math.max(record.width, (dry ? 2 : 2.4) / zoom) + (dry ? 1.5 : 1) / zoom;
  }

  function paintWater(ctx, record, zoom, hoveredId) {
    const { feature, path } = record;
    const hovered = hoveredId === feature.id;
    const dry = drDry(feature);
    if (record.geometry === 'point') { paintDetail(ctx, record, zoom, hoveredId); return; }
    if (record.geometry === 'line') {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      if (hovered) { ctx.strokeStyle = 'rgba(233,236,172,.55)'; ctx.lineWidth = waterWidth(record, zoom) + 3 / zoom; ctx.stroke(path); }
      ctx.strokeStyle = dry ? '#978d6f' : '#859b90'; ctx.lineWidth = waterWidth(record, zoom); ctx.stroke(path);
      ctx.strokeStyle = hovered ? '#e6e8b3' : dry ? '#c6ba97' : world.geographic ? '#435f5a' : '#354d49';
      ctx.lineWidth = Math.max(record.width, 1.1 / zoom); ctx.stroke(path);
      return;
    }
    ctx.fillStyle = dry ? '#bdb393' : feature.kind === 'pool' ? '#6e968b' : world.geographic ? '#435f5a' : '#354d49';
    ctx.fill(path, record.fillRule);
    ctx.strokeStyle = hovered ? '#e8eab8' : dry ? '#a29472' : '#91a798';
    ctx.lineWidth = (hovered ? 1.6 : .8) / zoom;
    if (dry) ctx.setLineDash([3 / zoom, 2 / zoom]);
    if (!(feature.merged && record.parts.length > 1)) ctx.stroke(path); ctx.setLineDash([]);
    if (hovered) { ctx.fillStyle = 'rgba(224,228,161,.12)'; ctx.fill(path, record.fillRule); }
  }

  function paintBiome(ctx, record, zoom, hoveredId) {
    if (record.outlineOnly) { paintBoundary(ctx, record, zoom, hoveredId); return; }
    if (record.geometry !== 'polygon') { paintDetail(ctx, record, zoom, hoveredId); return; }
    const { feature, path, biome, bounds: b } = record;
    const hovered = hoveredId === feature.id;
    const colors = {
      residential: 'rgba(171,153,112,.48)', industrial: 'rgba(106,118,111,.50)', commercial: 'rgba(163,139,107,.46)', retail: 'rgba(167,146,106,.50)',
      forest: 'rgba(99,125,81,.77)', wetland: 'rgba(116,143,112,.68)', grassland: 'rgba(150,166,104,.54)', scrub: 'rgba(142,148,100,.55)',
      park: 'rgba(117,146,84,.62)', garden: 'rgba(134,160,94,.56)', recreation: 'rgba(145,157,105,.57)', cemetery: 'rgba(133,145,111,.58)',
      farmland: 'rgba(161,153,96,.52)', orchard: 'rgba(139,158,94,.59)', vineyard: 'rgba(142,154,98,.57)',
      sand: 'rgba(196,180,129,.58)', rock: 'rgba(145,137,113,.44)', quarry: 'rgba(149,132,104,.62)',
      construction: 'rgba(172,148,108,.54)', brownfield: 'rgba(142,129,104,.50)', landfill: 'rgba(139,137,105,.55)',
      transport: 'rgba(132,137,120,.47)', glacier: 'rgba(190,207,194,.72)', plain: 'rgba(164,168,126,.18)',
      parking: 'rgba(145,148,125,.47)', religious: 'rgba(163,149,120,.48)', healthcare: 'rgba(133,157,145,.50)',
      education: 'rgba(144,158,116,.49)', civic: 'rgba(143,151,132,.48)', emergency: 'rgba(165,140,119,.47)',
      accommodation: 'rgba(166,155,126,.47)', camping: 'rgba(127,149,100,.53)', food_service: 'rgba(173,151,112,.48)',
      wasteland: 'rgba(156,151,119,.28)', suburb: 'rgba(160,154,112,.40)', urban: 'rgba(153,140,103,.51)', dense: 'rgba(126,122,102,.63)', aircraft_parking: 'rgba(145,147,126,.62)',
      service: 'rgba(150,145,121,.47)', utilities: 'rgba(132,142,128,.50)', heritage: 'rgba(162,145,113,.49)',
    };
    ctx.fillStyle = colors[biome] || 'rgba(145,153,113,.28)'; ctx.fill(path, record.fillRule);
    // Sparse print hatching expresses a land-use category, not extra mapped geometry.
    const hatch = ['industrial', 'quarry', 'construction', 'brownfield', 'landfill', 'transport', 'parking', 'utilities', 'aircraft_parking'].includes(biome);
    const rows = ['farmland', 'orchard', 'vineyard'].includes(biome);
    if (hatch || rows) {
      const span = Math.max(b.maxX - b.minX, b.maxY - b.minY), spacing = Math.max(7 / zoom, span / 40);
      ctx.save(); ctx.clip(path, record.fillRule);
      ctx.strokeStyle = 'rgba(59,72,48,.12)'; ctx.lineWidth = .65 / zoom; ctx.beginPath();
      for (let x = b.minX - (hatch ? span : 0); x <= b.maxX; x += spacing) {
        ctx.moveTo(x, b.minY); ctx.lineTo(x + (hatch ? span : 0), b.maxY);
      }
      ctx.stroke(); ctx.restore();
    }
    ctx.strokeStyle = hovered ? '#e8eab8' : 'rgba(73,94,58,.28)'; ctx.lineWidth = (hovered ? 1.6 : .6) / zoom;
    if (!record.fallback && !(feature.merged && record.parts.length > 1)) ctx.stroke(path); ctx.setLineDash([]);
    if (hovered && !record.fallback) { ctx.fillStyle = 'rgba(224,228,161,.12)'; ctx.fill(path, record.fillRule); }
  }

  function paintRoadSurface(ctx, record, zoom, hoveredId) {
    const hovered = hoveredId === record.feature.id;
    ctx.fillStyle = '#bcb18e'; ctx.fill(record.path, record.fillRule);
    ctx.strokeStyle = hovered ? '#f2efb5' : '#77775d'; ctx.lineWidth = (hovered ? 1.6 : .8) / zoom; ctx.stroke(record.path);
  }

  function paintRoadLabels(ctx, visible, view) {
    if (view.zoom < 4) return;
    const used = new Set(), boxes = [];
    let count = 0;
    for (const record of visible) {
      const { feature: road, longest } = record;
      if (!road.name || used.has(road.name) || !longest || longest.length * view.zoom < 115 || count >= 12) continue;
      const x = (longest.a.x + longest.b.x) / 2, y = (longest.a.y + longest.b.y) / 2;
      const screenX = (x - view.cameraX) * view.zoom + view.width / 2, screenY = (y - view.cameraY) * view.zoom + view.height / 2;
      if (screenX < 30 || screenX > view.width - 30 || screenY < 60 || screenY > view.height - 60) continue;
      const label = road.name.length > 30 ? road.name.slice(0, 29) + '…' : road.name;
      const width = label.length * 5.3, box = { x: screenX - width / 2, y: screenY - 9, width, height: 18 };
      if (boxes.some(b => box.x < b.x + b.width && box.x + box.width > b.x && box.y < b.y + b.height && box.y + box.height > b.y)) continue;
      let angle = longest.angle; if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
      ctx.save(); ctx.translate(x, y); ctx.rotate(angle); ctx.scale(1 / view.zoom, 1 / view.zoom);
      ctx.font = '500 10px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(186,175,140,.9)'; ctx.strokeText(label, 0, -2); ctx.fillStyle = '#48583d'; ctx.fillText(label, 0, -2); ctx.restore();
      boxes.push(box); used.add(road.name); count++;
    }
  }

  function draw(ctx, view) {
    lastZoom = view.zoom;
    lastHoveredId = view.hoveredId || null;
    if (view.layers) setLayers(view.layers);
    if (view.roadClasses) setRoadClasses(view.roadClasses);
    const halfWidth = view.width / (2 * view.zoom), halfHeight = view.height / (2 * view.zoom);
    const candidates = queryRecords({ minX: view.cameraX - halfWidth - 12, minY: view.cameraY - halfHeight - 12, maxX: view.cameraX + halfWidth + 12, maxY: view.cameraY + halfHeight + 12 });
    const visible = candidates.filter(record => isEnabled(record) && inView(record, view));
    stats.viewCandidates = candidates.length; stats.drawCount++;
    const visibleRoads = visible.filter(record => record.group === 'road');
    const visiblePower = visible.filter(record => record.layer === 'power' && record.geometry === 'line');
    for (const layer of Object.keys(layers)) stats['visible' + layer[0].toUpperCase() + layer.slice(1)] = visible.filter(record => record.layer === layer).length;
    ctx.save(); ctx.globalAlpha = 1;
    if (Number.isFinite(world.width) && Number.isFinite(world.height)) { ctx.beginPath(); ctx.rect(0, 0, world.width, world.height); ctx.clip(); }
    let roadsPainted = false, powerPainted = false;
    for (const record of visible) {
      if (record.layer === 'landscape') paintBiome(ctx, record, view.zoom, view.hoveredId);
      else if (record.layer === 'water') paintWater(ctx, record, view.zoom, view.hoveredId);
      else if (record.layer === 'roads' && record.geometry === 'polygon') paintRoadSurface(ctx, record, view.zoom, view.hoveredId);
      else if (record.group === 'road') {
        if (!roadsPainted) paintRoadBatch(ctx, visibleRoads, view.zoom, view.hoveredId);
        roadsPainted = true;
      }
      else if (record.layer === 'power' && record.geometry === 'line') {
        if (!powerPainted) paintPowerBatch(ctx, visiblePower, view.zoom, view.hoveredId);
        powerPainted = true;
      }
      else if (record.group === 'building') paintBuilding(ctx, record, view.zoom, view.hoveredId);
      else paintDetail(ctx, record, view.zoom, view.hoveredId);
    }
    paintRoadLabels(ctx, visibleRoads, view);
    ctx.restore();
  }

  /** Draw only the selection overlay over a previously rendered static map. */
  function drawHighlight(ctx, view, target = view.hoveredKey || view.hoveredId) {
    lastZoom = view.zoom;
    if (view.layers) setLayers(view.layers);
    if (view.roadClasses) setRoadClasses(view.roadClasses);
    const identity = typeof target === 'object' && target ? target.key || target.id : target;
    const record = recordsByKey.get(identity) || recordsById.get(identity);
    lastHoveredId = record && isEnabled(record) ? record.feature.id : null;
    if (!lastHoveredId || !inView(record, view, Math.max(12, record.width / 2 + 4 / view.zoom))) return null;
    stats.highlightDrawCount++;
    if (record.fallback) return record.key;
    ctx.save(); ctx.globalAlpha = 1;
    if (Number.isFinite(world.width) && Number.isFinite(world.height)) { ctx.beginPath(); ctx.rect(0, 0, world.width, world.height); ctx.clip(); }
    if (record.geometry === 'point') paintDetail(ctx, record, view.zoom, record.feature.id);
    else if (record.geometry === 'polygon' && !record.outlineOnly) {
      ctx.fillStyle = 'rgba(224,228,161,.16)'; ctx.fill(record.path, record.fillRule);
      ctx.strokeStyle = '#eff0be'; ctx.lineWidth = Math.max(record.group === 'building' ? .26 : 0, 1.6 / view.zoom);
      if (!(record.feature.merged && record.parts.length > 1)) ctx.stroke(record.path);
    } else {
      const width = record.outlineOnly ? boundaryWidth(view.zoom) : record.group === 'road' ? roadWidth(record, view.zoom).stroke : record.layer === 'water' ? waterWidth(record, view.zoom) : record.layer === 'power' ? powerWidth(record, view.zoom) : detailLineWidth(record, view.zoom);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(238,238,169,.65)'; ctx.lineWidth = width + 4 / view.zoom; ctx.stroke(record.path);
      ctx.strokeStyle = '#f2efb5'; ctx.lineWidth = Math.max(1.25 / view.zoom, width * .28); ctx.stroke(record.path);
    }
    ctx.restore();
    return record.key;
  }

  function describe(record, point = record.center) {
    const feature = record.feature;
    const zone = !record.outlineOnly && record.layer === 'landscape' && record.geometry === 'polygon' && (mapZoneBiome(feature) || ['residential', 'industrial', 'commercial', 'retail'].includes(record.biome));
    const kind = record.outlineOnly ? 'settlement_boundary' : zone ? `${record.biome}_area` : record.group === 'building' ? feature.ruins ? 'ruins' : 'building' : record.group === 'road' ? 'road' : record.group === 'area' ? feature.type : record.group === 'river' ? 'river' : record.group === 'lake' ? 'lake' : feature.kind;
    const roadDescription = (ROAD_CLASSES[record.roadClass]?.name || 'Дорога') + ((feature.members || [feature]).some(member => member.tags?.railway === 'abandoned') ? ' · По бывшей железной дороге' : '');
    return { id: feature.id, key: record.key, sourceId: drSourceId(feature), layer: record.layer, kind, biome: record.biome, ...drTypeMetadata(record),
      biomeName: record.biome ? drBiomeNames[record.biome] || drFeatureLabel(feature, record.group) : null,
      geometry: record.geometry, footprintOnly: record.footprintOnly === true, outlineOnly: record.outlineOnly, derived: feature.derived === true, urbanFiller: feature.urbanFiller === true, fallback: record.fallback, provenance: feature.provenance ? structuredClone(feature.provenance) : null,
      roadClass: record.roadClass, roadClassName: ROAD_CLASSES[record.roadClass]?.name || null,
      sourceIds: [...(feature.sourceIds || [drSourceId(feature)])], memberIds: [...(feature.memberIds || [feature.id])],
      name: drFeatureLabel(feature, record.group), x: point.x, y: point.y, source: feature, members: (feature.members || []).map(member => structuredClone(member)),
      paths: record.geometry === 'line' ? record.rings.map(path => path.map(point => ({ ...point }))) : undefined, parts: record.geometry === 'polygon' ? record.parts.map(part => part.map(ring => ring.map(point => ({ ...point })))) : undefined,
      description: feature.derived ? `${drBiomeNames[record.biome] || 'Игровая зона'} · Игровая разметка местности` : record.outlineOnly ? 'Граница населённого пункта' : record.group === 'building' ? [feature.address, drNames[feature.type], feature.levels ? `${feature.levels} эт.` : ''].filter(Boolean).join(' · ') : record.group === 'road' ? roadDescription : record.footprintOnly ? `${drBiomeNames[record.biome]} · По контуру здания` : feature.tags?.railway === 'abandoned' ? 'Заброшенная железная дорога' : record.layer === 'water' && drDry(feature) ? 'Сезонное русло' : drNames[kind] || drFeatureLabel(feature, record.group) };
  }

  /** All physical zone memberships coexist, including zones hidden from view. */
  function zonesAt(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > world.width || y > world.height) return [];
    const result = [], seen = new Set(), fallbacks = [];
    const candidates = queryZones({ minX: x, maxX: x, minY: y, maxY: y });
    stats.zoneCandidates = candidates.length;
    const add = record => {
      const item = describe(record, { x, y }), identity = `${item.sourceId}:${item.biome}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      result.push({ id: item.id, key: item.key, sourceId: item.sourceId, sourceIds: item.sourceIds, biome: item.biome, biomeName: item.biomeName, name: item.name, layer: item.layer, footprintOnly: item.footprintOnly, derived: item.derived, urbanFiller: item.urbanFiller, fallback: item.fallback, provenance: item.provenance, ...drTypeMetadata(record) });
    };
    for (const record of candidates) {
      const b = record.bounds;
      if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || !drPartContains(record, x, y)) continue;
      if (record.fallback) fallbacks.push(record); else add(record);
    }
    if (!result.length && fallbacks.length) {
      const permanentWater = queryRecords({ minX: x, maxX: x, minY: y, maxY: y }).some(record => record.layer === 'water' && !drDry(record.feature)
        && (record.geometry === 'polygon' ? drPartContains(record, x, y) : record.geometry === 'line' && drNearestOnRings(x, y, record.rings).distance <= Math.max(.5, record.width / 2)));
      if (!permanentWater) fallbacks.forEach(add);
    }
    return result;
  }

  function pointPaintDistance(record, x, y, zoom) {
    const kind = record.feature.kind, point = record.points[0];
    const px = x - point.x, py = y - point.y;
    const size = Math.max(1.7, Math.min(4, 8 / zoom));
    const halfStroke = Math.max(.2, 1 / zoom) / 2;
    const rectangle = (cx, cy, hx, hy, stroke = halfStroke) => Math.hypot(Math.max(0, Math.abs(px - cx) - hx), Math.max(0, Math.abs(py - cy) - hy)) - stroke;
    const segment = (ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay;
      const t = drClamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
      return Math.hypot(px - ax - t * dx, py - ay - t * dy) - halfStroke;
    };
    if (kind === 'tree') return Math.min(Math.hypot(px, py) - size - halfStroke, Math.hypot(px - .3, py - .5) - size);
    if (['bench', 'picnic_table', 'picnic_site'].includes(kind)) return Math.min(rectangle(0, 0, size, .6), segment(-size * .65, -1.2, -size * .65, 1.2), segment(size * .65, -1.2, size * .65, 1.2));
    if (['gate', 'cattle_grid'].includes(kind)) return Math.min(segment(-size, -1, -size, 1), segment(size, -1, size, 1), segment(-size, 0, size, 0));
    if (kind === 'ruins') return Math.min(
      segment(-size, -size * .5, -size, size * .5), segment(-size, size * .5, -.3, size * .5),
      segment(.3, size * .5, size, size * .5), segment(size, size * .5, size, -size * .5),
      rectangle(-size * .3 + .3, -.15, .3, .25, 0),
    );
    if (['well', 'fountain', 'spring', 'drinking_water'].includes(kind)) return Math.hypot(px, py) - size * .65 - halfStroke;
    // Generic OSM points are drawn as 1.4-world-unit squares, not size-radius discs.
    return rectangle(0, 0, .7, .7);
  }

  function pick(x, y, tolerance = 3) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (Number.isFinite(world.width) && Number.isFinite(world.height) && (x < 0 || y < 0 || x > world.width || y > world.height)) return null;
    tolerance = Math.max(0, Number.isFinite(tolerance) ? tolerance : 0);
    // Index bounds include physical line width; this extra margin includes
    // zoom-dependent readability strokes, glyphs and the pointer tolerance.
    const margin = tolerance + 9 / Math.max(.01, lastZoom) + 3;
    const candidates = queryRecords({ minX: x - margin, maxX: x + margin, minY: y - margin, maxY: y + margin });
    stats.pickCandidates = candidates.length;
    const candidateBuildings = candidates.filter(record => record.group === 'building').sort((a, b) => a.sourceOrder - b.sourceOrder);
    for (let i = candidateBuildings.length - 1; i >= 0; i--) {
      const record = candidateBuildings[i], b = record.bounds;
      if (isEnabled(record) && x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && drPartContains(record, x, y)) return describe(record);
    }
    let pointHit = null, pointScore = Infinity;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const record = candidates[i];
      if (!isEnabled(record) || record.geometry !== 'point') continue;
      const edgeDistance = pointPaintDistance(record, x, y, lastZoom);
      if (edgeDistance <= 0) return describe(record, record.points[0]);
      if (edgeDistance <= tolerance && edgeDistance < pointScore) { pointHit = describe(record, record.points[0]); pointScore = edgeDistance; }
    }

    // Native point and line footprints win before generous finger tolerances.
    // All line families share the semantic visibility used by the paint pass.
    let closest = null, minimum = Infinity;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const record = candidates[i];
      if (!isEnabled(record) || record.geometry !== 'line' && !record.outlineOnly) continue;
      let stroke = record.outlineOnly ? boundaryWidth(lastZoom) : record.group === 'road' ? roadWidth(record, lastZoom).stroke : record.layer === 'water' ? waterWidth(record, lastZoom) : record.layer === 'power' ? powerWidth(record, lastZoom) : detailLineWidth(record, lastZoom);
      if (record.feature.id === lastHoveredId) stroke += (record.group === 'road' ? 4 : record.layer === 'water' ? 3 : 1.5) / lastZoom;
      const b = record.bounds;
      if (x < b.minX - tolerance - stroke / 2 || x > b.maxX + tolerance + stroke / 2 || y < b.minY - tolerance - stroke / 2 || y > b.maxY + tolerance + stroke / 2) continue;
      const point = drNearestOnRings(x, y, record.rings, record.outlineOnly && record.geometry === 'polygon'), edgeDistance = point.distance - stroke / 2;
      if (edgeDistance <= 0) return describe(record, point);
      if (edgeDistance <= tolerance && edgeDistance < minimum) { closest = describe(record, point); minimum = edgeDistance; }
    }
    if (pointHit && pointScore < minimum) return pointHit;
    if (closest) return closest;
    // Reverse paint order keeps streets and small territories above broad biomes.
    for (let i = candidates.length - 1; i >= 0; i--) {
      const record = candidates[i], feature = record.feature;
      if (!isEnabled(record) || record.geometry !== 'polygon' || record.outlineOnly) continue;
      if (record.ellipse ? ((x - feature.x) / feature.rx) ** 2 + ((y - feature.y) / feature.ry) ** 2 <= 1 : drPartContains(record, x, y)) return describe(record);
    }
    return null;
  }

  function setLayers(changes = {}) {
    for (const key of Object.keys(layers)) if (Object.hasOwn(changes, key)) layers[key] = changes[key] !== false;
    for (const layer of Object.keys(layers)) if (!layers[layer]) stats['visible' + layer[0].toUpperCase() + layer.slice(1)] = 0;
    return { ...layers };
  }

  function setRoadClasses(changes = {}) {
    for (const key of Object.keys(roadClasses)) if (Object.hasOwn(changes, key)) roadClasses[key] = changes[key] !== false;
    if (Object.values(roadClasses).every(value => !value)) stats.visibleRoads = 0;
    return { ...roadClasses };
  }

  function getFeatures() {
    return registry.map(record => ({
      id: record.feature.id, key: record.key, sourceId: drSourceId(record.feature), layer: record.layer, group: record.group,
      sourceIds: [...(record.feature.sourceIds || [drSourceId(record.feature)])], memberIds: [...(record.feature.memberIds || [record.feature.id])],
      sourceTypes: [...(record.feature.sourceTypes || [record.feature.type || record.feature.kind].filter(Boolean))], names: [...(record.feature.names || [record.feature.name].filter(Boolean))], merged: record.feature.merged === true,
      roadClass: record.roadClass, roadClassName: ROAD_CLASSES[record.roadClass]?.name || null,
      ...drTypeMetadata(record),
      kind: describe(record).kind, name: drFeatureLabel(record.feature, record.group), geometry: record.geometry,
      points: record.points.map(point => ({ ...point })), rings: record.geometry === 'polygon' ? record.parts[0].map(ring => ring.map(point => ({ ...point }))) : undefined,
      parts: record.geometry === 'polygon' ? record.parts.map(part => part.map(ring => ring.map(point => ({ ...point })))) : undefined,
      paths: record.geometry === 'line' ? record.rings.map(path => path.map(point => ({ ...point }))) : undefined,
      bounds: { ...record.bounds }, biome: record.biome, biomeName: record.biome ? drBiomeNames[record.biome] || drFeatureLabel(record.feature, record.group) : null,
      derived: record.feature.derived === true, urbanFiller: record.feature.urbanFiller === true, fallback: record.fallback, provenance: record.feature.provenance ? structuredClone(record.feature.provenance) : null,
      footprintOnly: record.footprintOnly === true, outlineOnly: record.outlineOnly, width: record.width, enabled: isEnabled(record),
    }));
  }

  function focus() {
    if (focusPoint) return { ...focusPoint };
    if (!buildings.length) return null;
    const radius = 160;
    let selected = null, maxCount = 0;
    for (const building of buildings) {
      const near = buildings.filter(other => Math.hypot(other.center.x - building.center.x, other.center.y - building.center.y) < radius);
      if (near.length > maxCount) { maxCount = near.length; selected = near; }
    }
    const center = selected.reduce((point, building) => ({ x: point.x + building.center.x / selected.length, y: point.y + building.center.y / selected.length }), { x: 0, y: 0 });
    focusPoint = { ...center, zoom: 6 };
    return { ...focusPoint };
  }

  return { draw, drawHighlight, pick, focus, zonesAt, setLayers, getLayers: () => ({ ...layers }), setRoadClasses, getRoadClasses: () => ({ ...roadClasses }), getFeatures, getStats: () => ({ ...stats, layers: { ...layers }, roadClasses: { ...roadClasses } }) };
}
