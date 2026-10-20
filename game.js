import { createWorld, findPath, terrainAt, nearestWalkable } from './world.js';
import { createRealWorld } from './real-world.js';
import { convertOSM } from './scripts/lib/osm-converter.mjs';
import usaMap from './maps/usa.js';
import { createDetailRenderer } from './detail-renderer.js';

const $ = id => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d', { alpha: false });
let world = createRealWorld(usaMap);
let currentMap = usaMap;
let detailRenderer = createDetailRenderer(world);
let hoveredObject = null;
const maximumZoom = () => world.geographic ? 24 : 5;
const greenPalette = { plain: '#a7ac8d', forest: '#6e8163', water: '#354d49', swamp: '#7f927c', hill: '#a8a38a', road: '#aaa88e', bridge: '#b7b39b' };
const desertPalette = { plain: '#b2aa89', forest: '#788367', water: '#435b54', swamp: '#929b7c', hill: '#a99b7a', road: '#b6ab87', bridge: '#c7bc95' };
let palette = desertPalette;
const metersPerUnit = () => world.metersPerUnit || 5;
const terrainNames = { plain: 'Пустошь', forest: 'Хвойный лес', water: 'Вода', swamp: 'Заболоченная низина', hill: 'Каменистые холмы', road: 'Старая дорога', bridge: 'Мост' };
const kindNames = { village: 'Поселение', town: 'Заброшенный город', city: 'Заброшенный город', settlement: 'Поселение', camp: 'Укрытие', shelter: 'Укрытие', station: 'Станция', factory: 'Промзона', ruins: 'Руины', ruin: 'Руины', danger: 'Опасная зона', bunker: 'Бункер', tower: 'Радиовышка', bridge: 'Переправа', gas: 'Заправка', hospital: 'Медпункт' };
let vw = innerWidth, vh = innerHeight, dpr = Math.min(devicePixelRatio || 1, 2);
let player = { ...world.start };
let camera = { x: player.x, y: player.y, zoom: innerWidth < 640 ? .68 : .85 };
let route = null, paused = false, following = true, speed = 1;
let stamina = 100, water = 100, minutes = 7 * 60 + 42, totalDistance = 0;
let pointer = null, hover = null, hoveredPoi = null, trail = [];
let discovered = new Set(world.pois.filter(p => p.discovered).map(p => p.id));
let last = performance.now(), uiTick = 0, hintTimer, arrivalMarker = null, keys = new Set();
let randomSeed = world.seed || 715;
let mapLabelBoxes = [];
function random() { randomSeed = (Math.imul(randomSeed, 1664525) + 1013904223) >>> 0; return randomSeed / 4294967296; }
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const poiTitle = poi => poi.name.replace(/\s*· OSM\s+\S+$/, '');
const formatDistance = d => d >= 1000 ? `${(d / 1000).toFixed(1).replace('.', ',')} км` : `${Math.max(0, Math.round(d / 10) * 10)} м`;
const screenToWorld = (x, y) => ({ x: (x - vw / 2) / camera.zoom + camera.x, y: (y - vh / 2) / camera.zoom + camera.y });
const worldToScreen = p => ({ x: (p.x - camera.x) * camera.zoom + vw / 2, y: (p.y - camera.y) * camera.zoom + vh / 2 });

function line(context, points) {
  context.beginPath();
  points.forEach((p, i) => i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y));
}

