import { findPath, terrainAt } from './world.js';
import { createRealWorld, prepareTravelWorld } from './real-world.js';
import { MOVEMENT_FACTORS, advanceAlongRoute, movementAt } from './movement-model.js';
import { LANDSCAPE_TYPES, createLandscape } from './landscape.js';
import { createLandmarkMarkers } from './landmark-markers.js';
import { createWorldLoot } from './world-loot.js';
import { createGroundPileRenderer } from './ground-pile-renderer.js';
import { createInventoryUI } from './inventory-ui.js';
import usaMap from './maps/usa.js';
import beattyElevation from './maps/beatty-elevation.js';
import { createElevationRenderer } from './elevation-renderer.js';
import { createDetailRenderer } from './detail-renderer.js';
import { mapFeatureLayer, shouldRenderFeature } from './map-layers.js';
import { ROAD_CLASSES } from './map-presentation.js';
import { BUILDING_CATEGORIES, BUILDING_ROLES } from './building-roles.js';
import { createOverviewMarkers, OVERVIEW_MAX_ZOOM } from './map-overview.js';
import { BUILDING_TYPES, BIOME_TYPES, RESOURCE_PROFILES, RESOURCE_KINDS, classifyBuilding, collectResourceProfiles, collectResourceCandidates } from './gameplay-types.js';

const $ = id => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');
const objectCache = document.createElement('canvas');
const objectCacheCtx = objectCache.getContext('2d');
const createGameWorld = map => createRealWorld(map, { navigationCellSize: map.cellSize / 4 });
const world = createGameWorld(usaMap);
const layers = { biomes: true, elevation: true, landscape: false, roads: true, power: true, buildings: true, details: true };
const roadClasses = Object.fromEntries(Object.keys(ROAD_CLASSES).map(key => [key, true]));
const detailRenderer = createDetailRenderer(world);
const elevationRenderer = createElevationRenderer(world, beattyElevation);
const landscape = createLandscape(world, { elevationAt: elevationRenderer.available ? elevationRenderer.sampleAt : null });
prepareTravelWorld(world, { landscape, elevationAt: elevationRenderer.available ? elevationRenderer.sampleAt : null, biomeFeatures: detailRenderer.getFeatures().filter(feature => feature.exclusive) });
const overviewMarkers = createOverviewMarkers(world);
const landmarkRenderer = createLandmarkMarkers(world, { elevationAt: elevationRenderer.available ? elevationRenderer.sampleAt : null });
const landmarkSourceIds = new Set(landmarkRenderer.getMarkers().map(marker => marker.sourceId));
const typedBuildingSources = new Set(detailRenderer.getFeatures().filter(feature => feature.gameplayAssignment).flatMap(feature => [feature.sourceId || feature.id, ...(feature.gameplayAssignment.evidenceIds || [])]));
const countryLabel = usaMap.country === 'US' ? 'США' : usaMap.country;
const regionLabel = String(usaMap.region || '').split(',').map(part => part.trim()).filter(part => part && part !== countryLabel && part !== usaMap.country).join(', ');
const placeLabels = { Beatty: 'Битти', Rhyolite: 'Райолит', Bullfrog: 'Буллфрог', 'Gold Center': 'Голд-Сентер' };
const regionPlaces = overviewMarkers.filter(marker => marker.tags?.place);
let hoveredObject = null, hoveredPile = null;
const maximumZoom = () => 24;
const metersPerUnit = () => world.metersPerUnit || 5;
const terrainNames = { plain: 'Пустошь', forest: 'Хвойный лес', water: 'Вода', swamp: 'Заболоченная низина', hill: 'Каменистые холмы', road: 'Старая дорога', bridge: 'Мост' };
const kindNames = { village: 'Поселение', town: 'Заброшенный город', city: 'Заброшенный город', settlement: 'Поселение', camp: 'Укрытие', shelter: 'Укрытие', station: 'Станция', factory: 'Промзона', ruins: 'Руины', ruin: 'Руины', danger: 'Опасная зона', bunker: 'Бункер', tower: 'Радиовышка', airport: 'Аэропорт', locality: 'Местность', bridge: 'Переправа', gas: 'Заправка', hospital: 'Медпункт' };
let vw = innerWidth, vh = innerHeight, dpr = Math.min(devicePixelRatio || 1, 2);
let player = { ...world.start };
let camera = { x: world.width / 2, y: world.height / 2, zoom: Math.max(.32, Math.min(.85, (innerWidth - 360) / world.width, (innerHeight - 210) / world.height)) };
let route = null, paused = false, following = false, speed = 1;
const GAME_MINUTES_PER_SECOND = 1;
let stamina = 100, water = 100, minutes = 7 * 60 + 42, totalDistance = 0;
let pointer = null, hover = null, hoveredPoi = null, trail = [];
let discovered = new Set(world.pois.filter(p => p.discovered).map(p => p.id));
let last = performance.now(), uiTick = 0, hintTimer, arrivalMarker = null, keys = new Set();
const inventoryModel = createWorldLoot(world, { buildingAssignments: detailRenderer.getFeatures().filter(feature => feature.gameplayAssignment) });
const groundPileRenderer = createGroundPileRenderer();
const lootSaveKey = `day-next:world-loot:v1:${world.id}`;
let lootRevision = -1, lootContextRevision = -1, lootSaveStatus = 'new';
restoreLoot();
let itemWindows = null;
itemWindows = createInventoryUI({ root: $('game-windows'), model: inventoryModel, onContextOpen: context => {
  if (route && !paused) togglePause();
  inventoryModel.setPosition(player, { moving: false });
  inventoryModel.openContext(context?.id);
  syncWorldLoot(false);
}, onTransfer: () => syncWorldLoot(false), onVisibilityChange: () => {
  keys.clear();
  const open = itemWindows?.hasOpenWindows() || false;
  $('items-button').setAttribute('aria-expanded', String(open));
  if (open) { closeLayers(); $('help-close').click(); hideObjectCard(); }
} });
$('items-button').addEventListener('click', () => itemWindows.toggleWorkspace());
let mapLabelBoxes = [];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const poiTitle = poi => {
  if (poi.landmark || landmarkSourceIds.has(poi.sourceId || poi.id)) return poi.name;
  const tags = poi.tags || {};
  if (poi.overview || tags.place || tags['abandoned:place'] || tags.natural) return String(poi.name || 'Местность').replace(/\s*· OSM\s+\S+$/, '');
  const type = classifyBuilding(poi);
  return type.typeId !== 'building.unknown' ? type.typeName : kindNames[poi.kind] || 'Объект';
};
const formatDistance = d => d >= 1000 ? `${(d / 1000).toFixed(1).replace('.', ',')} км` : `${Math.max(0, Math.round(d / 10) * 10)} м`;
const formatFactor = value => `×${Number(value).toFixed(value < .1 ? 3 : 2).replace('.', ',')}`;
const screenToWorld = (x, y) => ({ x: (x - vw / 2) / camera.zoom + camera.x, y: (y - vh / 2) / camera.zoom + camera.y });
const worldToScreen = p => ({ x: (p.x - camera.x) * camera.zoom + vw / 2, y: (p.y - camera.y) * camera.zoom + vh / 2 });

