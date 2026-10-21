// Derived display geometry only. Navigation and the original OSM features stay intact.
export const ROAD_CLASSES = Object.freeze(Object.fromEntries([
  ['highway', 'Магистраль', 'Магистрали'],
  ['road', 'Дорога', 'Дороги'],
  ['street', 'Улица и проезд', 'Улицы и проезды'],
  ['track', 'Грунтовка', 'Грунтовки'],
  ['trail', 'Тропа', 'Тропы'],
  ['railway', 'Железная дорога', 'Железные дороги'],
].map(([id, name, pluralName]) => [id, Object.freeze({ id, name, label: name, pluralName })])));

const ROAD_TYPES = Object.freeze({
  motorway: 'highway', motorway_link: 'highway', trunk: 'highway', trunk_link: 'highway', primary: 'highway', primary_link: 'highway',
  secondary: 'road', secondary_link: 'road', tertiary: 'road', tertiary_link: 'road', road: 'road', construction: 'road',
  residential: 'street', unclassified: 'street', service: 'street', living_street: 'street',
  track: 'track',
  footway: 'trail', path: 'trail', cycleway: 'trail', bridleway: 'trail', steps: 'trail', pedestrian: 'trail',
});

export function roadClass(feature) {
  if (typeof feature !== 'string' && Object.hasOwn(ROAD_CLASSES, feature?.roadClass)) return feature.roadClass;
  const highway = typeof feature === 'string' ? feature : feature?.tags?.highway || feature?.tags?.['area:highway'];
  if (!highway && (feature?.tags?.railway || feature?.kind === 'railway')) return 'railway';
  const type = highway || feature?.sourceType || feature?.type;
  if (['rail', 'light_rail', 'narrow_gauge', 'tram', 'subway', 'monorail', 'funicular', 'abandoned', 'disused', 'dismantled', 'razed'].includes(type)) return 'railway';
  return Object.hasOwn(ROAD_TYPES, type) ? ROAD_TYPES[type] : 'street';
}

const clone = value => {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
  return value;
};
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const pointKey = point => `${point.x},${point.y}`;
const sourceType = (feature, kind) => kind === 'road'
  ? feature.tags?.highway || feature.tags?.['area:highway'] || feature.tags?.railway || feature.sourceType || feature.type || (feature.kind === 'railway' ? 'railway' : 'unclassified')
  : kind === 'water' ? feature.tags?.waterway || feature.tags?.water || feature.sourceType || feature.type || feature.kind || 'water'
    : feature.tags?.power || feature.sourceType || feature.kind || 'line';
const flag = value => value === undefined || value === false || value === 'no' || value === 'false' || value === '0'
  ? 'no' : value === true || value === 'true' || value === 'yes' || value === '1' ? 'yes' : String(value);

/**
 * A waterway relation repeats its member ways, but often omits their local
 * seasonality, width or culvert tags. An exact native path supplies those display
 * facts. Original ways and relation fragments remain unchanged in members.
 */
