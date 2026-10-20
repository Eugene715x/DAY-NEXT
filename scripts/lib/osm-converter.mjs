/** OpenStreetMap -> DAY NEXT. Geometry is projected from OSM, never invented. */
const METERS_PER_DEGREE = 6371008.8 * Math.PI / 180;
const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
const same = (a, b) => Math.abs(a.x - b.x) < 1e-7 && Math.abs(a.y - b.y) < 1e-7;
const safeTags = tags => Object.fromEntries(Object.entries(tags || {}).filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key)).map(([key, value]) => [key, clean(value)]));

export function validateBbox(value) {
  const bbox = Array.isArray(value) ? value.map(Number) : String(value).split(',').map(Number);
  if (bbox.length !== 4 || bbox.some(n => !Number.isFinite(n))) throw new Error('bbox must be west,south,east,north');
  const [west, south, east, north] = bbox;
  if (west < -180 || east > 180 || south < -85 || north > 85 || west >= east || south >= north) throw new Error('Invalid bbox: ordered longitude/latitude bounds between ±180° / ±85° required');
  const meterWidth = (east - west) * METERS_PER_DEGREE * Math.cos((north + south) / 2 * Math.PI / 180);
  const meterHeight = (north - south) * METERS_PER_DEGREE;
  if (meterWidth < 100 || meterHeight < 100 || meterWidth > 60000 || meterHeight > 60000 || meterWidth * meterHeight > 400_000_000) throw new Error('Choose a local area: at least 100 m per side, at most 400 km² and 60 km per side');
  return bbox;
}

export function createProjection(value, { maxSize = 3000, cellSize = 25 } = {}) {
  const bbox = validateBbox(value);
  if (!Number.isInteger(cellSize) || cellSize < 5 || cellSize > 100 || !Number.isInteger(maxSize) || maxSize < 100 || maxSize > 10000 || maxSize % cellSize) throw new Error('maxSize must be a cellSize multiple; cellSize must be 5..100');
  const [west, south, east, north] = bbox;
  const cosLat = Math.cos((north + south) / 2 * Math.PI / 180);
  const meterWidth = (east - west) * METERS_PER_DEGREE * cosLat;
  const meterHeight = (north - south) * METERS_PER_DEGREE;
  const metersPerUnit = Math.max(meterWidth, meterHeight) / maxSize;
  return { bbox, width: Math.ceil(meterWidth / metersPerUnit / cellSize) * cellSize, height: Math.ceil(meterHeight / metersPerUnit / cellSize) * cellSize, cellSize, metersPerUnit, meterWidth, meterHeight, cosLat };
}

export function projectPoint(lon, lat, projection) {
  return {
    x: (Number(lon) - projection.bbox[0]) * METERS_PER_DEGREE * projection.cosLat / projection.metersPerUnit,
    y: (projection.bbox[3] - Number(lat)) * METERS_PER_DEGREE / projection.metersPerUnit,
  };
}

function decodeXML(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()];
  });
}
function attributes(source) {
  const result = Object.create(null);
  for (const match of source.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (!['__proto__', 'constructor', 'prototype'].includes(match[1])) result[match[1]] = decodeXML(match[2] ?? match[3]);
  }
  return result;
}

export function parseOSM(input) {
  if (input && typeof input === 'object' && !ArrayBuffer.isView(input)) {
    if (!Array.isArray(input.elements)) throw new Error('OSM JSON must contain an elements array (Overpass format)');
    return { ...input, elements: input.elements.map(element => ({ ...element, tags: safeTags(element.tags) })) };
  }
  const text = String(input).trim();
  if (text.startsWith('{')) {
    try { return parseOSM(JSON.parse(text)); } catch (error) { throw new Error(`Invalid OSM JSON: ${error.message}`); }
  }
  if (!/<osm\b/.test(text)) throw new Error('Expected Overpass JSON or an OSM XML document');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('XML entity declarations and DTDs are not supported');
  const elements = [];
  for (const match of text.matchAll(/<(node|way|relation)\b([^>]*?)(?:\s*\/>|>([\s\S]*?)<\/\1\s*>)/g)) {
    const type = match[1], a = attributes(match[2]), body = match[3] || '';
    if (!a.id) continue;
    const element = { type, id: a.id, tags: Object.create(null) };
    if (a.timestamp) element.timestamp = a.timestamp;
    if (a.lat !== undefined && a.lon !== undefined) { element.lat = Number(a.lat); element.lon = Number(a.lon); }
    for (const tag of body.matchAll(/<tag\b([^>]*?)\/?\s*>/g)) {
      const { k, v } = attributes(tag[1]);
      if (k && v !== undefined && !['__proto__', 'constructor', 'prototype'].includes(k)) element.tags[k] = clean(v);
    }
    if (type === 'way') element.nodes = [...body.matchAll(/<nd\b([^>]*?)\/?\s*>/g)].map(tag => attributes(tag[1]).ref).filter(Boolean);
    if (type === 'relation') element.members = [...body.matchAll(/<member\b([^>]*?)\/?\s*>/g)].map(tag => {
      const member = attributes(tag[1]);
      return { type: member.type, ref: member.ref, role: member.role || '' };
    });
    elements.push(element);
  }
  if (!elements.length) throw new Error('OSM input has no supported elements');
  return { version: 0.6, generator: 'OSM XML', elements };
}

