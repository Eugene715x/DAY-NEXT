// Mapped summits and mine entrances are landmarks, not inferred terrain or loot.
const lmTypes = Object.freeze({
  peak: { name: 'Вершина', layer: 'biomes', color: '#dde2cb' },
  mine: { name: 'Шахта', layer: 'details', color: '#d8bc7c' },
  adit: { name: 'Штольня', layer: 'details', color: '#d8bc7c' },
  mineshaft: { name: 'Шахтный ствол', layer: 'details', color: '#d8bc7c' },
});
const lmPoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
const lmDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const lmCopy = marker => ({ ...marker, tags: { ...marker.tags } });
const lmKind = feature => {
  const tags = feature.tags || {};
  if (tags.natural === 'peak' || feature.kind === 'peak') return 'peak';
  for (const value of [tags.man_made, tags['abandoned:man_made'], tags['disused:man_made'], feature.kind]) if (['mine', 'adit', 'mineshaft'].includes(value)) return value;
  return tags.historic === 'mine' || tags.mine === 'yes' ? 'mine' : null;
};
const lmInRing = (point, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};
const lmInside = (point, rings) => rings.reduce((inside, ring) => inside !== lmInRing(point, ring), false);

function lmPosition(feature) {
  if (lmPoint(feature)) return { x: feature.x, y: feature.y };
  const rings = feature.parts?.[0] || feature.rings || (feature.points ? [feature.points] : []);
  const points = rings[0] || [];
  if (!points.length || !points.every(lmPoint)) return null;
  if (feature.geometry === 'point' || points.length === 1) return { ...points[0] };
  let area = 0, x = 0, y = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], cross = a.x * b.y - b.x * a.y;
    area += cross; x += (a.x + b.x) * cross; y += (a.y + b.y) * cross;
  }
  const centroid = Math.abs(area) > 1e-9 ? { x: x / (3 * area), y: y / (3 * area) } : points[0];
  if (lmInside(centroid, rings)) return { ...centroid };
  const left = Math.min(...points.map(p => p.x)), right = Math.max(...points.map(p => p.x));
  const top = Math.min(...points.map(p => p.y)), bottom = Math.max(...points.map(p => p.y));
  for (let row = 0; row < 16; row++) for (let column = 0; column < 16; column++) {
    const point = { x: left + (column + .5) / 16 * (right - left), y: top + (row + .5) / 16 * (bottom - top) };
    if (lmInside(point, rings)) return point;
  }
  return { ...points[0] };
}

function lmElevation(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?(?:\s*m)?$/.test(text)) return null;
  const height = Number(text.replace(/\s*m$/, ''));
  return Number.isFinite(height) ? height : null;
}

function lmIcon(ctx, marker, hovered) {
  const peak = marker.kind === 'peak', color = lmTypes[marker.kind].color;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
  // An opaque compact backing replaces the former generic point square.
  ctx.beginPath();
  if (peak) { ctx.moveTo(0, -14); ctx.lineTo(13, 8); ctx.lineTo(-13, 8); }
  else { for (let side = 0; side < 6; side++) { const angle = side * Math.PI / 3 - Math.PI / 6; const x = Math.cos(angle) * 12, y = Math.sin(angle) * 12; side ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } }
  ctx.closePath(); ctx.fillStyle = hovered ? '#304035' : '#243029'; ctx.fill();
  ctx.lineWidth = hovered ? 1.8 : 1.25; ctx.strokeStyle = color; ctx.stroke();
  ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.3;
  if (peak) {
    ctx.moveTo(-8, 4); ctx.lineTo(-1, -7); ctx.lineTo(6, 4);
    ctx.moveTo(-4, -2); ctx.lineTo(-1, 0); ctx.lineTo(1, -2);
    ctx.moveTo(2, -7); ctx.lineTo(2, -17); ctx.lineTo(8, -15); ctx.lineTo(2, -12);
    ctx.stroke();
  } else if (marker.kind === 'adit') {
    ctx.moveTo(-6, 5); ctx.lineTo(-6, -1); ctx.bezierCurveTo(-6, -8, 6, -8, 6, -1); ctx.lineTo(6, 5);
    ctx.moveTo(-8, 5); ctx.lineTo(8, 5); ctx.moveTo(-3, 5); ctx.lineTo(-3, -1); ctx.moveTo(3, 5); ctx.lineTo(3, -1); ctx.stroke();
  } else {
    ctx.moveTo(-6, 6); ctx.lineTo(5, -5); ctx.moveTo(6, 6); ctx.lineTo(-5, -5);
    ctx.moveTo(-8, -3); ctx.quadraticCurveTo(-5, -9, 1, -7); ctx.moveTo(8, -3); ctx.quadraticCurveTo(5, -9, -1, -7); ctx.stroke();
    if (marker.kind === 'mineshaft') { ctx.fillStyle = color; ctx.fillRect(-1, 6, 2, 2); }
  }
}

