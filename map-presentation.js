// Derived display geometry only. Navigation and the original OSM features stay intact.
export const ROAD_CLASSES = Object.freeze(Object.fromEntries([
  ['highway', 'Магистраль', 'Магистрали'],
  ['road', 'Дорога', 'Дороги'],
  ['street', 'Улица и проезд', 'Улицы и проезды'],
  ['track', 'Грунтовка', 'Грунтовки'],
  ['trail', 'Тропа', 'Тропы'],
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
  const type = typeof feature === 'string' ? feature : feature?.tags?.highway || feature?.tags?.['area:highway'] || feature?.sourceType || feature?.type;
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
  ? feature.tags?.highway || feature.tags?.['area:highway'] || feature.sourceType || feature.type || 'unclassified'
  : feature.tags?.power || feature.sourceType || feature.kind || 'line';
const flag = value => value === undefined || value === false || value === 'no' || value === 'false' || value === '0'
  ? 'no' : value === true || value === 'true' || value === 'yes' || value === '1' ? 'yes' : String(value);

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