function line(context, points) {
  context.beginPath();
  points.forEach((p, i) => i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y));
}

let objectRevision = 0, objectCacheState = null;
const renderStats = { frames: 0, staticRebuilds: 0, lastStaticMs: 0, lastFrameMs: 0, totalFrameMs: 0, lastRouteSearchMs: 0 };

function restoreLoot() {
  try {
    const raw = localStorage.getItem(lootSaveKey);
    if (raw) {
      const saved = JSON.parse(raw), point = saved.player;
      if (saved.schema !== 1 || saved.mapId !== world.id || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
        || point.x < 0 || point.y < 0 || point.x >= world.width || point.y >= world.height || !terrainAt(world, point.x, point.y)?.walkable
        || !['minutes', 'stamina', 'water', 'totalDistance'].every(key => Number.isFinite(saved[key]) && saved[key] >= 0)
        || !inventoryModel.importState(saved.loot).ok) throw new Error('Invalid checkpoint');
      player = { x: point.x, y: point.y }; minutes = saved.minutes;
      stamina = Math.min(100, saved.stamina); water = Math.min(100, saved.water); totalDistance = saved.totalDistance;
      lootSaveStatus = 'restored';
    }
  } catch { lootSaveStatus = 'unavailable-or-invalid'; }
  inventoryModel.setPosition(player, { moving: false });
}
function saveLoot() {
  try {
    localStorage.setItem(lootSaveKey, JSON.stringify({ schema: 1, mapId: world.id, loot: inventoryModel.exportState(), player, minutes, stamina, water, totalDistance }));
    lootSaveStatus = 'saved';
  } catch { lootSaveStatus = 'session-only'; }
}
function syncWorldLoot(refresh = true) {
  const revision = inventoryModel.getRevision(), context = inventoryModel.getContext();
  const changed = revision !== lootRevision, contextChanged = context.revision !== lootContextRevision;
  if (changed) {
    lootRevision = revision; groundPileRenderer.setPiles(inventoryModel.getGroundPiles()); objectRevision++; saveLoot();
  }
  lootContextRevision = context.revision;
  if (refresh && (changed || contextChanged) && itemWindows?.isWindowOpen('ground')) itemWindows.refresh();
}
function syncLootPosition() {
  inventoryModel.setPosition(player, { moving: !!route && !paused }); syncWorldLoot();
}
function openLocalLoot(target) {
  inventoryModel.setPosition(player, { moving: false });
  const context = inventoryModel.getContext();
  if (target && context.id !== target.id) return false;
  itemWindows.openWindow('inventory'); itemWindows.openWindow('ground');
  return true;
}
addEventListener('pagehide', saveLoot);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveLoot(); });
syncWorldLoot(false);

function resize() {
  vw = innerWidth; vh = innerHeight; dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr);
  canvas.style.width = `${vw}px`; canvas.style.height = `${vh}px`;
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
  return world.pois.filter(p => !landmarkSourceIds.has(p.sourceId || p.id) && !typedBuildingSources.has(p.sourceId || p.id) && (!world.geographic || !overviewMarkers.some(marker => marker.sourceId === (p.sourceId || p.id))));
}
function poiEnabled(poi) {
  const sourceLayer = mapFeatureLayer(poi, 'poi');
  const layer = poi.overview || sourceLayer === 'landscape' || sourceLayer === 'water' ? 'biomes' : sourceLayer;
  return shouldRenderFeature(poi, 'poi') && layers[layer];
}
function pickPoi(position, radius = 35) {
  return displayedPois().filter(p => poiEnabled(p) && p.reachable !== false).sort((a, b) => dist(a, position) - dist(b, position)).find(p => dist(p, position) < radius / Math.max(.65, camera.zoom)) || null;
}