export function coalesceWaterwaySources(sources = []) {
  const sourceId = feature => feature.sourceId || String(feature.id || '').match(/^(?:node|way|relation)-\d+/)?.[0] || feature.id;
  const relation = feature => feature.tags?.type === 'waterway' && /^relation-/.test(sourceId(feature));
  const signature = feature => `${sourceType(feature, 'water')}|${(feature.paths || [feature.points || []]).map(path => {
    const forward = path.map(pointKey).join(';'), reverse = [...path].reverse().map(pointKey).join(';');
    return forward < reverse ? forward : reverse;
  }).sort(compare).join('|')}`;
  const semantics = feature => componentKey(feature, 'water');
  const native = new Map(), attached = new Map(), duplicates = new Set();
  for (const feature of sources) if (!relation(feature)) {
    const key = signature(feature);
    if (!native.has(key)) native.set(key, []);
    native.get(key).push(feature);
  }
  for (const feature of sources) if (relation(feature)) {
    const matches = native.get(signature(feature));
    if (!matches?.length) continue;
    // Conflicting native records cannot justify inferred local semantics.
    if (matches.some(match => semantics(match) !== semantics(matches[0]))) continue;
    const match = [...matches].sort((a, b) => compare(String(a.id), String(b.id)))[0];
    if (!attached.has(match)) attached.set(match, []);
    attached.get(match).push(feature); duplicates.add(feature);
  }
  const features = sources.filter(feature => !duplicates.has(feature)).map(feature => {
    const relations = attached.get(feature);
    if (!relations) return feature;
    const members = [feature, ...relations].map(clone);
    return { ...clone(feature), nativeWaterwayPresentation: true, members,
      memberIds: [...new Set(members.flatMap(member => member.memberIds || [member.id]))].sort(compare),
      sourceIds: [...new Set(members.flatMap(member => member.sourceIds || [sourceId(member)]))].sort(compare),
      names: [...new Set(members.flatMap(member => member.names || [member.name || member.tags?.name]).filter(Boolean))],
      provenance: { ...(feature.provenance || {}), presentationMethod: 'exact-native-waterway', nativeSourceId: sourceId(feature), relationSourceIds: [...new Set(relations.map(sourceId))].sort(compare) },
    };
  });
  return { features, coalesced: duplicates.size };
}

function compatibility(feature, kind) {
  const tags = feature.tags || {};
  const structure = [String(tags.layer ?? feature.layer ?? 0), flag(tags.bridge ?? feature.bridge), flag(tags.tunnel ?? feature.tunnel)];
  if (kind === 'road') return JSON.stringify([roadClass(feature), ...structure]);
  const type = sourceType(feature, kind);
  return JSON.stringify([
    type === 'cable' ? 'cable' : 'overhead', ...structure,
    ...['voltage', 'cables', 'circuits', 'wires', 'frequency', 'location'].map(key => String(tags[key] ?? feature[key] ?? '')),
  ]);
}

// Two independent integer hashes keep identifiers compact without browser crypto APIs.
function hash(value) {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ value.charCodeAt(i);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

function geometryLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return length;
}

function makeFeature(chain, kind) {
  const members = chain.map(({ edge }) => clone(edge.feature));
  const memberIds = chain.map(({ edge }) => edge.id);
  const points = [];
  for (const { edge, reversed } of chain) {
    const part = reversed ? [...edge.feature.points].reverse() : edge.feature.points;
    points.push(...part.slice(points.length ? 1 : 0).map(clone));
  }
  const sourceIds = [...new Set(members.flatMap((member, i) => member.sourceIds || [
    member.sourceId || memberIds[i].match(/^(?:node|way|relation)-\d+/)?.[0] || memberIds[i],
  ]))];
  const names = [...new Set(members.flatMap(member => member.names || [member.name || member.tags?.name]).filter(Boolean))];
  const sourceTypes = [...new Set(members.map(member => sourceType(member, kind)))];
  const first = members[0];
  const feature = {
    ...clone(first),
    id: members.length === 1 ? memberIds[0] : `network-${kind}-${hash([...memberIds].sort(compare).join('\n'))}`,
    geometry: 'line', points, members, memberIds, sourceIds, sourceTypes, names,
    memberReversed: chain.map(member => member.reversed),
    sourceType: sourceType(first, kind),
    merged: members.length > 1,
    length: geometryLength(points),
  };
  // A mixed-name chain has no single source street name; the full names remain explicit.
  feature.name = names.join(' / ');
  const widths = members.map(member => member.width).filter(Number.isFinite);
  if (widths.length) feature.width = Math.max(...widths);
  if (kind === 'road') {
    feature.roadClass = roadClass(first);
    feature.roadClassName = ROAD_CLASSES[feature.roadClass].name;
  }
  return feature;
}

/**
 * Join actual touching line endpoints into maximal non-branching display chains.
 * No snapping, interpolation, inferred pole links or missing-edge closures occur.
 * Each source feature occurs exactly once in `members`; source objects are untouched.
 */