function makeAtlas() {
  const atlas = document.createElement('canvas');
  atlas.width = world.width; atlas.height = world.height;
  const g = atlas.getContext('2d');
  const terrain = document.createElement('canvas');
  terrain.width = world.width; terrain.height = world.height;
  const t = terrain.getContext('2d');
  t.fillStyle = palette.plain; t.fillRect(0, 0, terrain.width, terrain.height);
  world.cells.forEach((cell, i) => {
    t.fillStyle = world.geographic && ['road', 'bridge'].includes(cell.type) ? palette.plain : palette[cell.type] || palette.plain;
    t.fillRect((i % world.cols) * world.cellSize, Math.floor(i / world.cols) * world.cellSize, world.cellSize + 1, world.cellSize + 1);
  });
  g.fillStyle = palette.plain; g.fillRect(0, 0, atlas.width, atlas.height);
  g.filter = 'blur(12px)'; g.drawImage(terrain, 0, 0); g.filter = 'none';
  if (world.geographic) {
    // Print patina is decorative paper texture, not inferred geography or elevation.
    for (let i = 0; i < 18; i++) {
      const x = random() * world.width, y = random() * world.height, r = 180 + random() * 500;
      const stain = g.createRadialGradient(x, y, 0, x, y, r);
      stain.addColorStop(0, i % 2 ? 'rgba(56,65,40,.06)' : 'rgba(245,234,186,.06)'); stain.addColorStop(1, 'rgba(60,62,39,0)');
      g.fillStyle = stain; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }

  // OSM polygons keep their actual outlines and holes; no painted-in water or forests.
  for (const area of world.areas || []) {
    g.beginPath();
    for (const ring of area.rings) {
      ring.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y));
      g.closePath();
    }
    const dry = area.intermittent || area.seasonal;
    g.fillStyle = dry ? '#bdb393' : palette[area.type] || palette.plain; g.fill('evenodd');
    if (area.type === 'water' && !dry) { g.strokeStyle = '#8c9879'; g.lineWidth = 1.2; g.stroke(); }
  }

  // Contours use the same elevation field as the navigation map.
  for (let level = .2; level < .95; level += .085) {
    g.beginPath();
    for (let y = 0; y < world.rows - 1; y++) for (let x = 0; x < world.cols - 1; x++) {
      const cell = world.cellSize;
      const corners = [world.cells[y * world.cols + x], world.cells[y * world.cols + x + 1], world.cells[(y + 1) * world.cols + x + 1], world.cells[(y + 1) * world.cols + x]];
      if (corners.some(c => c.type === 'water')) continue;
      const positions = [[x * cell + cell / 2, y * cell + cell / 2], [(x + 1) * cell + cell / 2, y * cell + cell / 2], [(x + 1) * cell + cell / 2, (y + 1) * cell + cell / 2], [x * cell + cell / 2, (y + 1) * cell + cell / 2]];
      const edges = [];
      for (let j = 0; j < 4; j++) {
        const k = (j + 1) % 4, a = corners[j].height, b = corners[k].height;
        if ((a < level) !== (b < level)) {
          const f = (level - a) / (b - a);
          edges.push({ x: positions[j][0] + (positions[k][0] - positions[j][0]) * f, y: positions[j][1] + (positions[k][1] - positions[j][1]) * f });
        }
      }
      for (let j = 0; j + 1 < edges.length; j += 2) { g.moveTo(edges[j].x, edges[j].y); g.lineTo(edges[j + 1].x, edges[j + 1].y); }
    }
    g.strokeStyle = 'rgba(45, 55, 37, .19)'; g.lineWidth = .8; g.stroke();
  }

  for (const river of world.rivers) {
    line(g, river.points); g.lineCap = 'round'; g.lineJoin = 'round';
    if (river.intermittent || river.seasonal) {
      g.strokeStyle = '#978d6f'; g.lineWidth = Math.max(2, river.width + 3); g.stroke();
      g.strokeStyle = '#c2b996'; g.lineWidth = Math.max(1, river.width); g.stroke();
      continue;
    }
    g.strokeStyle = '#768a74'; g.lineWidth = river.width + 14; g.stroke();
    g.strokeStyle = palette.water; g.lineWidth = river.width; g.stroke();
    g.strokeStyle = '#526b5d'; g.lineWidth = 1.5; g.stroke();
  }
  for (const lake of world.lakes) {
    g.beginPath(); g.ellipse(lake.x, lake.y, lake.rx + 6, lake.ry + 6, 0, 0, Math.PI * 2); g.fillStyle = '#758a76'; g.fill();
    g.beginPath(); g.ellipse(lake.x, lake.y, lake.rx, lake.ry, 0, 0, Math.PI * 2); g.fillStyle = palette.water; g.fill();
    g.strokeStyle = '#96a18a'; g.lineWidth = 1; g.stroke();
    g.beginPath(); g.ellipse(lake.x, lake.y, Math.max(1, lake.rx - 15), Math.max(1, lake.ry - 15), 0, 0, Math.PI * 2); g.strokeStyle = '#4c6356'; g.stroke();
  }

  // Fine-grained print texture, trees, reed beds and rocky hill marks.
  for (let i = 0; i < 35000; i++) {
    const x = random() * world.width, y = random() * world.height;
    const cell = terrainAt(world, x, y);
    if (!cell) continue;
    g.fillStyle = random() > .4 ? 'rgba(27,40,25,.07)' : 'rgba(246,237,197,.09)';
    g.fillRect(x, y, random() * 2 + .3, random() * 2 + .3);
    if (cell.type === 'forest' && i % 3 === 0) {
      const size = 2.8 + random() * 4;
      g.beginPath(); g.moveTo(x, y - size); g.lineTo(x - size * .55, y + size * .5); g.lineTo(x + size * .55, y + size * .5); g.closePath();
      g.fillStyle = 'rgba(34,60,37,.23)'; g.fill();
      g.fillStyle = 'rgba(35,51,32,.25)'; g.fillRect(x - .4, y + size * .5, .8, 2);
    } else if (cell.type === 'swamp' && i % 4 === 0) {
      g.strokeStyle = 'rgba(44,67,49,.25)'; g.lineWidth = .8;
      g.beginPath(); g.moveTo(x - 3, y); g.lineTo(x + 3, y); g.moveTo(x, y); g.lineTo(x, y - 3); g.stroke();
    } else if (cell.type === 'hill' && i % 9 === 0) {
      g.strokeStyle = 'rgba(66,60,39,.21)'; g.lineWidth = .8;
      g.beginPath(); g.moveTo(x - 3, y + 1); g.lineTo(x, y - 3); g.lineTo(x + 3, y + 1); g.stroke();
    }
  }

  for (const road of world.geographic ? [] : world.roads) {
    line(g, road.points); g.lineJoin = 'round'; g.lineCap = 'round';
    const width = world.geographic ? clamp(road.width, 1.2, 9) : 4;
    g.strokeStyle = 'rgba(59,55,39,.3)'; g.lineWidth = width + 3; g.stroke();
    g.strokeStyle = '#d0c6a3'; g.lineWidth = width; g.stroke();
    g.setLineDash([9, 9]); g.strokeStyle = '#74725a'; g.lineWidth = .7; g.stroke(); g.setLineDash([]);
  }
  for (const road of world.geographic ? [] : world.roads) {
    let span = [];
    const paintBridge = () => {
      if (span.length < 2) { span = []; return; }
      line(g, span); g.lineCap = 'butt'; g.strokeStyle = '#4c5845'; g.lineWidth = 24; g.stroke();
      g.strokeStyle = '#d1c7a2'; g.lineWidth = 19; g.stroke();
      g.setLineDash([1.5, 7]); g.strokeStyle = '#7c7d60'; g.lineWidth = 17; g.stroke(); g.setLineDash([]);
      span = [];
    };
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1], b = road.points[i], steps = Math.ceil(dist(a, b) / 5);
      for (let j = 0; j <= steps; j++) {
        const point = { x: a.x + (b.x - a.x) * j / steps, y: a.y + (b.y - a.y) * j / steps };
        if (terrainAt(world, point.x, point.y)?.type === 'bridge') span.push(point);
        else paintBridge();
      }
    }
    paintBridge();
  }

  for (const building of world.geographic ? [] : world.buildings || []) {
    line(g, building.points); g.closePath();
    g.fillStyle = '#a3997a'; g.fill(); g.strokeStyle = '#59604a'; g.lineWidth = .7; g.stroke();
  }
  for (const poi of world.geographic ? [] : world.pois) {
    const n = poi.kind === 'town' || poi.kind === 'city' ? 20 : 7;
    for (let i = 0; i < n; i++) {
      const x = poi.x + (random() - .5) * 95, y = poi.y + (random() - .5) * 70;
      if (!terrainAt(world, x, y)?.walkable) continue;
      const width = 4 + random() * 8, height = 4 + random() * 6;
      g.save(); g.translate(x, y); g.rotate(Math.round(random() * 3) * Math.PI / 4);
      g.fillStyle = '#525b47'; g.fillRect(-width / 2 - 1, -height / 2 - 1, width + 2, height + 2);
      g.fillStyle = '#beb798'; g.fillRect(-width / 2, -height / 2, width, height);
      g.restore();
    }
  }

  g.strokeStyle = 'rgba(45,61,40,.13)'; g.lineWidth = .7;
  g.beginPath();
  for (let x = 0; x <= world.width; x += 250) { g.moveTo(x, 0); g.lineTo(x, world.height); }
  for (let y = 0; y <= world.height; y += 250) { g.moveTo(0, y); g.lineTo(world.width, y); }
  g.stroke();
  const mapText = (text, x, y, size, angle = 0) => {
    g.save(); g.translate(x, y); g.rotate(angle); g.fillStyle = 'rgba(33,51,35,.26)';
    g.font = `500 ${size}px Georgia, serif`; g.textAlign = 'center'; g.letterSpacing = '5px'; g.fillText(text, 0, 0); g.restore();
  };
  if (!world.geographic) {
    mapText('С Е В Е Р Н Ы Е   П У С Т О Ш И', 1130, 370, 27, -.06);
    mapText('Х В О Й Н Ы Й   Л Е С', 620, 1550, 17, -.32);
    mapText('З А Р Е Ч Ь Е', 2300, 1450, 25, -.08);
  }
  return atlas;
}
let atlas = makeAtlas();

