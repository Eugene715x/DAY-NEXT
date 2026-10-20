import { mapBiome } from './map-layers.js';

/**
 * Gameplay taxonomy and resource-table configuration, independent of OSM tags.
 * Candidate resource classes are design defaults, never generated loot or a
 * statement that a real-world building contains any of these resources.
 */
const gtFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) gtFreeze(item);
    Object.freeze(value);
  }
  return value;
};
const gtPresent = value => value !== undefined && value !== null && !['', 'no', 'false', '0'].includes(String(value));
const gtCatalog = (prefix, rows, property) => gtFreeze(Object.fromEntries(rows.map(([key, name, values = []]) => {
  const id = `${prefix}.${key}`;
  return [id, { id, name, [property]: values }];
})));

export const RESOURCE_KINDS = gtFreeze(Object.fromEntries([
  ['scrap_metal', 'Металлолом'], ['wood', 'Древесина'], ['fabric', 'Ткань'],
  ['tools', 'Инструменты'], ['electrical_parts', 'Электрические компоненты'],
  ['medical_supplies', 'Медицинские принадлежности'], ['medicine', 'Лекарства'],
  ['food', 'Продукты'], ['containers', 'Тара'], ['books', 'Книги и бумаги'],
  ['fuel', 'Топливо'], ['vehicle_parts', 'Детали транспорта'],
  ['seeds', 'Семена'], ['plants', 'Растительное сырьё'], ['stone', 'Камень'],
  ['water', 'Вода'],
].map(([key, name]) => { const id = `resource.${key}`; return [id, { id, name }]; })));

/** Edit these shared lists to configure candidates for every place of a type. */
export const RESOURCE_PROFILES = gtCatalog('profile', [
  ['salvage', 'Строительные материалы', ['resource.scrap_metal', 'resource.wood', 'resource.fabric']],
  ['household', 'Бытовые припасы', ['resource.fabric', 'resource.containers', 'resource.tools']],
  ['medical', 'Медицина', ['resource.medical_supplies', 'resource.medicine', 'resource.containers']],
  ['food', 'Продовольствие', ['resource.food', 'resource.containers']],
  ['education', 'Учебные материалы', ['resource.books', 'resource.containers']],
  ['industrial', 'Промышленное снабжение', ['resource.tools', 'resource.scrap_metal', 'resource.electrical_parts']],
  ['electrical', 'Электрооборудование', ['resource.electrical_parts', 'resource.scrap_metal', 'resource.tools']],
  ['vehicles', 'Транспортное снабжение', ['resource.vehicle_parts', 'resource.fuel', 'resource.tools']],
  ['outdoors', 'Природное сырьё', ['resource.wood', 'resource.plants', 'resource.stone']],
  ['agriculture', 'Сельское хозяйство', ['resource.seeds', 'resource.plants', 'resource.tools']],
  ['water', 'Водные источники', ['resource.water']],
  ['mining', 'Горные материалы', ['resource.stone', 'resource.scrap_metal', 'resource.tools']],
], 'candidateResourceIds');