export function mergeNetworkLines(lines, { kind = 'road' } = {}) {
  if (!['road', 'power'].includes(kind)) throw new TypeError(`Unknown network kind: ${kind}`);
  if (!Array.isArray(lines)) throw new TypeError('Network features must be an array');
  const globalDegree = new Map(), groups = new Map();
  const edges = lines.map(feature => {
    if (!Array.isArray(feature?.points) || feature.points.length < 2
      || feature.points.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
      throw new TypeError(`Network feature ${feature?.id || '(without id)'} needs at least two finite points`);
    }
    const id = String(feature.id ?? `anonymous-${hash(JSON.stringify(feature))}`);
    const edge = { id, feature, start: pointKey(feature.points[0]), end: pointKey(feature.points.at(-1)), used: false };
    const key = compatibility(feature, kind);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
    // An interior source vertex contributes two edges. This also detects a way
    // ending at another way's interior, which must remain a junction.
    feature.points.forEach((point, i) => {
      const key = pointKey(point), degree = i === 0 || i === feature.points.length - 1 ? 1 : 2;
      globalDegree.set(key, (globalDegree.get(key) || 0) + degree);
    });
    return edge;
  });
  const features = [];
  for (const key of [...groups.keys()].sort(compare)) {
    const group = groups.get(key).sort((a, b) => compare(a.id, b.id) || compare(a.start, b.start) || compare(a.end, b.end));
    const endpoints = new Map();
    for (const edge of group) for (const endpoint of [edge.start, edge.end]) {
      if (!endpoints.has(endpoint)) endpoints.set(endpoint, []);
      endpoints.get(endpoint).push(edge);
    }
    const canContinue = endpoint => globalDegree.get(endpoint) === 2 && endpoints.get(endpoint)?.length === 2;
    const walk = (start, endpoint) => {
      const chain = [];
      let edge = start;
      while (edge && !edge.used) {
        const reversed = edge.end === endpoint && edge.start !== endpoint;
        chain.push({ edge, reversed });
        edge.used = true;
        endpoint = reversed ? edge.start : edge.end;
        if (!canContinue(endpoint)) break;
        edge = endpoints.get(endpoint).find(candidate => !candidate.used);
      }
      features.push(makeFeature(chain, kind));
    };
    // Open chains start at a branch or end. Remaining edges are genuine loops.
    for (const edge of group) {
      if (edge.used || canContinue(edge.start) && canContinue(edge.end)) continue;
      const ends = [edge.start, edge.end].filter(endpoint => !canContinue(endpoint)).sort(compare);
      walk(edge, ends[0]);
    }
    for (const edge of group) if (!edge.used) walk(edge, [edge.start, edge.end].sort(compare)[0]);
  }
  features.sort((a, b) => compare(a.id, b.id));
  const byClass = kind === 'road' ? Object.fromEntries(Object.keys(ROAD_CLASSES).map(id => [id, {
    sourceFeatures: edges.filter(edge => roadClass(edge.feature) === id).length,
    displayFeatures: features.filter(feature => feature.roadClass === id).length,
  }])) : undefined;
  return {
    features,
    report: {
      kind, sourceFeatures: lines.length, displayFeatures: features.length,
      joinedConnections: lines.length - features.length,
      mergedFeatures: features.filter(feature => feature.merged).length,
      sourceLength: edges.reduce((sum, edge) => sum + geometryLength(edge.feature.points), 0),
      displayLength: features.reduce((sum, feature) => sum + feature.length, 0),
      ...(byClass && { byClass }),
    },
  };
}