function setDestination(position) {
  const pile = groundPileRenderer.pick(position.x, position.y, { zoom: camera.zoom, layers });
  const feature = pile ? null : detailRenderer.pick(position.x, position.y, 0);
  const building = feature?.gameplayAssignment ? feature : null;
  const lootTarget = pile ? { kind: 'pile', id: pile.id } : building ? { kind: 'building', id: `building:${building.sourceId || building.id}` } : null;
  if (lootTarget && inventoryModel.getContext().id === lootTarget.id) {
    if (route && !paused) togglePause();
    openLocalLoot(lootTarget); return;
  }
  const poi = lootTarget ? null : landmarkRenderer.pick(position.x, position.y, 10 / camera.zoom, { zoom: camera.zoom, layers }) || pickPoi(position, 34);
  const target = pile ? { x: pile.x, y: pile.y } : poi ? { x: poi.x, y: poi.y } : position;
  if (target.x < 0 || target.y < 0 || target.x >= world.width || target.y >= world.height) { toast('Здесь заканчивается лист карты.'); return; }
  if (!terrainAt(world, target.x, target.y)?.walkable) { toast('Вода непроходима. Ищи мост или обойди берег.'); return; }
  const searchStarted = performance.now();
  const result = findPath(world, player, target);
  renderStats.lastRouteSearchMs = performance.now() - searchStarted;
  if (!result || !result.points.length) { toast('Путь закрыт. Попробуй другой берег или дорогу.'); return; }
  if (result.distance < 5 && !lootTarget) return;
  const name = pile ? 'Предметы на земле' : building ? building.gameplayAssignment.roleName : poi ? poiTitle(poi) : terrainNames[terrainAt(world, target.x, target.y)?.type] || 'Точка на карте';
  route = { ...result, points: result.points.map(p => ({ ...p })), index: 0, destination: target, name, lootTarget, remaining: result.distance, remainingDurationMinutes: result.durationMinutes };
  paused = false; arrivalMarker = target;
  log(`Маршрут: ${name.toLowerCase()}`, true);
  $('travel-panel').hidden = false; $('destination-label').textContent = name;
  $('pause-button').textContent = 'Ⅱ Пауза'; $('pause-button').setAttribute('aria-label', 'Приостановить движение');
  syncLootPosition(); updateUI();
}

function cancelRoute() {
  if (!route) return;
  route = null; paused = false; arrivalMarker = null; $('travel-panel').hidden = true;
  syncLootPosition(); saveLoot(); log('Маршрут отменён.'); updateUI();
}
function togglePause() {
  if (!route) return;
  paused = !paused;
  $('pause-button').textContent = paused ? '▶ Продолжить' : 'Ⅱ Пауза';
  $('pause-button').setAttribute('aria-label', paused ? 'Продолжить движение' : 'Приостановить движение');
  syncLootPosition(); saveLoot(); updateUI();
}
function reset() {
  player = { ...world.start }; camera.x = player.x; camera.y = player.y;
  route = null; paused = false; following = true; speed = 1;
  stamina = water = 100; minutes = 7 * 60 + 42; totalDistance = 0; trail = []; arrivalMarker = null;
  discovered = new Set(world.pois.filter(p => p.discovered).map(p => p.id));
  itemWindows.reset();
  syncLootPosition(); saveLoot();
  hideObjectCard();
  $('travel-panel').hidden = true; $('speed-button').textContent = '1×'; $('activity-log').replaceChildren();
  log('Новый день. Впереди — неизвестность.', true); toast('Вернулись к началу экспедиции.'); updateUI();
}

function syncLayerUI() {
  for (const key of Object.keys(layers)) $('layer-' + key).checked = layers[key];
  for (const key of Object.keys(roadClasses)) {
    const input = $('road-class-' + key);
    input.checked = roadClasses[key]; input.disabled = !layers.roads;
    $('factor-road-class-' + key).textContent = formatFactor(MOVEMENT_FACTORS.roads[key]);
    $('factor-road-class-' + key).title = 'Бонус дороги; покрытие уточняет значение';
  }
  $('road-classes').classList.toggle('is-disabled', !layers.roads);
  $('biome-key').classList.toggle('is-disabled', !layers.biomes);
  for (const biome of ['city', 'wasteland', 'sand']) $('factor-biome-' + biome).textContent = formatFactor(MOVEMENT_FACTORS.biomes[biome]);
  syncElevationUI();
  syncLandscapeUI();
}

function syncElevationUI() {
  const info = elevationRenderer.getInfo(), available = elevationRenderer.available;
  const active = available && layers.elevation;
  $('layer-elevation').disabled = !available;
  $('elevation-button').disabled = !available;
  $('elevation-button').setAttribute('aria-pressed', String(active));
  $('elevation-key').hidden = !active;
  $('elevation-unavailable').hidden = available;
  if (!available) return;
  $('elevation-min').textContent = 'ТЕНИ';
  $('elevation-max').textContent = 'СВЕТ';
  $('elevation-mid').textContent = 'НЕЙТРАЛЬНО';
  $('elevation-gradient').style.background = 'linear-gradient(90deg,#454545,#808080,#c5c5c5)';
  $('elevation-source').textContent = `USGS 3DEP · ${Math.floor(info.min)}–${Math.ceil(info.max)} м · горизонтали ${info.contourInterval} м`;
}

