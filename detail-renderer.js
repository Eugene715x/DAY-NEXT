import { mapFeatureLayer, mapBiome, mapZoneBiome } from './map-layers.js';

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
};

const drBiomeNames = {
  ...drNames, residential: 'Жилая зона', industrial: 'Промышленная зона', commercial: 'Коммерческая зона', retail: 'Торговая зона',
  parking: 'Парковочная зона', religious: 'Религиозная зона', healthcare: 'Медицинская зона', education: 'Образовательная зона',
  civic: 'Общественная зона', emergency: 'Зона экстренных служб', transport: 'Транспортная зона', accommodation: 'Гостиничная зона',
  camping: 'Кемпинг', food_service: 'Зона питания', service: 'Зона обслуживания', utilities: 'Коммунальная зона', heritage: 'Историческая зона',
  forest: 'Лес', garden: 'Сад', landscape: 'Ландшафт', plain: 'Открытая местность',
};
const drSourceId = feature => feature.sourceId || String(feature.id || '').match(/^(?:node|way|relation)-\d+/)?.[0] || feature.id;
const drSameFootprint = (a, b) => a.rings.length === b.rings.length && a.rings.every(ring => b.rings.some(other => ring.length === other.length
  && ring.every(point => other.some(candidate => candidate.x === point.x && candidate.y === point.y))));

function drFeatureLabel(feature, group) {
  if (feature.name) return feature.name;
  if (group === 'building') return drNames[feature.ruins ? 'ruins' : feature.type] || drNames.building;
  if (group === 'road') return drNames[feature.type === 'residential' ? 'residential_road' : feature.type] || 'Дорога';
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

function drCache(original, group, layer, metersPerUnit, index) {
  const feature = original.id ? original : { ...original, id: `${group}-${index}` };
  const geometry = group === 'building' || group === 'area' || group === 'lake' || group === 'zone' ? 'polygon' : feature.geometry || 'line';
  const ellipse = group === 'lake' && [feature.x, feature.y, feature.rx, feature.ry].every(Number.isFinite);
  const ellipseRing = ellipse ? Array.from({ length: 65 }, (_, i) => ({ x: feature.x + Math.cos(i / 64 * Math.PI * 2) * feature.rx, y: feature.y + Math.sin(i / 64 * Math.PI * 2) * feature.ry })) : null;
  const rings = ellipseRing ? [ellipseRing] : feature.rings?.length ? feature.rings : feature.points?.length ? [feature.points] : [];
  const points = rings.flat();
  if (!points.length) return null;
  const path = new Path2D();
  for (const ring of ellipse ? [] : rings) {
    ring.forEach((p, i) => i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y));
    if (geometry === 'polygon') path.closePath();
  }
  if (ellipse) path.ellipse(feature.x, feature.y, feature.rx, feature.ry, 0, 0, Math.PI * 2);
  const bounds = drBounds(points);
  const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
  let longest = null;
  for (let i = 1; i < rings[0].length; i++) {
    const a = rings[0][i - 1], b = rings[0][i], length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!longest || length > longest.length) longest = { a, b, length, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }
  const actualWidth = Number(feature.widthMeters ?? feature.tags?.width) / metersPerUnit;
  return { feature, group, layer, biome: layer === 'landscape' ? mapBiome(feature) : null, geometry, ellipse, key: `${layer}:${group}:${feature.id}`, rings, points, path, bounds, center, longest, hash: drHash(feature.id), width: Number.isFinite(actualWidth) && actualWidth > 0 ? actualWidth : Number(feature.width) || 1 };
}

