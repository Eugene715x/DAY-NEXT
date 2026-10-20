import { createWorld, findPath, terrainAt, nearestWalkable } from './world.js';
import { createRealWorld } from './real-world.js';
import { convertOSM, validateBbox } from './scripts/lib/osm-converter.mjs';
import usaMap from './maps/usa.js';
import { createDetailRenderer } from './detail-renderer.js';
import { createTerrainBackdrop, createLandscapeBackdrop } from './terrain-renderer.js';
import { mapFeatureLayer, shouldRenderFeature } from './map-layers.js';
import { ROAD_CLASSES } from './map-presentation.js';
import { createOverviewMarkers, OVERVIEW_MAX_ZOOM } from './map-overview.js';
import { BUILDING_TYPES, BIOME_TYPES, RESOURCE_PROFILES, RESOURCE_KINDS, collectResourceProfiles, collectResourceCandidates } from './gameplay-types.js';

const $ = id => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');
const terrainCanvas = $('terrain-map');
const terrainCtx = terrainCanvas.getContext('2d', { alpha: false });
const objectCache = document.createElement('canvas');
const objectCacheCtx = objectCache.getContext('2d');
let world = createRealWorld(usaMap);
let currentMap = usaMap;
let overviewMarkers = createOverviewMarkers(world);
const layers = { terrain: true, landscape: true, water: true, roads: true, power: true, buildings: true, details: true };
const roadClasses = Object.fromEntries(Object.keys(ROAD_CLASSES).map(key => [key, true]));
let detailRenderer = createDetailRenderer(world);
let hoveredObject = null;
const maximumZoom = () => 24;
const greenPalette = { plain: '#a7ac8d', forest: '#6e8163', water: '#354d49', swamp: '#7f927c', hill: '#a8a38a', road: '#aaa88e', bridge: '#b7b39b' };
const desertPalette = { plain: '#b2aa89', forest: '#788367', water: '#435b54', swamp: '#929b7c', hill: '#a99b7a', road: '#b6ab87', bridge: '#c7bc95' };
let palette = desertPalette;
const metersPerUnit = () => world.metersPerUnit || 5;
const terrainNames = { plain: 'Пустошь', forest: 'Хвойный лес', water: 'Вода', swamp: 'Заболоченная низина', hill: 'Каменистые холмы', road: 'Старая дорога', bridge: 'Мост' };
const kindNames = { village: 'Поселение', town: 'Заброшенный город', city: 'Заброшенный город', settlement: 'Поселение', camp: 'Укрытие', shelter: 'Укрытие', station: 'Станция', factory: 'Промзона', ruins: 'Руины', ruin: 'Руины', danger: 'Опасная зона', bunker: 'Бункер', tower: 'Радиовышка', airport: 'Аэропорт', locality: 'Местность', bridge: 'Переправа', gas: 'Заправка', hospital: 'Медпункт' };
let vw = innerWidth, vh = innerHeight, dpr = Math.min(devicePixelRatio || 1, 2);
let player = { ...world.start };
let camera = { x: player.x, y: player.y, zoom: innerWidth < 640 ? .68 : .85 };
let route = null, paused = false, following = true, speed = 1;
let stamina = 100, water = 100, minutes = 7 * 60 + 42, totalDistance = 0;
let pointer = null, hover = null, hoveredPoi = null, trail = [];
let discovered = new Set(world.pois.filter(p => p.discovered).map(p => p.id));
let last = performance.now(), uiTick = 0, hintTimer, arrivalMarker = null, keys = new Set();
let mapLabelBoxes = [];
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

let terrainBackdrop = createTerrainBackdrop(world, palette);
let landscapeBackdrop = createLandscapeBackdrop(world, palette);
let terrainFrameKey = '';
let terrainRevision = 0;
let objectRevision = 0, objectCacheState = null;
const renderStats = { frames: 0, staticRebuilds: 0, lastStaticMs: 0, lastFrameMs: 0, totalFrameMs: 0 };

function resize() {
  vw = innerWidth; vh = innerHeight; dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr);
  canvas.style.width = `${vw}px`; canvas.style.height = `${vh}px`;
  terrainCanvas.width = canvas.width; terrainCanvas.height = canvas.height;
  terrainCanvas.style.width = `${vw}px`; terrainCanvas.style.height = `${vh}px`;
  terrainFrameKey = '';
  objectCacheState = null;
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

