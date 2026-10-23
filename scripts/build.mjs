import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createZip } from './lib/zip.mjs';
import { writeMapObjectsReport } from './report-map-objects.mjs';
import { BUILDING_TYPES, BIOME_TYPES, RESOURCE_PROFILES, RESOURCE_KINDS } from '../gameplay-types.js';
import { BUILDING_CATEGORIES, BUILDING_ROLES } from '../building-roles.js';
import { LANDSCAPE_TYPES } from '../landscape.js';
import { MOVEMENT_FACTORS } from '../movement-model.js';
const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const [html, css, movementGeometry, movementModel, landscape, world, realWorld, polygonVendor, polygonGeometry, ribbons, cities, biomes, mapLayers, presentation, overview, types, roles, details, elevationRenderer, elevationData, map, game] = await Promise.all(['index.html', 'styles.css', 'movement-geometry.js', 'movement-model.js', 'landscape.js', 'world.js', 'real-world.js', 'vendor/polygon-clipping.js', 'polygon-geometry.js', 'biome-ribbons.js', 'city-biomes.js', 'biome-map.js', 'map-layers.js', 'map-presentation.js', 'map-overview.js', 'gameplay-types.js', 'building-roles.js', 'detail-renderer.js', 'elevation-renderer.js', 'maps/beatty-elevation.js', 'maps/usa.js', 'game.js'].map(read));
const { version } = JSON.parse(await read('package.json'));
const mapData = JSON.parse(map.replace(/^export default\s+/, '').trim().replace(/;$/, ''));
const objectsReport = await writeMapObjectsReport(mapData, root);
const wrap = (body, names) => `const {${names}} = (() => {\n${body.replace(/^export\s+/gm, '')}\nreturn {${names}};\n})();\n`;
const source = wrap(movementGeometry.replace(/^import\s+[^;]+;\s*/gm, ''), 'prepareMovementGeometry')
  + wrap(landscape.replace(/^import\s+[^;]+;\s*/gm, ''), 'LANDSCAPE_TYPES,classifyLandscape,createLandscape')
  + wrap(movementModel.replace(/^import\s+[^;]+;\s*/gm, ''), 'MOVEMENT_FACTORS,BASE_WALK_METERS_PER_MINUTE,MAX_MOVEMENT_MULTIPLIER,biomeSpeedMultiplier,roadSpeedMultiplier,cellMovementMultiplier,movementAt,segmentTravel,advanceAlongRoute')
  + wrap(world.replace(/^import\s+[^;]+;\s*/gm, ''), 'findPath,terrainAt,nearestWalkable')
  + wrap(realWorld.replace(/^import\s+[^;]+;\s*/gm, ''), 'createRealWorld,prepareTravelWorld')
  + wrap(polygonVendor, 'polygonClipping')
  + wrap(polygonGeometry.replace(/^import\s+[^;]+;\s*/gm, ''), 'polygonDifference,polygonUnion,polygonIntersection,normalizePolygonParts')
  + wrap(ribbons.replace(/^import\s+[^;]+;\s*/gm, ''), 'buildWaterRibbonParts')
  + wrap(cities.replace(/^import\s+[^;]+;\s*/gm, ''), 'buildCityBiomes')
  + wrap(mapLayers, 'mapFeatureLayer,mapBiome,mapZoneBiome,shouldRenderFeature,shouldRenderLandscapeFeature,mapLandscapeBiome')
  + wrap(presentation, 'ROAD_CLASSES,roadClass,mergeNetworkLines,mergeConnectedNetworks,coalesceWaterwaySources')
  + wrap(overview, 'OVERVIEW_MAX_ZOOM,createOverviewMarkers')
  + wrap(types.replace(/^import\s+[^;]+;\s*/gm, ''), 'BUILDING_TYPES,BIOME_TYPES,RESOURCE_PROFILES,RESOURCE_KINDS,classifyBuilding,classifyBiome,collectResourceProfiles,collectResourceCandidates')
  + wrap(roles.replace(/^import\s+[^;]+;\s*/gm, ''), 'BUILDING_CATEGORIES,BUILDING_ROLES,createBuildingAssignments')
  + wrap(biomes.replace(/^import\s+[^;]+;\s*/gm, ''), 'buildBiomeMap')
  + wrap(details.replace(/^import\s+[^;]+;\s*/gm, ''), 'createDetailRenderer')
  + wrap(elevationRenderer.replace(/^import\s+[^;]+;\s*/gm, ''), 'createElevationRenderer')
  + `const usaMap = ${map.replace(/^export default\s+/, '')}\n`
  + `const beattyElevation = ${elevationData.replace(/^export default\s+/, '')}\n`
  + game.replace(/^import\s+[^;]+;\s*/gm, '');