export const BUILDING_TYPES = gtCatalog('building', [
  ['unknown', 'Здание неуточнённого назначения'],
  ['house', 'Частный жилой дом', ['profile.household', 'profile.salvage']],
  ['apartment', 'Многоквартирный дом', ['profile.household', 'profile.salvage']],
  ['residential', 'Жилое здание', ['profile.household', 'profile.salvage']],
  ['industrial', 'Промышленное здание', ['profile.industrial', 'profile.salvage']],
  ['storage', 'Склад', ['profile.industrial', 'profile.salvage']],
  ['medical', 'Медицинское здание', ['profile.medical', 'profile.salvage']],
  ['religious', 'Религиозное здание', ['profile.salvage']],
  ['education', 'Учебное здание', ['profile.education', 'profile.salvage']],
  ['retail', 'Торговое здание', ['profile.household', 'profile.salvage']],
  ['commercial', 'Коммерческое здание', ['profile.household', 'profile.salvage']],
  ['office', 'Офисное здание', ['profile.education', 'profile.salvage']],
  ['food', 'Заведение питания', ['profile.food', 'profile.household', 'profile.salvage']],
  ['lodging', 'Гостиничное здание', ['profile.household', 'profile.salvage']],
  ['civic', 'Общественное здание', ['profile.education', 'profile.salvage']],
  ['emergency', 'Здание экстренных служб', ['profile.industrial', 'profile.salvage']],
  ['service', 'Здание обслуживания', ['profile.industrial', 'profile.salvage']],
  ['garage', 'Гараж', ['profile.vehicles', 'profile.salvage']],
  ['agricultural', 'Сельскохозяйственная постройка', ['profile.agriculture', 'profile.salvage']],
  ['utility', 'Техническая постройка', ['profile.electrical', 'profile.salvage']],
  ['transport', 'Транспортное здание', ['profile.vehicles', 'profile.salvage']],
  ['leisure', 'Здание для отдыха', ['profile.household', 'profile.salvage']],
  ['shelter', 'Укрытие или навес', ['profile.salvage']],
  ['ruin', 'Руины неуточнённого здания', ['profile.salvage']],
], 'resourceProfileIds');

export const BIOME_TYPES = gtCatalog('biome', [
  ['unknown', 'Биом неуточнённого типа'],
  ['administrative', 'Административная территория'],
  ['plain', 'Открытая местность', ['profile.outdoors']],
  ['wasteland', 'Пустошь', ['profile.outdoors']],
  ['suburb', 'Пригород', ['profile.household', 'profile.salvage']],
  ['urban', 'Городская застройка', ['profile.household', 'profile.salvage']],
  ['dense', 'Плотная застройка', ['profile.household', 'profile.salvage']],
  ['aircraft_parking', 'Стоянка самолётов', ['profile.vehicles']],
  ['residential', 'Жилая зона', ['profile.household', 'profile.salvage']],
  ['industrial', 'Промышленная зона', ['profile.industrial', 'profile.salvage']],
  ['commercial', 'Коммерческая зона', ['profile.household', 'profile.salvage']],
  ['retail', 'Торговая зона', ['profile.household', 'profile.salvage']],
  ['parking', 'Парковочная зона', ['profile.vehicles']],
  ['religious', 'Религиозная зона', ['profile.salvage']],
  ['healthcare', 'Медицинская зона', ['profile.medical']],
  ['education', 'Образовательная зона', ['profile.education']],
  ['civic', 'Общественная зона', ['profile.education']],
  ['emergency', 'Зона экстренных служб', ['profile.industrial', 'profile.medical']],
  ['transport', 'Транспортная зона', ['profile.vehicles']],
  ['accommodation', 'Гостиничная зона', ['profile.household']],
  ['camping', 'Кемпинг', ['profile.household', 'profile.outdoors']],
  ['food_service', 'Зона питания', ['profile.food', 'profile.household']],
  ['service', 'Зона обслуживания', ['profile.industrial']],
  ['utilities', 'Коммунальная зона', ['profile.electrical']],
  ['heritage', 'Историческая зона', ['profile.salvage']],
  ['forest', 'Лес', ['profile.outdoors']],
  ['wetland', 'Заболоченная местность', ['profile.outdoors', 'profile.water']],
  ['grassland', 'Луг', ['profile.outdoors']],
  ['scrub', 'Кустарник', ['profile.outdoors']],
  ['park', 'Парк', ['profile.outdoors']],
  ['garden', 'Сад', ['profile.agriculture', 'profile.outdoors']],
  ['recreation', 'Зона отдыха', ['profile.outdoors']],
  ['farmland', 'Поля', ['profile.agriculture']],
  ['orchard', 'Садовые угодья', ['profile.agriculture']],
  ['vineyard', 'Виноградник', ['profile.agriculture']],
  ['cemetery', 'Кладбище', ['profile.salvage']],
  ['sand', 'Пески', ['profile.outdoors']],
  ['desert', 'Пустыня', ['profile.outdoors']],
  ['valley', 'Долина'],
  ['gully', 'Овраг'],
  ['rock', 'Скальная местность', ['profile.mining']],
  ['quarry', 'Карьер', ['profile.mining', 'profile.industrial']],
  ['construction', 'Стройплощадка', ['profile.industrial', 'profile.salvage']],
  ['brownfield', 'Заброшенная территория', ['profile.salvage']],
  ['landfill', 'Полигон отходов', ['profile.salvage']],
  ['glacier', 'Ледник', ['profile.water']],
  ['water', 'Водоём или водоток', ['profile.water']],
  ['dry_riverbed', 'Сухое русло', ['profile.outdoors']],
], 'resourceProfileIds');

