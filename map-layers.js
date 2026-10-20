/** Shared semantic ownership for vector geometry, map markers and layer switches. */
const mlPresent = value => value !== undefined && value !== null && !['', 'no', 'false', '0'].includes(String(value));
const mlNaturalKinds = new Set(['tree', 'tree_row', 'wood', 'forest', 'scrub', 'heath', 'grassland', 'wetland', 'swamp', 'sand', 'beach', 'bare_rock', 'scree', 'shingle', 'peak', 'cliff', 'ridge', 'valley', 'fell', 'glacier']);
const mlLeisureZones = new Set(['park', 'garden', 'pitch', 'playground', 'recreation_ground', 'nature_reserve', 'golf_course', 'dog_park', 'sports_centre', 'stadium', 'common']);
const mlWaterKinds = new Set(['water', 'lake', 'river', 'reservoir', 'basin', 'pond', 'pool', 'swimming_pool', 'spring', 'hot_tub', 'tailings_pond']);
const mlWaterways = new Set(['river', 'stream', 'canal', 'drain', 'ditch', 'riverbank', 'dock', 'tidal_channel']);
const mlPowerKinds = new Set(['utility_pole', 'power_pole', 'power_tower', 'power_line', 'power_cable', 'transformer', 'substation']);
const mlPowerFeature = feature => mlPresent(feature.tags?.power) || feature.tags?.man_made === 'utility_pole' || mlPowerKinds.has(feature.kind);
const mlBarrierKinds = new Set(['barrier', 'fence', 'wall', 'city_wall', 'retaining_wall', 'hedge', 'ditch', 'guard_rail', 'handrail', 'kerb', 'gate', 'lift_gate', 'swing_gate', 'kissing_gate', 'cattle_grid', 'bollard', 'block', 'debris', 'stile', 'turnstile', 'sally_port', 'chain', 'rope', 'log', 'jersey_barrier', 'motorcycle_barrier', 'cycle_barrier', 'bus_trap', 'sump_buster', 'border_control', 'entrance']);
const mlRailTracks = new Set(['rail', 'light_rail', 'tram', 'narrow_gauge', 'monorail', 'subway', 'funicular', 'abandoned', 'disused', 'preserved', 'construction']);
const mlRoadSignKinds = new Set(['stop', 'give_way', 'traffic_signals', 'traffic_sign', 'speed_camera', 'milestone', 'turning_circle', 'noexit']);
const mlPointFeature = (feature, group) => feature.geometry === 'point' || group === 'poi'
  || !feature.points?.length && Number.isFinite(feature.x) && Number.isFinite(feature.y) && group !== 'lake';
const mlServiceZones = new Map([
  ['parking', 'parking'], ['parking_space', 'parking'], ['motorcycle_parking', 'parking'], ['bicycle_parking', 'parking'], ['parking_entrance', 'parking'],
  ['place_of_worship', 'religious'], ['monastery', 'religious'],
  ['hospital', 'healthcare'], ['clinic', 'healthcare'], ['doctors', 'healthcare'], ['dentist', 'healthcare'], ['pharmacy', 'healthcare'], ['nursing_home', 'healthcare'],
  ['school', 'education'], ['college', 'education'], ['university', 'education'], ['kindergarten', 'education'], ['library', 'education'], ['music_school', 'education'], ['language_school', 'education'], ['driving_school', 'education'],
  ['townhall', 'civic'], ['courthouse', 'civic'], ['community_centre', 'civic'], ['social_centre', 'civic'], ['social_facility', 'civic'], ['post_office', 'civic'], ['public_building', 'civic'], ['embassy', 'civic'], ['prison', 'civic'],
  ['police', 'emergency'], ['fire_station', 'emergency'], ['ambulance_station', 'emergency'], ['rescue_station', 'emergency'],
  ['bus_station', 'transport'], ['ferry_terminal', 'transport'], ['taxi', 'transport'],
  ['restaurant', 'food_service'], ['cafe', 'food_service'], ['fast_food', 'food_service'], ['food_court', 'food_service'], ['pub', 'food_service'], ['bar', 'food_service'], ['biergarten', 'food_service'], ['ice_cream', 'food_service'],
  ['marketplace', 'retail'],
  ['fuel', 'service'], ['car_wash', 'service'], ['car_rental', 'service'], ['vehicle_inspection', 'service'], ['bank', 'service'], ['veterinary', 'service'], ['animal_shelter', 'service'], ['animal_boarding', 'service'], ['crematorium', 'service'], ['funeral_hall', 'service'],
  ['waste_transfer_station', 'utilities'],
]);
const mlAccommodation = new Set(['hotel', 'motel', 'hostel', 'guest_house', 'apartment', 'chalet', 'alpine_hut', 'wilderness_hut', 'resort']);
const mlCamping = new Set(['camp_site', 'caravan_site', 'camp_pitch']);
const mlHeritageSites = new Set(['museum', 'attraction', 'zoo', 'theme_park', 'aquarium']);