/** Call draw inside a world transform; view dimensions are CSS screen pixels. */
export function createDetailRenderer(world) {
  const metersPerUnit = world.metersPerUnit || 5;
  const cache = (features, group) => (features || []).map((feature, index) => drCache(feature, group, mapFeatureLayer(feature, group), metersPerUnit, index)).filter(Boolean);
  const roads = cache(world.roads, 'road');
  const buildings = cache(world.buildings, 'building');
  const nativeRoads = new Map(roads.map(record => [record.feature.id, record]));
  const details = cache(world.details, 'detail').filter(record => {
    const road = record.layer === 'roads' && nativeRoads.get(record.feature.id);
    // The same OSM alignment can be both a present road and a former railway.
    // Its native road already retains all tags; keep one physical selectable ink path.
    return !(road && record.geometry === 'line' && road.points.length === record.points.length
      && road.points.every((point, index) => point.x === record.points[index].x && point.y === record.points[index].y));
  });
  const areas = cache(world.areas, 'area');
  const rivers = cache(world.rivers, 'river');
  const lakes = cache(world.lakes, 'lake');
  const mappedZones = [...areas, ...details].filter(record => record.layer === 'landscape' && record.geometry === 'polygon');
  const footprintZones = buildings.flatMap((building, index) => {
    const biome = mapZoneBiome(building.feature);
    if (!biome) return [];
    // An existing campus/grounds polygon already provides the institution's zone.
    // Otherwise its building outline is the only measured extent we can use.
    if (mappedZones.some(zone => zone.biome === biome && (drSameFootprint(zone, building)
      || building.rings[0].every(point => drInPolygon(point.x, point.y, zone.rings))))) return [];
    const record = drCache(building.feature, 'zone', 'landscape', metersPerUnit, index);
    record.footprintOnly = true;
    return [record];
  });
  const rank = record => record.group === 'building' ? 9
    : record.geometry === 'polygon' ? record.layer === 'landscape' ? 0 : record.layer === 'water' ? 1 : record.layer === 'roads' ? 5 : 2
    : record.geometry === 'point' ? 8 : record.layer === 'water' ? 3 : record.layer === 'landscape' ? 4 : record.group === 'road' ? 6 : 7;
  const surfaceSize = record => (record.bounds.maxX - record.bounds.minX) * (record.bounds.maxY - record.bounds.minY);
  const registry = [...areas, ...rivers, ...lakes, ...details, ...footprintZones, ...roads, ...buildings]
    .sort((a, b) => rank(a) - rank(b) || (a.geometry === 'polygon' && b.geometry === 'polygon' ? surfaceSize(b) - surfaceSize(a) : 0));
  const zonePolygons = registry.filter(record => record.layer === 'landscape' && record.geometry === 'polygon');
  const layers = { landscape: true, water: true, roads: true, buildings: true, details: true };
  const stats = { features: registry.length };
  for (const layer of Object.keys(layers)) {
    stats[layer] = registry.filter(record => record.layer === layer).length;
    stats['visible' + layer[0].toUpperCase() + layer.slice(1)] = 0;
  }
  const fineRoads = new Set(['footway', 'path', 'track', 'cycleway', 'bridleway', 'steps']);
  const greenAreas = new Set(['park', 'garden', 'grass', 'playground', 'pitch', 'cemetery']);
  let lastZoom = 1, lastHoveredId = null;
  let focusPoint = null;

  function inView(record, view, margin = 12) {
    const halfWidth = view.width / (2 * view.zoom), halfHeight = view.height / (2 * view.zoom), b = record.bounds;
    return b.maxX >= view.cameraX - halfWidth - margin && b.minX <= view.cameraX + halfWidth + margin
      && b.maxY >= view.cameraY - halfHeight - margin && b.minY <= view.cameraY + halfHeight + margin;
  }

  function roadWidth(record, zoom) {
    const fine = fineRoads.has(record.feature.type);
    const core = Math.max(record.width, (fine ? .75 : 1.2) / zoom);
    let stroke = core + (fine ? .7 / zoom : Math.max(.25, 1.1 / zoom));
    if (record.feature.bridge && zoom >= 2) stroke = Math.max(stroke, core + .5);
    if (record.feature.type === 'steps' && zoom >= 4) stroke = Math.max(stroke, 1);
    return { core, stroke };
  }

  function paintRoad(ctx, record, zoom, hoveredId) {
    const { feature: road, path } = record;
    const fine = fineRoads.has(road.type), minor = road.type === 'service' || road.type === 'residential' || road.type === 'unclassified';
    const { core: width, stroke } = roadWidth(record, zoom);
    const hovered = hoveredId === road.id;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (hovered) {
      ctx.strokeStyle = 'rgba(238,238,169,.65)'; ctx.lineWidth = stroke + 4 / zoom; ctx.stroke(path);
    }
    ctx.globalAlpha = road.tunnel ? .58 : 1;
    if (fine) {
      ctx.strokeStyle = road.type === 'track' ? '#8a8062' : '#706f54';
      ctx.lineWidth = width + .7 / zoom; ctx.stroke(path);
      ctx.strokeStyle = '#d8ccaa'; ctx.lineWidth = Math.max(.55 / zoom, width * .52);
      ctx.setLineDash([Math.max(.65, 2 / zoom), Math.max(.55, 2 / zoom)]); ctx.stroke(path); ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = road.bridge ? '#4b5847' : '#77775d'; ctx.lineWidth = width + Math.max(.25, 1.1 / zoom); ctx.stroke(path);
      ctx.strokeStyle = minor ? '#d2c6a1' : '#bcb18e'; ctx.lineWidth = width; ctx.stroke(path);
      if (!minor && zoom >= 4 && width * zoom >= 6) {
        ctx.strokeStyle = '#e4d7ad'; ctx.lineWidth = .65 / zoom;
        ctx.setLineDash([1.8, 1.7]); ctx.stroke(path); ctx.setLineDash([]);
      }
    }
    if (road.bridge && zoom >= 2) {
      ctx.strokeStyle = 'rgba(42,57,42,.5)'; ctx.lineWidth = width + .5; ctx.setLineDash([.25, 1.8]); ctx.stroke(path); ctx.setLineDash([]);
      ctx.strokeStyle = '#d9cda7'; ctx.lineWidth = Math.max(.2, width * .7); ctx.stroke(path);
    }
    if (road.type === 'steps' && zoom >= 4) {
      ctx.strokeStyle = '#4e5944'; ctx.lineWidth = Math.max(width, 1); ctx.setLineDash([.15, .7]); ctx.stroke(path); ctx.setLineDash([]);
    }
    if (hovered) {
      ctx.globalAlpha = 1; ctx.strokeStyle = '#f2efb5'; ctx.lineWidth = Math.max(1.25 / zoom, width * .28); ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
  }

  function paintBuilding(ctx, record, zoom, hoveredId) {
    const { feature, path, bounds: b, center, longest } = record;
    const high = zoom >= 2.5, hovered = hoveredId === feature.id;
    const ruin = feature.ruins === true || feature.type === 'ruins';
    const colors = ['#a39f7c', '#b4a583', '#8b9675', '#b7b18d', '#9b9b7c'];
    const roof = ruin ? '#9a9476' : colors[record.hash % colors.length];
    if (high) {
      ctx.save(); ctx.translate(.55, .8);
      ctx.fillStyle = 'rgba(39,47,32,.3)'; ctx.fill(path, 'evenodd'); ctx.restore();
      const gradient = ctx.createLinearGradient(b.minX, b.minY, b.maxX, b.maxY);
      gradient.addColorStop(0, roof); gradient.addColorStop(.5, roof); gradient.addColorStop(1, '#74785b');
      ctx.fillStyle = gradient;
    } else ctx.fillStyle = '#80876a';
    ctx.fill(path, 'evenodd');
    ctx.strokeStyle = hovered ? '#eff0be' : '#3f503c'; ctx.lineWidth = high ? Math.max(.26, .9 / zoom) : .8 / zoom;
    if (ruin) ctx.setLineDash([.7, .4]);
    ctx.stroke(path); ctx.setLineDash([]);
    if (!high) return;
    ctx.save(); ctx.clip(path, 'evenodd');
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
      ctx.fillStyle = highlighted ? 'rgba(217,223,153,.25)' : boundary ? 'rgba(126,143,111,.025)' : aeroway ? 'rgba(117,122,106,.22)' : kind === 'pool' ? '#738f83' : greenAreas.has(kind) ? 'rgba(116,132,88,.38)' : kind === 'parking' ? 'rgba(140,135,107,.32)' : 'rgba(136,127,96,.15)';
      ctx.fill(path, 'evenodd'); ctx.strokeStyle = highlighted ? '#eceabb' : aeroway ? '#626d58' : '#7c8060'; ctx.lineWidth = (highlighted ? 1.5 : .7) / zoom;
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
    ctx.fill(path, 'evenodd');
    ctx.strokeStyle = hovered ? '#e8eab8' : dry ? '#a29472' : '#91a798';
    ctx.lineWidth = (hovered ? 1.6 : .8) / zoom;
    if (dry) ctx.setLineDash([3 / zoom, 2 / zoom]);
    ctx.stroke(path); ctx.setLineDash([]);
    if (hovered) { ctx.fillStyle = 'rgba(224,228,161,.12)'; ctx.fill(path, 'evenodd'); }
  }

  function paintBiome(ctx, record, zoom, hoveredId) {
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
      service: 'rgba(150,145,121,.47)', utilities: 'rgba(132,142,128,.50)', heritage: 'rgba(162,145,113,.49)',
    };
    ctx.fillStyle = colors[biome] || 'rgba(145,153,113,.28)'; ctx.fill(path, 'evenodd');
    // Sparse print hatching expresses a land-use category, not extra mapped geometry.
    const hatch = ['industrial', 'quarry', 'construction', 'brownfield', 'landfill', 'transport', 'parking', 'utilities'].includes(biome);
    const rows = ['farmland', 'orchard', 'vineyard'].includes(biome);
    if (hatch || rows) {
      const span = Math.max(b.maxX - b.minX, b.maxY - b.minY), spacing = Math.max(7 / zoom, span / 40);
      ctx.save(); ctx.clip(path, 'evenodd');
      ctx.strokeStyle = 'rgba(59,72,48,.12)'; ctx.lineWidth = .65 / zoom; ctx.beginPath();
      for (let x = b.minX - (hatch ? span : 0); x <= b.maxX; x += spacing) {
        ctx.moveTo(x, b.minY); ctx.lineTo(x + (hatch ? span : 0), b.maxY);
      }
      ctx.stroke(); ctx.restore();
    }
    ctx.strokeStyle = hovered ? '#e8eab8' : 'rgba(73,94,58,.28)'; ctx.lineWidth = (hovered ? 1.6 : .6) / zoom; ctx.stroke(path);
    if (hovered) { ctx.fillStyle = 'rgba(224,228,161,.12)'; ctx.fill(path, 'evenodd'); }
  }

  function paintRoadSurface(ctx, record, zoom, hoveredId) {
    const hovered = hoveredId === record.feature.id;
    ctx.fillStyle = '#bcb18e'; ctx.fill(record.path, 'evenodd');
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
    const visible = registry.filter(record => layers[record.layer] && inView(record, view));
    const visibleRoads = visible.filter(record => record.group === 'road');
    for (const layer of Object.keys(layers)) stats['visible' + layer[0].toUpperCase() + layer.slice(1)] = visible.filter(record => record.layer === layer).length;
    ctx.save(); ctx.globalAlpha = 1;
    if (Number.isFinite(world.width) && Number.isFinite(world.height)) { ctx.beginPath(); ctx.rect(0, 0, world.width, world.height); ctx.clip(); }
    for (const record of visible) {
      if (record.layer === 'landscape') paintBiome(ctx, record, view.zoom, view.hoveredId);
      else if (record.layer === 'water') paintWater(ctx, record, view.zoom, view.hoveredId);
      else if (record.layer === 'roads' && record.geometry === 'polygon') paintRoadSurface(ctx, record, view.zoom, view.hoveredId);
      else if (record.group === 'road') paintRoad(ctx, record, view.zoom, view.hoveredId);
      else if (record.group === 'building') paintBuilding(ctx, record, view.zoom, view.hoveredId);
      else paintDetail(ctx, record, view.zoom, view.hoveredId);
    }
    paintRoadLabels(ctx, visibleRoads, view);
    ctx.restore();
  }

  function describe(record, point = record.center) {
    const feature = record.feature;
    const zone = record.layer === 'landscape' && record.geometry === 'polygon' && (mapZoneBiome(feature) || ['residential', 'industrial', 'commercial', 'retail'].includes(record.biome));
    const kind = zone ? `${record.biome}_area` : record.group === 'building' ? feature.ruins ? 'ruins' : 'building' : record.group === 'road' ? 'road' : record.group === 'area' ? feature.type : record.group === 'river' ? 'river' : record.group === 'lake' ? 'lake' : feature.kind;
    const roadDescription = (drNames[feature.type === 'residential' ? 'residential_road' : feature.type] || 'Дорога') + (feature.tags?.railway === 'abandoned' ? ' · По бывшей железной дороге' : '');
    return { id: feature.id, key: record.key, sourceId: drSourceId(feature), layer: record.layer, kind, biome: record.biome,
      biomeName: record.biome ? drBiomeNames[record.biome] || drFeatureLabel(feature, record.group) : null,
      geometry: record.geometry, footprintOnly: record.footprintOnly === true,
      name: drFeatureLabel(feature, record.group), x: point.x, y: point.y, source: feature,
      description: record.group === 'building' ? [feature.address, drNames[feature.type], feature.levels ? `${feature.levels} эт.` : ''].filter(Boolean).join(' · ') : record.group === 'road' ? roadDescription : record.footprintOnly ? `${drBiomeNames[record.biome]} · По контуру здания` : feature.tags?.railway === 'abandoned' ? 'Заброшенная железная дорога' : record.layer === 'water' && drDry(feature) ? 'Сезонное русло' : drNames[kind] || drFeatureLabel(feature, record.group) };
  }

  /** All physical zone memberships coexist, including zones hidden from view. */
  function zonesAt(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > world.width || y > world.height) return [];
    const result = [], seen = new Set();
    for (const record of zonePolygons) {
      const b = record.bounds;
      if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || !drInPolygon(x, y, record.rings)) continue;
      const item = describe(record, { x, y }), identity = `${item.sourceId}:${item.biome}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      result.push({ id: item.id, key: item.key, sourceId: item.sourceId, biome: item.biome, biomeName: item.biomeName, name: item.name, layer: item.layer, footprintOnly: item.footprintOnly });
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
    for (let i = buildings.length - 1; i >= 0; i--) {
      const record = buildings[i], b = record.bounds;
      if (layers[record.layer] && x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && drInPolygon(x, y, record.rings)) return describe(record);
    }
    let pointHit = null, pointScore = Infinity;
    for (let i = registry.length - 1; i >= 0; i--) {
      const record = registry[i];
      if (!layers[record.layer] || record.geometry !== 'point') continue;
      const edgeDistance = pointPaintDistance(record, x, y, lastZoom);
      if (edgeDistance <= 0) return describe(record, record.points[0]);
      if (edgeDistance <= tolerance && edgeDistance < pointScore) { pointHit = describe(record, record.points[0]); pointScore = edgeDistance; }
    }

    // Native point and line footprints win before generous finger tolerances.
    // All line families share the semantic visibility used by the paint pass.
    let closest = null, minimum = Infinity;
    for (let i = registry.length - 1; i >= 0; i--) {
      const record = registry[i];
      if (!layers[record.layer] || record.geometry !== 'line') continue;
      let stroke = record.group === 'road' ? roadWidth(record, lastZoom).stroke : record.layer === 'water' ? waterWidth(record, lastZoom) : detailLineWidth(record, lastZoom);
      if (record.feature.id === lastHoveredId) stroke += (record.group === 'road' ? 4 : record.layer === 'water' ? 3 : 1.5) / lastZoom;
      const b = record.bounds;
      if (x < b.minX - tolerance - stroke / 2 || x > b.maxX + tolerance + stroke / 2 || y < b.minY - tolerance - stroke / 2 || y > b.maxY + tolerance + stroke / 2) continue;
      const point = drNearestOnLine(x, y, record.points), edgeDistance = point.distance - stroke / 2;
      if (edgeDistance <= 0) return describe(record, point);
      if (edgeDistance <= tolerance && edgeDistance < minimum) { closest = describe(record, point); minimum = edgeDistance; }
    }
    if (pointHit && pointScore < minimum) return pointHit;
    if (closest) return closest;
    // Reverse paint order keeps streets and small territories above broad biomes.
    for (let i = registry.length - 1; i >= 0; i--) {
      const record = registry[i], feature = record.feature;
      if (!layers[record.layer] || record.geometry !== 'polygon') continue;
      if (record.ellipse ? ((x - feature.x) / feature.rx) ** 2 + ((y - feature.y) / feature.ry) ** 2 <= 1 : drInPolygon(x, y, record.rings)) return describe(record);
    }
    return null;
  }

  function setLayers(changes = {}) {
    for (const key of Object.keys(layers)) if (Object.hasOwn(changes, key)) layers[key] = changes[key] !== false;
    for (const layer of Object.keys(layers)) if (!layers[layer]) stats['visible' + layer[0].toUpperCase() + layer.slice(1)] = 0;
    return { ...layers };
  }

  function getFeatures() {
    return registry.map(record => ({
      id: record.feature.id, key: record.key, sourceId: drSourceId(record.feature), layer: record.layer, group: record.group,
      kind: describe(record).kind, name: drFeatureLabel(record.feature, record.group), geometry: record.geometry,
      points: record.points.map(point => ({ ...point })), rings: record.geometry === 'polygon' ? record.rings.map(ring => ring.map(point => ({ ...point }))) : undefined,
      bounds: { ...record.bounds }, biome: record.biome, biomeName: record.biome ? drBiomeNames[record.biome] || drFeatureLabel(record.feature, record.group) : null,
      footprintOnly: record.footprintOnly === true, width: record.width, enabled: layers[record.layer],
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

  return { draw, pick, focus, zonesAt, setLayers, getLayers: () => ({ ...layers }), getFeatures, getStats: () => ({ ...stats, layers: { ...layers } }) };
}