function displayedPois() {
  if (world.geographic && camera.zoom <= OVERVIEW_MAX_ZOOM) return overviewMarkers;
  return world.pois.filter(p => !world.geographic || !overviewMarkers.some(marker => marker.sourceId === (p.sourceId || p.id)));
}
function poiEnabled(poi) { return shouldRenderFeature(poi, 'poi') && (poi.overview ? layers.landscape : layers[mapFeatureLayer(poi, 'poi')]); }
function pickPoi(position, radius = 35) {
  return displayedPois().filter(p => poiEnabled(p) && p.reachable !== false).sort((a, b) => dist(a, position) - dist(b, position)).find(p => dist(p, position) < radius / Math.max(.65, camera.zoom)) || null;
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
  $('map-summary').textContent = currentMap ? `${currentMap.name} · ${(world.width * metersPerUnit() / 1000).toFixed(1)} × ${(world.height * metersPerUnit() / 1000).toFixed(1)} км. ${world.roads.length} исходных участков дорог, ${world.buildings.length} зданий, ${world.pois.length} мест. ${currentMap.source?.snapshotAt ? `Снимок OSM: ${currentMap.source.snapshotAt.slice(0, 10)}` : 'Данные OpenStreetMap'}.` : 'Вымышленная территория · 12 локаций, леса и переправы.';
  $('map-attribution').hidden = !currentMap;
  // Keep source attribution permanent and link only to the known source copyright page.
  $('map-source-link').href = 'https://www.openstreetmap.org/copyright';
  $('map-source-link').textContent = '© OpenStreetMap contributors · ODbL';
  $('map-export').disabled = !currentMap;
  $('detail-button').disabled = !world.buildings?.length;
  syncLayerUI();
  const coverage = world.coverage;
  $('coverage-summary').textContent = coverage ? formatCoverage(coverage) : 'Этот файл не содержит отчёта полноты. Геометрия отображается без замены источника.';
  $('map-bbox').value = (currentMap?.bbox || usaMap.bbox).join(', ');
  updateSourceDownload();
}

function updateSourceDownload() {
  const link = $('map-source-download');
  try {
    const bbox = validateBbox($('map-bbox').value.trim());
    if ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) > .25) throw new Error('api-area');
    const url = new URL('https://api.openstreetmap.org/api/0.6/map');
    url.searchParams.set('bbox', bbox.join(','));
    link.href = url.href;
    link.removeAttribute('aria-disabled'); link.removeAttribute('tabindex');
    $('map-source-status').textContent = 'Откроется скачивание свежего map.osm. Выбери его ниже. Нужен интернет; загружаются объекты, нанесённые в OSM.';
  } catch (error) {
    link.removeAttribute('href'); link.setAttribute('aria-disabled', 'true'); link.setAttribute('tabindex', '-1');
    $('map-source-status').textContent = error.message === 'api-area'
      ? 'Для скачивания уменьши участок: API OSM допускает до 0,25 квадратного градуса.'
      : 'Укажи корректные границы: запад, юг, восток, север. Участок — до 400 км² и 60 км по стороне.';
  }
}

function formatCoverage(coverage) {
  const represented = coverage.representedSourceElements;
  const eligible = coverage.eligibleInBounds;
  const partial = coverage.partialRelations?.length || 0;
  const missing = (coverage.omittedCounts?.incompleteGeometry || 0) + (coverage.omittedCounts?.invalidCoordinate || 0);
  return `${Number.isFinite(represented) ? `Сохранено элементов исходника в границах: ${represented}${Number.isFinite(eligible) ? ` из ${eligible}` : ''}. ` : ''}${missing ? `Не хватает геометрии для ${missing} элементов. ` : ''}${partial ? `Составных объектов с неполной геометрией в исходнике: ${partial}. ` : ''}Снимок: ${world.source?.snapshotAt?.slice(0, 10) || 'дата не указана'}.`;
}

