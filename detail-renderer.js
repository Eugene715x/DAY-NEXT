/** Sharp, scale-aware cartography over the original mapped footprints and paths. */
const drClamp = (n, min, max) => Math.max(min, Math.min(max, n));

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
};

function drFeatureLabel(feature, group) {
  if (feature.name) return feature.name;
  if (group === 'building') return drNames[feature.ruins ? 'ruins' : feature.type] || drNames.building;
  if (group === 'road') return drNames[feature.type === 'residential' ? 'residential_road' : feature.type] || 'Дорога';
  return drNames[feature.kind] || 'Объект на карте';
}

function drCache(feature, group, metersPerUnit) {
  const rings = feature.rings?.length ? feature.rings : feature.points?.length ? [feature.points] : [];
  const points = rings.flat();
  if (!points.length) return null;
  const path = new Path2D();
  for (const ring of rings) {
    ring.forEach((p, i) => i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y));
    if (group === 'building' || feature.geometry === 'polygon') path.closePath();
  }
  const bounds = drBounds(points);
  const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
  let longest = null;
  for (let i = 1; i < rings[0].length; i++) {
    const a = rings[0][i - 1], b = rings[0][i], length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!longest || length > longest.length) longest = { a, b, length, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }
  const actualWidth = Number(feature.widthMeters) / metersPerUnit;
  return { feature, group, rings, points, path, bounds, center, longest, hash: drHash(feature.id), width: Number.isFinite(actualWidth) && actualWidth > 0 ? actualWidth : Number(feature.width) || 1 };
}

