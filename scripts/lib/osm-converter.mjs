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

function lengthMeters(value) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  const feetAndInches = text.match(/^(\d+(?:\.\d+)?)\s*'\s*(\d+(?:\.\d+)?)?\s*(?:"|in)?$/);
  if (feetAndInches) return Number(feetAndInches[1]) * .3048 + Number(feetAndInches[2] || 0) * .0254;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(m|metres?|meters?|ft|feet)?$/i);
  if (!match) return undefined;
  return Number(match[1]) * (/^(ft|feet)$/i.test(match[2] || '') ? .3048 : 1);
}

function buildingMetadata(tags) {
  const metadata = { type: clean(tags.building), tags: safeTags(tags) };
  if (tags.building === 'ruins' || tags.historic === 'ruins' || tags.ruins && !['no', 'false', '0'].includes(tags.ruins)) metadata.ruins = true;
  if (tags['roof:shape']) metadata.roofShape = clean(tags['roof:shape']);
  if (tags['building:material'] || tags.material) metadata.material = clean(tags['building:material'] || tags.material);
  if (tags['roof:material']) metadata.roofMaterial = clean(tags['roof:material']);
  const levels = Number(tags['building:levels']);
  if (tags['building:levels'] !== undefined && Number.isFinite(levels) && levels >= 0) metadata.levels = levels;
  const height = lengthMeters(tags.height ?? tags['building:height']);
  if (height !== undefined) metadata.heightMeters = height;
  const address = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:city'], tags['addr:postcode'],
  ].filter(Boolean).join(', ');
  if (address) metadata.address = clean(address);
  return metadata;
}

/** Mapped objects retain their source geometry; point ruins never acquire invented footprints. */
function detailKind(tags) {
  if (tags.barrier && !['no', 'false', '0'].includes(tags.barrier)) return clean(tags.barrier);
  if (tags.railway && !['proposed', 'construction', 'no'].includes(tags.railway)) return 'railway';
  if (tags.amenity === 'parking' || tags.amenity === 'parking_space') return tags.amenity;
  if (tags.leisure === 'swimming_pool' || tags.amenity === 'swimming_pool') return 'pool';
  if (['pitch', 'garden', 'park', 'playground', 'recreation_ground', 'picnic_table'].includes(tags.leisure)) return tags.leisure;
  if (tags.natural === 'tree' || tags.natural === 'tree_row' || tags.natural === 'spring') return tags.natural;
  if (['bench', 'fountain', 'drinking_water', 'shelter', 'toilets'].includes(tags.amenity)) return tags.amenity;
  if (tags.man_made === 'water_well') return 'well';
  if (tags.tourism === 'picnic_site' || tags.tourism === 'information') return tags.tourism;
  if (tags.historic === 'ruins' || tags.ruins && !['no', 'false', '0'].includes(tags.ruins)) return 'ruins';
  if (tags.landuse === 'cemetery' || tags.amenity === 'grave_yard') return 'cemetery';
  if (tags.landuse === 'quarry') return 'quarry';
  if (tags.highway === 'street_lamp') return 'lamp';
  return null;
}