function syncLandscapeUI() {
  const available = landscape.available;
  $('layer-landscape').disabled = !available;
  $('landscape-unavailable').hidden = available;
  $('landscape-legend').classList.toggle('is-disabled', !available || !layers.landscape);
  $('landscape-legend').replaceChildren(...Object.entries(LANDSCAPE_TYPES).map(([id, type]) => {
    const row = document.createElement('div'); row.className = 'landscape-legend-row';
    const swatch = document.createElement('i'); swatch.style.backgroundColor = type.color; swatch.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.textContent = type.name;
    const factor = document.createElement('span'); factor.className = 'landscape-factor'; factor.textContent = `×${type.multiplier.toFixed(2).replace('.', ',')}`;
    row.dataset.landscape = id; row.append(swatch, label, factor); return row;
  }));
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
  if (open) itemWindows.closeAll();
  $('help-close').click(); hideObjectCard();
  $('layers-panel').hidden = !open; $('layers-button').setAttribute('aria-expanded', String(open));
});
$('layers-close').addEventListener('click', closeLayers);
$('elevation-button').addEventListener('click', () => {
  if (!elevationRenderer.available) return;
  $('layer-elevation').checked = !layers.elevation;
  $('layer-elevation').dispatchEvent(new Event('change'));
});

function hideObjectCard() {
  hoveredObject = null;
  $('object-card').hidden = true;
  $('map-tooltip').hidden = true;
}

const quietHoverLayers = new Set(['biomes', 'roads', 'power']);
const roadHoverNames = { highway: 'Магистраль', road: 'Дорога', street: 'Улица / проезд', track: 'Грунтовая дорога', trail: 'Тропа', railway: 'Железная дорога' };

function showMapTooltip(label, screenX, screenY) {
  const tooltip = $('map-tooltip');
  $('object-card').hidden = true;
  const position = screenToWorld(screenX, screenY);
  const height = layers.elevation && elevationRenderer.available ? elevationRenderer.sampleAt(position.x, position.y) : null;
  const land = landscape.getAt(position.x, position.y);
  const landscapeLabel = land ? `${land.name} ×${land.multiplier.toFixed(2).replace('.', ',')}` : '';
  const movement = movementAt(world, position.x, position.y);
  const biomeFactor = `Биом ${formatFactor(movement.biomeMultiplier)}`;
  const roadFactor = movement.roadMultiplier > 1 ? `Дорога ${formatFactor(movement.roadMultiplier)}` : '';
  tooltip.textContent = [label, biomeFactor, landscapeLabel, roadFactor, Number.isFinite(height) ? `${Math.round(height)} м` : ''].filter(Boolean).join(' · ');
  tooltip.hidden = false;
  const bounds = tooltip.getBoundingClientRect();
  const left = screenX + 14 + bounds.width > vw - 8 ? screenX - bounds.width - 14 : screenX + 14;
  const top = screenY + 18 + bounds.height > vh - 8 ? screenY - bounds.height - 12 : screenY + 18;
  tooltip.style.left = `${clamp(left, 8, Math.max(8, vw - bounds.width - 8))}px`;
  tooltip.style.top = `${clamp(top, 8, Math.max(8, vh - bounds.height - 8))}px`;
}

function briefMapLabel(feature) {
  const type = feature.layer === 'roads' ? roadHoverNames[feature.roadClass] || 'Дорога'
    : feature.layer === 'power' ? feature.kind === 'substation' ? 'Подстанция' : 'ЛЭП'
    : feature.biomeName || feature.typeName || 'Местность';
  const name = feature.layer === 'roads' || feature.layer === 'buildings' ? '' : (feature.source?.name || feature.source?.tags?.name || '').trim();
  // A named place helps orientation; technical or generic names add no detail.
  const named = name && name !== type && !/^(Зона:|Участок|Пустошь$|Городская местность$)/.test(name);
  return named ? `${type} · ${name.length > 48 ? name.slice(0, 47) + '…' : name}` : type;
}

