#!/usr/bin/env node
/** Reproducible inventory of the renderer's remaining detail objects. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDetailRenderer } from '../detail-renderer.js';

const repositoryRoot = new URL('../', import.meta.url);
const categoryNames = {
  energy: 'Электросети и опоры',
  barriers: 'Ограды, ворота и препятствия',
  road_equipment: 'Дорожные знаки, оборудование и следы старых дорог',
  aviation: 'Оборудование и разметка аэродрома',
  mining: 'Шахты, штольни и старые рудники',
  heritage: 'Исторические объекты, искусство и следы построек',
  infrastructure: 'Связь и технические сооружения',
  amenities: 'Отдельные бытовые и сервисные объекты',
  recreation: 'Туристические и рекреационные объекты',
  advertising: 'Рекламные щиты',
  boundaries: 'Фрагменты границ',
  places: 'Географические названия мест',
  mapped: 'Объекты с другими исходными тегами',
};

const subtypeNames = {
  'man_made=utility_pole': 'Коммунальные столбы',
  'power=tower': 'Опоры ЛЭП', 'power=pole': 'Столбы электросети',
  'power=minor_line': 'Линии местной электросети', 'power=line': 'Линии электропередачи',
  'power=transformer': 'Трансформаторы', 'power=substation': 'Подстанции',
  'barrier=fence': 'Ограды', 'barrier=gate': 'Ворота', 'barrier=cattle_grid': 'Скотопрогонные решётки',
  'barrier=block': 'Блоки-заграждения', 'barrier=debris': 'Завалы',
  'highway=crossing': 'Пешеходные переходы', 'highway=stop': 'Знаки STOP',
  'highway=street_lamp': 'Уличные фонари', 'highway=give_way': 'Знаки «Уступи дорогу»',
  'highway=turning_circle': 'Точки разворота', 'noexit=yes': 'Отметки тупиков',
  'disused:highway=residential': 'Неиспользуемые улицы', 'demolished:highway=track': 'Следы уничтоженной грунтовой дороги',
  'demolished:building=yes': 'Контуры снесённых зданий',
  'aeroway=parking_position': 'Места стоянки самолётов', 'aeroway=taxilane': 'Линии движения на стоянке самолётов',
  'aeroway=holding_position': 'Позиция ожидания на аэродроме', 'aeroway=windsock': 'Ветроуказатель',
  'aeroway=runway': 'Взлётная полоса', 'aeroway=taxiway': 'Рулёжная дорожка',
  'aeroway=apron': 'Перрон аэродрома', 'aeroway=hangar': 'Ангар',
  'aeroway=aerodrome': 'Аэродром', 'aeroway=helipad': 'Вертолётная площадка',
  'man_made=mineshaft': 'Шахтные стволы', 'man_made=adit': 'Штольни', 'historic=mine': 'Старые рудники',
  'historic=ruins': 'Руины', 'tourism=artwork': 'Произведения искусства',
  'historic=yes;place=town': 'Историческая метка Битти',
  'railway=abandoned': 'Заброшенные железнодорожные пути',
  'man_made=satellite_dish': 'Спутниковые антенны', 'man_made=mast': 'Мачты',
  'man_made=tower': 'Башня связи', 'man_made=beacon': 'Сигнальный маяк',
  'man_made=survey_point': 'Геодезический пункт', 'man_made=dyke': 'Дамбы и защитные насыпи',
  'man_made=storage_tank': 'Резервуар', 'man_made=tailings_pond': 'Хвостохранилище',
  'man_made=water_tower': 'Водонапорная башня',
  'amenity=toilets': 'Общественный туалет', 'amenity=atm': 'Банкомат',
  'amenity=charging_station': 'Зарядная станция', 'amenity=waste_disposal': 'Точки сбора отходов',
  'amenity=waste_transfer_station': 'Перегрузочная станция отходов',
  'amenity=car_wash': 'Автомойка', 'amenity=fuel': 'Заправка',
  'amenity=fire_station': 'Пожарная станция', 'amenity=school': 'Школа',
  'amenity=clinic': 'Клиника', 'amenity=hospital': 'Больница',
  'amenity=courthouse': 'Суд', 'amenity=police': 'Полиция', 'amenity=townhall': 'Мэрия',
  'amenity=community_centre': 'Общественный центр', 'amenity=social_centre': 'Социальный центр',
  'amenity=parking': 'Парковки', 'amenity=restaurant': 'Ресторан', 'amenity=fast_food': 'Быстрое питание',
  'shop=confectionery': 'Кондитерская', 'socket:nema_5_15=4': 'Уличная точка с четырьмя электророзетками',
  'tourism=information': 'Туристический информационный пункт',
  'tourism=picnic_site': 'Место для пикника', 'leisure=picnic_table': 'Стол для пикника',
  'tourism=museum': 'Музей', 'tourism=attraction': 'Достопримечательность',
  'tourism=camp_pitch': 'Площадки для палаток', 'tourism=camp_site': 'Кемпинг',
  'tourism=caravan_site': 'Стоянки автодомов', 'golf=driving_range': 'Площадка для тренировки ударов в гольфе',
  'leisure=hot_tub': 'Горячая купель', 'advertising=billboard': 'Рекламные щиты',
  'boundary=census': 'Участки переписных границ Битти', 'place=locality': 'Названия урочищ и местностей',
};

function subtype(tags, kind) {
  if (tags.noexit) return `noexit=${tags.noexit}`;
  if (tags.advertising) return `advertising=${tags.advertising}`;
  if (tags['socket:nema_5_15']) return `socket:nema_5_15=${tags['socket:nema_5_15']}`;
  if (tags['disused:highway']) return `disused:highway=${tags['disused:highway']}`;
  if (tags['demolished:highway']) return `demolished:highway=${tags['demolished:highway']}`;
  if (tags['demolished:building']) return `demolished:building=${tags['demolished:building']}`;
  if (tags.golf) return `golf=${tags.golf}`;
  if (tags.historic === 'yes' && tags.place === 'town') return 'historic=yes;place=town';
  for (const key of ['power', 'barrier', 'highway', 'aeroway', 'man_made', 'railway', 'tourism', 'amenity', 'shop', 'boundary', 'place', 'leisure', 'historic']) {
    if (tags[key]) return `${key}=${tags[key]}`;
  }
  return Object.entries(tags).filter(([key]) => !/^(name|source|note|fixme|created_by|attribution)(:|$)/.test(key)).map(([key, value]) => `${key}=${value}`).sort().join('; ') || `kind=${kind || 'mapped_feature'}`;
}

function category(tags) {
  if (tags.power || tags.man_made === 'utility_pole') return 'energy';
  if (tags.barrier) return 'barriers';
  if (tags.highway || tags.noexit || tags['disused:highway'] || tags['demolished:highway']) return 'road_equipment';
  if (tags.aeroway) return 'aviation';
  if (['mineshaft', 'adit'].includes(tags.man_made) || tags.historic === 'mine') return 'mining';
  if (tags.boundary) return 'boundaries';
  if (tags.man_made) return 'infrastructure';
  if (tags.historic || tags.railway || tags['demolished:building'] || tags.tourism === 'artwork') return 'heritage';
  if (tags.advertising) return 'advertising';
  if (tags.amenity || tags.shop || Object.keys(tags).some(key => key.startsWith('socket:'))) return 'amenities';
  if (tags.tourism || tags.leisure || tags.golf) return 'recreation';
  if (tags.place) return 'places';
  return 'mapped';
}

const geometryCounts = records => Object.fromEntries(['point', 'line', 'polygon'].map(geometry => [geometry, records.filter(record => record.geometry === geometry).length]));
const byCount = (a, b) => b.count - a.count || a.id.localeCompare(b.id);
function groupRecords(records, keyFor) {
  const groups = new Map();
  for (const record of records) {
    const key = keyFor(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups];
}

function rendererFeatures(map) {
  // The report inspects the real renderer registry, not a second classification.
  // Cache construction needs Path2D commands but never paints or reads pixels.
  // Node has no Canvas; these four inert commands allow metadata-only construction.
  // The adapter is process-local and removed immediately after the registry is read.
  const needsAdapter = typeof globalThis.Path2D === 'undefined';
  if (needsAdapter) globalThis.Path2D = class ReportPath {
    moveTo() {} lineTo() {} closePath() {} ellipse() {}
  };
  try { const renderer = createDetailRenderer(map); return { features: renderer.getFeatures(), stats: renderer.getStats() }; }
  finally { if (needsAdapter) delete globalThis.Path2D; }
}

/** Complete partition: every remaining rendered record appears exactly once. */
export function createMapObjectsReport(map) {
  const { features, stats } = rendererFeatures(map);
  const originals = new Map(['roads', 'rivers', 'areas', 'buildings', 'details', 'lakes'].flatMap(collection => (map[collection] || []).map(feature => [`${collection}:${feature.id}`, feature])));
  const collectionForGroup = { road: 'roads', river: 'rivers', area: 'areas', building: 'buildings', detail: 'details', lake: 'lakes' };
  const remaining = features.filter(feature => feature.layer === 'details').map(feature => {
    const original = originals.get(`${collectionForGroup[feature.group]}:${feature.id}`);
    if (!original) throw new Error(`Cannot trace remaining renderer record ${feature.key} to source geometry.`);
    const tags = structuredClone(original.tags || {}), type = subtype(tags, feature.kind);
    return {
      id: feature.id, key: feature.key, sourceId: feature.sourceId || original.sourceId || feature.id.match(/^(?:node|way|relation)-\d+/)?.[0] || feature.id,
      name: original.name || '', kind: feature.kind, geometry: feature.geometry,
      category: category(tags), subtype: type, label: subtypeNames[type] || type, tags,
    };
  }).sort((a, b) => a.category.localeCompare(b.category) || a.subtype.localeCompare(b.subtype) || a.key.localeCompare(b.key));
  if (new Set(remaining.map(record => record.key)).size !== remaining.length) throw new Error('Duplicate remaining renderer keys.');
  const categories = groupRecords(remaining, record => record.category).map(([id, records]) => ({
    id, name: categoryNames[id], count: records.length, geometryCounts: geometryCounts(records),
    subtypes: groupRecords(records, record => record.subtype).map(([subtypeId, items]) => ({
      id: subtypeId, label: items[0].label, count: items.length, geometryCounts: geometryCounts(items),
    })).sort(byCount),
  })).sort(byCount);
  if (categories.reduce((total, group) => total + group.count, 0) !== remaining.length) throw new Error('Remaining categories do not cover the complete renderer registry.');
  const landscape = features.filter(feature => feature.layer === 'landscape');
  return {
    version: 2, mapId: map.id, mapName: map.name,
    source: { file: map.source?.sourceFile || 'maps/source/beatty.osm', sha256: map.source?.sha256 || null, downloadedAt: map.source?.downloadedAt || null, snapshotAt: map.source?.snapshotAt || null, supplementalSources: structuredClone(map.source?.supplementalSources || []) },
    layerCounts: Object.fromEntries(['landscape', 'water', 'roads', 'power', 'buildings', 'details'].map(layer => [layer, features.filter(feature => feature.layer === layer).length])),
    presentation: { inputFeatures: stats.inputFeatures, filteredFeatures: stats.filteredFeatures, coalescedFeatures: stats.coalescedFeatures, sourceRoads: stats.sourceRoads, displayRoads: stats.displayRoads, sourcePowerLines: stats.sourcePowerLines, displayPowerLines: stats.displayPowerLines, roadClasses: Object.fromEntries([...new Set(features.filter(feature => feature.layer === 'roads').map(feature => feature.roadClass))].map(id => [id, features.filter(feature => feature.layer === 'roads' && feature.roadClass === id).length])) },
    landscape: { count: landscape.length, geometryCounts: geometryCounts(landscape), biomes: groupRecords(landscape, feature => feature.biome || 'landscape').map(([id, records]) => ({ id, count: records.length, geometryCounts: geometryCounts(records) })).sort(byCount) },
    remaining: { count: remaining.length, uniqueSourceElements: new Set(remaining.map(record => record.sourceId)).size, geometryCounts: geometryCounts(remaining), categories, objects: remaining },
    notes: [
      'Counts are rendered geometry records. Clipped ways can have several fragments; compatible road segments are joined into display chains, retaining all source IDs. Navigation keeps the original roads.',
      'Institution/building zone facets share the original footprint; point-only mapped institutions do not acquire invented site boundaries.',
      'Crossing fixtures, barriers and point electrical equipment are retained in raw data but omitted from the game presentation. Administrative boundaries have outlines only and do not grant biome membership.',
      'Categories partition the details layer exactly. Source tags and IDs are retained for every record.',
    ],
  };
}