// These are explicit source semantics, not guesses from a name, address or zone.
const gtAmenityBuildings = {
  hospital: 'medical', clinic: 'medical', doctors: 'medical', dentist: 'medical', pharmacy: 'medical', nursing_home: 'medical',
  place_of_worship: 'religious', monastery: 'religious',
  school: 'education', college: 'education', university: 'education', kindergarten: 'education', library: 'education', music_school: 'education', language_school: 'education',
  restaurant: 'food', cafe: 'food', fast_food: 'food', food_court: 'food', pub: 'food', bar: 'food', ice_cream: 'food',
  police: 'emergency', fire_station: 'emergency', ambulance_station: 'emergency', rescue_station: 'emergency',
  townhall: 'civic', courthouse: 'civic', community_centre: 'civic', social_centre: 'civic', social_facility: 'civic', post_office: 'civic', public_building: 'civic', embassy: 'civic', prison: 'civic',
  bus_station: 'transport', ferry_terminal: 'transport',
  shelter: 'shelter', marketplace: 'retail',
  fuel: 'service', car_wash: 'service', car_rental: 'service', bank: 'office', veterinary: 'medical',
};
const gtPhysicalBuildings = {
  house: 'house', detached: 'house', semidetached_house: 'house', terrace: 'house', bungalow: 'house', cabin: 'house', farmhouse: 'house', hut: 'house',
  apartments: 'apartment', dormitory: 'apartment', residential: 'residential',
  industrial: 'industrial', manufacture: 'industrial', factory: 'industrial', warehouse: 'storage', storage_tank: 'storage', storage: 'storage',
  hospital: 'medical', clinic: 'medical', church: 'religious', cathedral: 'religious', chapel: 'religious', mosque: 'religious', synagogue: 'religious', temple: 'religious', monastery: 'religious',
  school: 'education', university: 'education', college: 'education', kindergarten: 'education',
  retail: 'retail', supermarket: 'retail', kiosk: 'retail', commercial: 'commercial', office: 'office',
  hotel: 'lodging', motel: 'lodging', guest_house: 'lodging', hostel: 'lodging',
  civic: 'civic', public: 'civic', government: 'civic', townhall: 'civic',
  fire_station: 'emergency', garage: 'garage', garages: 'garage', carport: 'garage',
  barn: 'agricultural', farm_auxiliary: 'agricultural', stable: 'agricultural', cowshed: 'agricultural', greenhouse: 'agricultural',
  transformer_tower: 'utility', substation: 'utility', service: 'utility', water_tower: 'utility',
  train_station: 'transport', transportation: 'transport', hangar: 'transport', terminal: 'transport',
  sports_hall: 'leisure', stadium: 'leisure', pavilion: 'leisure',
  roof: 'shelter', shed: 'storage', ruins: 'ruin',
};
const gtLodging = new Set(['hotel', 'motel', 'hostel', 'guest_house', 'apartment', 'chalet', 'alpine_hut', 'wilderness_hut', 'resort']);