function resize() {
  vw = innerWidth; vh = innerHeight; dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr);
  canvas.style.width = `${vw}px`; canvas.style.height = `${vh}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize); resize();

function log(message, accent = false) {
  const node = document.createElement('div');
  node.className = `log-entry${accent ? ' is-accent' : ''}`;
  const time = document.createElement('span'); time.className = 'log-time';
  const minute = Math.floor(minutes); time.textContent = `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const text = document.createElement('span'); text.textContent = message;
  node.append(time, text); $('activity-log').prepend(node);
  while ($('activity-log').children.length > 3) $('activity-log').lastChild.remove();
}
function toast(message) {
  clearTimeout(hintTimer); $('toast').textContent = message; $('toast').hidden = false;
  hintTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}

function pickPoi(position, radius = 35) {
  return world.pois.filter(p => p.reachable !== false).sort((a, b) => dist(a, position) - dist(b, position)).find(p => dist(p, position) < radius / Math.max(.65, camera.zoom)) || null;
}

function setDestination(position) {
  const poi = pickPoi(position, 34);
  const target = poi ? { x: poi.x, y: poi.y } : position;
  if (target.x < 0 || target.y < 0 || target.x >= world.width || target.y >= world.height) { toast('Здесь заканчивается лист карты.'); return; }
  if (!terrainAt(world, target.x, target.y)?.walkable) { toast('Вода непроходима. Ищи мост или обойди берег.'); return; }
  const result = findPath(world, player, target);
  if (!result || !result.points.length) { toast('Путь закрыт. Попробуй другой берег или дорогу.'); return; }
  if (result.distance < 5) return;
  const name = poi ? poiTitle(poi) : terrainNames[terrainAt(world, target.x, target.y)?.type] || 'Точка на карте';
  route = { points: result.points.map(p => ({ ...p })), index: 0, destination: target, name, remaining: result.distance };
  paused = false; arrivalMarker = target;
  log(`Маршрут: ${name.toLowerCase()}`, true);
  $('travel-panel').hidden = false; $('destination-label').textContent = name;
  $('pause-button').textContent = 'Ⅱ Пауза'; $('pause-button').setAttribute('aria-label', 'Приостановить движение');
  updateUI();
}

function cancelRoute() {
  if (!route) return;
  route = null; paused = false; arrivalMarker = null; $('travel-panel').hidden = true;
  log('Маршрут отменён.'); updateUI();
}
function togglePause() {
  if (!route) return;
  paused = !paused;
  $('pause-button').textContent = paused ? '▶ Продолжить' : 'Ⅱ Пауза';
  $('pause-button').setAttribute('aria-label', paused ? 'Продолжить движение' : 'Приостановить движение');
  updateUI();
}
function reset() {
  player = { ...world.start }; camera.x = player.x; camera.y = player.y;
  route = null; paused = false; following = true; speed = 1;
  stamina = water = 100; minutes = 7 * 60 + 42; totalDistance = 0; trail = []; arrivalMarker = null;
  discovered = new Set(world.pois.filter(p => p.discovered).map(p => p.id));
  hideObjectCard();
  $('travel-panel').hidden = true; $('speed-button').textContent = '1×'; $('activity-log').replaceChildren();
  log('Новый день. Впереди — неизвестность.', true); toast('Вернулись к началу экспедиции.'); updateUI();
}