/** Call draw inside a world transform; view dimensions are CSS screen pixels. */
export function createDetailRenderer(world) {
  const metersPerUnit = world.metersPerUnit || 5;
  const cache = (features, group) => (features || []).map(feature => drCache(feature, group, metersPerUnit)).filter(Boolean);
  const roads = cache(world.roads, 'road');
  const buildings = cache(world.buildings, 'building');
  const details = cache(world.details, 'detail');
  const stats = { buildings: buildings.length, roads: roads.length, details: details.length, visibleBuildings: 0, visibleRoads: 0, visibleDetails: 0 };
  const fineRoads = new Set(['footway', 'path', 'track', 'cycleway', 'bridleway', 'steps']);
  const greenAreas = new Set(['park', 'garden', 'grass', 'playground', 'pitch', 'cemetery']);
  let lastZoom = 1;
  let focusPoint = null;

  function inView(record, view, margin = 12) {
    const halfWidth = view.width / (2 * view.zoom), halfHeight = view.height / (2 * view.zoom), b = record.bounds;
    return b.maxX >= view.cameraX - halfWidth - margin && b.minX <= view.cameraX + halfWidth + margin
      && b.maxY >= view.cameraY - halfHeight - margin && b.minY <= view.cameraY + halfHeight + margin;
  }

  function paintRoad(ctx, record, zoom) {
    const { feature: road, path } = record;
    const fine = fineRoads.has(road.type), minor = road.type === 'service' || road.type === 'residential' || road.type === 'unclassified';
    const width = Math.max(record.width, (fine ? .75 : 1.2) / zoom);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
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
    const kind = feature.kind, polygon = feature.geometry === 'polygon', point = feature.geometry === 'point';
    const highlighted = hoveredId === feature.id;
    if (polygon) {
      ctx.fillStyle = kind === 'pool' ? '#738f83' : greenAreas.has(kind) ? 'rgba(116,132,88,.38)' : kind === 'parking' ? 'rgba(140,135,107,.32)' : 'rgba(136,127,96,.22)';
      ctx.fill(path, 'evenodd'); ctx.strokeStyle = highlighted ? '#eceabb' : '#7c8060'; ctx.lineWidth = .7 / zoom; ctx.stroke(path);
      if (zoom >= 5 && kind === 'parking') {
        ctx.save(); ctx.translate(center.x, center.y); ctx.scale(1 / zoom, 1 / zoom);
        ctx.fillStyle = '#737956'; ctx.font = '600 11px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('P', 0, 4); ctx.restore();
      }
      return;
    }
    if (!point) {
      const rail = kind === 'railway', fence = ['fence', 'wall', 'retaining_wall', 'hedge'].includes(kind);
      ctx.strokeStyle = highlighted ? '#eceabb' : rail ? '#626e55' : kind === 'wall' ? '#667152' : '#7c7b58';
      ctx.lineWidth = Math.max((rail ? .8 : .32), .8 / zoom);
      if (fence && kind !== 'wall') ctx.setLineDash([Math.max(.5, 1 / zoom), Math.max(.7, 2 / zoom)]);
      ctx.stroke(path); ctx.setLineDash([]);
      if (rail && zoom >= 3) {
        ctx.lineWidth = Math.max(1.3, 2 / zoom); ctx.setLineDash([.2, 1.1]); ctx.stroke(path); ctx.setLineDash([]);
        ctx.strokeStyle = '#a4a07e'; ctx.lineWidth = .3; ctx.stroke(path);
      }
      return;
    }
    if (zoom < 2.2 && !highlighted) return;
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
    const visibleRoads = roads.filter(record => inView(record, view));
    const visibleBuildings = buildings.filter(record => inView(record, view));
    const visibleDetails = details.filter(record => inView(record, view));
    stats.visibleRoads = visibleRoads.length; stats.visibleBuildings = visibleBuildings.length; stats.visibleDetails = visibleDetails.length;
    ctx.save(); ctx.globalAlpha = 1;
    for (const record of visibleDetails) if (record.feature.geometry === 'polygon') paintDetail(ctx, record, view.zoom, view.hoveredId);
    for (const record of visibleRoads) paintRoad(ctx, record, view.zoom);
    for (const record of visibleDetails) if (record.feature.geometry !== 'polygon') paintDetail(ctx, record, view.zoom, view.hoveredId);
    for (const record of visibleBuildings) paintBuilding(ctx, record, view.zoom, view.hoveredId);
    paintRoadLabels(ctx, visibleRoads, view);
    ctx.restore();
  }

  function describe(record, point = record.center) {
    const feature = record.feature;
    return { id: feature.id, kind: record.group === 'building' ? feature.ruins ? 'ruins' : 'building' : record.group === 'road' ? 'road' : feature.kind,
      name: drFeatureLabel(feature, record.group), x: point.x, y: point.y, source: feature,
      description: record.group === 'building' ? [feature.address, drNames[feature.type], feature.levels ? `${feature.levels} эт.` : ''].filter(Boolean).join(' · ') : record.group === 'road' ? drNames[feature.type] || 'Дорога' : drNames[feature.kind] || 'Объект OpenStreetMap' };
  }

  function pick(x, y, tolerance = 3) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (let i = buildings.length - 1; i >= 0; i--) {
      const record = buildings[i], b = record.bounds;
      if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && drInPolygon(x, y, record.rings)) return describe(record);
    }
    if (lastZoom < 1.5) return null;
    for (let i = details.length - 1; i >= 0; i--) {
      const record = details[i], feature = record.feature;
      if (feature.geometry === 'polygon' && drInPolygon(x, y, record.rings)) return describe(record);
      if (feature.geometry === 'point' && Math.hypot(x - record.points[0].x, y - record.points[0].y) <= Math.max(tolerance, 1.8)) return describe(record, record.points[0]);
      if (feature.geometry === 'line') { const nearest = drNearestOnLine(x, y, record.points); if (nearest.distance <= tolerance) return describe(record, nearest); }
    }
    let closest = null, minimum = Infinity;
    for (const record of roads) {
      const b = record.bounds;
      if (x < b.minX - tolerance - record.width || x > b.maxX + tolerance + record.width || y < b.minY - tolerance - record.width || y > b.maxY + tolerance + record.width) continue;
      const point = drNearestOnLine(x, y, record.points);
      if (point.distance <= record.width / 2 + tolerance && point.distance < minimum) { closest = describe(record, point); minimum = point.distance; }
    }
    return closest;
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

  return { draw, pick, focus, getStats: () => ({ ...stats }) };
}
