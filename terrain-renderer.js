/** Cached land and paper only. Every mapped object is drawn in the object layer. */

function trRandom(seed) {
  let value = Number(seed) >>> 0 || 715;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function trDryGround(world, cells) {
  const count = world.cols * world.rows;
  const types = new Array(count);
  const queue = new Int32Array(count);
  let head = 0, tail = 0;
  for (let i = 0; i < count; i++) {
    const type = cells[i]?.type;
    if (type === 'plain' || type === 'forest' || type === 'hill') {
      types[i] = type;
      queue[tail++] = i;
    }
  }
  // Flood from dry land, rather than leaving water/road-shaped blanks in the backdrop.
  if (!tail) return types.fill('plain');
  while (head < tail) {
    const index = queue[head++], x = index % world.cols, y = Math.floor(index / world.cols);
    const visit = next => {
      if (types[next] === undefined) { types[next] = types[index]; queue[tail++] = next; }
    };
    if (x > 0) visit(index - 1);
    if (x + 1 < world.cols) visit(index + 1);
    if (y > 0) visit(index - world.cols);
    if (y + 1 < world.rows) visit(index + world.cols);
  }
  return types;
}

function trContours(context, world, cells) {
  const size = world.cellSize;
  for (let level = .2; level < .95; level += .085) {
    context.beginPath();
    for (let y = 0; y < world.rows - 1; y++) for (let x = 0; x < world.cols - 1; x++) {
      const corners = [cells[y * world.cols + x], cells[y * world.cols + x + 1], cells[(y + 1) * world.cols + x + 1], cells[(y + 1) * world.cols + x]];
      if (corners.some(cell => !Number.isFinite(cell?.height))) continue;
      const positions = [[x + .5, y + .5], [x + 1.5, y + .5], [x + 1.5, y + 1.5], [x + .5, y + 1.5]];
      const edges = [];
      for (let i = 0; i < 4; i++) {
        const next = (i + 1) % 4, a = corners[i].height, b = corners[next].height;
        if ((a < level) === (b < level)) continue;
        const fraction = (level - a) / (b - a);
        edges.push({ x: (positions[i][0] + (positions[next][0] - positions[i][0]) * fraction) * size, y: (positions[i][1] + (positions[next][1] - positions[i][1]) * fraction) * size });
      }
      for (let i = 0; i + 1 < edges.length; i += 2) {
        context.moveTo(edges[i].x, edges[i].y); context.lineTo(edges[i + 1].x, edges[i + 1].y);
      }
    }
    context.strokeStyle = 'rgba(45,55,37,.19)'; context.lineWidth = .8; context.stroke();
  }
}

/** The cache is independent of roads, buildings, rivers, lakes, POIs and their visibility. */
export function createTerrainBackdrop(world, palette) {
  if (!world || !Number.isInteger(world.width) || !Number.isInteger(world.height)
    || world.width < 1 || world.height < 1 || world.width > 10000 || world.height > 10000 || world.width * world.height > 20000000) {
    throw new Error('Invalid terrain backdrop dimensions');
  }
  const canvas = document.createElement('canvas');
  canvas.width = world.width; canvas.height = world.height;
  const context = canvas.getContext('2d', { alpha: false });
  const plain = palette?.plain || '#a7ac8d';
  const random = trRandom(world.seed);
  context.fillStyle = plain; context.fillRect(0, 0, canvas.width, canvas.height);

  const cells = world.terrainCells || world.cells || [];
  let types = null;
  if (!world.geographic && cells.length && world.cols > 0 && world.rows > 0) {
    types = trDryGround(world, cells);
    const ground = document.createElement('canvas');
    ground.width = world.width; ground.height = world.height;
    const fill = ground.getContext('2d');
    types.forEach((type, index) => {
      fill.fillStyle = palette?.[type] || plain;
      fill.fillRect((index % world.cols) * world.cellSize, Math.floor(index / world.cols) * world.cellSize, world.cellSize + 1, world.cellSize + 1);
    });
    context.filter = 'blur(12px)'; context.drawImage(ground, 0, 0); context.filter = 'none';
    trContours(context, world, cells);
  }

  // Print stains are purely decorative: geographic backdrops contain no inferred relief.
  for (let i = 0; i < 18; i++) {
    const x = random() * world.width, y = random() * world.height, radius = 180 + random() * 500;
    const stain = context.createRadialGradient(x, y, 0, x, y, radius);
    stain.addColorStop(0, i % 2 ? 'rgba(56,65,40,.06)' : 'rgba(245,234,186,.06)');
    stain.addColorStop(1, 'rgba(60,62,39,0)');
    context.fillStyle = stain; context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  const marks = Math.min(45000, Math.max(2000, Math.round(world.width * world.height / 190)));
  for (let i = 0; i < marks; i++) {
    const x = random() * world.width, y = random() * world.height;
    context.fillStyle = random() > .4 ? 'rgba(27,40,25,.07)' : 'rgba(246,237,197,.09)';
    context.fillRect(x, y, random() * 2 + .3, random() * 2 + .3);
    if (!types) continue;
    const index = Math.floor(y / world.cellSize) * world.cols + Math.floor(x / world.cellSize), type = types[index];
    if (type === 'forest' && i % 3 === 0) {
      const size = 2.8 + random() * 4;
      context.beginPath(); context.moveTo(x, y - size); context.lineTo(x - size * .55, y + size * .5); context.lineTo(x + size * .55, y + size * .5); context.closePath();
      context.fillStyle = 'rgba(34,60,37,.23)'; context.fill();
      context.fillStyle = 'rgba(35,51,32,.25)'; context.fillRect(x - .4, y + size * .5, .8, 2);
    } else if (type === 'hill' && i % 9 === 0) {
      context.strokeStyle = 'rgba(66,60,39,.21)'; context.lineWidth = .8;
      context.beginPath(); context.moveTo(x - 3, y + 1); context.lineTo(x, y - 3); context.lineTo(x + 3, y + 1); context.stroke();
    }
  }

  context.strokeStyle = 'rgba(45,61,40,.1)'; context.lineWidth = .7; context.beginPath();
  for (let x = 0; x <= world.width; x += 250) { context.moveTo(x, 0); context.lineTo(x, world.height); }
  for (let y = 0; y <= world.height; y += 250) { context.moveTo(0, y); context.lineTo(world.width, y); }
  context.stroke();
  return canvas;
}