function inBounds(p, width, height) { return p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height; }
function clipSegment(a, b, width, height) {
  const dx = b.x - a.x, dy = b.y - a.y;
  let low = 0, high = 1;
  const p = [-dx, dx, -dy, dy], q = [a.x, width - a.x, a.y, height - a.y];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-12) { if (q[i] < 0) return null; }
    else {
      const t = q[i] / p[i];
      if (p[i] < 0) low = Math.max(low, t); else high = Math.min(high, t);
      if (low > high) return null;
    }
  }
  const round = n => Math.round(n * 1000) / 1000;
  return [{ x: round(a.x + low * dx), y: round(a.y + low * dy) }, { x: round(a.x + high * dx), y: round(a.y + high * dy) }];
}
function clipLine(points, width, height) {
  const parts = []; let current = [];
  for (let i = 1; i < points.length; i++) {
    const segment = clipSegment(points[i - 1], points[i], width, height);
    if (!segment) { if (current.length > 1) parts.push(current); current = []; continue; }
    if (current.length && same(current.at(-1), segment[0])) current.push(segment[1]);
    else { if (current.length > 1) parts.push(current); current = segment; }
  }
  if (current.length > 1) parts.push(current);
  return parts;
}
function clipRing(points, width, height) {
  let ring = [...points]; if (ring.length > 1 && same(ring[0], ring.at(-1))) ring.pop();
  for (const [axis, bound, minimum] of [['x', 0, true], ['x', width, false], ['y', 0, true], ['y', height, false]]) {
    const input = ring; ring = [];
    const inside = p => minimum ? p[axis] >= bound : p[axis] <= bound;
    for (let i = 0; i < input.length; i++) {
      const a = input[i], b = input[(i + 1) % input.length], ia = inside(a), ib = inside(b);
      if (ia) ring.push(a);
      if (ia !== ib) {
        const t = (bound - a[axis]) / (b[axis] - a[axis]);
        ring.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
  }
  if (ring.length < 3) return null;
  ring = ring.map(p => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }));
  ring.push({ ...ring[0] });
  return Math.abs(polygonArea(ring)) > .1 ? ring : null;
}
function polygonArea(ring) {
  let area = 0;
  for (let i = 1; i < ring.length; i++) area += ring[i - 1].x * ring[i].y - ring[i].x * ring[i - 1].y;
  return area / 2;
}
function insideRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function joinRings(fragments) {
  const remaining = fragments.filter(points => points.length >= 2).map(points => [...points]);
  const rings = [];
  while (remaining.length) {
    const ring = remaining.shift();
    for (;;) {
      if (same(ring[0], ring.at(-1))) { if (ring.length >= 4) rings.push(ring); break; }
      const index = remaining.findIndex(points => same(ring.at(-1), points[0]) || same(ring.at(-1), points.at(-1)) || same(ring[0], points[0]) || same(ring[0], points.at(-1)));
      if (index === -1) break;
      let next = remaining.splice(index, 1)[0];
      if (same(ring.at(-1), next.at(-1)) || same(ring[0], next[0])) next.reverse();
      if (same(ring.at(-1), next[0])) ring.push(...next.slice(1)); else ring.unshift(...next.slice(0, -1));
    }
  }
  return rings;
}
function areaType(tags) {
  if (tags.natural === 'water' || ['reservoir', 'basin'].includes(tags.landuse) || tags.waterway === 'riverbank' || tags.water) return 'water';
  if (tags.natural === 'wetland' || tags.wetland) return 'swamp';
  if (tags.natural === 'wood' || tags.landuse === 'forest') return 'forest';
  if (['grassland', 'heath', 'scrub'].includes(tags.natural) || ['meadow', 'grass', 'farmland', 'orchard', 'recreation_ground'].includes(tags.landuse)) return 'plain';
  return null;
}
function isSeasonal(tags) { return !!tags.seasonal && !['no', 'false', '0'].includes(tags.seasonal); }
function isIntermittent(tags) { return (!!tags.intermittent && !['no', 'false', '0'].includes(tags.intermittent)) || isSeasonal(tags); }
function centroid(points) {
  const real = points.length > 1 && same(points[0], points.at(-1)) ? points.slice(0, -1) : points;
  return real.reduce((sum, p) => ({ x: sum.x + p.x / real.length, y: sum.y + p.y / real.length }), { x: 0, y: 0 });
}
function poiKind(tags) {
  if (['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood'].includes(tags.place)) return 'town';
  if (['station', 'halt'].includes(tags.railway)) return 'station';
  if (tags.amenity === 'shelter' || ['camp_site', 'caravan_site'].includes(tags.tourism)) return 'camp';
  if (['hospital', 'clinic', 'doctors', 'pharmacy'].includes(tags.amenity)) return 'hospital';
  if (tags.amenity === 'fuel') return 'gas';
  if (tags.man_made === 'tower' || tags.man_made === 'communications_tower') return 'tower';
  if (tags.historic === 'ruins' || tags.building === 'ruins') return 'ruin';
  if (['police', 'fire_station', 'school', 'library', 'community_centre', 'townhall'].includes(tags.amenity)) return 'station';
  if (['museum', 'viewpoint', 'attraction', 'picnic_site'].includes(tags.tourism)) return 'ruin';
  if (['convenience', 'supermarket', 'hardware', 'outdoor'].includes(tags.shop)) return 'town';
  return null;
}
const fallbackNames = { town: 'Поселение / магазин', station: 'Общественное здание', camp: 'Укрытие', hospital: 'Медпункт', gas: 'Заправка', tower: 'Башня', ruin: 'Достопримечательность' };