/** Identify purpose only from mapped function/type; keep condition independently. */
export function classifyBuilding(feature = {}) {
  const tags = feature.tags || {};
  const sourceType = String(tags.building || feature.type || '').trim() || null;
  let key = 'unknown', classificationSource = 'unknown';
  if (gtAmenityBuildings[tags.amenity]) { key = gtAmenityBuildings[tags.amenity]; classificationSource = 'amenity'; }
  else if (gtPresent(tags.healthcare)) { key = 'medical'; classificationSource = 'healthcare'; }
  else if (gtPresent(tags.shop)) { key = 'retail'; classificationSource = 'shop'; }
  else if (gtLodging.has(tags.tourism)) { key = 'lodging'; classificationSource = 'tourism'; }
  else if (tags.tourism === 'museum') { key = 'civic'; classificationSource = 'tourism'; }
  else if (gtPresent(tags.office)) { key = ['government', 'diplomatic'].includes(tags.office) ? 'civic' : 'office'; classificationSource = 'office'; }
  else if (['plant', 'substation'].includes(tags.power) || ['works', 'water_works', 'wastewater_plant'].includes(tags.man_made)) { key = 'utility'; classificationSource = 'infrastructure'; }
  else if (gtPhysicalBuildings[sourceType]) { key = gtPhysicalBuildings[sourceType]; classificationSource = 'building'; }
  const definition = BUILDING_TYPES[`building.${key}`];
  const ruined = gtPresent(feature.ruins) || sourceType === 'ruins' || tags.historic === 'ruins' || gtPresent(tags.ruins);
  const condition = ruined ? 'ruined' : gtPresent(tags.abandoned) || gtPresent(tags['abandoned:building']) ? 'abandoned' : 'standing';
  return { typeId: definition.id, typeName: definition.name, resourceProfileIds: [...definition.resourceProfileIds], condition, sourceType, classificationSource };
}

const gtBiomeAliases = { swamp: 'wetland', grass: 'grassland', meadow: 'grassland', wood: 'forest', lake: 'water', river: 'water', pond: 'water', reservoir: 'water', boundary: 'administrative', settlement: 'administrative' };

/** Accept a canonical mapBiome value, a zone descriptor or an original feature. */
export function classifyBiome(input = {}) {
  const sourceBiome = typeof input === 'string' ? input.replace(/^biome\./, '') : input?.biome || mapBiome(input || {});
  const key = gtBiomeAliases[sourceBiome] || sourceBiome;
  const definition = BIOME_TYPES[`biome.${key}`] || BIOME_TYPES['biome.unknown'];
  return { typeId: definition.id, typeName: definition.name, resourceProfileIds: [...definition.resourceProfileIds], sourceBiome: sourceBiome || null };
}

/** Union preserves overlapping biome/building profiles without multiplying them. */
export function collectResourceProfiles(...inputs) {
  const profiles = new Set();
  const visit = input => {
    if (input === null || input === undefined) return;
    if (Array.isArray(input)) { input.forEach(visit); return; }
    if (typeof input === 'object') { visit(input.resourceProfileIds || input.gameplayType?.resourceProfileIds || []); return; }
    if (typeof input !== 'string') throw new Error('Expected a gameplay type or resource profile ID.');
    if (RESOURCE_PROFILES[input]) { profiles.add(input); return; }
    const definition = BUILDING_TYPES[input] || BIOME_TYPES[input];
    if (!definition) throw new Error(`Unknown gameplay type or resource profile: ${input}`);
    definition.resourceProfileIds.forEach(visit);
  };
  inputs.forEach(visit);
  return [...profiles].sort();
}

/** These candidates are editable design data; this function never awards loot. */
export function collectResourceCandidates(...inputs) {
  const ids = new Set(collectResourceProfiles(...inputs).flatMap(id => RESOURCE_PROFILES[id].candidateResourceIds));
  return [...ids].sort().map(id => ({ ...RESOURCE_KINDS[id] }));
}