function syncLayerUI() {
  const features = detailRenderer.getFeatures();
  for (const key of Object.keys(layers)) $('layer-' + key).checked = layers[key];
  for (const key of ['landscape', 'water', 'roads', 'power', 'buildings', 'details']) $('count-' + key).textContent = features.filter(feature => feature.layer === key).length;
  for (const key of Object.keys(roadClasses)) {
    const input = $('road-class-' + key);
    input.checked = roadClasses[key]; input.disabled = !layers.roads;
    $('count-road-class-' + key).textContent = features.filter(feature => feature.layer === 'roads' && feature.roadClass === key).length;
  }
  $('road-classes').classList.toggle('is-disabled', !layers.roads);
  if (!world.geographic && landscapeBackdrop) $('count-landscape').textContent = 'биомы';
  terrainCanvas.hidden = !layers.terrain;
}

function closeLayers() { $('layers-panel').hidden = true; $('layers-button').setAttribute('aria-expanded', 'false'); }
for (const key of Object.keys(layers)) $('layer-' + key).addEventListener('change', e => {
  layers[key] = e.target.checked; detailRenderer.setLayers(layers);
  objectRevision++;
  hideObjectCard(); hoveredPoi = null; syncLayerUI();
});
for (const key of Object.keys(roadClasses)) $('road-class-' + key).addEventListener('change', e => {
  roadClasses[key] = e.target.checked; detailRenderer.setRoadClasses(roadClasses);
  objectRevision++; hideObjectCard(); hoveredPoi = null; syncLayerUI();
});
$('layers-button').addEventListener('click', () => {
  const open = $('layers-panel').hidden;
  $('maps-close').click(); $('help-close').click(); hideObjectCard();
  $('layers-panel').hidden = !open; $('layers-button').setAttribute('aria-expanded', String(open));
});
$('layers-close').addEventListener('click', closeLayers);

