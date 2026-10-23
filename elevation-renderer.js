// Real DEM presentation only. This module never changes terrain or navigation.
const erClamp = (value, low, high) => Math.max(low, Math.min(high, value));
const erValidBbox = bbox => Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)
  && bbox[0] >= -180 && bbox[2] <= 180 && bbox[1] >= -90 && bbox[3] <= 90 && bbox[0] < bbox[2] && bbox[1] < bbox[3];
// Compatibility metadata for the neutral illumination legend. These stops no
// longer colour elevation: the raster contains illumination only.
const erPalette = [[0, '#545454'], [.5, '#808080'], [1, '#bdbdbd']];
function erCanvas(width, height) {
  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(width, height);
  else if (typeof document !== 'undefined') { canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; }
  return canvas || null;
}
function erLineLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return length;
}
function erJoinSegments(segments) {
  const adjacent = new Map();
  segments.forEach((segment, index) => segment.forEach(end => {
    if (!adjacent.has(end.key)) adjacent.set(end.key, []);
    adjacent.get(end.key).push(index);
  }));
  const used = new Set(), paths = [];
  const walk = (start, first) => {
    const points = [{ x: start.x, y: start.y }];
    let key = start.key, index = first;
    while (!used.has(index)) {
      used.add(index);
      const segment = segments[index], end = segment[0].key === key ? segment[1] : segment[0];
      points.push({ x: end.x, y: end.y }); key = end.key;
      const next = (adjacent.get(key) || []).find(value => !used.has(value));
      if (next === undefined) break;
      index = next;
    }
    if (points.length > 1) paths.push({ points, length: erLineLength(points) });
  };
  for (const [key, indices] of adjacent) if (indices.length === 1 && !used.has(indices[0])) {
    const segment = segments[indices[0]]; walk(segment.find(end => end.key === key), indices[0]);
  }
  segments.forEach((segment, index) => { if (!used.has(index)) walk(segment[0], index); });
  return paths.sort((a, b) => b.length - a.length);
}
function erPath(paths) {
  if (typeof Path2D === 'undefined') return null;
  const path = new Path2D();
  for (const line of paths) line.points.forEach((point, index) => index ? path.lineTo(point.x, point.y) : path.moveTo(point.x, point.y));
  return path;
}
function erStroke(ctx, contour) {
  if (contour.path) { ctx.stroke(contour.path); return; }
  ctx.beginPath();
  for (const line of contour.paths) line.points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.stroke();
}

/**
 * Cache an elevation raster and contours once. Grid values are elevation metres
 * at inclusive bbox vertices, row-major west→east and north→south. Draw expects
 * the caller's world transform and belongs above ground fills, below objects.
 */
