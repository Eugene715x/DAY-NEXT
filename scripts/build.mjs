import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createZip } from './lib/zip.mjs';
const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const [html, css, world, realWorld, details, converter, map, game] = await Promise.all(['index.html', 'styles.css', 'world.js', 'real-world.js', 'detail-renderer.js', 'scripts/lib/osm-converter.mjs', 'maps/usa.js', 'game.js'].map(read));
const wrap = (body, names) => `const {${names}} = (() => {\n${body.replace(/^export\s+/gm, '')}\nreturn {${names}};\n})();\n`;
const source = wrap(world, 'createWorld,findPath,terrainAt,nearestWalkable')
  + wrap(realWorld, 'createRealWorld')
  + wrap(details, 'createDetailRenderer')
  + wrap(converter, 'convertOSM')
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
const instructions = 'DAY / NEXT 0.3 — одиночная экспедиция\n\nОткройте day-next.html в браузере. Установка и интернет не нужны.\nКлик/касание — идти, перетаскивание — карта, колесо/щипок — масштаб до 24x.\nB / кнопка дома — посмотреть застройку; наведение/касание — сведения об отдельном доме или дороге. F / прицел — вернуться к путнику.\nКнопка атласа — реальная/вымышленная карта, импорт OSM/XML/JSON, экспорт JSON.\n\nРеальная местность: Beatty / Rhyolite, Nevada, USA. Исторический снимок OSM 2017-08-18.\nГеоданные: © OpenStreetMap contributors, ODbL 1.0\nhttps://www.openstreetmap.org/copyright\nИсходники, происхождение данных и конвертер:\nhttps://github.com/Eugene715x/DAY-NEXT\n';
await writeFile(new URL('downloads/day-next.zip', root), createZip([{ name: 'day-next.html', data: standalone }, { name: 'README.txt', data: instructions }]));
console.log(`Built dist/day-next.html and repository downloads/day-next.{html,zip} (${Math.round(Buffer.byteLength(standalone) / 1024)} KiB HTML). Fully offline.`);