function updateMapDetails() {
  $('usa-map-title').textContent = `${usaMap.name} · ${usaMap.region || 'США'}`;
  $('map-usa').setAttribute('aria-pressed', String(currentMap === usaMap));
  $('map-generated').setAttribute('aria-pressed', String(!currentMap));
  $('sector-label').textContent = currentMap ? `${currentMap.region || currentMap.country || 'OPENSTREETMAP'} / РЕАЛЬНАЯ МЕСТНОСТЬ` : 'СЕВЕРНЫЙ СЕКТОР / 04';
  $('map-summary').textContent = currentMap ? `${currentMap.name} · ${(world.width * metersPerUnit() / 1000).toFixed(1)} × ${(world.height * metersPerUnit() / 1000).toFixed(1)} км. ${world.roads.length} дорог, ${world.buildings.length} зданий, ${world.pois.length} мест. ${currentMap.source?.snapshotAt ? `Снимок OSM: ${currentMap.source.snapshotAt.slice(0, 10)}` : 'Данные OpenStreetMap'}.` : 'Вымышленная территория · 12 локаций, леса и переправы.';
  $('map-attribution').hidden = !currentMap;
  // Keep source attribution permanent and link only to the known source copyright page.
  $('map-source-link').href = 'https://www.openstreetmap.org/copyright';
  $('map-source-link').textContent = '© OpenStreetMap contributors · ODbL';
  $('map-export').disabled = !currentMap;
  $('detail-button').disabled = !world.buildings?.length;
}

function switchMap(map) {
  const next = map ? createRealWorld(map) : createWorld();
  world = next; currentMap = map;
  detailRenderer = createDetailRenderer(world);
  palette = map ? desertPalette : greenPalette;
  randomSeed = world.seed || 715; atlas = makeAtlas();
  camera.zoom = innerWidth < 640 ? .68 : .85;
  hover = null; hoveredPoi = null;
  reset(); updateMapDetails();
  $('maps-panel').hidden = true; $('maps-button').setAttribute('aria-expanded', 'false');
  toast(map ? `Территория: ${map.name}. Выбери точку на карте.` : 'Северные пустоши. Выбери свой путь.');
}

function hideObjectCard() {
  hoveredObject = null;
  $('object-card').hidden = true;
}

function inspectObject(point, screenX, screenY, touch = false) {
  if (!world.geographic || camera.zoom < 2) { hideObjectCard(); return; }
  const feature = detailRenderer.pick(point.x, point.y, 5 / camera.zoom);
  if (!feature) { hideObjectCard(); return; }
  hoveredObject = feature;
  const names = { building: 'ЗДАНИЕ', road: 'ДОРОГА', fence: 'ОГРАДА', wall: 'СТЕНА', gate: 'ВОРОТА', railway: 'ЖЕЛЕЗНАЯ ДОРОГА', parking: 'ПАРКОВКА', pitch: 'СПОРТПЛОЩАДКА', garden: 'САД', pool: 'БАССЕЙН', tree: 'ДЕРЕВО', bench: 'СКАМЕЙКА', picnic_table: 'МЕСТО ДЛЯ ПРИВАЛА', fountain: 'ФОНТАН', well: 'КОЛОДЕЦ', ruins: 'РУИНЫ', shelter: 'УКРЫТИЕ', cemetery: 'КЛАДБИЩЕ', park: 'ПАРК', spring: 'РОДНИК', quarry: 'КАРЬЕР', playground: 'ДЕТСКАЯ ПЛОЩАДКА', cattle_grid: 'РЕШЁТКА НА ДОРОГЕ' };
  $('object-kind').textContent = names[feature.kind] || 'ОБЪЕКТ';
  $('object-name').textContent = feature.name || (feature.kind === 'building' ? 'Безымянное здание' : 'Объект на карте');
  const source = feature.source || {};
  const address = typeof source.address === 'string' ? source.address : source.address ? Object.values(source.address).join(', ') : '';
  const extra = [feature.description, address, source.levels ? `${source.levels} эт.` : '', source.surface ? `Покрытие: ${source.surface}` : ''].filter(Boolean).flatMap(text => String(text).split(' · '));
  $('object-meta').textContent = [...new Set(extra)].filter(text => text !== feature.name).join(' · ') || 'Нанесён на карту OpenStreetMap';
  if (touch && ['building', 'ruins'].includes(feature.kind)) $('object-meta').textContent += '\nКоснись земли рядом, чтобы подойти.';
  $('object-card').hidden = false;
  const bounds = $('object-card').getBoundingClientRect();
  $('object-card').style.left = `${clamp(screenX + 18, 12, vw - bounds.width - 12)}px`;
  $('object-card').style.top = `${clamp(screenY + 20 + bounds.height > vh - 60 ? screenY - bounds.height - 18 : screenY + 20, 90, vh - bounds.height - 45)}px`;
}

function focusBuildings() {
  const focus = detailRenderer.focus();
  if (!focus) { toast('На этом участке нет нанесённых контуров домов.'); return; }
  following = false; camera.x = focus.x; camera.y = focus.y;
  camera.zoom = innerWidth < 640 ? Math.max(focus.zoom, 7) : focus.zoom;
  hideObjectCard(); updateUI();
  toast(`${currentMap === usaMap ? 'Застройка Битти' : 'Застройка на карте'}. Приближай карту и наводи на отдельные дома.`);
}
$('detail-button').addEventListener('click', focusBuildings);

