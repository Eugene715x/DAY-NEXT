/** Shared semantic ownership for vector geometry, map markers and layer switches. */
const mlPresent = value => value !== undefined && value !== null && !['', 'no', 'false', '0'].includes(String(value));
const mlNaturalKinds = new Set(['tree', 'tree_row', 'wood', 'forest', 'scrub', 'heath', 'grassland', 'wetland', 'swamp', 'sand', 'beach', 'bare_rock', 'scree', 'shingle', 'peak', 'cliff', 'ridge', 'valley', 'fell', 'glacier']);
const mlLeisureZones = new Set(['park', 'garden', 'pitch', 'playground', 'recreation_ground', 'nature_reserve', 'golf_course', 'dog_park', 'sports_centre', 'stadium', 'common']);
const mlWaterKinds = new Set(['water', 'lake', 'river', 'reservoir', 'basin', 'pond', 'pool', 'swimming_pool', 'spring']);
const mlWaterways = new Set(['river', 'stream', 'canal', 'drain', 'ditch', 'riverbank', 'dock', 'tidal_channel']);

export function mapFeatureLayer(feature = {}, group = '') {
  const tags = feature.tags || {};
  const point = feature.geometry === 'point' || group === 'poi' || !feature.points?.length && Number.isFinite(feature.x) && Number.isFinite(feature.y) && group !== 'lake';
  if (group === 'building' || mlPresent(tags.building) || mlPresent(tags['building:part'])) return 'buildings';
  // A former rail alignment can also be a current highway. Every facet of that
  // same road belongs to the road layer, so its second style cannot leak through.
  if (group === 'road' || !point && (mlPresent(tags.highway) || mlPresent(tags['area:highway']))) return 'roads';
  if (group === 'river' || group === 'lake' || feature.type === 'water' || mlWaterKinds.has(feature.kind)
    || tags.natural === 'water' || tags.natural === 'coastline' || tags.natural === 'spring' || mlPresent(tags.water)
    || mlWaterways.has(tags.waterway) || ['reservoir', 'basin'].includes(tags.landuse)
    || tags.leisure === 'swimming_pool' || tags.amenity === 'swimming_pool') return 'water';
  if (group === 'area' || mlPresent(tags.natural) || mlPresent(tags.landuse) || mlNaturalKinds.has(feature.kind)
    || mlLeisureZones.has(tags.leisure) || mlLeisureZones.has(feature.kind) || tags.amenity === 'grave_yard'
    || feature.kind === 'cemetery' || feature.kind === 'quarry') return 'landscape';
  return 'details';
}

/** Rendering categories never change or replace original OSM tags and geometry. */
export function mapBiome(feature = {}) {
  const tags = feature.tags || {};
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