export function createElevationRenderer(world = {}, data) {
  const width = Number(world.width), height = Number(world.height), mapBbox = world.bbox;
  const columns = Number(data?.columns), rows = Number(data?.rows), bbox = data?.bbox;
  const stats = { rasterBuilds: 0, contourBuilds: 0, drawCount: 0, maskDrawCount: 0, contourLevels: 0, contourSegments: 0, labelsDrawn: 0, pixelCount: 0 };
  let reason = !data ? 'missing-data' : null;
  if (!reason && (!(width > 0 && height > 0) || !Number.isFinite(width + height) || !erValidBbox(mapBbox))) reason = 'map-no-geography';
  if (!reason && (!erValidBbox(bbox) || !Number.isInteger(columns) || !Number.isInteger(rows) || columns < 2 || rows < 2
    || columns * rows > 4000000 || !Array.isArray(data.values) || data.values.length !== columns * rows
    || data.units !== 'm' || data.rowOrder !== 'north-to-south')) reason = 'invalid-data';
  if (!reason && (mapBbox[0] < bbox[0] - 1e-9 || mapBbox[1] < bbox[1] - 1e-9 || mapBbox[2] > bbox[2] + 1e-9 || mapBbox[3] > bbox[3] + 1e-9)) reason = 'outside-coverage';
  let min = Infinity, max = -Infinity, grid;
  const nodata = data?.noDataValue ?? data?.noData;
  if (!reason) {
    grid = new Float64Array(columns * rows);
    for (let index = 0; index < grid.length; index++) {
      const value = data.values[index];
      if (Number.isFinite(value) && !(Number.isFinite(nodata) && value === nodata)) {
        grid[index] = value; min = Math.min(min, value); max = Math.max(max, value);
      } else grid[index] = NaN;
    }
    if (!Number.isFinite(min)) reason = 'no-valid-elevations';
  }
  const available = !reason, contourInterval = 50, majorContourInterval = 100;
  const source = data?.source ? structuredClone(data.source) : null;
  const getInfo = () => ({
    available, reason, min: available ? min : null, max: available ? max : null, units: 'm',
    columns: available ? columns : 0, rows: available ? rows : 0, bbox: erValidBbox(bbox) ? [...bbox] : null,
    contourInterval, majorContourInterval, renderMode: 'neutral-relief-mask',
    palette: available ? erPalette.map(([position, color]) => ({ height: min + (max - min) * position, position, color })) : [],
    source: source ? structuredClone(source) : null,
  });
  if (!available) return { available, sampleAt: () => null, draw: () => false, drawMask: () => false, getInfo, getStats: () => ({ ...stats, available }) };
  const longitudeScale = (columns - 1) / (bbox[2] - bbox[0]), latitudeScale = (rows - 1) / (bbox[3] - bbox[1]);
  const worldX = column => (bbox[0] + column / longitudeScale - mapBbox[0]) / (mapBbox[2] - mapBbox[0]) * width;
  const worldY = row => (mapBbox[3] - (bbox[3] - row / latitudeScale)) / (mapBbox[3] - mapBbox[1]) * height;
  const left = worldX(0), top = worldY(0), rasterWidth = worldX(columns - 1) - left, rasterHeight = worldY(rows - 1) - top;
  const latitude = (bbox[1] + bbox[3]) / 2 * Math.PI / 180;
  const stepX = (bbox[2] - bbox[0]) * 111320 * Math.cos(latitude) / (columns - 1);
  const stepY = (bbox[3] - bbox[1]) * 111132 / (rows - 1);
  let raster = null, contours = null;

  function sampleAt(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height) return null;
    const longitude = mapBbox[0] + x / width * (mapBbox[2] - mapBbox[0]);
    const latitude = mapBbox[3] - y / height * (mapBbox[3] - mapBbox[1]);
    const column = erClamp((longitude - bbox[0]) * longitudeScale, 0, columns - 1);
    const row = erClamp((bbox[3] - latitude) * latitudeScale, 0, rows - 1);
    const x0 = Math.floor(column), y0 = Math.floor(row), x1 = Math.min(columns - 1, x0 + 1), y1 = Math.min(rows - 1, y0 + 1);
    const fx = column - x0, fy = row - y0;
    const samples = [[x0, y0, (1 - fx) * (1 - fy)], [x1, y0, fx * (1 - fy)], [x0, y1, (1 - fx) * fy], [x1, y1, fx * fy]];
    let value = 0;
    for (const [cx, cy, weight] of samples) {
      if (weight <= 1e-12) continue;
      const elevation = grid[cy * columns + cx];
      if (!Number.isFinite(elevation)) return null;
      value += elevation * weight;
    }
    return value;
  }

  function buildRaster() {
    if (raster) return;
    const canvas = erCanvas(columns, rows), context = canvas?.getContext('2d');
    if (!context) return;
    const image = context.createImageData(columns, rows), pixels = image.data;
    // Northwest sunlight. Shading is artistic presentation, not a slope model.
    const azimuth = 315 * Math.PI / 180, altitude = 42 * Math.PI / 180;
    const light = [Math.sin(azimuth) * Math.cos(altitude), -Math.cos(azimuth) * Math.cos(altitude), Math.sin(altitude)];
    const slope = (index, negative, positive, spacing) => {
      const a = grid[negative], b = grid[positive], value = grid[index];
      const hasA = Number.isFinite(a) && negative !== index, hasB = Number.isFinite(b) && positive !== index;
      return hasA && hasB ? (b - a) / (2 * spacing) : hasB ? (b - value) / spacing : hasA ? (value - a) / spacing : 0;
    };
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const index = row * columns + column, value = grid[index], pixel = index * 4;
      if (!Number.isFinite(value)) continue;
      const sx = slope(index, row * columns + Math.max(0, column - 1), row * columns + Math.min(columns - 1, column + 1), stepX) * 1.6;
      const sy = slope(index, Math.max(0, row - 1) * columns + column, Math.min(rows - 1, row + 1) * columns + column, stepY) * 1.6;
      const normal = Math.hypot(sx, sy, 1), dot = erClamp((-sx * light[0] - sy * light[1] + light[2]) / normal, 0, 1);
      // Flat ground is the neutral midpoint of soft-light. Absolute elevation
      // never enters this illumination: identical shapes at different altitudes
      // produce the same mask. All channels are equal, so no terrain hue leaks
      // into the independent biome/landscape colours beneath it.
      const illumination = erClamp(.5 + (dot - light[2]) * .88, .08, .90);
      const gray = Math.round(illumination * 255);
      for (let channel = 0; channel < 3; channel++) pixels[pixel + channel] = gray;
      pixels[pixel + 3] = 255;
    }
    context.putImageData(image, 0, 0); raster = canvas;
    stats.rasterBuilds++; stats.pixelCount = columns * rows;
  }

  function buildContours() {
    if (contours) return;
    const levels = new Map();
    const segmentPairs = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[3, 0]] };
    for (let row = 0; row < rows - 1; row++) for (let column = 0; column < columns - 1; column++) {
      const values = [grid[row * columns + column], grid[row * columns + column + 1], grid[(row + 1) * columns + column + 1], grid[(row + 1) * columns + column]];
      if (!values.every(Number.isFinite)) continue;
      const low = Math.min(...values), high = Math.max(...values);
      if (low === high) continue;
      for (let height = Math.ceil(low / contourInterval) * contourInterval; height <= high; height += contourInterval) {
        const mask = values.reduce((mask, value, index) => mask | (value >= height ? 1 << index : 0), 0);
        if (!mask || mask === 15) continue;
        const centerHigh = values.reduce((sum, value) => sum + value, 0) / 4 >= height;
        const pairs = mask === 5 ? centerHigh ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]]
          : mask === 10 ? centerHigh ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]] : segmentPairs[mask];
        if (!pairs) continue;
        const corners = [[column, row], [column + 1, row], [column + 1, row + 1], [column, row + 1]];
        const edge = index => {
          const next = (index + 1) % 4, fraction = (height - values[index]) / (values[next] - values[index]);
          const x = corners[index][0] + (corners[next][0] - corners[index][0]) * fraction;
          const y = corners[index][1] + (corners[next][1] - corners[index][1]) * fraction;
          const key = Number.isInteger(x) && Number.isInteger(y) ? `p${x},${y}` : index === 0 ? `h${column},${row}` : index === 1 ? `v${column + 1},${row}` : index === 2 ? `h${column},${row + 1}` : `v${column},${row}`;
          return { key, x: worldX(x), y: worldY(y) };
        };
        if (!levels.has(height)) levels.set(height, []);
        for (const [a, b] of pairs) {
          const p = edge(a), q = edge(b);
          if (Math.hypot(p.x - q.x, p.y - q.y) > 1e-8) levels.get(height).push([p, q]);
        }
      }
    }
    contours = [...levels].sort((a, b) => a[0] - b[0]).map(([height, segments]) => {
      const paths = erJoinSegments(segments); stats.contourSegments += segments.length;
      return { height, major: height % majorContourInterval === 0, paths, path: erPath(paths) };
    }).filter(contour => contour.paths.length);
    stats.contourBuilds++; stats.contourLevels = contours.length;
  }

  function drawLabels(ctx, view, zoom) {
    if (!ctx.fillText) return;
    const cx = Number.isFinite(view.cameraX) ? view.cameraX : width / 2, cy = Number.isFinite(view.cameraY) ? view.cameraY : height / 2;
    const halfWidth = (Number(view.width) || width * zoom) / (2 * zoom), halfHeight = (Number(view.height) || height * zoom) / (2 * zoom);
    const boxes = []; let count = 0;
    for (const contour of contours) {
      if (!contour.major || count >= 12) continue;
      const candidates = [];
      for (const line of contour.paths.slice(0, 8)) {
        if (line.length * zoom < 100) continue;
        for (let i = 1; i < line.points.length; i++) {
          const a = line.points[i - 1], b = line.points[i], x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
          if (Math.abs(x - cx) > halfWidth - 35 / zoom || Math.abs(y - cy) > halfHeight - 25 / zoom) continue;
          candidates.push({ x, y, angle: Math.atan2(b.y - a.y, b.x - a.x), distance: Math.hypot(x - cx, y - cy) });
        }
      }
      candidates.sort((a, b) => a.distance - b.distance);
      for (const point of candidates) {
        const x = (point.x - cx) * zoom, y = (point.y - cy) * zoom;
        if (boxes.some(box => Math.abs(x - box.x) < 76 && Math.abs(y - box.y) < 34)) continue;
        let angle = point.angle; if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
        ctx.save(); ctx.translate(point.x, point.y); ctx.rotate(angle); ctx.scale(1 / zoom, 1 / zoom);
        ctx.font = '500 10px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(238,238,238,.68)'; ctx.fillStyle = '#484848';
        ctx.strokeText(`${contour.height} м`, 0, 0); ctx.fillText(`${contour.height} м`, 0, 0); ctx.restore();
        boxes.push({ x, y }); count++; break;
      }
    }
    stats.labelsDrawn = count;
  }

  function paint(ctx, view, mask) {
    buildRaster(); buildContours();
    if (!raster) return false;
    const zoom = Number(view.zoom) > 0 ? Number(view.zoom) : 1;
    ctx.save(); ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
    ctx.imageSmoothingEnabled = true;
    // The biome ground is already opaque when this is used as a mask. A
    // neutral soft-light transfer adds shading without painting a grey matte.
    ctx.globalCompositeOperation = mask ? 'soft-light' : 'source-over';
    // Pixel centres correspond to DEM sample vertices, including bbox edges.
    ctx.drawImage(raster, .5, .5, columns - 1, rows - 1, left, top, rasterWidth, rasterHeight);
    // Contours and their measured labels are ordinary neutral ink above relief.
    ctx.globalCompositeOperation = 'source-over';
    if (view.elevationContours !== false) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
      for (const contour of contours) {
        ctx.strokeStyle = contour.major ? 'rgba(55,55,55,.32)' : 'rgba(55,55,55,.18)';
        ctx.lineWidth = (contour.major ? 1.05 : .65) / zoom; erStroke(ctx, contour);
      }
      drawLabels(ctx, view, zoom);
    } else stats.labelsDrawn = 0;
    ctx.restore(); stats.drawCount++;
    if (mask) stats.maskDrawCount++;
    return true;
  }

  // Standalone height view uses neutral grey relief; the normal map composites
  // the same cached raster onto biome/landscape colours with drawMask().
  const draw = (ctx, view = {}) => paint(ctx, view, false);
  const drawMask = (ctx, view = {}) => paint(ctx, view, true);

  return { available, sampleAt, draw, drawMask, getInfo, getStats: () => ({ ...stats, available }) };
}