const cell = value => String(value).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const geometryLabel = counts => [['point', 'точки'], ['line', 'линии'], ['polygon', 'полигоны']].filter(([key]) => counts[key]).map(([key, name]) => `${name}: ${counts[key]}`).join(', ') || '—';

export function formatMapObjectsReport(report) {
  const { remaining } = report;
  const lines = [
    '# Что осталось в слое «Остальные объекты»', '',
    `Карта: **${report.mapName}**. Всего **${remaining.count} геометрических записей** из **${remaining.uniqueSourceElements} исходных элементов OSM**. ${geometryLabel(remaining.geometryCounts)}.`, '',
    `Последняя правка OSM в исходнике: **${report.source.snapshotAt || 'дата не указана'}**. Выгрузка: **${report.source.downloadedAt || 'дата не указана'}**.`, '',
    'Парковки и территории учреждений относятся к слою «Ландшафт и зоны». Пересекающиеся зоны сохраняются отдельно; здания внутри них остаются в слое зданий. Для точечного учреждения без нанесённых границ сохраняется точка, новая площадь не придумывается.', '',
    'Обозначения переходов, ограды и отдельные столбы/опоры электросети скрыты. Административные границы показаны только контуром и не входят в список биомов. Исходные элементы сохранены в геоданных.', '',
    '## Полный список', '',
    '| Категория | Количество |', '| --- | ---: |',
    ...remaining.categories.map(group => `| ${cell(group.name)} | ${group.count} |`),
    `| **Всего** | **${remaining.count}** |`, '',
  ];
  for (const group of remaining.categories) {
    lines.push(`### ${group.name} — ${group.count}`, '', '| Объекты | Количество | Геометрия | Исходные теги |', '| --- | ---: | --- | --- |');
    for (const type of group.subtypes) lines.push(`| ${cell(type.label)} | ${type.count} | ${geometryLabel(type.geometryCounts)} | \`${cell(type.id)}\` |`);
    lines.push('');
  }
  lines.push('## Как читать количество', '',
    'Количество относится к геометрии, которую реально регистрирует отрисовщик. Обрезанная геометрия может давать несколько фрагментов; совместимые участки дорог соединяются в общие трассы. Метки мест не считаются повторно. Полный перечень записей с исходными ID и тегами находится в [remaining-objects.json](remaining-objects.json).', '',
    'Отчёт создаётся автоматически командой `npm run map:report` и при сборке игры. Геоданные: © OpenStreetMap contributors, ODbL 1.0.', '');
  return lines.join('\n');
}

