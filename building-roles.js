import { classifyBuilding } from './gameplay-types.js';

// Gameplay roles are separate from measured OSM facts. Unknown mapped purpose
// remains unknown in sourceFactType even when the game assigns a usable role.
const brFreeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(brFreeze); Object.freeze(value); } return value; };
const brClone = value => Array.isArray(value) ? value.map(brClone) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, brClone(item)])) : value;
export const BUILDING_CATEGORIES = brFreeze(Object.fromEntries([
  ['housing', 'Жильё', '#c3b88e', '#d8ceaa', '#786d49', 'house'],
  ['retail', 'Магазины', '#c4a66a', '#dfc58c', '#796038', 'shop'],
  ['food', 'Еда и заведения', '#c88e6f', '#e0b092', '#80513e', 'food'],
  ['medical', 'Медицина', '#80b6ae', '#b1d3c8', '#3f746b', 'medical'],
  ['education', 'Образование', '#88a9c7', '#b1cbe0', '#486b8a', 'school'],
  ['industry', 'Производство', '#8c9da7', '#b7c4ca', '#4f626c', 'industry'],
  ['storage', 'Склады', '#afa18d', '#d0c4af', '#716351', 'storage'],
  ['transport', 'Транспорт', '#b09cc1', '#cebedb', '#6c567e', 'plane'],
  ['civic', 'Общественные здания', '#a09fc5', '#c5c4df', '#5e5d85', 'civic'],
  ['service', 'Службы и мастерские', '#a6b77d', '#c9d5a5', '#647647', 'wrench'],
  ['lodging', 'Гостиницы', '#bea2b2', '#dbc2cd', '#805e72', 'bed'],
  ['ruin', 'Руины', '#8f8c7e', '#b4b0a0', '#57594d', 'ruin'],
].map(([key, name, fill, roof, stroke, icon]) => { const id = `category.${key}`; return [id, { id, name, color: fill, fill, roof, stroke, icon }]; })));
const brRoleRows = [
  ['house', 'Жилой дом', 'housing', 'house', ['household', 'salvage']],
  ['apartment', 'Многоквартирный дом', 'housing', 'apartment', ['household', 'salvage']],
  ['residential', 'Жилой корпус', 'housing', 'residential', ['household', 'salvage']],
  ['mixed_use', 'Многофункциональное здание', 'retail', 'commercial', ['household', 'salvage']],
  ['shop_general', 'Универсальный магазин', 'retail', 'retail', ['household', 'salvage']],
  ['shop_food', 'Продуктовый магазин', 'retail', 'retail', ['food', 'household']],
  ['shop_hardware', 'Хозяйственный магазин', 'retail', 'retail', ['industrial', 'salvage']],
  ['shop_clothing', 'Магазин одежды', 'retail', 'retail', ['household']],
  ['shop_electronics', 'Магазин электроники', 'retail', 'retail', ['electrical']],
  ['shop_auto', 'Магазин автотоваров', 'retail', 'retail', ['vehicles']],
  ['shop_outdoor', 'Магазин снаряжения', 'retail', 'retail', ['household', 'outdoors']],
  ['shop_furniture', 'Магазин мебели', 'retail', 'retail', ['household', 'salvage']],
  ['pharmacy', 'Аптека', 'medical', 'medical', ['medical']],
  ['restaurant', 'Ресторан', 'food', 'food', ['food', 'household']],
  ['cafe', 'Кафе', 'food', 'food', ['food', 'household']],
  ['bar', 'Бар', 'food', 'food', ['food', 'household']],
  ['hospital', 'Больница', 'medical', 'medical', ['medical', 'salvage']],
  ['clinic', 'Медпункт', 'medical', 'medical', ['medical', 'salvage']],
  ['school', 'Школа / учебный корпус', 'education', 'education', ['education', 'salvage']],
  ['library', 'Библиотека', 'education', 'education', ['education']],
  ['warehouse', 'Склад', 'storage', 'storage', ['industrial', 'salvage']],
  ['factory', 'Завод / цех', 'industry', 'industrial', ['industrial', 'salvage']],
  ['workshop', 'Мастерская', 'service', 'service', ['industrial', 'salvage']],
  ['airport', 'Аэропорт / аэровокзал', 'transport', 'transport', ['vehicles', 'electrical']],
  ['hangar', 'Авиационный ангар', 'transport', 'transport', ['vehicles', 'salvage']],
  ['station', 'Станция / вокзал', 'transport', 'transport', ['vehicles', 'salvage']],
  ['garage', 'Гараж', 'transport', 'garage', ['vehicles', 'salvage']],
  ['hotel', 'Гостиница', 'lodging', 'lodging', ['household', 'salvage']],
  ['church', 'Храм', 'civic', 'religious', ['salvage']],
  ['civic', 'Общественное здание', 'civic', 'civic', ['education', 'salvage']],
  ['police', 'Полицейский участок', 'civic', 'emergency', ['industrial', 'salvage']],
  ['fire_station', 'Пожарная часть', 'service', 'emergency', ['industrial', 'vehicles']],
  ['office', 'Офис', 'civic', 'office', ['education', 'salvage']],
  ['utility', 'Техническая постройка', 'service', 'utility', ['electrical', 'salvage']],
  ['farm', 'Хозяйственная постройка', 'service', 'agricultural', ['agriculture', 'salvage']],
  ['shelter', 'Навес / укрытие', 'storage', 'shelter', ['salvage']],
  ['ruins', 'Руины', 'ruin', 'ruin', ['salvage']],
  ['leisure', 'Спортивное здание', 'civic', 'leisure', ['household', 'salvage']],
  ['service', 'Сервисное здание', 'service', 'service', ['industrial', 'salvage']],
  ['fuel', 'Заправочная станция', 'service', 'service', ['vehicles', 'industrial']],
];
export const BUILDING_ROLES = brFreeze(Object.fromEntries(brRoleRows.map(([key, name, category, type, profiles]) => {
  const id = `role.${key}`, definition = BUILDING_CATEGORIES[`category.${category}`];
  return [id, { id, name, categoryId: definition.id, typeId: `building.${type}`, icon: definition.icon, resourceProfileIds: profiles.map(profile => `profile.${profile}`) }];
})));
const brHash = text => { let hash = 2166136261; for (const char of String(text)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0; return hash; };
const brSourceId = feature => String(feature.sourceId || feature.id?.match(/^(?:node|way|relation)-\d+/)?.[0] || feature.id || '');
const brParts = feature => feature.parts?.length ? feature.parts : feature.rings?.length ? [feature.rings] : feature.points?.length >= 3 ? [[feature.points]] : [];
const brBounds = points => points.reduce((b, p) => ({ minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y), maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
const brRingArea = ring => Math.abs(ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]; return sum + p.x * q.y - q.x * p.y; }, 0)) / 2;
const brArea = parts => parts.reduce((total, rings) => total + brRingArea(rings[0]) - rings.slice(1).reduce((sum, ring) => sum + brRingArea(ring), 0), 0);
function brInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside; }
  return inside;
}
const brContains = (record, point) => point.x >= record.bounds.minX && point.x <= record.bounds.maxX && point.y >= record.bounds.minY && point.y <= record.bounds.maxY && record.parts.some(rings => brInRing(point, rings[0]) && !rings.slice(1).some(hole => brInRing(point, hole)));
const brPhysical = { house: 'house', apartment: 'apartment', residential: 'residential', industrial: 'factory', storage: 'warehouse', medical: 'clinic', religious: 'church', education: 'school', retail: 'shop_general', commercial: 'office', office: 'office', food: 'restaurant', lodging: 'hotel', civic: 'civic', emergency: 'fire_station', service: 'service', garage: 'garage', agricultural: 'farm', utility: 'utility', transport: 'station', leisure: 'leisure', shelter: 'shelter', ruin: 'ruins' };
function brFunctionRole(feature = {}) {
  const tags = feature.tags || {}, amenity = tags.amenity, shop = tags.shop;
  const primaryInstitutions = { hospital: 'hospital', clinic: 'clinic', doctors: 'clinic', dentist: 'clinic', pharmacy: 'pharmacy', school: 'school', college: 'school', university: 'school', kindergarten: 'school', library: 'library', police: 'police', fire_station: 'fire_station', place_of_worship: 'church', townhall: 'civic', courthouse: 'civic' };
  if (primaryInstitutions[amenity]) return primaryInstitutions[amenity];
  if (shop && !['no', 'vacant', 'yes'].includes(shop)) {
    if (['supermarket', 'convenience', 'greengrocer', 'bakery', 'butcher', 'confectionery', 'deli', 'seafood', 'beverages', 'alcohol', 'farm'].includes(shop)) return 'shop_food';
    if (['hardware', 'doityourself', 'trade', 'building_materials', 'paint', 'garden_centre'].includes(shop)) return 'shop_hardware';
    if (['clothes', 'shoes', 'fashion', 'second_hand', 'tailor', 'laundry'].includes(shop)) return 'shop_clothing';
    if (['electronics', 'computer', 'mobile_phone', 'electrical', 'appliance', 'hifi'].includes(shop)) return 'shop_electronics';
    if (['car', 'car_parts', 'tyres', 'motorcycle', 'motorcycle_parts'].includes(shop)) return 'shop_auto';
    if (['outdoor', 'sports', 'hunting', 'fishing', 'bicycle'].includes(shop)) return 'shop_outdoor';
    if (['furniture', 'interior_decoration', 'bed', 'carpet'].includes(shop)) return 'shop_furniture';
    if (shop === 'chemist') return 'pharmacy';
    if (['car_repair', 'vehicle_inspection'].includes(shop)) return 'workshop';
    return 'shop_general';
  }
  const amenities = { pharmacy: 'pharmacy', hospital: 'hospital', clinic: 'clinic', doctors: 'clinic', dentist: 'clinic', nursing_home: 'clinic', veterinary: 'clinic', school: 'school', college: 'school', university: 'school', kindergarten: 'school', music_school: 'school', library: 'library', restaurant: 'restaurant', fast_food: 'cafe', cafe: 'cafe', food_court: 'restaurant', pub: 'bar', bar: 'bar', biergarten: 'bar', ice_cream: 'cafe', police: 'police', fire_station: 'fire_station', ambulance_station: 'clinic', rescue_station: 'service', place_of_worship: 'church', monastery: 'church', townhall: 'civic', courthouse: 'civic', post_office: 'civic', community_centre: 'civic', social_centre: 'civic', social_facility: 'civic', embassy: 'civic', prison: 'civic', marketplace: 'shop_general', fuel: 'fuel', car_wash: 'workshop', car_rental: 'service', bank: 'office', bus_station: 'station', ferry_terminal: 'station', shelter: 'shelter', toilets: 'service' };
  if (amenities[amenity]) return amenities[amenity];
  if (tags.healthcare && tags.healthcare !== 'no') return 'clinic';
  if (tags.aeroway === 'hangar') return 'hangar';
  if (['terminal', 'aerodrome'].includes(tags.aeroway)) return 'airport';
  if (tags.railway === 'station') return 'station';
  if (['hotel', 'motel', 'hostel', 'guest_house', 'apartment', 'resort', 'chalet', 'wilderness_hut'].includes(tags.tourism)) return 'hotel';
  if (tags.tourism === 'museum') return 'civic';
  if (tags.office) return ['government', 'diplomatic'].includes(tags.office) ? 'civic' : 'office';
  if (tags.man_made === 'works' || tags.industrial || tags.manufacture) return 'factory';
  if (['plant', 'substation'].includes(tags.power) || ['water_works', 'wastewater_plant'].includes(tags.man_made)) return 'utility';
  return null;
}
function brPhysicalRole(feature, fact) {
  const type = feature.tags?.building || feature.type;
  if (type === 'hangar') return 'hangar';
  if (type === 'terminal') return 'airport';
  return brPhysical[fact.typeId.replace(/^building\./, '')] || null;
}
function brPoint(feature) {
  if (feature.geometry === 'point' && feature.points?.length) return feature.points[0];
  if (feature.points?.length === 1) return feature.points[0];
  if (Number.isFinite(feature.x) && Number.isFinite(feature.y) && !/^(way|relation)-/.test(feature.id || '')) return { x: feature.x, y: feature.y };
  return null;
}
function brDistanceToRoad(record, roads, metersPerUnit) {
  let distance = Infinity;
  for (const road of roads) {
    if (!['primary', 'secondary', 'tertiary', 'trunk', 'unclassified', 'residential', 'service'].includes(road.tags?.highway || road.type || road.sourceType)) continue;
    for (let i = 1; i < (road.points?.length || 0); i++) { const a = road.points[i - 1], b = road.points[i], dx = b.x - a.x, dy = b.y - a.y, denominator = dx * dx + dy * dy; const t = denominator ? Math.max(0, Math.min(1, ((record.center.x - a.x) * dx + (record.center.y - a.y) * dy) / denominator)) : 0; distance = Math.min(distance, Math.hypot(record.center.x - a.x - dx * t, record.center.y - a.y - dy * t)); }
  }
  return distance * metersPerUnit;
}
function brGameRole(record, sites, roads, metersPerUnit) {
  const contextual = sites.filter(site => brContains(site, record.center)).sort((a, b) => a.area - b.area || a.sourceId.localeCompare(b.sourceId));
  const landuse = contextual.find(site => ['industrial', 'commercial', 'retail', 'residential', 'garages', 'farmyard'].includes(site.feature.tags?.landuse));
  const hash = brHash(record.feature.id || record.sourceId), area = record.area * metersPerUnit * metersPerUnit;
  if (landuse?.feature.tags.landuse === 'industrial') return { role: area >= 450 && hash % 3 === 0 ? 'factory' : area >= 120 ? 'warehouse' : 'workshop', evidenceIds: [landuse.sourceId], reason: 'industrial-plot-layout' };
  if (landuse?.feature.tags.landuse === 'garages') return { role: 'garage', evidenceIds: [landuse.sourceId], reason: 'garage-plot-layout' };
  if (landuse?.feature.tags.landuse === 'farmyard') return { role: 'farm', evidenceIds: [landuse.sourceId], reason: 'farm-plot-layout' };
  if (['commercial', 'retail'].includes(landuse?.feature.tags.landuse) && area >= 55) {
    const choices = ['shop_food', 'shop_general', 'shop_hardware', 'shop_clothing', 'shop_electronics', 'shop_auto', 'cafe', 'office'];
    return { role: choices[hash % choices.length], evidenceIds: [landuse.sourceId], reason: 'commercial-plot-layout' };
  }
  if (area < 28) return { role: hash % 4 === 0 ? 'garage' : 'warehouse', evidenceIds: landuse ? [landuse.sourceId] : [], reason: 'small-outbuilding-layout' };
  if (area >= 600 && landuse?.feature.tags.landuse === 'residential') return { role: 'apartment', evidenceIds: [landuse.sourceId], reason: 'residential-footprint-layout' };
  if (area >= 800) return { role: hash % 3 === 0 ? 'factory' : 'warehouse', evidenceIds: landuse ? [landuse.sourceId] : [], reason: 'large-footprint-layout' };
  if (!landuse && area >= 100 && hash % 11 === 0 && brDistanceToRoad(record, roads, metersPerUnit) < 45) return { role: ['shop_general', 'shop_food', 'workshop'][hash % 3], evidenceIds: [], reason: 'roadside-gameplay-layout' };
  return { role: 'house', evidenceIds: landuse ? [landuse.sourceId] : [], reason: 'residential-gameplay-default' };
}