function inspectObject(point, screenX, screenY, touch = false, pickedFeature) {
  const feature = pickedFeature === undefined ? detailRenderer.pick(point.x, point.y, 5 / camera.zoom) : pickedFeature;
  if (!feature) {
    hideObjectCard();
    if ((layers.elevation && elevationRenderer.available) || (layers.landscape && landscape.available)) showMapTooltip(layers.landscape ? 'Ландшафт' : 'Высота', screenX, screenY);
    return;
  }
  hoveredObject = feature;
  hoveredPoi = null;
  if (quietHoverLayers.has(feature.layer)) {
    showMapTooltip(briefMapLabel(feature), screenX, screenY);
    return;
  }
  $('map-tooltip').hidden = true;
  const names = { settlement_boundary: 'ГРАНИЦА ПОСЕЛЕНИЯ', building: 'ЗДАНИЕ', road: 'ДОРОГА', fence: 'ОГРАДА', wall: 'СТЕНА', gate: 'ВОРОТА', railway: 'ЖЕЛЕЗНАЯ ДОРОГА', parking: 'ПАРКОВКА', pitch: 'СПОРТПЛОЩАДКА', garden: 'САД', pool: 'БАССЕЙН', tree: 'ДЕРЕВО', bench: 'СКАМЕЙКА', picnic_table: 'МЕСТО ДЛЯ ПРИВАЛА', fountain: 'ФОНТАН', well: 'КОЛОДЕЦ', ruins: 'РУИНЫ', shelter: 'УКРЫТИЕ', cemetery: 'КЛАДБИЩЕ', park: 'ПАРК', spring: 'РОДНИК', quarry: 'КАРЬЕР', playground: 'ДЕТСКАЯ ПЛОЩАДКА', cattle_grid: 'РЕШЁТКА НА ДОРОГЕ', runway: 'ВЗЛЁТНАЯ ПОЛОСА', taxiway: 'РУЛЁЖНАЯ ДОРОЖКА', apron: 'ПЕРРОН АЭРОДРОМА', aerodrome: 'АЭРОДРОМ', river: 'ВОДОТОК', lake: 'ОЗЕРО', water: 'ВОДОЁМ', forest: 'ЛЕС', swamp: 'БОЛОТО', plain: 'УЧАСТОК МЕСТНОСТИ', boundary: 'ГРАНИЦА' };
  const zoneNames = { residential: 'ЖИЛАЯ ЗОНА', industrial: 'ПРОМЫШЛЕННАЯ ЗОНА', commercial: 'КОММЕРЧЕСКАЯ ЗОНА', retail: 'ТОРГОВАЯ ЗОНА', farmland: 'ПОЛЯ', sand: 'ПЕСКИ', rock: 'СКАЛЫ', scrub: 'КУСТАРНИК', wetland: 'БОЛОТО' };
  const layerNames = { biomes: 'БИОМ', roads: 'ДОРОГА', power: 'ЭЛЕКТРОСЕТЬ', buildings: 'ЗДАНИЕ' };
  const assignment = feature.gameplayAssignment;
  const lootState = assignment ? inventoryModel.getBuildingState(feature.sourceId || feature.id) : null;
  const card = $('object-card');
  card.classList.toggle('is-building', !!assignment);
  card.style.setProperty('--object-type-color', assignment?.color || assignment?.category?.color || '#bccca4');
  card.dataset.roleId = assignment?.roleId || '';
  $('object-kind').textContent = assignment?.categoryName?.toUpperCase() || (feature.roadClassName && feature.roadClassName.toUpperCase()) || names[feature.kind] || (feature.layer === 'biomes' && feature.biomeName ? feature.biomeName.toUpperCase() : zoneNames[feature.biome || feature.kind]) || layerNames[feature.layer] || 'ОБЪЕКТ';
  $('object-name').textContent = assignment?.roleName || feature.name || (feature.kind === 'building' ? 'Безымянное здание' : 'Объект на карте');
  const source = feature.source || {};
  const buildingDescription = assignment ? [assignment.condition === 'ruined' ? 'Руины' : assignment.condition === 'abandoned' ? 'Заброшено' : '', assignment.roleOrigin === 'gameplay' ? 'Игровое назначение' : assignment.roleOrigin === 'context' ? 'Назначение по окружению' : 'Назначение по меткам карты'].filter(Boolean).join(' · ') : feature.description;
  const extra = [buildingDescription].filter(Boolean).flatMap(text => String(text).split(' · '));
  $('object-meta').textContent = [...new Set(extra)].filter(text => text !== (assignment?.roleName || feature.name)).join(' · ') || (feature.derived ? 'Игровая зона' : world.geographic ? 'Нанесён на карту OpenStreetMap' : 'Объект игровой карты');
  if (lootState?.visited) $('object-meta').textContent += `\nОткрыто · ${lootState.empty ? 'Пусто' : 'Есть предметы'}`;
  const zones = detailRenderer.zonesAt(point.x, point.y);
  if (zones.length) $('object-meta').textContent += `\nБиом: ${[...new Set(zones.map(zone => zone.biomeName || zone.name))].join(' + ')}`;
  const elevation = layers.elevation && elevationRenderer.available ? elevationRenderer.sampleAt(point.x, point.y) : null;
  if (Number.isFinite(elevation)) $('object-meta').textContent += `\nВысота: ${Math.round(elevation)} м`;
  const land = landscape.getAt(point.x, point.y);
  if (land) $('object-meta').textContent += `\nЛандшафт: ${land.name} ×${land.multiplier.toFixed(2).replace('.', ',')}`;
  if (feature.typeName && !assignment) $('object-meta').textContent += `\nИгровой тип: ${feature.typeName}`;
  const profiles = collectResourceProfiles(assignment || feature, zones);
  if (profiles.length) $('object-meta').textContent += `\nПрофили ресурсов: ${profiles.map(id => RESOURCE_PROFILES[id]?.name || id).join(', ')}`;
  if (feature.derived && feature.provenance?.method?.startsWith('building-density-')) $('object-meta').textContent += '\nСвободная территория среди застройки.';
  if (feature.footprintOnly) $('object-meta').textContent += '\nЗона в пределах нанесённого контура здания.';
  if (touch && camera.zoom >= 2 && ['building', 'ruins'].includes(feature.kind)) $('object-meta').textContent += '\nКоснись земли рядом, чтобы подойти.';
  $('object-card').hidden = false;
  const bounds = $('object-card').getBoundingClientRect();
  $('object-card').style.left = `${clamp(screenX + 18, 12, vw - bounds.width - 12)}px`;
  $('object-card').style.top = `${clamp(screenY + 20 + bounds.height > vh - 60 ? screenY - bounds.height - 18 : screenY + 20, 90, vh - bounds.height - 45)}px`;
}