function switchMap(map) {
  const next = map ? createRealWorld(map) : createWorld();
  world = next; currentMap = map;
  overviewMarkers = createOverviewMarkers(world);
  detailRenderer = createDetailRenderer(world);
  objectCacheState = null; objectRevision++;
  palette = map ? desertPalette : greenPalette;
  terrainBackdrop = createTerrainBackdrop(world, palette); terrainRevision++; terrainFrameKey = '';
  landscapeBackdrop = createLandscapeBackdrop(world, palette);
  detailRenderer.setLayers(layers);
  detailRenderer.setRoadClasses(roadClasses);
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
  const feature = detailRenderer.pick(point.x, point.y, 5 / camera.zoom);
  if (!feature) { hideObjectCard(); return; }
  hoveredObject = feature;
  hoveredPoi = null;
  const names = { settlement_boundary: 'ГРАНИЦА ПОСЕЛЕНИЯ', building: 'ЗДАНИЕ', road: 'ДОРОГА', fence: 'ОГРАДА', wall: 'СТЕНА', gate: 'ВОРОТА', railway: 'ЖЕЛЕЗНАЯ ДОРОГА', parking: 'ПАРКОВКА', pitch: 'СПОРТПЛОЩАДКА', garden: 'САД', pool: 'БАССЕЙН', tree: 'ДЕРЕВО', bench: 'СКАМЕЙКА', picnic_table: 'МЕСТО ДЛЯ ПРИВАЛА', fountain: 'ФОНТАН', well: 'КОЛОДЕЦ', ruins: 'РУИНЫ', shelter: 'УКРЫТИЕ', cemetery: 'КЛАДБИЩЕ', park: 'ПАРК', spring: 'РОДНИК', quarry: 'КАРЬЕР', playground: 'ДЕТСКАЯ ПЛОЩАДКА', cattle_grid: 'РЕШЁТКА НА ДОРОГЕ', runway: 'ВЗЛЁТНАЯ ПОЛОСА', taxiway: 'РУЛЁЖНАЯ ДОРОЖКА', apron: 'ПЕРРОН АЭРОДРОМА', aerodrome: 'АЭРОДРОМ', river: 'ВОДОТОК', lake: 'ОЗЕРО', water: 'ВОДОЁМ', forest: 'ЛЕС', swamp: 'БОЛОТО', plain: 'УЧАСТОК МЕСТНОСТИ', boundary: 'ГРАНИЦА' };
  const zoneNames = { residential: 'ЖИЛАЯ ЗОНА', industrial: 'ПРОМЫШЛЕННАЯ ЗОНА', commercial: 'КОММЕРЧЕСКАЯ ЗОНА', retail: 'ТОРГОВАЯ ЗОНА', farmland: 'ПОЛЯ', sand: 'ПЕСКИ', rock: 'СКАЛЫ', scrub: 'КУСТАРНИК', wetland: 'БОЛОТО' };
  const layerNames = { landscape: 'ЛАНДШАФТ', water: 'ВОДА', roads: 'ДОРОГА', power: 'ЭЛЕКТРОСЕТЬ', buildings: 'ЗДАНИЕ' };
  $('object-kind').textContent = (feature.roadClassName && feature.roadClassName.toUpperCase()) || names[feature.kind] || (feature.layer === 'landscape' && feature.biomeName ? feature.biomeName.toUpperCase() : zoneNames[feature.biome || feature.kind]) || layerNames[feature.layer] || 'ОБЪЕКТ';
  $('object-name').textContent = feature.name || (feature.kind === 'building' ? 'Безымянное здание' : 'Объект на карте');
  const source = feature.source || {};
  const address = typeof source.address === 'string' ? source.address : source.address ? Object.values(source.address).join(', ') : '';
  const extra = [feature.description, address, source.levels ? `${source.levels} эт.` : '', source.surface ? `Покрытие: ${source.surface}` : ''].filter(Boolean).flatMap(text => String(text).split(' · '));
  $('object-meta').textContent = [...new Set(extra)].filter(text => text !== feature.name).join(' · ') || (feature.derived ? 'Игровая зона' : world.geographic ? 'Нанесён на карту OpenStreetMap' : 'Объект игровой карты');
  const zones = detailRenderer.zonesAt(point.x, point.y);
  if (zones.length) $('object-meta').textContent += `\nБиомы: ${[...new Set(zones.map(zone => zone.biomeName || zone.name))].join(' + ')}`;
  if (feature.typeName) $('object-meta').textContent += `\nИгровой тип: ${feature.typeName}`;
  const profiles = collectResourceProfiles(feature, zones);
  if (profiles.length) $('object-meta').textContent += `\nПрофили ресурсов: ${profiles.map(id => RESOURCE_PROFILES[id]?.name || id).join(', ')}`;
  if (feature.derived && feature.provenance?.method?.startsWith('building-density-')) $('object-meta').textContent += '\nСвободная территория среди застройки.';
  if (feature.footprintOnly) $('object-meta').textContent += '\nЗона в пределах нанесённого контура здания.';
  if (touch && camera.zoom >= 2 && ['building', 'ruins'].includes(feature.kind)) $('object-meta').textContent += '\nКоснись земли рядом, чтобы подойти.';
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
  closeLayers();
  $('maps-panel').hidden = !$('maps-panel').hidden;
  $('maps-button').setAttribute('aria-expanded', String(!$('maps-panel').hidden));
  $('help-panel').hidden = true; $('help-button').setAttribute('aria-expanded', 'false');
});
$('maps-close').addEventListener('click', () => { $('maps-panel').hidden = true; $('maps-button').setAttribute('aria-expanded', 'false'); });
$('map-usa').addEventListener('click', () => switchMap(usaMap));
$('map-generated').addEventListener('click', () => switchMap(null));
$('map-export').addEventListener('click', () => { if (currentMap) downloadJSON(currentMap); });
$('map-bbox').addEventListener('input', updateSourceDownload);
$('map-source-download').addEventListener('click', event => { if (event.currentTarget.getAttribute('aria-disabled') === 'true') event.preventDefault(); });
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
$('help-button').addEventListener('click', () => { closeLayers(); hideObjectCard(); $('help-panel').hidden = !$('help-panel').hidden; $('help-button').setAttribute('aria-expanded', String(!$('help-panel').hidden)); $('maps-close').click(); });
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
  if (!pointer && !pinch) {
    if (hoveredPoi) hideObjectCard(); else inspectObject(hover, e.clientX, e.clientY);
  }
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
      const inspectOnly = camera.zoom >= 2 && hoveredObject && ['building', 'ruins'].includes(hoveredObject.kind);
      if (!inspectOnly) setDestination(point);
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
  if (e.key === 'Escape') { if (!$('help-panel').hidden) $('help-close').click(); else if (!$('maps-panel').hidden) $('maps-close').click(); else if (!$('layers-panel').hidden) closeLayers(); else cancelRoute(); }
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
  if (poi.overview) {
    ctx.beginPath(); ctx.arc(0, 0, isHovered ? 8 : 6, 0, Math.PI * 2);
    ctx.fillStyle = '#293e30'; ctx.strokeStyle = '#e2deaf'; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
    if (poi.kind === 'airport') {
      ctx.strokeStyle = '#e2deaf'; ctx.lineWidth = 1.5; ctx.beginPath();
      ctx.moveTo(0, -4); ctx.lineTo(0, 4); ctx.moveTo(-4, 0); ctx.lineTo(4, 0); ctx.stroke();
    } else { ctx.beginPath(); ctx.arc(0, 0, 1.5, 0, Math.PI * 2); ctx.fillStyle = '#e2deaf'; ctx.fill(); }
  } else {
  ctx.rotate(Math.PI / 4); ctx.fillStyle = active ? '#263b2d' : '#49523d'; ctx.strokeStyle = active ? '#d6ddad' : '#b7b99a'; ctx.lineWidth = 1.2;
  ctx.fillRect(-size / 2, -size / 2, size, size); ctx.strokeRect(-size / 2, -size / 2, size, size); ctx.rotate(-Math.PI / 4);
  ctx.fillStyle = active ? '#dbe7b7' : '#c8c6a7'; ctx.fillRect(-1.5, -1.5, 3, 3);
  }
  const anonymous = /· OSM\s+\S+$/.test(poi.name);
  const important = (poi.overview || poi.kind === 'town') && !anonymous;
  const fontSize = camera.zoom < .5 ? 10 : important ? 13 : 11;
  const title = isHovered ? poiTitle(poi) : poi.name;
  ctx.font = `${isHovered || active || important ? 600 : 500} ${fontSize}px "Segoe UI", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const width = ctx.measureText(title).width;
  let offsetY = important ? -31 : 17;
  const boxAt = dy => ({ x: p.x - width / 2 - 5, y: p.y + dy - 3, width: width + 10, height: fontSize + 8 });
  const overlaps = box => mapLabelBoxes.some(b => box.x < b.x + b.width && box.x + box.width > b.x && box.y < b.y + b.height && box.y + box.height > b.y);
  let box = boxAt(offsetY);
  if (important && overlaps(box)) {
    const candidate = (poi.overview ? [-31, 28, -52, 54] : [-31, 28]).find(dy => !overlaps(boxAt(dy)));
    if (candidate !== undefined) { offsetY = candidate; box = boxAt(offsetY); }
  }
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

function drawStaticObjects(time) {
  const key = `${camera.zoom},${vw},${vh},${dpr},${objectRevision},${terrainRevision}`;
  const cached = objectCacheState;
  if (!cached || cached.key !== key || Math.abs(camera.x - cached.x) * camera.zoom > cached.margin || Math.abs(camera.y - cached.y) * camera.zoom > cached.margin) {
    const started = performance.now();
    const margin = Math.round(Math.min(256, Math.min(vw, vh) * .28));
    const width = vw + margin * 2, height = vh + margin * 2;
    // Cache a viewport with a small guard band, never the whole world at street zoom.
    const scale = Math.min(dpr, Math.sqrt(16000000 / (width * height)));
    const pixelWidth = Math.ceil(width * scale), pixelHeight = Math.ceil(height * scale);
    if (objectCache.width !== pixelWidth) objectCache.width = pixelWidth;
    if (objectCache.height !== pixelHeight) objectCache.height = pixelHeight;
    objectCacheCtx.setTransform(1, 0, 0, 1, 0, 0);
    objectCacheCtx.clearRect(0, 0, pixelWidth, pixelHeight);
    objectCacheCtx.setTransform(scale, 0, 0, scale, 0, 0);
    objectCacheCtx.save(); objectCacheCtx.translate(width / 2, height / 2); objectCacheCtx.scale(camera.zoom, camera.zoom); objectCacheCtx.translate(-camera.x, -camera.y);
    if (layers.landscape && landscapeBackdrop) objectCacheCtx.drawImage(landscapeBackdrop, 0, 0);
    detailRenderer.draw(objectCacheCtx, { zoom: camera.zoom, cameraX: camera.x, cameraY: camera.y, width, height, time, hoveredId: null });
    objectCacheCtx.restore();
    objectCacheState = { key, x: camera.x, y: camera.y, margin, scale, width, height };
    renderStats.staticRebuilds++; renderStats.lastStaticMs = performance.now() - started;
  }
  const state = objectCacheState;
  const x = (state.margin + (camera.x - state.x) * camera.zoom) * state.scale;
  const y = (state.margin + (camera.y - state.y) * camera.zoom) * state.scale;
  ctx.drawImage(objectCache, x, y, vw * state.scale, vh * state.scale, 0, 0, vw, vh);
}

function draw(time) {
  const started = performance.now();
  const frameKey = `${camera.x.toFixed(4)},${camera.y.toFixed(4)},${camera.zoom},${canvas.width},${canvas.height},${terrainRevision}`;
  if (layers.terrain && terrainFrameKey !== frameKey) {
    terrainCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    terrainCtx.fillStyle = '#1b2721'; terrainCtx.fillRect(0, 0, vw, vh);
    terrainCtx.save(); terrainCtx.translate(vw / 2, vh / 2); terrainCtx.scale(camera.zoom, camera.zoom); terrainCtx.translate(-camera.x, -camera.y);
    terrainCtx.drawImage(terrainBackdrop, 0, 0); terrainCtx.restore(); terrainFrameKey = frameKey;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vw, vh);
  drawStaticObjects(time);
  ctx.save(); ctx.translate(vw / 2, vh / 2); ctx.scale(camera.zoom, camera.zoom); ctx.translate(-camera.x, -camera.y);
  detailRenderer.drawHighlight(ctx, { zoom: camera.zoom, cameraX: camera.x, cameraY: camera.y, width: vw, height: vh, time }, hoveredObject);
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
  const availablePois = displayedPois();
  const pois = world.geographic ? [...availablePois].sort((a, b) => Number(b.id === hoveredPoi?.id) - Number(a.id === hoveredPoi?.id) || Number(b.kind === 'settlement' || b.kind === 'airport') - Number(a.kind === 'settlement' || a.kind === 'airport') || Number(discovered.has(b.id)) - Number(discovered.has(a.id))) : availablePois;
  for (const poi of pois) if (poiEnabled(poi) && (camera.zoom < 4 || hoveredPoi?.id === poi.id || poi.kind === 'town')) drawPoi(poi, time);
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
  renderStats.frames++; renderStats.lastFrameMs = performance.now() - started; renderStats.totalFrameMs += renderStats.lastFrameMs;
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
  const biomes = [...new Set(detailRenderer.zonesAt(player.x, player.y).map(zone => zone.biomeName || zone.name))];
  $('biome-label').hidden = !biomes.length;
  $('biome-label').textContent = biomes.length ? `Биомы: ${biomes.join(' + ')}` : '';
  $('biome-label').title = $('biome-label').textContent;
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
  zonesAt: (x, y) => detailRenderer.zonesAt(x, y),
  getLayers: () => ({ ...layers }),
  getRoadClasses: () => ({ ...roadClasses }),
  getOverviewMarkers: () => overviewMarkers.map(marker => ({ ...structuredClone(marker), visible: world.geographic && camera.zoom <= OVERVIEW_MAX_ZOOM && poiEnabled(marker) })),
  getFeatures: () => detailRenderer.getFeatures(),
  getRenderStats: () => ({ ...renderStats, meanFrameMs: renderStats.totalFrameMs / Math.max(1, renderStats.frames), cachePixels: objectCache.width * objectCache.height, cacheBytes: objectCache.width * objectCache.height * 4, renderer: detailRenderer.getStats() }),
  getTypeCatalogs: () => structuredClone({ buildingTypes: BUILDING_TYPES, biomeTypes: BIOME_TYPES, resourceProfiles: RESOURCE_PROFILES, resourceKinds: RESOURCE_KINDS }),
  getResourceCandidatesAt: (x, y) => collectResourceCandidates(detailRenderer.pick(x, y, 1), detailRenderer.zonesAt(x, y)),
};
log('Невада. На карте — следы прежней жизни.', true); updateMapDetails(); updateUI();
function frame(now) {
  const dt = Math.min((now - last) / 1000, .08); last = now;
  update(dt); draw(now / 1000);
  uiTick += dt; if (uiTick >= .15) { updateUI(); uiTick = 0; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
