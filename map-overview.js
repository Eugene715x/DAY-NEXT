// Overview places come from mapped place/airport geometry, never census borders.
export const OVERVIEW_MAX_ZOOM = 1.35;
const settlementPlaces = new Set(['city', 'town', 'village', 'hamlet', 'isolated_dwelling']);
const insideRing = (point, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};
const inside = (point, rings) => rings.reduce((value, ring) => value !== insideRing(point, ring), false);
function markerPosition(feature) {
  if (Number.isFinite(feature.x) && Number.isFinite(feature.y)) return { x: feature.x, y: feature.y };
  const rings = feature.rings?.length ? feature.rings : feature.points?.length ? [feature.points] : [];
  const points = rings[0] || [];
  if (!points.length) return null;
  if (points.length === 1 || feature.geometry === 'point') return { ...points[0] };
  let area = 0, x = 0, y = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], cross = a.x * b.y - b.x * a.y;
    area += cross; x += (a.x + b.x) * cross; y += (a.y + b.y) * cross;
  }
  const centroid = Math.abs(area) > 1e-9 ? { x: x / (3 * area), y: y / (3 * area) } : points[0];
  if (inside(centroid, rings)) return { ...centroid };
  // A concave airport/courtyard can exclude its centroid. Find a real interior
  // sample instead of placing the clickable marker inside a hole or outside it.
  const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
  for (let row = 0; row < 12; row++) for (let col = 0; col < 12; col++) {
    const point = { x: minX + (col + .5) / 12 * (maxX - minX), y: minY + (row + .5) / 12 * (maxY - minY) };
    if (inside(point, rings)) return point;
  }
  return { ...points[0] };
}

export function createOverviewMarkers(world) {
  if (!world.geographic && !world.bbox) return [];
  const candidates = [...(world.pois || []), ...(world.details || []), ...(world.areas || [])];
  const markers = new Map();
  for (const feature of candidates) {
    const tags = feature.tags || {}, airport = tags.aeroway === 'aerodrome';
    const settlement = settlementPlaces.has(tags.place) || settlementPlaces.has(tags['abandoned:place']);
    if (!airport && !settlement && tags.place !== 'locality') continue;
    const name = tags.name || feature.name;
    if (!name || /· OSM\s+\S+$/.test(name)) continue;
    const point = markerPosition(feature);
    if (!point || point.x < 0 || point.y < 0 || point.x > world.width || point.y > world.height) continue;
    const sourceId = feature.sourceId || feature.id?.match(/^(?:node|way|relation)-\d+/)?.[0] || feature.id;
    if (markers.has(sourceId)) continue;
    markers.set(sourceId, {
      id: `overview-${sourceId}`, sourceId, name, ...point,
      kind: airport ? 'airport' : settlement ? 'settlement' : 'locality',
      overview: true, reachable: feature.reachable !== false,
      tags: structuredClone(tags),
      description: airport ? 'Аэропорт' : tags['abandoned:place'] ? 'Заброшенное поселение' : settlement ? 'Поселение' : 'Именованная местность',
    });
  }
  return [...markers.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.sourceId.localeCompare(b.sourceId));
}