$('pause-button').addEventListener('click', togglePause);
$('cancel-button').addEventListener('click', cancelRoute);
$('center-button').addEventListener('click', () => { hideObjectCard(); following = true; camera.x = player.x; camera.y = player.y; updateUI(); });
$('reset-button').addEventListener('click', reset);
$('speed-button').addEventListener('click', () => { speed = speed === 1 ? 3 : 1; $('speed-button').textContent = `${speed}×`; toast(`Темп времени: ${speed}×`); });
$('help-button').addEventListener('click', () => { itemWindows.closeAll(); closeLayers(); hideObjectCard(); $('help-panel').hidden = !$('help-panel').hidden; $('help-button').setAttribute('aria-expanded', String(!$('help-panel').hidden)); });
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
  hover = screenToWorld(e.clientX, e.clientY);
  hoveredPile = !pointer && !pinch ? groundPileRenderer.pick(hover.x, hover.y, { zoom: camera.zoom, layers }) : null;
  const pickedFeature = !pointer && !pinch && !hoveredPile ? detailRenderer.pick(hover.x, hover.y, 5 / camera.zoom) : null;
  hoveredPoi = hoveredPile ? null : landmarkRenderer.pick(hover.x, hover.y, 10 / camera.zoom, { zoom: camera.zoom, layers }) || (pickedFeature?.gameplayAssignment ? null : pickPoi(hover));
  if (!pointer && !pinch) {
    if (hoveredPile) {
      hideObjectCard(); showMapTooltip(`Предметы на земле · ${hoveredPile.itemCount}`, e.clientX, e.clientY);
    } else if (hoveredPoi) {
      hideObjectCard();
      showMapTooltip(landmarkSourceIds.has(hoveredPoi.sourceId) ? `${poiTitle(hoveredPoi)}` : `${kindNames[hoveredPoi.kind] || 'Место'} · ${poiTitle(hoveredPoi)}`, e.clientX, e.clientY);
    } else inspectObject(hover, e.clientX, e.clientY, false, pickedFeature);
  }
  canvas.style.cursor = pointer?.moved ? 'grabbing' : hoveredPile || hoveredPoi || hoveredObject && !quietHoverLayers.has(hoveredObject.layer) ? 'pointer' : 'crosshair';
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
canvas.addEventListener('pointerleave', e => { hover = null; hoveredPoi = null; hoveredPile = null; if (e.pointerType !== 'touch') hideObjectCard(); });
addEventListener('keydown', e => {
  if (e.defaultPrevented || e.target instanceof Element && e.target.closest('#game-windows')) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  if (e.target instanceof HTMLButtonElement && [' ', 'Enter'].includes(e.key)) return;
  if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
  if (e.repeat && [' ', 'f', 'F', 'r', 'R'].includes(e.key)) return;
  if (e.key === ' ') togglePause();
  if (e.key === 'Escape') { if (!$('help-panel').hidden) $('help-close').click(); else if (!$('layers-panel').hidden) closeLayers(); else cancelRoute(); }
  if (e.key.toLowerCase() === 'f') $('center-button').click();
  if (e.key.toLowerCase() === 'r') reset();
  if (e.key === '+' || e.key === '=') zoomBy(1.2);
  if (e.key === '-') zoomBy(1 / 1.2);
  keys.add(e.key.toLowerCase());
});
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => { keys.clear(); pointer = null; touches.clear(); pinch = null; wasPinch = false; hoveredPoi = null; hideObjectCard(); });