/**
 * A site's function is separate from its physical building. This may identify a
 * source point, but never manufactures a surrounding plot or a radius for it.
 */
export function mapZoneBiome(feature = {}) {
  const tags = feature.tags || {};
  const amenity = mlServiceZones.get(tags.amenity);
  if (amenity) return amenity;
  if (mlPresent(tags.healthcare)) return 'healthcare';
  if (tags.landuse === 'religious') return 'religious';
  if (tags.landuse === 'education') return 'education';
  if (tags.landuse === 'institutional') return 'civic';
  if (tags.office === 'government' || tags.office === 'diplomatic') return 'civic';
  if (mlPresent(tags.office)) return 'service';
  if (mlPresent(tags.shop)) return 'retail';
  if (mlAccommodation.has(tags.tourism)) return 'accommodation';
  if (mlCamping.has(tags.tourism)) return 'camping';
  if (mlHeritageSites.has(tags.tourism)) return 'heritage';
  if (tags.tourism === 'information' && ['office', 'visitor_centre', 'visitor_center'].includes(tags.information)) return 'civic';
  if (['apron', 'parking_position'].includes(tags.aeroway) || feature.kind === 'aircraft_parking') return 'aircraft_parking';
  if (['aerodrome', 'helipad'].includes(tags.aeroway)) return 'transport';
  if (['plant', 'substation'].includes(tags.power) || ['works', 'water_works', 'wastewater_plant'].includes(tags.man_made)) return 'utilities';
  if (tags.amenity === 'recycling' && tags.recycling_type === 'centre') return 'utilities';
  // A mapped archaeological/ruin territory is a zone; an individual statue,
  // memorial or other historical point remains a small physical object.
  if (feature.geometry === 'polygon' && ['archaeological_site', 'ruins', 'battlefield', 'castle', 'fort'].includes(tags.historic)) return 'heritage';
  // Source-free imported maps can express the same semantic type directly.
  if (!tags.amenity && mlServiceZones.has(feature.kind)) return mlServiceZones.get(feature.kind);
  if (!tags.tourism && mlAccommodation.has(feature.kind)) return 'accommodation';
  if (!tags.tourism && mlCamping.has(feature.kind)) return 'camping';
  if (!tags.tourism && mlHeritageSites.has(feature.kind)) return 'heritage';
  return null;
}

export function mapFeatureLayer(feature = {}, group = '') {
  const tags = feature.tags || {};
  const point = mlPointFeature(feature, group);
  const siteMarker = point && group !== 'building' && (mapZoneBiome(feature) || mlPowerFeature(feature));
  if (group === 'building' || !siteMarker && (mlPresent(tags.building) || mlPresent(tags['building:part']))) return 'buildings';
  // A former rail alignment can also be a current highway. Every facet of that
  // same road belongs to the road layer, so its second style cannot leak through.
  if (group === 'road' || !point && (mlPresent(tags.highway) || mlPresent(tags['area:highway'])
    || mlRailTracks.has(tags.railway) || !tags.railway && feature.kind === 'railway')) return 'roads';
  if (group === 'river' || group === 'lake' || feature.type === 'water' || mlWaterKinds.has(feature.kind)
    || tags.natural === 'water' || tags.natural === 'coastline' || tags.natural === 'spring' || mlPresent(tags.water)
    || mlWaterways.has(tags.waterway) || ['reservoir', 'basin'].includes(tags.landuse)
    || ['swimming_pool', 'hot_tub'].includes(tags.leisure) || tags.amenity === 'swimming_pool' || tags.man_made === 'tailings_pond') return 'water';
  // Electrical network geometry belongs to one switch. A plant/substation can
  // still identify a utilities biome through mapZoneBiome without its physical
  // poles, cables or equipment leaking into the landscape/details layers.
  if (group === 'power' || mlPowerFeature(feature)) return 'power';
  if (!point && ['census', 'administrative'].includes(tags.boundary)) return 'landscape';
  if (group === 'area' || mlPresent(tags.natural) || mlPresent(tags.landuse) || mlNaturalKinds.has(feature.kind)
    || mlLeisureZones.has(tags.leisure) || mlLeisureZones.has(feature.kind) || tags.amenity === 'grave_yard'
    || feature.kind === 'cemetery' || feature.kind === 'quarry' || mapZoneBiome(feature)) return 'landscape';
  return 'details';
}