/** Every original footprint gets a game role. Its original tags remain facts. */
export function createBuildingAssignments(world = {}) {
  const buildings = world.buildings || [], metersPerUnit = Number(world.metersPerUnit) || 5;
  const records = buildings.map(feature => {
    const parts = brParts(feature), bounds = brBounds(parts.flat(2));
    return { feature, parts, bounds, center: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }, area: brArea(parts), sourceId: brSourceId(feature) || feature.id || '' };
  });
  const candidates = [...(world.details || []), ...(world.areas || []), ...(world.pois || [])], seenPoints = new Set(), seenSites = new Set(), points = [], sites = [];
  for (const feature of candidates) {
    const sourceId = brSourceId(feature) || feature.id || '', role = brFunctionRole(feature), point = brPoint(feature), parts = brParts(feature);
    if (point && role && !seenPoints.has(sourceId)) { seenPoints.add(sourceId); points.push({ feature, sourceId, role, point }); }
    if (parts.length && !seenSites.has(feature.id || sourceId)) { seenSites.add(feature.id || sourceId); sites.push({ feature, sourceId, role, parts, bounds: brBounds(parts.flat(2)), area: brArea(parts) }); }
  }
  points.sort((a, b) => a.sourceId.localeCompare(b.sourceId)); sites.sort((a, b) => a.area - b.area || a.sourceId.localeCompare(b.sourceId) || String(a.feature.id).localeCompare(String(b.feature.id)));
  for (const site of sites.filter(site => site.role === 'airport')) {
    site.mainBuildingId = records.filter(record => record.sourceId !== site.sourceId && brContains(site, record.center) && !brFunctionRole(record.feature) && !brPhysicalRole(record.feature, classifyBuilding(record.feature)))
      .sort((a, b) => b.area - a.area || a.sourceId.localeCompare(b.sourceId))[0]?.feature.id;
  }
  const counts = {}, categoryCounts = {}, originCounts = { mapped: 0, context: 0, gameplay: 0 };
  const features = records.map(record => {
    const feature = record.feature, fact = classifyBuilding(feature), own = brFunctionRole(feature), physical = brPhysicalRole(feature, fact);
    const contained = points.filter(point => point.sourceId !== record.sourceId && brContains(record, point.point));
    let key, origin, evidenceIds = [], confidence, reason, occupants = [];
    if (own) { key = own; origin = 'mapped'; evidenceIds = [record.sourceId]; confidence = 1; reason = 'building-function-tags'; }
    else if (contained.length) {
      const roles = [...new Set(contained.map(point => point.role))]; key = roles.length === 1 ? roles[0] : 'mixed_use'; origin = 'mapped'; confidence = .95; reason = 'contained-mapped-points'; evidenceIds = contained.map(point => point.sourceId);
      occupants = contained.map(point => ({ sourceId: point.sourceId, roleId: `role.${point.role}`, roleName: BUILDING_ROLES[`role.${point.role}`].name, name: point.feature.name || point.feature.tags?.name || '' }));
    } else if (physical) { key = physical; origin = 'mapped'; evidenceIds = [record.sourceId]; confidence = 1; reason = 'building-type-tag'; }
    else {
      const contexts = sites.filter(site => site.role && site.sourceId !== record.sourceId && brContains(site, record.center) && record.parts[0]?.[0].slice(0, -1).every(point => brContains(site, { x: point.x + (record.center.x - point.x) * 1e-7, y: point.y + (record.center.y - point.y) * 1e-7 })));
      const site = contexts[0];
      if (site) { key = site.role === 'airport' && site.mainBuildingId !== feature.id ? 'hangar' : site.role; origin = 'context'; confidence = .8; reason = 'contained-functional-site'; evidenceIds = [site.sourceId]; }
      else { const generated = brGameRole(record, sites, world.roads || [], metersPerUnit); key = generated.role; origin = 'gameplay'; confidence = .35; reason = generated.reason; evidenceIds = generated.evidenceIds; }
    }
    const definition = BUILDING_ROLES[`role.${key}`], category = BUILDING_CATEGORIES[definition.categoryId];
    const profiles = [...new Set([...definition.resourceProfileIds, ...occupants.flatMap(item => BUILDING_ROLES[item.roleId].resourceProfileIds)])].sort();
    const assignment = {
      roleId: definition.id, roleName: definition.name, typeId: definition.typeId, typeName: definition.name,
      categoryId: category.id, categoryName: category.name, color: category.color, fill: category.fill, roof: category.roof, stroke: category.stroke, icon: definition.icon,
      resourceProfileIds: profiles, roleOrigin: origin, derived: origin !== 'mapped', evidenceIds: [...new Set(evidenceIds)].sort(), confidence, sourceFactType: brClone(fact), condition: fact.condition,
      displayName: feature.name || feature.tags?.name || (occupants.length === 1 ? occupants[0].name : '') || definition.name, occupants,
      provenance: { method: reason, fictional: origin === 'gameplay', inferred: origin === 'context', sourceFactTypeId: fact.typeId, sourceEvidenceIds: [...new Set(evidenceIds)].sort() },
    };
    counts[assignment.roleId] = (counts[assignment.roleId] || 0) + 1; categoryCounts[category.id] = (categoryCounts[category.id] || 0) + 1; originCounts[origin]++;
    return { ...brClone(feature), gameplayAssignment: assignment };
  });
  return { features, report: { total: features.length, assigned: features.length, unassigned: 0, sourceKnown: records.filter(record => classifyBuilding(record.feature).typeId !== 'building.unknown').length, sourceUnknown: records.filter(record => classifyBuilding(record.feature).typeId === 'building.unknown').length, origins: originCounts, byRole: Object.fromEntries(Object.entries(counts).sort()), byCategory: Object.fromEntries(Object.entries(categoryCounts).sort()) } };
}
