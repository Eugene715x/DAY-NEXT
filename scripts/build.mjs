import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createZip } from './lib/zip.mjs';
import { writeMapObjectsReport } from './report-map-objects.mjs';
import { BUILDING_TYPES, BIOME_TYPES, RESOURCE_PROFILES, RESOURCE_KINDS } from '../gameplay-types.js';
const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const [html, css, world, realWorld, terrain, mapLayers, presentation, overview, polygonVendor, polygonGeometry, biomes, types, details, converter, map, game] = await Promise.all(['index.html', 'styles.css', 'world.js', 'real-world.js', 'terrain-renderer.js', 'map-layers.js', 'map-presentation.js', 'map-overview.js', 'vendor/polygon-clipping.js', 'polygon-geometry.js', 'biome-zones.js', 'gameplay-types.js', 'detail-renderer.js', 'scripts/lib/osm-converter.mjs', 'maps/usa.js', 'game.js'].map(read));
const { version } = JSON.parse(await read('package.json'));
const mapData = JSON.parse(map.replace(/^export default\s+/, '').trim().replace(/;$/, ''));
const objectsReport = await writeMapObjectsReport(mapData, root);
const wrap = (body, names) => `const {${names}} = (() => {\n${body.replace(/^export\s+/gm, '')}\nreturn {${names}};\n})();\n`;
const source = wrap(world, 'createWorld,findPath,terrainAt,nearestWalkable')
  + wrap(realWorld, 'createRealWorld')
  + wrap(terrain, 'createTerrainBackdrop,createLandscapeBackdrop')
  + wrap(mapLayers, 'mapFeatureLayer,mapBiome,mapZoneBiome,shouldRenderFeature')
  + wrap(presentation, 'ROAD_CLASSES,roadClass,mergeNetworkLines,mergeConnectedNetworks')
  + wrap(overview, 'OVERVIEW_MAX_ZOOM,createOverviewMarkers')
  + wrap(polygonVendor, 'polygonClipping')
  + wrap(polygonGeometry.replace(/^import\s+[^;]+;\s*/gm, ''), 'polygonDifference,polygonUnion,polygonIntersection,normalizePolygonParts')
  + wrap(types.replace(/^import\s+[^;]+;\s*/gm, ''), 'BUILDING_TYPES,BIOME_TYPES,RESOURCE_PROFILES,RESOURCE_KINDS,classifyBuilding,classifyBiome,collectResourceProfiles,collectResourceCandidates')
  + wrap(biomes.replace(/^import\s+[^;]+;\s*/gm, ''), 'buildGameplayBiomes,groupNearbyZones')
  + wrap(details.replace(/^import\s+[^;]+;\s*/gm, ''), 'createDetailRenderer')
  + wrap(converter, 'convertOSM,validateBbox')
  + `const usaMap = ${map.replace(/^export default\s+/, '')}\n`
  + game.replace(/^import\s+[^;]+;\s*/gm, '');
const standalone = html
  .replace(/<link\b[^>]*href=["'](?:\.\/)?styles\.css["'][^>]*>/, () => `<style>${css}</style>`)
  .replace(/<script\b[^>]*src=["'](?:\.\/)?game\.js["'][^>]*><\/script>/, () => `<script type="module">${source.replace(/<\/script/gi, '<\\/script')}</script>`);
if (standalone.includes('src="./game.js"') || !standalone.includes('function createWorld')) throw new Error('Standalone bundle was not created');
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/day-next.html', root), standalone);
await mkdir(new URL('downloads/', root), { recursive: true });
await writeFile(new URL('downloads/day-next.html', root), standalone);
const instructions = `DAY / NEXT ${version} — одиночная экспедиция

Откройте day-next.html в браузере. Установка и интернет не нужны.
Клик — идти, перетаскивание — карта, колесо — масштаб до 24x.
B / кнопка дома — посмотреть застройку; наведение — сведения об отдельном доме или дороге. F / прицел — вернуться к путнику.
Кнопка «Слои» — отдельное включение подложки, ландшафта с природой и зонами, водоёмов и русел, дорог, электросети, домов и прочих объектов. Выключенные объекты не рисуются и не выбираются.
Ландшафт объединяет леса, пески, скалы, парки, жилые и промышленные территории как биомы. Административные границы скрыты; при отдалении появляются точки поселений и аэропорта. Незонированная земля получает биом пустоши. Свободное пространство среди застройки заполняется пригородными, городскими и плотными зонами с плавными контурами; другие нанесённые зоны вырезаются из этих заполнителей.
Соединённые однотипные дороги, водотоки и электролинии выбираются и подсвечиваются единым объектом со всеми ответвлениями. Типы дорог: магистрали, дороги, улицы и проезды, грунтовки, тропы и железнодорожные пути. Каждый тип можно скрыть отдельно. Электросеть — сплошные линии без отдельных столбов. Ограды, обозначения переходов и дорожные знаки скрыты. Подстанция залита сплошным цветом, места стоянки самолётов относятся к зонам.
Парковки и территории учреждений также относятся к зонам. Пересекающиеся зоны учитываются одновременно; список биомов виден в карточке путника и при осмотре объектов.
remaining-objects.md содержит полный список того, что осталось в слое остальных объектов.
gameplay-types.json содержит типы зданий, биомов и общие профили ресурсов. Это настройки возможного поиска; механика добычи ещё не добавлена.
Кнопка атласа — реальная/вымышленная карта, импорт OSM/XML/JSON, экспорт JSON и ссылка на свежий исходник OSM для выбранного участка.

Реальная местность: ${mapData.name} / ${mapData.region}.
Снимок OSM: ${mapData.source?.snapshotAt || 'дата не указана'}.
Загружено: ${mapData.source?.downloadedAt || 'дата не указана'}.
${mapData.roads.length} исходных участков дорог, ${mapData.buildings.length} зданий.
Полнота относится к исходному файлу, а не ко всем существующим в реальности объектам.
Геоданные: © OpenStreetMap contributors, ODbL 1.0
https://www.openstreetmap.org/copyright
Исходники, происхождение данных и конвертер:
https://github.com/Eugene715x/DAY-NEXT
`;
await writeFile(new URL('downloads/day-next.zip', root), createZip([
  { name: 'day-next.html', data: standalone }, { name: 'README.txt', data: instructions },
  { name: 'remaining-objects.md', data: objectsReport.markdown },
  { name: 'remaining-objects.json', data: JSON.stringify(objectsReport.report, null, 2) + '\n' },
  { name: 'THIRD_PARTY_NOTICES.txt', data: await read('vendor/THIRD_PARTY_NOTICES.txt') },
  { name: 'gameplay-types.json', data: JSON.stringify({ buildingTypes: BUILDING_TYPES, biomeTypes: BIOME_TYPES, resourceProfiles: RESOURCE_PROFILES, resourceKinds: RESOURCE_KINDS }, null, 2) + '\n' },
]));
console.log(`Built dist/day-next.html and repository downloads/day-next.{html,zip} (${Math.round(Buffer.byteLength(standalone) / 1024)} KiB HTML). Fully offline.`);