/**
 * The game omits administrative outlines, traffic signs, aircraft parking marks,
 * small crossing/barrier fixtures and electrical point markers.
 * This presentation policy leaves imported geometry, tags and layer ownership
 * intact. Real road/building geometry keeps its role even with fixture tags.
 */
export function shouldRenderFeature(feature = {}, group = '') {
  const tags = feature.tags || {};
  const point = mlPointFeature(feature, group);
  if (['census', 'administrative'].includes(tags.boundary)) return false;
  if (group === 'building' || !point && (mlPresent(tags.building) || mlPresent(tags['building:part']))) return true;
  const highway = mlPresent(tags.highway) && tags.highway !== 'crossing' && !mlRoadSignKinds.has(tags.highway);
  if (!point && (highway || mlPresent(tags['area:highway'])
    || group === 'road' && tags.highway !== 'crossing' && feature.kind !== 'crossing' && !mlRoadSignKinds.has(tags.highway) && !mlRoadSignKinds.has(feature.kind))) return true;
  if (tags.aeroway === 'parking_position' || feature.kind === 'parking_position') return false;
  if (mlRoadSignKinds.has(tags.highway) || mlRoadSignKinds.has(feature.kind)
    || mlPresent(tags.traffic_sign) || point && (mlPresent(tags.noexit) || mlPresent(tags.maxspeed))) return false;
  if (tags.highway === 'crossing' || feature.kind === 'crossing' || tags.footway === 'crossing'
    || Object.entries(tags).some(([key, value]) => (key === 'crossing' || key.startsWith('crossing:')) && mlPresent(value))) return false;
  if (mlPresent(tags.barrier) || tags.barrier === undefined && mlBarrierKinds.has(feature.kind)) return false;
  if (point && mapFeatureLayer(feature, group) === 'power') return false;
  return true;
}

/** Rendering categories never change or replace original OSM tags and geometry. */
export function mapBiome(feature = {}) {
  if (feature.derived === true && feature.biome) return feature.biome;
  const tags = feature.tags || {};
  // Jurisdiction extents may include undeveloped land. They coexist with land
  // use but must not turn their entire area into residential/resource terrain.
  if (['census', 'administrative'].includes(tags.boundary)) return 'administrative';
  const zone = mapZoneBiome(feature);
  if (zone) return zone;
  const natural = tags.natural || (mlNaturalKinds.has(feature.kind) ? feature.kind : '');
  const landuse = tags.landuse;
  if (tags.natural === 'wetland' || tags.wetland || feature.type === 'swamp') return 'wetland';
  if (natural === 'wood' || natural === 'forest' || landuse === 'forest' || feature.type === 'forest') return 'forest';
  if (['residential', 'industrial', 'commercial', 'retail', 'farmland', 'orchard', 'vineyard', 'cemetery', 'quarry', 'construction', 'brownfield', 'landfill'].includes(landuse)) return landuse;
  if (['railway', 'garages', 'depot', 'port'].includes(landuse)) return 'transport';
  if (landuse === 'allotments') return 'garden';
  if (['meadow', 'grass', 'village_green'].includes(landuse) || natural === 'grassland') return 'grassland';
  if (natural === 'scrub' || natural === 'heath') return 'scrub';
  if (natural === 'sand' || natural === 'beach' || natural === 'shingle') return 'sand';
  if (['bare_rock', 'scree', 'peak', 'cliff', 'ridge', 'arete', 'fell'].includes(natural)) return 'rock';
  if (natural === 'glacier') return 'glacier';
  if (tags.amenity === 'grave_yard' || feature.kind === 'cemetery') return 'cemetery';
  if (tags.leisure === 'garden' || feature.kind === 'garden') return 'garden';
  if (tags.leisure === 'park' || tags.leisure === 'nature_reserve' || feature.kind === 'park') return 'park';
  if (mlLeisureZones.has(tags.leisure) || mlLeisureZones.has(feature.kind) || landuse === 'recreation_ground') return 'recreation';
  if (feature.kind === 'quarry') return 'quarry';
  if (natural === 'tree' || natural === 'tree_row') return 'forest';
  return landuse || natural || feature.type || 'landscape';
}