function downloadJSON(map) {
  const blob = new Blob([JSON.stringify(map, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = `day-next-${String(map.id || 'map').replace(/[^a-z0-9_-]/gi, '-')}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('maps-button').addEventListener('click', () => {
  hideObjectCard();
  $('maps-panel').hidden = !$('maps-panel').hidden;
  $('maps-button').setAttribute('aria-expanded', String(!$('maps-panel').hidden));
  $('help-panel').hidden = true; $('help-button').setAttribute('aria-expanded', 'false');
});
$('maps-close').addEventListener('click', () => { $('maps-panel').hidden = true; $('maps-button').setAttribute('aria-expanded', 'false'); });
$('map-usa').addEventListener('click', () => switchMap(usaMap));
$('map-generated').addEventListener('click', () => switchMap(null));
$('map-export').addEventListener('click', () => { if (currentMap) downloadJSON(currentMap); });
$('map-file').addEventListener('change', () => {
  const file = $('map-file').files[0];
  $('map-file-label').textContent = file ? file.name : 'OSM XML / Overpass JSON / DAY NEXT JSON';
  $('map-import').disabled = !file;
  $('map-import-status').textContent = file ? 'Файл выбран. Для исходных OSM-данных укажи границы участка.' : 'Выбери файл с географическими данными.';
  $('map-import-status').classList.remove('is-error', 'is-success');
});
$('map-import').addEventListener('click', async () => {
  const file = $('map-file').files[0]; if (!file) return;
  $('map-import').disabled = true;
  $('map-import-status').textContent = 'Читаю данные и строю карту…';
  $('map-import-status').classList.remove('is-error', 'is-success');
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('Для прототипа выбери файл меньше 20 МБ.');
    const text = await file.text();
    let parsed = null;
    if (text.trimStart().startsWith('{')) {
      try { parsed = JSON.parse(text); } catch { throw new Error('JSON повреждён. Проверь экспорт исходных данных.'); }
    }
    let map;
    if (parsed?.version === 1 && Array.isArray(parsed.bbox) && Array.isArray(parsed.roads)) map = parsed;
    else {
      const bboxText = $('map-bbox').value.trim();
      if (!bboxText) throw new Error('Укажи границы участка: запад, юг, восток, север (долгота, широта).');
      map = convertOSM(parsed || text, { bbox: bboxText, name: $('map-name').value.trim() || file.name.replace(/\.[^.]+$/, ''), id: 'custom-map', dataUrl: `Local file: ${file.name}` });
    }
    // Validate before touching the current expedition; failed imports leave it intact.
    createRealWorld(map);
    switchMap(map);
    $('map-import-status').textContent = 'Карта готова. Её можно сохранить кнопкой «Скачать JSON карты».';
    $('map-import-status').classList.add('is-success');
  } catch (error) {
    $('map-import-status').textContent = `Не получилось импортировать: ${error.message}`;
    $('map-import-status').classList.add('is-error');
  } finally { $('map-import').disabled = !$('map-file').files.length; }
});

$('pause-button').addEventListener('click', togglePause);
$('cancel-button').addEventListener('click', cancelRoute);
$('center-button').addEventListener('click', () => { hideObjectCard(); following = true; camera.x = player.x; camera.y = player.y; updateUI(); });
$('reset-button').addEventListener('click', reset);
$('speed-button').addEventListener('click', () => { speed = speed === 1 ? 3 : 1; $('speed-button').textContent = `${speed}×`; toast(`Скорость путешествия: ${speed}×`); });
$('help-button').addEventListener('click', () => { hideObjectCard(); $('help-panel').hidden = !$('help-panel').hidden; $('help-button').setAttribute('aria-expanded', String(!$('help-panel').hidden)); $('maps-close').click(); });
$('help-close').addEventListener('click', () => { $('help-panel').hidden = true; $('help-button').setAttribute('aria-expanded', 'false'); });
function zoomBy(factor, point = { x: vw / 2, y: vh / 2 }) {
  const before = screenToWorld(point.x, point.y);
  camera.zoom = clamp(camera.zoom * factor, .32, maximumZoom());
  const after = screenToWorld(point.x, point.y);
  camera.x += before.x - after.x; camera.y += before.y - after.y;
  hideObjectCard();
  updateUI();
}
$('zoom-in').addEventListener('click', () => zoomBy(1.23));
$('zoom-out').addEventListener('click', () => zoomBy(1 / 1.23));
canvas.addEventListener('wheel', e => { e.preventDefault(); following = false; zoomBy(Math.exp(-e.deltaY * .0011), { x: e.clientX, y: e.clientY }); }, { passive: false });

const touches = new Map(); let pinch = null, wasPinch = false;
canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.pointerType !== 'touch') return;
  hideObjectCard();
  canvas.setPointerCapture(e.pointerId);
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2) {
    const [a, b] = [...touches.values()];
    pinch = { distance: dist(a, b), zoom: camera.zoom, midpoint: screenToWorld((a.x + b.x) / 2, (a.y + b.y) / 2) };
    wasPinch = true; pointer = null; following = false; return;
  }
  pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: camera.x, cy: camera.y, moved: false };
  canvas.classList.add('is-grabbing');
});
canvas.addEventListener('pointermove', e => {
  hover = screenToWorld(e.clientX, e.clientY); hoveredPoi = pickPoi(hover);
  if (!pointer && !pinch) inspectObject(hover, e.clientX, e.clientY);
  canvas.style.cursor = pointer?.moved ? 'grabbing' : hoveredPoi || hoveredObject ? 'pointer' : 'crosshair';
  if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && touches.size === 2) {
    const [a, b] = [...touches.values()];
    camera.zoom = clamp(pinch.zoom * dist(a, b) / pinch.distance, .32, maximumZoom());
    camera.x = pinch.midpoint.x - ((a.x + b.x) / 2 - vw / 2) / camera.zoom;
    camera.y = pinch.midpoint.y - ((a.y + b.y) / 2 - vh / 2) / camera.zoom;
    return;
  }
  if (!pointer || pointer.id !== e.pointerId) return;
  const dx = e.clientX - pointer.x, dy = e.clientY - pointer.y;
  if (Math.hypot(dx, dy) > 5) pointer.moved = true;
  if (pointer.moved) { hideObjectCard(); following = false; camera.x = pointer.cx - dx / camera.zoom; camera.y = pointer.cy - dy / camera.zoom; }
});
function pointerUp(e) {
  touches.delete(e.pointerId);
  if (wasPinch) { if (!touches.size) { wasPinch = false; pinch = null; } pointer = null; canvas.classList.remove('is-grabbing'); return; }
  if (pointer && pointer.id === e.pointerId && !pointer.moved && e.type !== 'pointercancel') {
    const point = screenToWorld(e.clientX, e.clientY);
    if (e.pointerType === 'touch') {
      inspectObject(point, e.clientX, e.clientY, true);
      if (!hoveredObject || !['building', 'ruins'].includes(hoveredObject.kind)) setDestination(point);
    } else setDestination(point);
  }
  pointer = null; canvas.classList.remove('is-grabbing');
}
canvas.addEventListener('pointerup', pointerUp); canvas.addEventListener('pointercancel', pointerUp);
canvas.addEventListener('pointerleave', e => { hover = null; hoveredPoi = null; if (e.pointerType !== 'touch') hideObjectCard(); });
addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  if (e.target instanceof HTMLButtonElement && [' ', 'Enter'].includes(e.key)) return;
  if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
  if (e.repeat && [' ', 'f', 'F', 'r', 'R', 'b', 'B'].includes(e.key)) return;
  if (e.key === ' ') togglePause();
  if (e.key === 'Escape') { if (!$('help-panel').hidden) $('help-close').click(); else if (!$('maps-panel').hidden) $('maps-close').click(); else cancelRoute(); }
  if (e.key.toLowerCase() === 'f') $('center-button').click();
  if (e.key.toLowerCase() === 'r') reset();
  if (e.key.toLowerCase() === 'b') focusBuildings();
  if (e.key === '+' || e.key === '=') zoomBy(1.2);
  if (e.key === '-') zoomBy(1 / 1.2);
  keys.add(e.key.toLowerCase());
});
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => { keys.clear(); pointer = null; touches.clear(); pinch = null; wasPinch = false; });

function update(dt) {
  const panX = Number(keys.has('d') || keys.has('arrowright')) - Number(keys.has('a') || keys.has('arrowleft'));
  const panY = Number(keys.has('s') || keys.has('arrowdown')) - Number(keys.has('w') || keys.has('arrowup'));
  if (panX || panY) { hideObjectCard(); following = false; camera.x += panX * dt * 450 / camera.zoom; camera.y += panY * dt * 450 / camera.zoom; }
  if (route && !paused) {
    const cell = terrainAt(world, player.x, player.y);
    const factor = cell?.type === 'road' || cell?.type === 'bridge' ? 1.35 : cell?.type === 'forest' ? .73 : cell?.type === 'swamp' ? .48 : cell?.type === 'hill' ? .8 : 1;
    let budget = dt * Math.min(33, 110 / camera.zoom) * speed * factor;
    let walked = 0;
    while (route && budget > 0 && route.index < route.points.length) {
      const target = route.points[route.index], length = dist(player, target);
      if (length <= budget) { player.x = target.x; player.y = target.y; budget -= length; walked += length; route.index++; }
      else { player.x += (target.x - player.x) / length * budget; player.y += (target.y - player.y) / length * budget; walked += budget; budget = 0; }
    }
    totalDistance += walked * metersPerUnit(); minutes += walked * metersPerUnit() / 66.67;
    stamina = Math.max(5, stamina - walked * .018); water = Math.max(10, water - walked * .005);
    if (!trail.length || dist(player, trail[trail.length - 1]) > 9) { trail.push({ ...player }); if (trail.length > 350) trail.shift(); }
    if (route) {
      route.remaining = dist(player, route.points[route.index] || player);
      for (let i = route.index + 1; i < route.points.length; i++) route.remaining += dist(route.points[i - 1], route.points[i]);
      if (route.index >= route.points.length) {
        log(`На месте: ${route.name.toLowerCase()}`, true);
        route = null; paused = false; arrivalMarker = null; $('travel-panel').hidden = true;
        toast('Ты на месте. Выбери, куда идти дальше.');
      }
    }
    for (const poi of world.pois) if (!discovered.has(poi.id) && dist(player, poi) < 65) {
      discovered.add(poi.id); log(`Обнаружено: ${poi.name}`, true); toast(`${poi.name}. ${poi.description || 'Новое место отмечено в журнале.'}`);
    }
  } else stamina = Math.min(100, stamina + dt * .8);
  if (following && !pointer) {
    const blend = 1 - Math.exp(-dt * 4);
    camera.x += (player.x - camera.x) * blend; camera.y += (player.y - camera.y) * blend;
  }
  camera.x = clamp(camera.x, -100, world.width + 100); camera.y = clamp(camera.y, -100, world.height + 100);
}

function drawPoi(poi, time) {
  const p = worldToScreen(poi);
  if (p.x < -120 || p.x > vw + 120 || p.y < -70 || p.y > vh + 70) return;
  const active = discovered.has(poi.id), isHovered = hoveredPoi?.id === poi.id;
  const size = isHovered ? 12 : 10;
  ctx.save(); ctx.translate(p.x, p.y);
  if (isHovered) { ctx.beginPath(); ctx.arc(0, 0, 21 + Math.sin(time * 2) * 1, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(238,230,192,.4)'; ctx.lineWidth = 1; ctx.stroke(); }
  ctx.rotate(Math.PI / 4); ctx.fillStyle = active ? '#263b2d' : '#49523d'; ctx.strokeStyle = active ? '#d6ddad' : '#b7b99a'; ctx.lineWidth = 1.2;
  ctx.fillRect(-size / 2, -size / 2, size, size); ctx.strokeRect(-size / 2, -size / 2, size, size); ctx.rotate(-Math.PI / 4);
  ctx.fillStyle = active ? '#dbe7b7' : '#c8c6a7'; ctx.fillRect(-1.5, -1.5, 3, 3);
  const anonymous = /· OSM\s+\S+$/.test(poi.name);
  const important = poi.kind === 'town' && !anonymous;
  const fontSize = camera.zoom < .5 ? 10 : important ? 13 : 11;
  const title = isHovered ? poiTitle(poi) : poi.name;
  ctx.font = `${isHovered || active || important ? 600 : 500} ${fontSize}px "Segoe UI", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const width = ctx.measureText(title).width;
  let offsetY = important ? -31 : 17;
  const boxAt = dy => ({ x: p.x - width / 2 - 5, y: p.y + dy - 3, width: width + 10, height: fontSize + 8 });
  const overlaps = box => mapLabelBoxes.some(b => box.x < b.x + b.width && box.x + box.width > b.x && box.y < b.y + b.height && box.y + box.height > b.y);
  let box = boxAt(offsetY);
  if (important && overlaps(box)) { offsetY = 28; box = boxAt(offsetY); }
  if (isHovered || !anonymous && !overlaps(box)) {
    ctx.lineWidth = 3.5; ctx.strokeStyle = world.geographic ? 'rgba(181,172,140,.9)' : 'rgba(153,163,131,.85)'; ctx.strokeText(title, 0, offsetY);
    ctx.fillStyle = '#253927'; ctx.fillText(title, 0, offsetY); mapLabelBoxes.push(box);
  }
  if (isHovered) {
    const text = `${poi.reachable === false ? 'Путь закрыт' : kindNames[poi.kind] || 'Место на карте'} · ${formatDistance(dist(player, poi) * metersPerUnit())}`;
    ctx.font = '10px "Segoe UI", sans-serif'; const width = ctx.measureText(text).width + 20;
    ctx.fillStyle = '#1c2a22'; ctx.beginPath(); ctx.roundRect(-width / 2, -40, width, 24, 3); ctx.fill();
    ctx.fillStyle = '#dfe1c8'; ctx.fillText(text, 0, -34);
  }
  ctx.restore();
}

function draw(time) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#1b2721'; ctx.fillRect(0, 0, vw, vh);
  ctx.save(); ctx.translate(vw / 2, vh / 2); ctx.scale(camera.zoom, camera.zoom); ctx.translate(-camera.x, -camera.y);
  ctx.drawImage(atlas, 0, 0);
  if (world.geographic) detailRenderer.draw(ctx, { zoom: camera.zoom, cameraX: camera.x, cameraY: camera.y, width: vw, height: vh, time, hoveredId: hoveredObject?.id });
  if (trail.length > 1) {
    line(ctx, trail); ctx.strokeStyle = 'rgba(54,61,35,.45)'; ctx.lineWidth = 1.5 / camera.zoom; ctx.setLineDash([2 / camera.zoom, 5 / camera.zoom]); ctx.stroke(); ctx.setLineDash([]);
  }
  if (route) {
    const points = [player, ...route.points.slice(route.index)];
    line(ctx, points); ctx.lineWidth = 5 / camera.zoom; ctx.strokeStyle = 'rgba(30,43,28,.4)'; ctx.lineJoin = 'round'; ctx.stroke();
    line(ctx, points); ctx.lineWidth = 1.8 / camera.zoom; ctx.strokeStyle = paused ? '#ded6aa' : '#f2f2b4';
    ctx.setLineDash([4 / camera.zoom, 7 / camera.zoom]); ctx.lineDashOffset = -time * 12; ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
  }
  ctx.restore();

  const playerOnScreen = worldToScreen(player);
  mapLabelBoxes = [{ x: playerOnScreen.x - 30, y: playerOnScreen.y - 22, width: 60, height: 56 }];
  const pois = world.geographic ? [...world.pois].sort((a, b) => Number(b.id === hoveredPoi?.id) - Number(a.id === hoveredPoi?.id) || Number(b.kind === 'town') - Number(a.kind === 'town') || Number(discovered.has(b.id)) - Number(discovered.has(a.id))) : world.pois;
  for (const poi of pois) if (camera.zoom < 4 || hoveredPoi?.id === poi.id || poi.kind === 'town') drawPoi(poi, time);
  if (arrivalMarker && route) {
    const p = worldToScreen(arrivalMarker);
    ctx.beginPath(); ctx.arc(p.x, p.y, 12 + Math.sin(time * 3) * 2, 0, Math.PI * 2); ctx.strokeStyle = '#f3edb3'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p.x, p.y - 9); ctx.lineTo(p.x, p.y - 29); ctx.lineTo(p.x + 12, p.y - 25); ctx.lineTo(p.x, p.y - 20);
    ctx.strokeStyle = '#f1e5b4'; ctx.fillStyle = '#f1e5b4'; ctx.lineWidth = 1.5; ctx.fill(); ctx.stroke();
  }

  const p = worldToScreen(player);
  const pulse = Math.sin(time * 2) * .5 + .5;
  const glow = ctx.createRadialGradient(p.x, p.y, 6, p.x, p.y, 47);
  glow.addColorStop(0, 'rgba(237,239,155,.26)'); glow.addColorStop(1, 'rgba(237,239,155,0)');
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(p.x, p.y, 47, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = `rgba(240,240,180,${.15 + pulse * .15})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p.x, p.y, 18 + pulse * 5, 0, Math.PI * 2); ctx.stroke();
  // Original, compact hiker silhouette; visible independently of zoom.
  ctx.save(); ctx.translate(p.x, p.y);
  ctx.fillStyle = 'rgba(24,37,26,.3)'; ctx.beginPath(); ctx.ellipse(2, 10, 9, 3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#f2edbb'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#263c2d'; ctx.beginPath(); ctx.arc(0, 0, 10.5, 0, Math.PI * 2); ctx.fill();
  const step = route && !paused ? Math.sin(time * 13 * speed) * 1.5 : 0;
  ctx.strokeStyle = '#e7e7be'; ctx.lineWidth = 2; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-1, 2); ctx.lineTo(-3 - step, 7); ctx.moveTo(1, 2); ctx.lineTo(3 + step, 7); ctx.stroke();
  ctx.fillStyle = '#d5d6ad'; ctx.fillRect(-3, -3, 6, 7);
  ctx.fillStyle = '#a5b27e'; ctx.fillRect(-5, -2, 2, 5);
  ctx.beginPath(); ctx.arc(0, -5, 2.5, 0, Math.PI * 2); ctx.fillStyle = '#efebc7'; ctx.fill();
  ctx.restore();
  if (!route) {
    ctx.font = '600 9px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#253c2b'; ctx.fillText('ТЫ ЗДЕСЬ', p.x, p.y + 30);
  }

  // Framing: unobtrusive lens shading keeps the controls legible.
  const shade = ctx.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * .25, vw / 2, vh / 2, Math.max(vw, vh) * .7);
  shade.addColorStop(0, 'rgba(9,21,15,0)'); shade.addColorStop(1, 'rgba(9,21,15,.43)');
  ctx.fillStyle = shade; ctx.fillRect(0, 0, vw, vh);
  const topFade = ctx.createLinearGradient(0, 0, 0, 150); topFade.addColorStop(0, 'rgba(12,23,17,.32)'); topFade.addColorStop(1, 'rgba(12,23,17,0)');
  ctx.fillStyle = topFade; ctx.fillRect(0, 0, vw, 150);

  // Map scale is a true distance based on current zoom, rather than a decoration.
  if (vw > 650) {
    const targetMeters = 135 * metersPerUnit() / camera.zoom;
    const scaleMeters = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].filter(n => n <= targetMeters).at(-1) || 1;
    const length = scaleMeters / metersPerUnit() * camera.zoom, x = vw - 36 - length, y = vh - 44;
    ctx.strokeStyle = 'rgba(222,227,199,.7)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + length, y); ctx.lineTo(x + length, y - 4); ctx.stroke();
    ctx.fillStyle = '#d4dbc0'; ctx.font = '9px monospace'; ctx.textAlign = 'right'; ctx.fillText(scaleMeters >= 1000 ? `${scaleMeters / 1000} КМ` : `${scaleMeters} М`, x + length, y - 9);
  }
}

function updateUI() {
  const minute = Math.floor(minutes);
  $('day-label').textContent = `ДЕНЬ ${Math.floor(minute / 1440) + 1}`;
  $('time-label').textContent = `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  $('weather-label').textContent = route && !paused ? 'В ПУТИ · +12°' : 'ПАСМУРНО · +12°';
  $('stamina-value').textContent = `${Math.round(stamina)}%`; $('stamina-bar').style.width = `${stamina}%`;
  $('health-value').textContent = '100%'; $('health-bar').style.width = '100%';
  $('water-value').textContent = `${Math.round(water)}%`; $('water-bar').style.width = `${water}%`;
  const nearest = [...world.pois].sort((a, b) => dist(player, a) - dist(player, b))[0];
  const atPoi = nearest && dist(player, nearest) < 65;
  $('location-name').textContent = atPoi ? poiTitle(nearest) : world.name || 'Северные пустоши';
  const terrain = terrainAt(world, player.x, player.y);
  $('terrain-label').textContent = `${terrainNames[terrain?.type] || 'Пустошь'}${route ? paused ? ' · привал' : ' · в пути' : ' · на привале'}`;
  if (world.geographic) {
    const [west, south, east, north] = world.bbox;
    const degree = 6371008.8 * Math.PI / 180, cosine = Math.cos((south + north) * Math.PI / 360);
    const lat = north - player.y * metersPerUnit() / degree, lon = west + player.x * metersPerUnit() / degree / cosine;
    $('coords').textContent = `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'С' : 'Ю'} · ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'В' : 'З'}`;
  } else $('coords').textContent = `${(58 + player.y / 10000).toFixed(3)}° С · ${(38 + player.x / 10000).toFixed(3)}° В`;
  $('zoom-label').textContent = `${Math.round(camera.zoom * 100)}%`;
  $('map-detail-label').textContent = camera.zoom >= 6 ? 'ДЕТАЛИ' : camera.zoom >= 2 ? 'УЛИЦЫ' : 'ОБЗОР';
  $('zoom-in').disabled = camera.zoom >= maximumZoom() - .001;
  $('zoom-out').disabled = camera.zoom <= .321;
  $('detail-button').classList.toggle('active', camera.zoom >= 4 && !following);
  $('center-button').classList.toggle('active', following);
  $('center-button').setAttribute('aria-pressed', String(following));
  if (route) {
    $('distance-label').textContent = formatDistance(route.remaining * metersPerUnit());
    const eta = Math.max(1, Math.round(route.remaining * metersPerUnit() / 66.67));
    $('eta-label').textContent = `${eta < 60 ? `${eta} мин` : `${Math.floor(eta / 60)} ч ${eta % 60} мин`} пути${paused ? ' · пауза' : ''}`;
  }
}

// Small read-only diagnostics for automated smoke checks and future iteration.
window.__DAY_NEXT__ = {
  getState: () => ({ player: { ...player }, camera: { ...camera }, moving: !!route && !paused, paused, speed, stamina, water, minutes, totalDistance, destination: route ? { ...route.destination } : null, remaining: route?.remaining || 0, discovered: [...discovered] }),
  getWorld: () => world,
  worldToScreen: position => worldToScreen(position),
  getDetails: () => detailRenderer.getStats(),
  inspectAt: (x, y) => detailRenderer.pick(x, y, 1),
};
log('Невада. На карте — следы прежней жизни.', true); updateMapDetails(); updateUI();
function frame(now) {
  const dt = Math.min((now - last) / 1000, .08); last = now;
  update(dt); draw(now / 1000);
  uiTick += dt; if (uiTick >= .15) { updateUI(); uiTick = 0; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