function componentKey(feature, kind) {
  const tags = feature.tags || {};
  // `feature.layer` may be the presentation layer ("roads", "water", ...).
  // Only a numeric level describes a grade separation in the source geometry.
  const level = tags.layer ?? (Number.isFinite(Number(feature.layer)) ? feature.layer : 0);
  const structure = [String(level), flag(tags.bridge ?? feature.bridge), flag(tags.tunnel ?? feature.tunnel)];
  if (kind === 'road') return JSON.stringify([roadClass(feature), ...structure]);
  if (kind === 'water') return JSON.stringify([
    tags.waterway ? 'waterway' : tags.natural === 'water' || tags.water ? 'water' : 'waterway',
    sourceType(feature, kind), flag(tags.intermittent ?? feature.intermittent), flag(tags.seasonal ?? feature.seasonal), ...structure,
  ]);
  return JSON.stringify([
    sourceType(feature, kind), ...structure,
    ...['voltage', 'cables', 'circuits', 'wires', 'frequency', 'location'].map(key => String(tags[key] ?? feature[key] ?? '')),
  ]);
}

const NETWORK_EPSILON = 1e-7;
function pointTouchesSegment(point, a, b) {
  if (point.x < Math.min(a.x, b.x) - NETWORK_EPSILON || point.x > Math.max(a.x, b.x) + NETWORK_EPSILON
    || point.y < Math.min(a.y, b.y) - NETWORK_EPSILON || point.y > Math.max(a.y, b.y) + NETWORK_EPSILON) return false;
  const dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - a.x, point.y - a.y) <= NETWORK_EPSILON;
  const parameter = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - a.x - parameter * dx, point.y - a.y - parameter * dy) <= NETWORK_EPSILON;
}

function componentFeature(edges, kind) {
  const members = edges.flatMap(edge => edge.feature.nativeWaterwayPresentation ? edge.feature.members.map(clone) : [clone(edge.feature)]);
  const first = members[0];
  const memberIds = [...new Set(edges.flatMap(edge => edge.feature.memberIds || [edge.id]))].sort(compare);
  const sourceIds = [...new Set(edges.flatMap(edge => edge.feature.sourceIds || [
    edge.feature.sourceId || edge.id.match(/^(?:node|way|relation)-\d+/)?.[0] || edge.id,
  ]))].sort(compare);
  const paths = edges.flatMap(edge => edge.paths.map(path => path.map(clone)));
  const names = [...new Set(members.flatMap(member => member.names || [member.name || member.tags?.name]).filter(Boolean))];
  const sourceTypes = [...new Set(members.flatMap(member => member.sourceTypes || [sourceType(member, kind)]))].sort(compare);
  const feature = {
    ...clone(first),
    id: edges.length === 1 ? edges[0].id : `component-${kind}-${hash(memberIds.join('\n'))}`,
    geometry: 'line', points: paths[0], paths, members, memberIds, sourceIds, names, sourceTypes,
    sourceType: sourceType(first, kind), name: names.join(' / '),
    merged: memberIds.length > 1, length: paths.reduce((sum, path) => sum + geometryLength(path), 0),
  };
  const coalesced = edges.filter(edge => edge.feature.nativeWaterwayPresentation);
  if (coalesced.length) feature.provenance = { ...(feature.provenance || {}), presentationMethod: 'exact-native-waterway',
    nativeSourceIds: [...new Set(coalesced.map(edge => edge.feature.provenance.nativeSourceId))].sort(compare),
    relationSourceIds: [...new Set(coalesced.flatMap(edge => edge.feature.provenance.relationSourceIds))].sort(compare) };
  const widths = edges.map(edge => edge.feature.width).filter(Number.isFinite);
  if (widths.length) feature.width = Math.max(...widths);
  if (kind === 'road') {
    feature.roadClass = roadClass(first);
    feature.roadClassName = ROAD_CLASSES[feature.roadClass].name;
  }
  return feature;
}

/**
 * One selectable object per connected same-type network, including branches.
 * Every source path stays separate: no traversal through a branch creates a
 * diagonal, retraces an edge or closes a missing segment. Connections require a
 * shared measured vertex, or a source endpoint lying exactly on another segment
 * (the 1e-7 tolerance only absorbs floating-point arithmetic, never map gaps).
 */