/** Read mapped source geometry once; drawing and picking share layer visibility. */
export function createLandmarkMarkers(world = {}, { elevationAt } = {}) {
  const sources = [...(world.details || []), ...(world.pois || []), ...(world.areas || []), ...(world.labels || []), ...(world.buildings || [])];
  const unique = new Map();
  for (const feature of sources) {
    const kind = lmKind(feature); if (!kind) continue;
    const sourceId = feature.sourceId || feature.id?.match(/^(?:node|way|relation)-\d+/)?.[0] || feature.id;
    if (!sourceId || unique.has(sourceId)) continue;
    const point = lmPosition(feature);
    if (!point || point.x < 0 || point.y < 0 || point.x >= world.width || point.y >= world.height) continue;
    const tags = feature.tags || {}, type = lmTypes[kind], dem = typeof elevationAt === 'function' ? elevationAt(point.x, point.y) : null;
    const mappedHeight = lmElevation(tags.ele), elevationMeters = Number.isFinite(dem) ? dem : mappedHeight;
    const name = kind === 'peak' ? String(tags.name || feature.name || '').replace(/\s*· OSM\s+\S+$/, '').trim() || 'Безымянная вершина' : type.name;
    const index = Number.isFinite(world.cellSize) && world.cols > 0 ? Math.floor(point.y / world.cellSize) * world.cols + Math.floor(point.x / world.cellSize) : -1;
    const uncertain = !!tags.fixme;
    unique.set(sourceId, {
      id: `landmark-${sourceId}`, sourceId, kind, layer: type.layer, name, typeName: type.name, ...point,
      elevationMeters, elevationSource: Number.isFinite(dem) ? 'USGS 3DEP' : mappedHeight !== null ? 'OpenStreetMap' : null,
      reachable: feature.reachable !== false && (index < 0 || !world.cells || world.cells[index]?.walkable !== false),
      description: [tags.historic === 'mine' ? 'Историческая шахта' : type.name, uncertain ? 'Тип отмечен в источнике как требующий уточнения' : '', Number.isFinite(elevationMeters) ? `${Math.round(elevationMeters)} м` : ''].filter(Boolean).join(' · '),
      mapped: true, landmark: true, uncertain,
      tags: kind === 'peak' ? { natural: 'peak' } : tags.historic === 'mine' ? { historic: 'mine' } : { man_made: kind },
    });
  }
  const markers = [...unique.values()].sort((a, b) => Number(a.kind !== 'peak') - Number(b.kind !== 'peak') || a.sourceId.localeCompare(b.sourceId));
  const stats = { total: markers.length, peaks: markers.filter(marker => marker.kind === 'peak').length, mines: markers.filter(marker => marker.kind !== 'peak').length, reachable: markers.filter(marker => marker.reachable).length, drawn: 0, symbols: 0, labels: 0, draws: 0 };
  const enabled = (marker, layers = {}) => layers[marker.layer] !== false;

  function pick(x, y, radius = 14, { zoom = 1, layers = {} } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const limit = Number.isFinite(radius) && radius >= 0 ? radius : 14 / Math.max(.01, zoom);
    let found = null, minimum = limit;
    for (const marker of markers) {
      if (!enabled(marker, layers)) continue;
      const distance = Math.hypot(marker.x - x, marker.y - y);
      if (distance <= minimum) { minimum = distance; found = marker; }
    }
    return found ? lmCopy(found) : null;
  }

  function draw(ctx, view = {}) {
    const zoom = Number(view.zoom) > 0 ? Number(view.zoom) : 1;
    const cx = Number(view.cameraX) || 0, cy = Number(view.cameraY) || 0;
    const halfWidth = Number(view.width) > 0 ? view.width / (2 * zoom) : Infinity, halfHeight = Number(view.height) > 0 ? view.height / (2 * zoom) : Infinity;
    const visible = markers.filter(marker => enabled(marker, view.layers) && Math.abs(marker.x - cx) <= halfWidth + 40 / zoom && Math.abs(marker.y - cy) <= halfHeight + 40 / zoom);
    const groups = [];
    for (const marker of visible) {
      // Close mine entrances use one source-anchored symbol on the overview.
      const group = zoom < 1.2 && marker.kind !== 'peak' ? groups.find(group => group.marker.kind !== 'peak' && lmDistance(group.marker, marker) * zoom < 21) : null;
      if (group) group.count++;
      else groups.push({ marker, count: 1 });
    }
    const boxes = view.labelBoxes || [];
    let labels = 0;
    for (const { marker, count } of groups) {
      const hovered = view.hoveredId === marker.id || view.hoveredId === marker.sourceId;
      const screenX = (marker.x - cx) * zoom + (view.width || 0) / 2, screenY = (marker.y - cy) * zoom + (view.height || 0) / 2;
      ctx.save(); ctx.translate(marker.x, marker.y); ctx.scale(1 / zoom, 1 / zoom);
      lmIcon(ctx, marker, hovered);
      if (count > 1) {
        ctx.beginPath(); ctx.arc(11, -10, 7, 0, Math.PI * 2); ctx.fillStyle = '#d7bd80'; ctx.fill();
        ctx.fillStyle = '#253029'; ctx.font = '600 9px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(count), 11, -10);
      }
      const label = marker.kind === 'peak' ? `${marker.name}${Number.isFinite(marker.elevationMeters) ? ` · ${Math.round(marker.elevationMeters)} м` : ''}` : marker.typeName;
      if (hovered || marker.kind === 'peak' && zoom >= .55 || marker.kind !== 'peak' && zoom >= 2) {
        ctx.font = `${hovered ? '600 ' : ''}10px "Segoe UI", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const width = Math.min(220, ctx.measureText(label).width + 12), box = { x: screenX - width / 2, y: screenY + 13, width, height: 16 };
        const overlaps = boxes.some(other => box.x < other.x + other.width && box.x + box.width > other.x && box.y < other.y + other.height && box.y + box.height > other.y);
        if (hovered || !overlaps) {
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(24,34,28,.85)'; ctx.strokeText(label, 0, 14, 208);
          ctx.fillStyle = lmTypes[marker.kind].color; ctx.fillText(label, 0, 14, 208); boxes.push(box); labels++;
        }
      }
      ctx.restore();
    }
    stats.draws++; stats.drawn = visible.length; stats.symbols = groups.length; stats.labels = labels;
    return { drawn: visible.length, symbols: groups.length, labels };
  }
  return { getMarkers: () => markers.map(lmCopy), pick, draw, getStats: () => ({ ...stats }) };
}