export async function writeMapObjectsReport(map, outputRoot = repositoryRoot) {
  const root = outputRoot instanceof URL ? outputRoot : pathToFileURL(resolve(outputRoot) + sep);
  const report = createMapObjectsReport(map), markdown = formatMapObjectsReport(report);
  await mkdir(new URL('maps/source/', root), { recursive: true });
  await writeFile(new URL('maps/source/remaining-objects.json', root), JSON.stringify(report, null, 2) + '\n');
  await writeFile(new URL('maps/source/remaining-objects.md', root), markdown);
  return { report, markdown };
}

async function main() {
  if (process.argv.slice(2).some(argument => ['--help', '-h'].includes(argument))) {
    console.log('node scripts/report-map-objects.mjs\nWrites maps/source/remaining-objects.{json,md} for the bundled map, using the real renderer registry.'); return;
  }
  if (process.argv.length > 2) throw new Error('No arguments are required. Use --help.');
  const text = await readFile(new URL('maps/usa.js', repositoryRoot), 'utf8');
  const map = JSON.parse(text.replace(/^export default\s+/, '').trim().replace(/;$/, ''));
  const { report } = await writeMapObjectsReport(map);
  console.log(`Remaining details: ${report.remaining.count}; categories: ${report.remaining.categories.length}; source elements: ${report.remaining.uniqueSourceElements}.`);
  for (const group of report.remaining.categories) console.log(`${group.name}: ${group.count}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