export function mergeConnectedNetworks(lines, { kind = 'road' } = {}) {
  if (!['road', 'power', 'water'].includes(kind)) throw new TypeError(`Unknown network kind: ${kind}`);
  if (!Array.isArray(lines)) throw new TypeError('Network features must be an array');
  const groups = new Map();
  const edges = lines.map(feature => {
    const paths = feature?.paths || [feature?.points];
    if (!Array.isArray(paths) || !paths.length || paths.some(path => !Array.isArray(path) || path.length < 2
      || path.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y)))) {
      throw new TypeError(`Network feature ${feature?.id || '(without id)'} needs finite source paths`);
    }
    const edge = { feature, paths, id: String(feature.id ?? `anonymous-${hash(JSON.stringify(feature))}`) };
    const key = componentKey(feature, kind);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
    return edge;
  });
  const features = [];
  for (const key of [...groups.keys()].sort(compare)) {
    const group = groups.get(key).sort((a, b) => compare(a.id, b.id) || compare(JSON.stringify(a.paths), JSON.stringify(b.paths)));
    const parents = group.map((_, index) => index);
    const root = index => {
      while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; }
      return index;
    };
    const join = (a, b) => {
      a = root(a); b = root(b);
      if (a !== b) parents[Math.max(a, b)] = Math.min(a, b);
    };
    const vertices = new Map();
    const segments = [], endpoints = [];
    group.forEach((edge, index) => {
      for (const path of edge.paths) {
        endpoints.push({ point: path[0], index }, { point: path.at(-1), index });
        path.forEach((point, vertex) => {
          const key = pointKey(point);
          if (vertices.has(key)) join(index, vertices.get(key));
          else vertices.set(key, index);
          if (vertex) segments.push({ a: path[vertex - 1], b: point, index });
        });
      }
    });
    // A small spatial hash makes exact endpoint-on-segment checks local. Long
    // diagonal segments that would span many buckets are checked separately.
    const bucketSize = 32, buckets = new Map(), broadSegments = [];
    for (const segment of segments) {
      const minX = Math.floor((Math.min(segment.a.x, segment.b.x) - NETWORK_EPSILON) / bucketSize);
      const maxX = Math.floor((Math.max(segment.a.x, segment.b.x) + NETWORK_EPSILON) / bucketSize);
      const minY = Math.floor((Math.min(segment.a.y, segment.b.y) - NETWORK_EPSILON) / bucketSize);
      const maxY = Math.floor((Math.max(segment.a.y, segment.b.y) + NETWORK_EPSILON) / bucketSize);
      if ((maxX - minX + 1) * (maxY - minY + 1) > 256) { broadSegments.push(segment); continue; }
      for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
        const key = `${x},${y}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(segment);
      }
    }
    for (const { point, index } of endpoints) {
      const local = buckets.get(`${Math.floor(point.x / bucketSize)},${Math.floor(point.y / bucketSize)}`) || [];
      for (const segment of [...local, ...broadSegments]) if (root(index) !== root(segment.index)
        && pointTouchesSegment(point, segment.a, segment.b)) join(index, segment.index);
    }
    const components = new Map();
    group.forEach((edge, index) => {
      const key = root(index);
      if (!components.has(key)) components.set(key, []);
      components.get(key).push(edge);
    });
    for (const component of components.values()) features.push(componentFeature(component, kind));
  }
  features.sort((a, b) => compare(a.id, b.id));
  const byClass = kind === 'road' ? Object.fromEntries(Object.keys(ROAD_CLASSES).map(id => [id, {
    sourceFeatures: edges.filter(edge => roadClass(edge.feature) === id).length,
    displayFeatures: features.filter(feature => feature.roadClass === id).length,
  }])) : undefined;
  return {
    features,
    report: {
      kind, sourceFeatures: lines.length, displayFeatures: features.length,
      joinedConnections: lines.length - features.length,
      mergedFeatures: features.filter(feature => feature.merged).length,
      sourceLength: edges.reduce((sum, edge) => sum + edge.paths.reduce((total, path) => total + geometryLength(path), 0), 0),
      displayLength: features.reduce((sum, feature) => sum + feature.length, 0),
      ...(byClass && { byClass }),
    },
  };
}
