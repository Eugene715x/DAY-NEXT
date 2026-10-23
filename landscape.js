// Game landscape classes derived from genuine DEM samples. Biomes remain a
// separate classification; absolute altitude alone never makes a mountain.
export const LANDSCAPE_TYPES = Object.freeze({
  plain: Object.freeze({ id: 'plain', name: 'Равнина', multiplier: 1, color: '#a8bb87' }),
  uneven: Object.freeze({ id: 'uneven', name: 'Неровная местность', multiplier: .78, color: '#c6bb78' }),
  hills: Object.freeze({ id: 'hills', name: 'Холмы', multiplier: .52, color: '#c39865' }),
  mountains: Object.freeze({ id: 'mountains', name: 'Горы', multiplier: .28, color: '#9b7b79' }),
  high_mountains: Object.freeze({ id: 'high_mountains', name: 'Высокие горы', multiplier: .14, color: '#887ba3' }),
});
const lsTypes = [null, ...Object.values(LANDSCAPE_TYPES)];
const lsCodes = Object.fromEntries(lsTypes.slice(1).map((type, index) => [type.id, index + 1]));
const lsClamp = (value, low, high) => Math.max(low, Math.min(high, value));
const lsThresholds = Object.freeze({
  gradientRadiusMeters: 75, localReliefRadiusMeters: 200, reliefRadiusMeters: 400,
  uneven: { slopePercent: 3, localReliefMeters: 20 },
  hills: { slopePercent: 9, slopeWithLocalReliefPercent: 4, localReliefMeters: 55, reliefMeters: 95 },
  mountains: { slopePercent: 20, reliefMeters: 100, broadSlopePercent: 12, broadReliefMeters: 180, localReliefMeters: 100 },
  high_mountains: { slopePercent: 38, reliefMeters: 180, broadSlopePercent: 22, broadReliefMeters: 260, localReliefMeters: 180, summitReliefMeters: 300 },
});

/** Classification thresholds are gameplay settings, not a geological survey. */
export function classifyLandscape({ slopePercent, reliefMeters, localReliefMeters } = {}) {
  if (!Number.isFinite(slopePercent) || slopePercent < 0 || !Number.isFinite(reliefMeters) || reliefMeters < 0 || !Number.isFinite(localReliefMeters) || localReliefMeters < 0) return null;
  if (slopePercent >= 38 && reliefMeters >= 180 || slopePercent >= 22 && reliefMeters >= 260 || localReliefMeters >= 180 && reliefMeters >= 300) return 'high_mountains';
  if (slopePercent >= 20 && reliefMeters >= 100 || slopePercent >= 12 && reliefMeters >= 180 || localReliefMeters >= 100 && reliefMeters >= 180) return 'mountains';
  if (slopePercent >= 9 || slopePercent >= 4 && localReliefMeters >= 55 || localReliefMeters >= 55 && reliefMeters >= 95) return 'hills';
  if (slopePercent >= 3 || localReliefMeters >= 20) return 'uneven';
  return 'plain';
}

// Separable monotonic queues calculate a full neighbourhood range in O(n),
// avoiding hundreds of DEM lookups per navigation cell on the 24 m grid.
function lsExtrema(values, columns, rows, radius, maximum) {
  const horizontal = new Float32Array(values.length), output = new Float32Array(values.length);
  const line = (count, read, write) => {
    const queue = new Int32Array(count);
    let head = 0, tail = 0, added = -1;
    for (let index = 0; index < count; index++) {
      const right = Math.min(count - 1, index + radius);
      while (added < right) {
        added++;
        const value = read(added);
        if (!Number.isFinite(value)) continue;
        while (tail > head && (maximum ? read(queue[tail - 1]) <= value : read(queue[tail - 1]) >= value)) tail--;
        queue[tail++] = added;
      }
      const left = Math.max(0, index - radius);
      while (head < tail && queue[head] < left) head++;
      write(index, head < tail ? read(queue[head]) : NaN);
    }
  };
  for (let row = 0; row < rows; row++) line(columns, column => values[row * columns + column], (column, value) => { horizontal[row * columns + column] = value; });
  for (let column = 0; column < columns; column++) line(rows, row => horizontal[row * columns + column], (row, value) => { output[row * columns + column] = value; });
  return output;
}

function lsCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  return canvas;
}

/**
 * Build a second, independent ground classification once per map. getAt() is
 * cell-exact for movement preparation; the optional cached overlay interpolates
 * metrics at twice this resolution to avoid painting square navigation cells.
 * No input geometry, source DEM or navigation fields are modified here.
 */
export function createLandscape(world = {}, { elevationAt } = {}) {
  const width = Number(world.width), height = Number(world.height), size = Number(world.cellSize);
  const columns = Number(world.cols), rows = Number(world.rows), scale = Number(world.metersPerUnit) > 0 ? Number(world.metersPerUnit) : 1;
  const stats = { sampleCount: 0, validSamples: 0, rasterBuilds: 0, pixelCount: 0, drawCount: 0 };
  let reason = typeof elevationAt !== 'function' ? 'missing-elevation' : null;
  if (!reason && (!(width > 0 && height > 0 && size > 0) || !Number.isFinite(width + height + size)
    || !Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns * rows > 250000)) reason = 'invalid-world';
  let codes = new Uint8Array(reason ? 0 : columns * rows), slope, localRelief, relief;
  const counts = Object.fromEntries(Object.keys(LANDSCAPE_TYPES).map(id => [id, 0]));
  if (!reason) {
    const elevations = new Float32Array(codes.length);
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const value = elevationAt(Math.min(width, (column + .5) * size), Math.min(height, (row + .5) * size));
      stats.sampleCount++;
      elevations[row * columns + column] = Number.isFinite(value) ? value : NaN;
      if (Number.isFinite(value)) stats.validSamples++;
    }
    if (!stats.validSamples) reason = 'no-valid-elevations';
    else {
      const spacing = size * scale;
      const gradientStep = Math.max(1, Math.round(lsThresholds.gradientRadiusMeters / spacing));
      const localRadius = Math.max(1, Math.ceil(lsThresholds.localReliefRadiusMeters / spacing));
      const broadRadius = Math.max(1, Math.ceil(lsThresholds.reliefRadiusMeters / spacing));
      const localMin = lsExtrema(elevations, columns, rows, localRadius, false), localMax = lsExtrema(elevations, columns, rows, localRadius, true);
      const broadMin = lsExtrema(elevations, columns, rows, broadRadius, false), broadMax = lsExtrema(elevations, columns, rows, broadRadius, true);
      slope = new Float32Array(codes.length); localRelief = new Float32Array(codes.length); relief = new Float32Array(codes.length);
      slope.fill(NaN); localRelief.fill(NaN); relief.fill(NaN);
      for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
        const index = row * columns + column;
        if (!Number.isFinite(elevations[index])) continue;
        const left = Math.max(0, column - gradientStep), right = Math.min(columns - 1, column + gradientStep);
        const top = Math.max(0, row - gradientStep), bottom = Math.min(rows - 1, row + gradientStep);
        const a = elevations[row * columns + left], b = elevations[row * columns + right];
        const c = elevations[top * columns + column], d = elevations[bottom * columns + column];
        // Missing neighbour data does not become invented flat terrain.
        if (![a, b, c, d].every(Number.isFinite)) continue;
        const gx = right > left ? (b - a) / ((right - left) * spacing) : 0;
        const gy = bottom > top ? (d - c) / ((bottom - top) * spacing) : 0;
        slope[index] = Math.hypot(gx, gy) * 100;
        localRelief[index] = localMax[index] - localMin[index];
        relief[index] = broadMax[index] - broadMin[index];
        const id = classifyLandscape({ slopePercent: slope[index], localReliefMeters: localRelief[index], reliefMeters: relief[index] });
        if (id) { codes[index] = lsCodes[id]; counts[id]++; }
      }
    }
  }
  const available = !reason && codes.some(Boolean);
  if (!available && !reason) reason = 'insufficient-neighbour-elevations';
  const getInfo = () => ({ available, reason, source: 'real-dem-derived-game-landscape',
    columns: available ? columns : 0, rows: available ? rows : 0, resolutionMeters: available ? size * scale : null,
    counts: { ...counts }, unknownCells: codes.length - Object.values(counts).reduce((sum, count) => sum + count, 0),
    types: Object.values(LANDSCAPE_TYPES).map(type => ({ ...type })), thresholds: structuredClone(lsThresholds),
  });
  const getStats = () => ({ ...stats, available, classifiedCells: Object.values(counts).reduce((sum, count) => sum + count, 0) });
  function getAt(x, y) {
    if (!available || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height) return null;
    const index = Math.floor(y / size) * columns + Math.floor(x / size), type = lsTypes[codes[index]];
    return type ? { ...type, slopePercent: slope[index], localReliefMeters: localRelief[index], reliefMeters: relief[index] } : null;
  }

  let raster = null;
  function buildRaster() {
    if (raster || !available) return;
    const rasterColumns = columns * 2, rasterRows = rows * 2;
    const canvas = lsCanvas(rasterColumns, rasterRows), context = canvas?.getContext('2d');
    if (!context) return;
    const image = context.createImageData(rasterColumns, rasterRows);
    const colors = lsTypes.map(type => type && [1, 3, 5].map(offset => parseInt(type.color.slice(offset, offset + 2), 16)));
    const metric = (values, a, b, c, d, wa, wb, wc, wd) => {
      const first = wa > 1e-12 ? values[a] * wa : 0, second = wb > 1e-12 ? values[b] * wb : 0;
      const third = wc > 1e-12 ? values[c] * wc : 0, fourth = wd > 1e-12 ? values[d] * wd : 0;
      return first + second + third + fourth;
    };
    for (let row = 0; row < rasterRows; row++) for (let column = 0; column < rasterColumns; column++) {
      const gx = lsClamp((column + .5) / 2 - .5, 0, columns - 1), gy = lsClamp((row + .5) / 2 - .5, 0, rows - 1);
      const x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(columns - 1, x0 + 1), y1 = Math.min(rows - 1, y0 + 1), dx = gx - x0, dy = gy - y0;
      const a = y0 * columns + x0, b = y0 * columns + x1, c = y1 * columns + x0, d = y1 * columns + x1;
      const wa = (1 - dx) * (1 - dy), wb = dx * (1 - dy), wc = (1 - dx) * dy, wd = dx * dy;
      const id = classifyLandscape({ slopePercent: metric(slope, a, b, c, d, wa, wb, wc, wd), localReliefMeters: metric(localRelief, a, b, c, d, wa, wb, wc, wd), reliefMeters: metric(relief, a, b, c, d, wa, wb, wc, wd) });
      if (!id) continue;
      const color = colors[lsCodes[id]], pixel = (row * rasterColumns + column) * 4;
      image.data[pixel] = color[0]; image.data[pixel + 1] = color[1]; image.data[pixel + 2] = color[2]; image.data[pixel + 3] = 255;
    }
    context.putImageData(image, 0, 0); raster = canvas;
    stats.rasterBuilds++; stats.pixelCount = rasterColumns * rasterRows;
  }
  function draw(ctx, view = {}) {
    if (!available || !ctx) return false;
    buildRaster();
    if (!raster) return false;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
    ctx.globalAlpha = Number.isFinite(view.landscapeAlpha) ? lsClamp(view.landscapeAlpha, 0, 1) : .32;
    ctx.imageSmoothingEnabled = true; ctx.drawImage(raster, 0, 0, width, height); ctx.restore();
    stats.drawCount++; return true;
  }
  return { available, getAt, sampleAt: getAt, draw, getInfo, getStats };
}