function update(dt) {
  const panX = Number(keys.has('d') || keys.has('arrowright')) - Number(keys.has('a') || keys.has('arrowleft'));
  const panY = Number(keys.has('s') || keys.has('arrowdown')) - Number(keys.has('w') || keys.has('arrowup'));
  if (panX || panY) { hideObjectCard(); following = false; camera.x += panX * dt * 450 / camera.zoom; camera.y += panY * dt * 450 / camera.zoom; }
  if (route && !paused) {
    const travel = advanceAlongRoute(world, route, player, dt * GAME_MINUTES_PER_SECOND * speed);
    if (travel.blocked) {
      cancelRoute(); toast('Этот путь недоступен. Выбери другую точку.');
    } else {
      totalDistance += travel.walkedMeters; minutes += travel.elapsedMinutes;
      stamina = Math.max(5, stamina - travel.walkedDistance * .018); water = Math.max(10, water - travel.walkedDistance * .005);
      if (!trail.length || dist(player, trail[trail.length - 1]) > 9) { trail.push({ ...player }); if (trail.length > 350) trail.shift(); }
      if (travel.arrived) {
        const lootTarget = route.lootTarget;
        log(`На месте: ${route.name.toLowerCase()}`, true);
        route = null; paused = false; arrivalMarker = null; $('travel-panel').hidden = true;
        syncLootPosition(); saveLoot();
        toast(lootTarget ? 'Ты на месте. G — вещи рядом.' : 'Ты на месте. Выбери, куда идти дальше.');
      }
    }
    for (const poi of world.pois) if (!discovered.has(poi.id) && dist(player, poi) < 65) {
      discovered.add(poi.id); log(`Обнаружено: ${poiTitle(poi)}`, true); toast(`${poiTitle(poi)}. Новое место отмечено в журнале.`);
    }
  } else stamina = Math.min(100, stamina + dt * .8);
  syncLootPosition();
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
  const important = (poi.overview || poi.tags?.place) && !anonymous;
  const fontSize = camera.zoom < .5 ? 10 : important ? 13 : 11;
  const title = poiTitle(poi);
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
  const key = `${camera.zoom},${vw},${vh},${dpr},${objectRevision}`;
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
    detailRenderer.draw(objectCacheCtx, { zoom: camera.zoom, cameraX: camera.x, cameraY: camera.y, width, height, time, hoveredId: null, suppressedSourceIds: landmarkSourceIds, buildingLootState: id => inventoryModel.getBuildingState(id),
      groundOverlay: layers.elevation && elevationRenderer.available && !layers.biomes ? (context, view) => elevationRenderer.draw(context, view) : null,
      landscapeOverlay: layers.landscape && landscape.available ? (context, view) => landscape.draw(context, view) : null,
      reliefOverlay: layers.elevation && elevationRenderer.available && layers.biomes ? (context, view) => elevationRenderer.drawMask(context, view) : null });
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
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#18251f'; ctx.fillRect(0, 0, vw, vh);
  drawStaticObjects(time);
  ctx.save(); ctx.translate(vw / 2, vh / 2); ctx.scale(camera.zoom, camera.zoom); ctx.translate(-camera.x, -camera.y);
  if (hoveredObject && !quietHoverLayers.has(hoveredObject.layer)) detailRenderer.drawHighlight(ctx, { zoom: camera.zoom, cameraX: camera.x, cameraY: camera.y, width: vw, height: vh, time }, hoveredObject);
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
  ctx.save(); ctx.translate(vw / 2, vh / 2); ctx.scale(camera.zoom, camera.zoom); ctx.translate(-camera.x, -camera.y);
  landmarkRenderer.draw(ctx, { zoom: camera.zoom, cameraX: camera.x, cameraY: camera.y, width: vw, height: vh, layers, hoveredId: hoveredPoi?.id, labelBoxes: mapLabelBoxes });
  groundPileRenderer.draw(ctx, { zoom: camera.zoom, cameraX: camera.x, cameraY: camera.y, width: vw, height: vh, layers, hoveredId: hoveredPile?.id });
  ctx.restore();
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
  const nearestPlace = regionPlaces.reduce((nearest, place) => !nearest || dist(player, place) < dist(player, nearest) ? place : nearest, null);
  $('sector-label').textContent = [countryLabel, regionLabel, placeLabels[nearestPlace?.name] || nearestPlace?.name || usaMap.name].filter(Boolean).join(' · ');
  const minute = Math.floor(minutes);
  $('day-label').textContent = `ДЕНЬ ${Math.floor(minute / 1440) + 1}`;
  $('time-label').textContent = `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  $('weather-label').textContent = route && !paused ? 'В ПУТИ · +12°' : 'ПАСМУРНО · +12°';
  $('stamina-value').textContent = `${Math.round(stamina)}%`; $('stamina-bar').style.width = `${stamina}%`;
  $('health-value').textContent = '100%'; $('health-bar').style.width = '100%';
  $('water-value').textContent = `${Math.round(water)}%`; $('water-bar').style.width = `${water}%`;
  const nearest = [...world.pois].sort((a, b) => dist(player, a) - dist(player, b))[0];
  const atPoi = nearest && dist(player, nearest) < 65;
  $('location-name').textContent = atPoi ? poiTitle(nearest) : world.name || 'Участок местности';
  const terrain = terrainAt(world, player.x, player.y);
  $('terrain-label').textContent = `${terrainNames[terrain?.type] || 'Пустошь'}${route ? paused ? ' · привал' : ' · в пути' : ' · на привале'}`;
  const biomes = [...new Set(detailRenderer.zonesAt(player.x, player.y).map(zone => zone.biomeName || zone.name))];
  $('biome-label').hidden = !biomes.length;
  $('biome-label').textContent = biomes.length ? `Биом: ${biomes.join(' + ')}` : '';
  $('biome-label').title = $('biome-label').textContent;
  const toward = route?.points[route.index] || null;
  const movement = movementAt(world, player.x, player.y, toward);
  $('movement-speed').textContent = `${movement.speedKmh.toFixed(movement.speedKmh < 1 ? 2 : 1).replace('.', ',')} км/ч`;
  const land = landscape.getAt(player.x, player.y);
  $('landscape-label').hidden = !land;
  $('landscape-label').textContent = land ? `Ландшафт: ${land.name} ×${land.multiplier.toFixed(2).replace('.', ',')}` : '';
  $('movement-multiplier').textContent = `×${movement.multiplier.toFixed(movement.multiplier < .1 ? 3 : 2).replace('.', ',')}`;
  const surfaceNames = { asphalt: 'Асфальт', concrete: 'Бетон', paved: 'Твёрдое покрытие', paving_stones: 'Брусчатка', gravel: 'Щебень', fine_gravel: 'Мелкий гравий', compacted: 'Уплотнённый грунт', dirt: 'Грунт', earth: 'Грунт', ground: 'Грунт', unpaved: 'Грунтовая дорога', sand: 'Песок', mud: 'Грязь', grass: 'Трава', rock: 'Камни' };
  const footing = movement.roadClass ? [ROAD_CLASSES[movement.roadClass]?.name || 'Дорога', surfaceNames[movement.surface]].filter(Boolean).join(' · ') : biomes[0] || 'Пустошь';
  const slope = toward ? Math.abs(movement.slopePercent) < .5 ? 'Почти ровно' : `${movement.slopePercent > 0 ? 'Подъём +' : 'Спуск −'}${Math.round(Math.abs(movement.slopePercent))}%` : '';
  const obstacles = [movement.buildingMultiplier < 1 ? 'Через здание' : '', movement.seasonalMultiplier < 1 ? 'Сезонное русло' : ''].filter(Boolean);
  $('movement-factors').textContent = [footing, slope, ...obstacles].filter(Boolean).join(' · ');
  $('biome-label').textContent = biomes.length ? `Биом: ${biomes.join(' + ')} ${formatFactor(movement.biomeMultiplier)}` : '';
  $('biome-label').title = $('biome-label').textContent;
  $('movement-products').textContent = `Биом ${formatFactor(movement.biomeMultiplier)} × ландшафт ${formatFactor(movement.landscapeMultiplier).slice(1)} × дорога ${formatFactor(movement.roadMultiplier).slice(1)}`;
  $('movement-multiplier').title = `Биом ${formatFactor(movement.biomeMultiplier)} · Ландшафт ${formatFactor(movement.landscapeMultiplier)} · Дорога ${formatFactor(movement.roadMultiplier)} · Уклон ${formatFactor(movement.slopeMultiplier)} · Здание ${formatFactor(movement.buildingMultiplier)} · Русло ${formatFactor(movement.seasonalMultiplier)}`;
  if (world.geographic) {
    const [west, south, east, north] = world.bbox;
    const degree = 6371008.8 * Math.PI / 180, cosine = Math.cos((south + north) * Math.PI / 360);
    const lat = north - player.y * metersPerUnit() / degree, lon = west + player.x * metersPerUnit() / degree / cosine;
    $('coords').textContent = `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'С' : 'Ю'} · ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'В' : 'З'}`;
  } else $('coords').textContent = `${(58 + player.y / 10000).toFixed(3)}° С · ${(38 + player.x / 10000).toFixed(3)}° В`;
  $('zoom-label').textContent = `${Math.round(camera.zoom * 100)}%`;
  $('zoom-in').disabled = camera.zoom >= maximumZoom() - .001;
  $('zoom-out').disabled = camera.zoom <= .321;
  $('center-button').classList.toggle('active', following);
  $('center-button').setAttribute('aria-pressed', String(following));
  if (route) {
    $('distance-label').textContent = formatDistance(route.remaining * metersPerUnit());
    const eta = Math.max(1, Math.ceil(route.remainingDurationMinutes));
    $('eta-label').textContent = `${eta < 60 ? `${eta} мин` : `${Math.floor(eta / 60)} ч ${eta % 60} мин`} пути${paused ? ' · пауза' : ''}`;
  }
}

// Small read-only diagnostics for automated smoke checks and future iteration.
window.__DAY_NEXT__ = {
  getState: () => ({ gameMinutesPerSecond: GAME_MINUTES_PER_SECOND, player: { ...player }, camera: { ...camera }, moving: !!route && !paused, paused, speed, stamina, water, minutes, totalDistance, destination: route ? { ...route.destination } : null, remaining: route?.remaining || 0, discovered: [...discovered] }),
  getInventoryState: () => inventoryModel.getState(),
  getWorldLootState: () => inventoryModel.exportState(),
  getGroundPiles: () => inventoryModel.getGroundPiles(),
  getLootContext: () => inventoryModel.getContext(),
  getBuildingLootState: id => inventoryModel.getBuildingState(id),
  getLootSaveInfo: () => ({ key: lootSaveKey, status: lootSaveStatus }),
  getItemWindowsState: () => itemWindows.getState(),
  getLandmarkMarkers: () => landmarkRenderer.getMarkers(),
  getLandmarkStats: () => landmarkRenderer.getStats(),
  getRoute: () => route ? { points: route.points.map(point => ({ ...point })), distance: route.distance, durationMinutes: route.durationMinutes, remaining: route.remaining, remainingDurationMinutes: route.remainingDurationMinutes, index: route.index, destination: { ...route.destination }, search: { ...route.search } } : null,
  getMovementFactors: () => structuredClone(MOVEMENT_FACTORS),
  getMovementAt: (x, y, toward = null) => movementAt(world, x, y, toward),
  getWorld: () => world,
  worldToScreen: position => worldToScreen(position),
  getDetails: () => detailRenderer.getStats(),
  inspectAt: (x, y) => detailRenderer.pick(x, y, 1),
  zonesAt: (x, y) => detailRenderer.zonesAt(x, y),
  getLayers: () => ({ ...layers }),
  getRoadClasses: () => ({ ...roadClasses }),
  getOverviewMarkers: () => overviewMarkers.map(marker => ({ ...structuredClone(marker), visible: world.geographic && camera.zoom <= OVERVIEW_MAX_ZOOM && poiEnabled(marker) })),
  getFeatures: () => detailRenderer.getFeatures(),
  getRenderStats: () => ({ ...renderStats, meanFrameMs: renderStats.totalFrameMs / Math.max(1, renderStats.frames), cachePixels: objectCache.width * objectCache.height, cacheBytes: objectCache.width * objectCache.height * 4, renderer: detailRenderer.getStats(), elevation: elevationRenderer.getStats(), landscape: landscape.getStats(), navigation: structuredClone(world.metadata?.movement || {}) }),
  getLandscapeInfo: () => landscape.getInfo(),
  landscapeAt: (x, y) => landscape.getAt(x, y),
  getElevationInfo: () => elevationRenderer.getInfo(),
  elevationAt: (x, y) => elevationRenderer.sampleAt(x, y),
  getTypeCatalogs: () => structuredClone({ buildingTypes: BUILDING_TYPES, buildingRoles: BUILDING_ROLES, buildingCategories: BUILDING_CATEGORIES, biomeTypes: BIOME_TYPES, landscapeTypes: LANDSCAPE_TYPES, resourceProfiles: RESOURCE_PROFILES, resourceKinds: RESOURCE_KINDS }),
  getResourceCandidatesAt: (x, y) => { const feature = detailRenderer.pick(x, y, 1); return collectResourceCandidates(feature?.gameplayAssignment || feature, detailRenderer.zonesAt(x, y)); },
};
log('Невада. На карте — следы прежней жизни.', true); syncLayerUI(); updateUI();
function frame(now) {
  const dt = Math.min((now - last) / 1000, .08); last = now;
  update(dt); draw(now / 1000);
  uiTick += dt; if (uiTick >= .15) { updateUI(); uiTick = 0; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
