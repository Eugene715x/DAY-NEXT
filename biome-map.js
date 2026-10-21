import { mapFeatureLayer, mapLandscapeBiome, shouldRenderFeature } from './map-layers.js';
import { mergeConnectedNetworks } from './map-presentation.js';
import { polygonDifference, polygonIntersection, polygonUnion, normalizePolygonParts } from './polygon-geometry.js';
import { buildWaterRibbonParts } from './biome-ribbons.js';
import { buildCityBiomes } from './city-biomes.js';

// A ground partition, calculated once per map. Source features remain untouched.
const bmClone = value => Array.isArray(value) ? value.map(bmClone) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bmClone(item)])) : value;
const bmFlag = value => value !== undefined && value !== null && !['', 'no', 'false', '0'].includes(String(value));
const bmDry = feature => [feature.intermittent, feature.seasonal, feature.tags?.intermittent, feature.tags?.seasonal].some(bmFlag);
const bmSourceId = feature => feature.sourceId || feature.id?.match(/^(?:node|way|relation)-\d+/)?.[0] || feature.id;
const bmAreaRing = ring => { let sum = 0; const origin = ring[0]; for (let i = 1; i < ring.length - 1; i++) sum += (ring[i].x - origin.x) * (ring[i + 1].y - origin.y) - (ring[i + 1].x - origin.x) * (ring[i].y - origin.y); return Math.abs(sum / 2); };
const bmArea = parts => parts.reduce((sum, polygon) => sum + Math.max(0, bmAreaRing(polygon[0]) - polygon.slice(1).reduce((holes, ring) => holes + bmAreaRing(ring), 0)), 0);
const bmBounds = parts => parts.flat(2).reduce((box, point) => ({ minX: Math.min(box.minX, point.x), minY: Math.min(box.minY, point.y), maxX: Math.max(box.maxX, point.x), maxY: Math.max(box.maxY, point.y) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
const bmOverlap = (a, b, pad = 0) => a.minX <= b.maxX + pad && a.maxX >= b.minX - pad && a.minY <= b.maxY + pad && a.maxY >= b.minY - pad;
function bmParts(feature) {
  if (feature.parts?.length) return feature.parts;
  if (feature.rings?.length) return [feature.rings];
  if (feature.geometry !== 'line' && feature.geometry !== 'point' && feature.points?.length >= 3) return [[feature.points]];
  if ([feature.x, feature.y, feature.rx, feature.ry].every(Number.isFinite)) {
    const ring = Array.from({ length: 49 }, (_, index) => ({ x: feature.x + Math.cos(index / 48 * Math.PI * 2) * feature.rx, y: feature.y + Math.sin(index / 48 * Math.PI * 2) * feature.ry }));
    ring[ring.length - 1] = { ...ring[0] }; return [[ring]];
  }
  return [];
}
function bmWidth(feature, metersPerUnit) {
  const physical = Number(feature.widthMeters ?? feature.tags?.width) / metersPerUnit;
  return physical > 0 && Number.isFinite(physical) ? physical : Number(feature.width) > 0 ? Number(feature.width) : 1;
}
function bmSourceCollections(world) {
  return [['areas', 'area'], ['details', 'detail'], ['rivers', 'river'], ['lakes', 'lake']].flatMap(([collection, group]) => (world[collection] || []).map((feature, index) => ({ feature: feature.id ? feature : { ...feature, id: `${collection}-${index}` }, group })));
}
function bmTerrainNature(world) {
  if (world.geographic || !world.terrainCells?.length || !(world.cols > 0 && world.rows > 0 && world.cellSize > 0)) return [];
  const groups = new Map();
  for (let row = 0; row < world.rows; row++) {
    let col = 0;
    while (col < world.cols) {
      const type = world.terrainCells[row * world.cols + col]?.type;
      const biome = ({ forest: 'forest', hill: 'rock', swamp: 'wetland' })[type];
      const start = col++;
      while (col < world.cols && world.terrainCells[row * world.cols + col]?.type === type) col++;
      if (!biome) continue;
      const x = start * world.cellSize, y = row * world.cellSize, right = Math.min(world.width, col * world.cellSize), bottom = Math.min(world.height, (row + 1) * world.cellSize);
      const ring = [{ x, y }, { x: right, y }, { x: right, y: bottom }, { x, y: bottom }, { x, y }];
      if (!groups.has(biome)) groups.set(biome, []);
      groups.get(biome).push([ring]);
    }
  }
  return [...groups].map(([biome, parts]) => ({ id: `generated-terrain-${biome}`, biome, type: biome, geometry: 'polygon', parts: polygonUnion(parts), derived: true, provenance: { method: 'procedural-ground-cells', seed: world.seed ?? null } }));
}
function bmDefaultSources(world, metersPerUnit) {
  const sources = bmSourceCollections(world).filter(({ feature, group }) => shouldRenderFeature(feature, group));
  const natureSources = sources.flatMap(({ feature, group }) => {
    const biome = mapLandscapeBiome(feature, group), parts = bmParts(feature);
    return biome && parts.length ? [{ ...feature, biome, parts }] : [];
  });
  const water = sources.filter(({ feature, group }) => mapFeatureLayer(feature, group) === 'water');
  const waterAreas = water.filter(({ feature, group }) => group === 'lake' || feature.geometry === 'polygon' || feature.rings?.length || feature.parts?.length).map(({ feature }) => ({ ...feature, parts: bmParts(feature) }));
  const waterLines = water.filter(({ feature, group }) => group !== 'lake' && feature.geometry !== 'polygon' && !feature.rings?.length && !feature.parts?.length && feature.geometry !== 'point' && (feature.paths?.length || feature.points?.length > 1)).map(({ feature }) => ({ ...feature, width: bmWidth(feature, metersPerUnit) }));
  return { natureSources, waterAreas, waterLines: mergeConnectedNetworks(waterLines, { kind: 'water' }).features };
}
const bmPriority = (biome, water, dry, line) => water ? line ? dry ? 90 : 100 : dry ? 105 : 110 : biome === 'city' ? 40 : ['desert', 'valley', 'gully', 'plain', 'wasteland', 'landscape'].includes(biome) ? 20 : 60;
const bmNames = { wasteland: 'Пустошь', city: 'Город', seasonal_river: 'Сезонное русло', river: 'Река', water: 'Водоём', dry_riverbed: 'Сухое русло' };

/**
 * Complete, mutually exclusive polygon coverage of the map bounds.
 * Prepared renderer sources may be supplied to preserve connected-network IDs.
 * River ink keeps original paths/width; its polygon is the physical ground ribbon.
 */
export function buildBiomeMap(world = {}, options = {}) {
  const width = Number(world.width), height = Number(world.height);
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height)) return { features: [], report: { enabled: false, featureCount: 0 } };
  const metersPerUnit = Number(world.metersPerUnit) || 5;
  const defaults = (!options.natureSources || !options.waterLines || !options.waterAreas) ? bmDefaultSources(world, metersPerUnit) : {};
  // Prepared OSM sources can be empty on the generated demo. Its measured
  // pre-road ground cells still belong to this same ground partition.
  const natureSources = [...(options.natureSources || defaults.natureSources), ...bmTerrainNature(world)];
  const waterLines = options.waterLines || defaults.waterLines;
  const waterAreas = options.waterAreas || defaults.waterAreas;
  const cities = options.cityFeatures ? { features: options.cityFeatures, report: { supplied: true } } : buildCityBiomes(world);
  const frame = [[[{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }, { x: 0, y: 0 }]]];
  const frameBounds = { minX: 0, minY: 0, maxX: width, maxY: height };
  const candidates = [];
  const add = (source, biome, water = false, line = false) => {
    if (!source || !biome) return;
    const feature = bmClone(source), dry = water && bmDry(feature);
    const nativeWidth = line ? bmWidth(feature, metersPerUnit) : undefined;
    const paths = line ? (feature.paths?.length ? feature.paths : [feature.points || []]).filter(path => path.length > 1) : undefined;
    let parts = line ? buildWaterRibbonParts(paths, nativeWidth) : bmParts(feature);
    if (!parts.length) return;
    const originalBounds = bmBounds(parts);
    if (!bmOverlap(frameBounds, originalBounds)) return;
    parts = originalBounds.minX < 0 || originalBounds.minY < 0 || originalBounds.maxX > width || originalBounds.maxY > height ? polygonIntersection(parts, frame) : polygonUnion(parts);
    if (!parts.length) return;
    const sourceId = bmSourceId(feature) || feature.id || `source-${candidates.length}`;
    const id = feature.id || sourceId;
    candidates.push({
      feature: { ...feature, id: `biome-${biome}-${id}`, sourceId,
        sourceIds: [...new Set(feature.sourceIds || [sourceId])].sort(), memberIds: [...(feature.memberIds || [id])],
        // Cutting a display region must not replace its inspectable source
        // footprint. Networks already contain their individual source members.
        members: feature.members?.length ? feature.members : [bmClone(source)],
        sourceTypes: [...(feature.sourceTypes || [feature.tags?.waterway || feature.tags?.water || feature.kind || feature.type || biome])],
        biome, sourceBiome: feature.sourceBiome || feature.biome || biome,
        sourceKind: feature.sourceKind || feature.kind || feature.type || null, sourceGeometry: feature.sourceGeometry || feature.geometry || (line ? 'line' : 'polygon'),
        name: feature.name || bmNames[biome] || '', kind: biome, geometry: 'polygon', semanticGeometry: line ? 'line' : 'polygon',
        parts, rings: parts[0], points: parts[0][0], water, waterKind: water ? line ? dry ? 'seasonal_river' : 'river' : dry ? 'seasonal_water' : 'lake' : null,
        ...(line ? { paths, width: nativeWidth, nativeWidth } : {}),
        ...(water ? { intermittent: dry, seasonal: bmFlag(feature.seasonal) || bmFlag(feature.tags?.seasonal) } : {}),
        biomePriority: bmPriority(biome, water, dry, line), biomePartition: true,
        provenance: { ...(feature.provenance || {}), partitionMethod: 'exclusive-ground-priority', sourceIds: [...new Set(feature.sourceIds || [sourceId])].sort() },
      }, bounds: bmBounds(parts), area: bmArea(parts),
    });
  };
  for (const feature of natureSources) add(feature, feature.biome || mapLandscapeBiome(feature, 'area'));
  for (const feature of cities.features || []) add(feature, 'city');
  for (const feature of waterLines) add(feature, bmDry(feature) ? 'seasonal_river' : 'river', true, true);
  for (const feature of waterAreas) add(feature, bmDry(feature) ? 'dry_riverbed' : 'water', true, false);
  candidates.sort((a, b) => b.feature.biomePriority - a.feature.biomePriority || a.area - b.area || a.feature.biome.localeCompare(b.feature.biome) || a.feature.id.localeCompare(b.feature.id));
  const finalized = [], features = [], allSourceIds = new Set(), representedSourceIds = new Set();
  let obscuredFeatures = 0, modifiedFeatures = 0;
  for (const candidate of candidates) {
    for (const id of candidate.feature.sourceIds) allSourceIds.add(id);
    const blockers = finalized.filter(record => bmOverlap(record.bounds, candidate.bounds));
    const masks = blockers.flatMap(record => record.feature.parts);
    const parts = masks.length ? polygonDifference(candidate.feature.parts, masks) : normalizePolygonParts(candidate.feature.parts);
    if (!parts.length || bmArea(parts) <= 1e-12) { obscuredFeatures++; continue; }
    const feature = { ...candidate.feature, parts, rings: parts[0], points: parts[0][0] };
    if (Math.abs(bmArea(parts) - candidate.area) > 1e-7) modifiedFeatures++;
    if (feature.water && feature.semanticGeometry === 'line') {
      feature.inkExclusionParts = finalized.filter(record => record.feature.water && bmOverlap(record.bounds, candidate.bounds, 16)).flatMap(record => record.feature.parts).map(bmClone);
    }
    features.push(feature); finalized.push({ feature, bounds: bmBounds(parts) });
    for (const id of feature.sourceIds) representedSourceIds.add(id);
  }
  const mappedArea = features.reduce((sum, feature) => sum + bmArea(feature.parts), 0);
  const fallbackParts = polygonDifference(frame, features.flatMap(feature => feature.parts));
  const fallbackArea = bmArea(fallbackParts);
  if (fallbackParts.length) features.push({ id: 'biome-unmapped-ground', sourceId: 'game-unmapped-ground', sourceIds: [], memberIds: [], sourceTypes: ['unmapped-ground'],
    name: 'Пустошь', kind: 'wasteland', type: 'wasteland', biome: 'wasteland', geometry: 'polygon', semanticGeometry: 'polygon', water: false,
    parts: fallbackParts, rings: fallbackParts[0], points: fallbackParts[0][0], derived: true, fallback: true, biomePartition: true, biomePriority: 0,
    provenance: { method: 'exclusive-ground-fallback', partitionMethod: 'exclusive-ground-priority', sourceIds: [] },
  });
  const coveredArea = features.reduce((sum, feature) => sum + bmArea(feature.parts), 0);
  // The fallback difference measures the mapped union independently of the
  // sum of individual regions, exposing even numerical overlap residue.
  const overlapArea = Math.max(0, mappedArea - (width * height - fallbackArea));
  return { features, report: {
    enabled: true, exclusive: true, method: 'exclusive-ground-priority', featureCount: features.length, sourceCandidates: candidates.length,
    sourceElements: allSourceIds.size, representedSourceElements: representedSourceIds.size, obscuredFeatures, modifiedFeatures,
    sourceIds: [...allSourceIds].sort(), obscuredSourceIds: [...allSourceIds].filter(id => !representedSourceIds.has(id)).sort(),
    mapArea: width * height, coveredArea, coverageError: Math.abs(width * height - coveredArea), overlapArea,
    uncoveredArea: Math.max(0, width * height - (coveredArea - overlapArea)), fallbackArea,
    waterLineFeatures: features.filter(feature => feature.water && feature.semanticGeometry === 'line').length,
    waterAreaFeatures: features.filter(feature => feature.water && feature.semanticGeometry !== 'line').length,
    cityFeatures: features.filter(feature => feature.biome === 'city').length,
    byBiome: Object.fromEntries([...new Set(features.map(feature => feature.biome))].sort().map(biome => [biome, { features: features.filter(feature => feature.biome === biome).length, area: features.filter(feature => feature.biome === biome).reduce((sum, feature) => sum + bmArea(feature.parts), 0) }])),
    city: cities.report,
    priority: ['water areas', 'permanent rivers', 'seasonal rivers', 'specific nature', 'city', 'regional nature', 'unmapped ground'],
  } };
}