// OSM objects outside the styled subset still retain their geometry and tags.
// Import bookkeeping and untagged shape vertices do not become game objects.
function meaningfulTags(tags = {}) {
  return Object.keys(tags).filter(key => !/^(?:source(?::|$)|tiger:|gnis:|created_by$|attribution$|note$|fixme$|FIXME$|odbl$|import_uuid$|type$|is_in(?::|$))/.test(key));
}
function genericKind(tags) {
  const known = detailKind(tags);
  if (known) return known;
  if (tags.boundary) return 'boundary';
  for (const key of ['aeroway', 'boundary', 'highway', 'railway', 'landuse', 'natural', 'amenity', 'tourism', 'shop', 'man_made', 'historic', 'leisure', 'power', 'public_transport', 'place']) {
    if (tags[key] && !['no', 'false', '0'].includes(tags[key])) return clean(tags[key]);
  }
  return meaningfulTags(tags).some(key => key.startsWith('addr:')) ? 'address' : 'mapped_feature';
}
function polygonSemantics(tags) {
  if (tags.area === 'no') return false;
  if (tags.area === 'yes') return true;
  if (tags.barrier || tags.boundary || tags.highway) return false;
  if (tags.waterway) return tags.waterway === 'riverbank';
  if (tags.aeroway) return !['runway', 'taxiway', 'navigationaid'].includes(tags.aeroway);
  if (tags.railway) return ['station', 'platform', 'turntable', 'roundhouse'].includes(tags.railway);
  if (['cliff', 'coastline', 'ridge', 'arete', 'tree_row'].includes(tags.natural)) return false;
  if (['pier', 'breakwater', 'pipeline', 'embankment', 'cutline'].includes(tags.man_made)) return false;
  return Boolean(tags.building && tags.building !== 'no' || tags.landuse || tags.natural || tags.amenity || tags.leisure || tags.shop || tags.tourism || tags.man_made || tags.historic);
}
const originalId = id => String(id).match(/^(?:node|way|relation)-\d+/)?.[0] || String(id);

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
  const geometryParts = element => {
    const source = element.geometry || (element.nodes || []).map(id => nodes.get(String(id)));
    const parts = []; let part = [];
    for (const point of source) {
      if (point && Number.isFinite(Number(point.lon)) && Number.isFinite(Number(point.lat))) part.push(project(point));
      else { if (part.length > 1) parts.push(part); part = []; }
    }
    if (part.length > 1) parts.push(part);
    return parts;
  };
  const roads = [], rivers = [], areas = [], buildings = [], details = [], pois = [], labels = [], relations = [];
  const relationMembers = new Set();
  const addPoi = (element, point) => {
    const tags = element.tags || {}, kind = poiKind(tags);
    if (!point || !inBounds(point, boundWidth, boundHeight)) return;
    if (tags.place && tags.name) labels.push({ name: clean(tags.name), x: point.x, y: point.y, kind: tags.place });
    if (!kind) return;
    const id = `${element.type}-${element.id}`;
    const name = clean(tags.name || `${fallbackNames[kind]} · OSM ${element.id}`);
    pois.push({ id, name, x: point.x, y: point.y, kind, tags: safeTags(tags), description: `Реальный объект OpenStreetMap: ${clean(tags.amenity || tags.place || tags.railway || tags.tourism || tags.shop || tags.man_made || tags.historic || tags.building || kind)}.`, discovered: false, named: !!tags.name });
  };
  for (const relation of elements.filter(e => e.type === 'relation' && ['multipolygon', 'boundary'].includes(e.tags?.type))) {
    const type = areaType(relation.tags), isBuilding = relation.tags.building && relation.tags.building !== 'no', detail = detailKind(relation.tags) || (meaningfulTags(relation.tags).length && polygonSemantics(relation.tags) ? genericKind(relation.tags) : null);
    if (!type && !isBuilding && !detail) continue;
    const outers = [], inners = [];
    for (const member of relation.members || []) {
      if (member.type !== 'way') continue;
      const way = ways.get(String(member.ref));
      const memberPoints = member.geometry ? geometry(member) : [];
      const points = memberPoints.length ? memberPoints : way ? geometry(way) : [];
      if (points.length < 2) continue;
      (member.role === 'inner' ? inners : outers).push(points);
    }
    const outerRings = joinRings(outers), innerRings = joinRings(inners);
    if (!outerRings.length) continue;
    let index = 0;
    for (const outer of outerRings) {
      const ring = clipRing(outer, boundWidth, boundHeight);
      if (!ring) continue;
      const rings = [ring, ...innerRings.filter(hole => insideRing(hole[0], outer)).map(hole => clipRing(hole, boundWidth, boundHeight)).filter(Boolean)];
      const id = `relation-${relation.id}-${index++}`, name = clean(relation.tags.name || '');
      const geometryIncomplete = (relation.members || []).some(member => member.type === 'way' && geometry(member).length < 2 && (!ways.has(String(member.ref)) || geometry(ways.get(String(member.ref))).length < 2));
      for (const member of relation.members || []) if (member.type === 'way') relationMembers.add(String(member.ref));
      if (type) areas.push({ id, type, rings, name, tags: safeTags(relation.tags), intermittent: isIntermittent(relation.tags), seasonal: isSeasonal(relation.tags) });
      if (isBuilding) buildings.push({ id, points: ring, rings, name, ...buildingMetadata(relation.tags) });
      if (detail && !isBuilding) details.push({ id, kind: detail, geometry: 'polygon', points: ring, rings, name, tags: safeTags(relation.tags), ...(geometryIncomplete ? { geometryIncomplete: true } : {}) });
      addPoi(relation, centroid(ring));
    }
  }
  for (const way of ways.values()) {
    const tags = way.tags || {}, points = geometry(way);
    if (points.length < 2) continue;
    const id = `way-${way.id}`, closed = points.length >= 4 && same(points[0], points.at(-1));
    const name = clean(tags.name || '');
    if (tags.highway && !['proposed', 'construction', 'platform'].includes(tags.highway) && tags.area !== 'yes') {
      const taggedWidth = lengthMeters(tags.width);
      const widthMeters = Math.max(1, Math.min(60, taggedWidth || (['motorway', 'trunk', 'primary'].includes(tags.highway) ? 12 : ['footway', 'path', 'cycleway', 'steps'].includes(tags.highway) ? 2 : 6)));
      const bridge = !!tags.bridge && !['no', 'false', '0'].includes(tags.bridge);
      const tunnel = !!tags.tunnel && !['no', 'false', '0'].includes(tags.tunnel);
      const metadata = { widthMeters, widthSource: taggedWidth ? 'tag' : 'highway-default' };
      for (const key of ['surface', 'access', 'tracktype', 'foot', 'service']) if (tags[key]) metadata[key] = clean(tags[key]);
      clipLine(points, boundWidth, boundHeight).forEach((part, i) => roads.push({ id: `${id}-${i}`, points: part, width: Math.max(2, widthMeters / metersPerUnit), type: tags.highway, bridge, tunnel, name, tags: safeTags(tags), ...metadata }));
    }
    if (['river', 'stream', 'canal', 'drain', 'ditch'].includes(tags.waterway) && !closed) {
      const widthMeters = Math.max(1, Math.min(300, Number.parseFloat(tags.width) || (tags.waterway === 'river' ? 25 : tags.waterway === 'canal' ? 12 : 3)));
      clipLine(points, boundWidth, boundHeight).forEach((part, i) => rivers.push({ id: `${id}-${i}`, points: part, width: Math.max(2, widthMeters / metersPerUnit), name, tags: safeTags(tags), intermittent: isIntermittent(tags), seasonal: isSeasonal(tags) }));
    }
    if (closed && !relationMembers.has(String(way.id))) {
      const ring = clipRing(points, boundWidth, boundHeight);
      if (ring) {
        const type = areaType(tags);
        if (type) areas.push({ id, type, rings: [ring], name, tags: safeTags(tags), intermittent: isIntermittent(tags), seasonal: isSeasonal(tags) });
        if (tags.building && tags.building !== 'no') buildings.push({ id, points: ring, rings: [ring], name, ...buildingMetadata(tags) });
        const detail = detailKind(tags);
        if (detail && !(tags.building && tags.building !== 'no')) {
          if (polygonSemantics(tags)) details.push({ id, kind: detail, geometry: 'polygon', points: ring, rings: [ring], name, tags: safeTags(tags) });
          else clipLine(points, boundWidth, boundHeight).forEach((part, i) => details.push({ id: `${id}-${i}`, kind: detail, geometry: 'line', points: part, name, tags: safeTags(tags) }));
        }
        addPoi(way, centroid(ring));
      }
    } else if (!closed && !relationMembers.has(String(way.id))) {
      const detail = detailKind(tags);
      if (detail) clipLine(points, boundWidth, boundHeight).forEach((part, i) => details.push({ id: `${id}-${i}`, kind: detail, geometry: 'line', points: part, name, tags: safeTags(tags) }));
    }
  }
  for (const node of nodes.values()) if (Number.isFinite(Number(node.lon)) && Number.isFinite(Number(node.lat))) {
    const point = project(node); addPoi(node, point);
    const kind = detailKind(node.tags || {});
    if (kind && inBounds(point, boundWidth, boundHeight)) details.push({ id: `node-${node.id}`, kind, geometry: 'point', points: [point], name: clean(node.tags?.name || ''), tags: safeTags(node.tags) });
  }

  const represented = new Set([...roads, ...rivers, ...areas, ...buildings, ...details].map(feature => originalId(feature.id)).filter(Boolean));
  const coverage = {
    inputElements: elements.length,
    sourceTaggedElements: 0,
    eligibleInBounds: 0,
    representedSourceElements: 0,
    representedByRelation: 0,
    metadataOnlyElements: 0,
    partialRelations: [],
    partialWays: [],
    omittedByReason: { outsideBounds: [], incompleteGeometry: [], invalidCoordinate: [] },
  };
  const bySource = new Map(elements.map(element => [`${element.type}-${element.id}`, element]));
  const markGeneric = (element, points, suffix = '', incomplete = false) => {
    const tags = element.tags || {}, name = clean(tags.name || ''), sourceId = `${element.type}-${element.id}`;
    if (points.length === 1) {
      if (!inBounds(points[0], boundWidth, boundHeight)) return false;
      details.push({ id: `${sourceId}${suffix}`, sourceId, kind: genericKind(tags), geometry: 'point', points, name, tags: safeTags(tags), ...(incomplete ? { geometryIncomplete: true } : {}) });
      represented.add(sourceId); return true;
    }
    const closed = points.length >= 4 && same(points[0], points.at(-1));
    if (closed && polygonSemantics(tags) && !incomplete) {
      const ring = clipRing(points, boundWidth, boundHeight);
      if (!ring) return false;
      details.push({ id: `${sourceId}${suffix}`, sourceId, kind: genericKind(tags), geometry: 'polygon', points: ring, rings: [ring], name, tags: safeTags(tags) });
      represented.add(sourceId); return true;
    }
    const parts = clipLine(points, boundWidth, boundHeight);
    parts.forEach((part, i) => details.push({ id: `${sourceId}${suffix}-${i}`, sourceId, kind: genericKind(tags), geometry: 'line', points: part, name, tags: safeTags(tags), ...(incomplete ? { geometryIncomplete: true } : {}) }));
    if (parts.length) represented.add(sourceId);
    return parts.length > 0;
  };
  // Preserve unstyled but meaningful points and ways, rather than silently filtering a whitelist.
  for (const element of elements.filter(element => element.type !== 'relation')) {
    const sourceId = `${element.type}-${element.id}`, tags = element.tags || {};
    if (!meaningfulTags(tags).length) { coverage.metadataOnlyElements++; continue; }
    coverage.sourceTaggedElements++;
    if (represented.has(sourceId)) { coverage.eligibleInBounds++; continue; }
    if (element.type === 'way' && relationMembers.has(String(element.id))) { coverage.representedByRelation++; continue; }
    const points = element.type === 'node' ? Number.isFinite(Number(element.lon)) && Number.isFinite(Number(element.lat)) ? [project(element)] : [] : geometry(element);
    if (!points.length) {
      const parts = element.type === 'way' ? geometryParts(element) : [];
      let included = false;
      for (let i = 0; i < parts.length; i++) included = markGeneric(element, parts[i], `-fragment-${i}`, true) || included;
      if (included) { coverage.eligibleInBounds++; coverage.partialWays.push(sourceId); }
      else coverage.omittedByReason[element.type === 'node' ? 'invalidCoordinate' : 'incompleteGeometry'].push(sourceId);
      continue;
    }
    if (markGeneric(element, points)) coverage.eligibleInBounds++;
    else coverage.omittedByReason.outsideBounds.push(sourceId);
  }
  // A route relation is a logical grouping of existing roads, never a second painted road.
  // Incomplete area/boundary relations retain available source fragments; no fake polygon is closed.
  for (const relation of elements.filter(element => element.type === 'relation')) {
    const sourceId = `relation-${relation.id}`, tags = relation.tags || {};
    if (!meaningfulTags(tags).length) { coverage.metadataOnlyElements++; continue; }
    coverage.sourceTaggedElements++;
    const availableMemberIds = [], missingMemberIds = [], incompleteMemberIds = [], fragments = [];
    for (const member of relation.members || []) {
      const memberId = `${member.type}-${member.ref}`, source = bySource.get(memberId);
      const memberParts = member.geometry ? geometryParts(member) : [];
      if (memberParts.length || source) availableMemberIds.push(memberId); else missingMemberIds.push(memberId);
      if (member.type === 'way') {
        const full = member.geometry ? geometry(member) : [];
        const sourcePoints = source ? geometry(source) : [];
        if (full.length >= 2 || sourcePoints.length >= 2) fragments.push({ points: full.length ? full : sourcePoints, member });
        else {
          if (memberParts.length || source) incompleteMemberIds.push(memberId);
          for (const points of memberParts) fragments.push({ points, member });
        }
      }
    }
    const record = { id: sourceId, name: clean(tags.name || ''), tags: safeTags(tags), members: (relation.members || []).map(member => ({ ...member, ...(member.geometry ? { geometry: member.geometry.map(point => point ? { ...point } : null) } : {}) })), availableMemberIds, missingMemberIds, incompleteMemberIds, geometryComplete: missingMemberIds.length === 0 && incompleteMemberIds.length === 0 };
    relations.push(record);
    if (missingMemberIds.length || incompleteMemberIds.length) coverage.partialRelations.push({ id: sourceId, available: availableMemberIds.length, missing: missingMemberIds.length, incomplete: incompleteMemberIds.length });
    if (represented.has(sourceId)) { coverage.eligibleInBounds++; continue; }
    if (tags.type === 'route' || tags.type === 'superroute') {
      if (availableMemberIds.some(memberId => represented.has(memberId))) { represented.add(sourceId); coverage.eligibleInBounds++; }
      else coverage.omittedByReason.incompleteGeometry.push(sourceId);
      continue;
    }
    if (!fragments.length) { coverage.omittedByReason.incompleteGeometry.push(sourceId); continue; }
    let included = false;
    for (let i = 0; i < fragments.length; i++) {
      const memberId = `${fragments[i].member.type}-${fragments[i].member.ref}`;
      if (tags.boundary && represented.has(memberId)) {
        for (const feature of details.filter(feature => (feature.sourceId || originalId(feature.id)) === memberId)) {
          feature.relationIds = [...new Set([...(feature.relationIds || []), sourceId])];
          if (!feature.name && tags.name) feature.name = clean(tags.name);
        }
        represented.add(sourceId); included = true;
      } else included = markGeneric(relation, fragments[i].points, `-member-${i}`, true) || included;
    }
    if (included) coverage.eligibleInBounds++;
    else coverage.omittedByReason.outsideBounds.push(sourceId);
  }
  for (let pass = 0; pass < relations.length; pass++) {
    let changed = false;
    for (const relation of relations) if (['route', 'superroute'].includes(relation.tags.type) && !represented.has(relation.id) && relation.availableMemberIds.some(memberId => represented.has(memberId))) {
      represented.add(relation.id); coverage.eligibleInBounds++; changed = true;
      coverage.omittedByReason.incompleteGeometry = coverage.omittedByReason.incompleteGeometry.filter(id => id !== relation.id);
    }
    if (!changed) break;
  }
  for (const feature of [...roads, ...rivers, ...areas, ...buildings, ...details, ...pois]) feature.sourceId ||= originalId(feature.id);
  coverage.representedSourceElements = represented.size;
  coverage.omittedCounts = Object.fromEntries(Object.entries(coverage.omittedByReason).map(([reason, ids]) => [reason, ids.length]));
  if (!roads.length && !rivers.length && !areas.length && !buildings.length && !details.length) throw new Error('The selected bbox has no usable mapped geometry. Check the bounds and complete OSM data.');
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
    roads, rivers, areas, buildings, details, relations, coverage, pois: distinctPois, labels, start,
    statistics: { inputElements: elements.length, roads: roads.length, rivers: rivers.length, areas: areas.length, buildings: buildings.length, details: details.length, pois: distinctPois.length },
  };
}
