import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createZip } from './lib/zip.mjs';
const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const [html, css, world, realWorld, terrain, mapLayers, details, converter, map, game] = await Promise.all(['index.html', 'styles.css', 'world.js', 'real-world.js', 'terrain-renderer.js', 'map-layers.js', 'detail-renderer.js', 'scripts/lib/osm-converter.mjs', 'maps/usa.js', 'game.js'].map(read));
const { version } = JSON.parse(await read('package.json'));
const mapData = JSON.parse(map.replace(/^export default\s+/, '').trim().replace(/;$/, ''));
const wrap = (body, names) => `const {${names}} = (() => {\n${body.replace(/^export\s+/gm, '')}\nreturn {${names}};\n})();\n`;
const source = wrap(world, 'createWorld,findPath,terrainAt,nearestWalkable')
  + wrap(realWorld, 'createRealWorld')
  + wrap(terrain, 'createTerrainBackdrop,createLandscapeBackdrop')
  + wrap(mapLayers, 'mapFeatureLayer,mapBiome')
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
Клик/касание — идти, перетаскивание — карта, колесо/щипок — масштаб до 24x.
B / кнопка дома — посмотреть застройку; наведение/касание — сведения об отдельном доме или дороге. F / прицел — вернуться к путнику.
Кнопка «Слои» — отдельное включение подложки, ландшафта с природой и зонами, водоёмов и русел, дорог, домов и прочих объектов. Выключенные объекты не рисуются и не выбираются.
Ландшафт объединяет леса, пески, скалы, парки, жилые и промышленные территории как биомы. Дороги и вода управляются независимо.
Кнопка атласа — реальная/вымышленная карта, импорт OSM/XML/JSON, экспорт JSON и ссылка на свежий исходник OSM для выбранного участка.

Реальная местность: ${mapData.name} / ${mapData.region}.
Снимок OSM: ${mapData.source?.snapshotAt || 'дата не указана'}.
Загружено: ${mapData.source?.downloadedAt || 'дата не указана'}.
${mapData.roads.length} дорог, ${mapData.buildings.length} зданий.
Полнота относится к исходному файлу, а не ко всем существующим в реальности объектам.
Геоданные: © OpenStreetMap contributors, ODbL 1.0
https://www.openstreetmap.org/copyright
Исходники, происхождение данных и конвертер:
https://github.com/Eugene715x/DAY-NEXT
`;
await writeFile(new URL('downloads/day-next.zip', root), createZip([{ name: 'day-next.html', data: standalone }, { name: 'README.txt', data: instructions }]));
console.log(`Built dist/day-next.html and repository downloads/day-next.{html,zip} (${Math.round(Buffer.byteLength(standalone) / 1024)} KiB HTML). Fully offline.`);