export function convertOSM(input, options = {}) {
  const parsed = parseOSM(input);
  const projection = createProjection(options.bbox, options);
  const { width, height, cellSize, metersPerUnit } = projection;
  const boundWidth = projection.meterWidth / metersPerUnit, boundHeight = projection.meterHeight / metersPerUnit;
  const elements = parsed.elements;
  const nodes = new Map(elements.filter(e => e.type === 'node').map(e => [String(e.id), e]));
  const ways = new Map(elements.filter(e => e.type === 'way').map(e => [String(e.id), e]));
  const project = p => projectPoint(p.lon, p.lat, projection);
  const geometry = element => {
    const points = element.geometry || (element.nodes || []).map(id => nodes.get(String(id)));
    if (points.some(p => !p || !Number.isFinite(Number(p.lon)) || !Number.isFinite(Number(p.lat)))) return [];
    return points.map(project);
  };
  const roads = [], rivers = [], areas = [], buildings = [], pois = [], labels = [];
  const relationMembers = new Set();
  const addPoi = (element, point) => {
    const tags = element.tags || {}, kind = poiKind(tags);
    if (!point || !inBounds(point, boundWidth, boundHeight)) return;
    if (tags.place && tags.name) labels.push({ name: clean(tags.name), x: point.x, y: point.y, kind: tags.place });
    if (!kind) return;
    const id = `${element.type}-${element.id}`;
    const name = clean(tags.name || `${fallbackNames[kind]} · OSM ${element.id}`);
    pois.push({ id, name, x: point.x, y: point.y, kind, description: `Реальный объект OpenStreetMap: ${clean(tags.amenity || tags.place || tags.railway || tags.tourism || tags.shop || tags.man_made || tags.historic || tags.building || kind)}.`, discovered: false, named: !!tags.name });
  };
  for (const relation of elements.filter(e => e.type === 'relation' && ['multipolygon', 'boundary'].includes(e.tags?.type))) {
    const type = areaType(relation.tags), isBuilding = relation.tags.building && relation.tags.building !== 'no';
    if (!type && !isBuilding) continue;
    const outers = [], inners = [];
    for (const member of relation.members || []) {
      if (member.type !== 'way') continue;
      const way = ways.get(String(member.ref));
      const points = member.geometry ? geometry(member) : way ? geometry(way) : [];
      if (points.length < 2) continue;
      (member.role === 'inner' ? inners : outers).push(points);
    }
    const outerRings = joinRings(outers), innerRings = joinRings(inners);
    if (!outerRings.length) continue;
    for (const member of relation.members || []) if (member.type === 'way') relationMembers.add(String(member.ref));
    let index = 0;
    for (const outer of outerRings) {
      const ring = clipRing(outer, boundWidth, boundHeight);
      if (!ring) continue;
      const rings = [ring, ...innerRings.filter(hole => insideRing(hole[0], outer)).map(hole => clipRing(hole, boundWidth, boundHeight)).filter(Boolean)];
      const id = `relation-${relation.id}-${index++}`, name = clean(relation.tags.name || '');
      if (type) areas.push({ id, type, rings, name, intermittent: isIntermittent(relation.tags), seasonal: isSeasonal(relation.tags) });
      if (isBuilding) buildings.push({ id, points: ring, name });
      addPoi(relation, centroid(ring));
    }
  }
  for (const way of ways.values()) {
    const tags = way.tags || {}, points = geometry(way);
    if (points.length < 2) continue;
    const id = `way-${way.id}`, closed = points.length >= 4 && same(points[0], points.at(-1));
    const name = clean(tags.name || '');
    if (tags.highway && !['proposed', 'construction', 'platform'].includes(tags.highway) && tags.area !== 'yes') {
      const widthMeters = Math.max(1, Math.min(60, Number.parseFloat(tags.width) || (['motorway', 'trunk', 'primary'].includes(tags.highway) ? 12 : ['footway', 'path', 'cycleway', 'steps'].includes(tags.highway) ? 2 : 6)));
      const bridge = !!tags.bridge && !['no', 'false', '0'].includes(tags.bridge);
      const tunnel = !!tags.tunnel && !['no', 'false', '0'].includes(tags.tunnel);
      clipLine(points, boundWidth, boundHeight).forEach((part, i) => roads.push({ id: `${id}-${i}`, points: part, width: Math.max(2, widthMeters / metersPerUnit), type: tags.highway, bridge, tunnel, name }));
    }
    if (['river', 'stream', 'canal', 'drain', 'ditch'].includes(tags.waterway) && !closed) {
      const widthMeters = Math.max(1, Math.min(300, Number.parseFloat(tags.width) || (tags.waterway === 'river' ? 25 : tags.waterway === 'canal' ? 12 : 3)));
      clipLine(points, boundWidth, boundHeight).forEach((part, i) => rivers.push({ id: `${id}-${i}`, points: part, width: Math.max(2, widthMeters / metersPerUnit), name, intermittent: isIntermittent(tags), seasonal: isSeasonal(tags) }));
    }
    if (closed && !relationMembers.has(String(way.id))) {
      const ring = clipRing(points, boundWidth, boundHeight);
      if (ring) {
        const type = areaType(tags);
        if (type) areas.push({ id, type, rings: [ring], name, intermittent: isIntermittent(tags), seasonal: isSeasonal(tags) });
        if (tags.building && tags.building !== 'no') buildings.push({ id, points: ring, name });
        addPoi(way, centroid(ring));
      }
    }
  }
  for (const node of nodes.values()) if (Number.isFinite(Number(node.lon)) && Number.isFinite(Number(node.lat))) addPoi(node, project(node));
  if (!roads.length && !rivers.length && !areas.length && !buildings.length) throw new Error('The selected bbox has no usable mapped geometry. Check the bounds and complete OSM data.');
  // Named objects take priority so the map is readable rather than a wall of anonymous shops.
  pois.sort((a, b) => Number(b.named) - Number(a.named) || Number(b.kind === 'town') - Number(a.kind === 'town') || a.id.localeCompare(b.id));
  const distinctPois = [];
  for (const poi of pois) if (!distinctPois.some(other => other.name === poi.name && Math.hypot(other.x - poi.x, other.y - poi.y) < 35)) {
    delete poi.named; distinctPois.push(poi); if (distinctPois.length >= 120) break;
  }
  const center = { x: width / 2, y: height / 2 };
  const town = distinctPois.filter(poi => poi.kind === 'town').sort((a, b) => Math.hypot(a.x - center.x, a.y - center.y) - Math.hypot(b.x - center.x, b.y - center.y))[0];
  const preferred = town || center;
  let start = { ...center }, closest = Infinity;
  for (const road of roads.filter(road => !road.bridge && !road.tunnel)) for (const point of road.points) {
    if (point.x < cellSize || point.y < cellSize || point.x > width - cellSize || point.y > height - cellSize) continue;
    const distance = Math.hypot(point.x - preferred.x, point.y - preferred.y);
    if (distance < closest) { closest = distance; start = { ...point }; }
  }
  return {
    version: 1,
    id: clean(options.id || 'osm-region').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80),
    name: clean(options.name || 'Реальная местность'),
    region: clean(options.region || ''), country: clean(options.country || ''),
    bbox: projection.bbox, width, height, cellSize, metersPerUnit,
    source: {
      provider: 'OpenStreetMap', copyright: '© OpenStreetMap contributors', license: 'ODbL-1.0',
      url: 'https://www.openstreetmap.org/copyright',
      dataUrl: clean(options.dataUrl || 'https://www.openstreetmap.org'),
      downloadedAt: options.downloadedAt || new Date().toISOString(),
      snapshotAt: options.snapshotAt || parsed.osm3s?.timestamp_osm_base || elements.map(element => element.timestamp).filter(Boolean).sort().at(-1) || null,
    },
    roads, rivers, areas, buildings, pois: distinctPois, labels, start,
    statistics: { inputElements: elements.length, roads: roads.length, rivers: rivers.length, areas: areas.length, buildings: buildings.length, pois: distinctPois.length },
  };
}