const standalone = html
  .replace(/<link\b[^>]*href=["'](?:\.\/)?styles\.css["'][^>]*>/, () => `<style>${css}</style>`)
  .replace(/<script\b[^>]*src=["'](?:\.\/)?game\.js["'][^>]*><\/script>/, () => `<script type="module">${source.replace(/<\/script/gi, '<\\/script')}</script>`);
if (standalone.includes('src="./game.js"') || !standalone.includes('function findPath') || !standalone.includes('function createElevationRenderer')) throw new Error('Standalone bundle was not created');
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/day-next.html', root), standalone);
await mkdir(new URL('downloads/', root), { recursive: true });
await writeFile(new URL('downloads/day-next.html', root), standalone);
const instructions = `DAY / NEXT ${version} — одиночная экспедиция

Откройте day-next.html в браузере. Установка и интернет не нужны.
Клик — идти, перетаскивание — карта, колесо — масштаб до 24x.
Наведение — сведения об отдельном доме или дороге. F / прицел — вернуться к путнику.
Кнопка «Слои» — отдельное включение карты высот, ландшафта, биомов, дорог, электросети, домов и прочих объектов. Выключенные объекты не рисуются и не выбираются.
Кнопка «Высоты» включает и выключает реальную карту рельефа USGS 3DEP. Нейтральная светотеневая маска показывает склоны без собственной высотной окраски, горизонтали проведены через 50 метров. При наведении видна высота в метрах. Сетка около 15 м встроена в игру, интернет не нужен. Начальный вид показывает весь участок. Биом, ландшафт, уклон и покрытие дороги влияют на скорость; маршрут выбирается по расчётному времени с учётом этих факторов. Здания и сезонные русла дают сильный штраф, но остаются проходимыми. Подъёмы значительно замедляют.
Каждый дом получил игровое назначение и цвет категории: жильё, разные магазины, еда, медицина, образование, производство, склады, транспорт, общественные здания, службы, гостиницы и руины.
Наведи на дом: в заголовке карточки будет конкретная роль — например, продуктовый магазин, школа, склад или ангар.
Назначения берутся из собственных тегов и меток карты; для неуточнённых зданий заданы устойчивые игровые роли с отдельной пометкой «Игровое назначение». Исходные факты OSM сохранены отдельно.
Биомы образуют весь фон карты без отдельной подложки и без наложений. Их собственные цвета сохраняются, поверх них светотеневая маска рельефа даёт тени и свет без смешивания с высотной палитрой. Без биомов рельеф показывается нейтральным серым. Природные участки и вода вырезаны из соседних биомов. Сезонные русла обозначены полноширинным прямоугольным синим пунктиром в границах русла, закреплённым в координатах карты без подстройки под масштаб; постоянная вода — сплошным синим. При отдалении появляются точки поселений и аэропорта.
Наведение на биом, дорогу или ЛЭП показывает краткую подсказку возле курсора без подсветки геометрии. Подробные карточки и подсветка домов сохранены. Соединённые однотипные дороги, водотоки и электролинии остаются едиными объектами со всеми ответвлениями. Типы дорог: магистрали, дороги, улицы и проезды, грунтовки, тропы и железнодорожные пути. Каждый тип можно скрыть отдельно. Магистрали тёмно-серые, обычный асфальт светлее, грунтовки песочные; указанное в источнике покрытие учитывается по участкам. Электросеть — сплошные линии без отдельных столбов. Ограды, обозначения переходов и дорожные знаки скрыты. Подстанция залита сплошным цветом; аэродром и перрон сохраняют свои контуры.
Городской контур — угловатый многоугольник; пески вырезаны из города, парки и вода сохраняют собственные участки. Амаргоса обозначена только пунктиром: устранено дублирование общего речного отношения поверх исходных сезонных участков. Условная ось долины Oasis Valley скрыта как вспомогательное обозначение, исходные теги сохранены.
В «Слоях» пункт «Ландшафт» показывает формы местности: равнины, неровную местность, холмы, горы и высокие горы. Классы определяются по реальным уклонам и локальным перепадам высот. Множители биома, ландшафта, дороги и уклона перемножаются. Без дороги её множитель ×1, на дороге — больше ×1, покрытие уточняет бонус. Город ×1,05, пустошь ×1, пески ×0,67. Без настоящих высот ландшафт не выдумывается.\nВ карточке путника показаны темп ходьбы, множитель скорости, биом, ландшафт, покрытие и уклон. ETA и реальное движение используют одну стоимость времени; масштаб и выключение слоёв её не меняют. Кнопка 1×/3× ускоряет игровое время. Текущий биом виден в карточке путника и при осмотре объектов. Сезонные русла остаются проходимыми и не обещают питьевую воду. Территории учреждений используются как сведения для игровых ролей зданий.
biomes.json содержит отчёт покрытия карты и происхождение биомов.
building-roles.json содержит все назначенные роли зданий, категории, происхождение и профили возможных ресурсов.\nlandscape-types.json содержит пять классов ландшафта и их коэффициенты скорости.\nmovement-factors.json содержит коэффициенты биомов, дорог, покрытий и препятствий.
remaining-objects.md содержит полный список того, что осталось в слое остальных объектов.
gameplay-types.json содержит типы зданий, биомов и общие профили ресурсов. Это настройки возможного поиска; механика добычи ещё не добавлена.
Реальные названия и адреса улиц и отдельных зданий убраны из игровых подписей и карточек; остаются игровые назначения. Архивные источники OSM сохранены отдельно.
Вверху — DAY / NEXT и текущий регион. Слои управляют отображением карты; счётчики объектов и лишние кнопки убраны. Конвертер и исходные данные остаются в репозитории для подготовки новых территорий.

Реальная местность: ${mapData.name} / ${mapData.region}.
Снимок OSM: ${mapData.source?.snapshotAt || 'дата не указана'}.
Загружено: ${mapData.source?.downloadedAt || 'дата не указана'}.
${mapData.roads.length} исходных участков дорог, ${mapData.buildings.length} зданий.
Полнота относится к исходному файлу, а не ко всем существующим в реальности объектам.
Геоданные: © OpenStreetMap contributors, ODbL 1.0
https://www.openstreetmap.org/copyright
Высоты: U.S. Geological Survey, 3D Elevation Program (3DEP), public domain.
https://www.usgs.gov/3d-elevation-program
Происхождение и контрольная сумма исходного GeoTIFF: elevation-source.json.
Исходники, происхождение данных и конвертер:
https://github.com/Eugene715x/DAY-NEXT
`;
await writeFile(new URL('downloads/day-next.zip', root), createZip([
  { name: 'day-next.html', data: standalone }, { name: 'README.txt', data: instructions },
  { name: 'remaining-objects.md', data: objectsReport.markdown },
  { name: 'remaining-objects.json', data: JSON.stringify(objectsReport.report, null, 2) + '\n' },
  { name: 'THIRD_PARTY_NOTICES.txt', data: await read('vendor/THIRD_PARTY_NOTICES.txt') },
  { name: 'biomes.json', data: JSON.stringify({ version: 1, source: objectsReport.report.source, ...objectsReport.report.biomes }, null, 2) + '\n' },
  { name: 'movement-factors.json', data: JSON.stringify(MOVEMENT_FACTORS, null, 2) + '\n' },
  { name: 'landscape-types.json', data: JSON.stringify({ version: 1, types: LANDSCAPE_TYPES, source: 'Classification of real USGS 3DEP slopes and neighbourhood relief; independent of biome and display visibility' }, null, 2) + '\n' },
  { name: 'elevation-source.json', data: await read('maps/source/beatty-elevation.provenance.json') },
  { name: 'building-roles.json', data: JSON.stringify({ version: 1, source: objectsReport.report.source, categories: BUILDING_CATEGORIES, roles: BUILDING_ROLES, ...objectsReport.report.buildings }, null, 2) + '\n' },
  { name: 'gameplay-types.json', data: JSON.stringify({ buildingTypes: BUILDING_TYPES, biomeTypes: BIOME_TYPES, resourceProfiles: RESOURCE_PROFILES, resourceKinds: RESOURCE_KINDS }, null, 2) + '\n' },
]));
console.log(`Built dist/day-next.html and repository downloads/day-next.{html,zip} (${Math.round(Buffer.byteLength(standalone) / 1024)} KiB HTML). Fully offline.`);
