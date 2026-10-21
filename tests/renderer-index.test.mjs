import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailRenderer } from '../detail-renderer.js';

globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} ellipse() {} };
const ring = (x1, y1, x2, y2) => [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }, { x: x1, y: y1 }];
const world = changes => ({ width: 10000, height: 10000, metersPerUnit: 1, roads: [], buildings: [], areas: [], rivers: [], lakes: [], details: [], ...changes });

test('spatial candidates include wide road strokes and giant zone holes outside the current view', () => {
  const outer = ring(0, 0, 10000, 10000), hole = ring(5000, 5000, 7000, 7000);
  const renderer = createDetailRenderer(world({
    roads: [{ id: 'wide-road', points: [{ x: 20, y: 50 }, { x: 350, y: 50 }], width: 800 }],
    details: [{ id: 'whole-region', geometry: 'polygon', points: outer, rings: [outer, hole], tags: { natural: 'wood' } }],
  }));
  assert.equal(renderer.pick(100, 400, 0).id, 'wide-road', 'A wide stroke must be indexed across its painted width');
  assert.equal(renderer.pick(9000, 9000, 0).sourceId, 'whole-region');
  assert.deepEqual(renderer.zonesAt(6000, 6000).map(zone => zone.biome), ['wasteland'], 'A large indexed polygon exposes ground through its hole');
  assert.deepEqual(renderer.zonesAt(9000, 9000).map(zone => zone.biome), ['forest']);
  renderer.setLayers({ biomes: false });
  assert.equal(renderer.pick(9000, 9000), null);
  assert.deepEqual(renderer.zonesAt(9000, 9000).map(zone => zone.biome), ['forest']);
});

test('power line visibility is independent while utility support markers are omitted', () => {
  const renderer = createDetailRenderer(world({ details: [
    { id: 'pole', geometry: 'point', points: [{ x: 128, y: 128 }], kind: 'utility_pole', tags: { man_made: 'utility_pole' } },
    { id: 'line', geometry: 'line', points: [{ x: 20, y: 200 }, { x: 1000, y: 200 }], tags: { power: 'line' } },
  ] }));
  renderer.setLayers({ biomes: false });
  assert.equal(renderer.pick(128, 128), null, 'Utility poles are retained in the source but do not clutter the map');
  assert.equal(renderer.pick(700, 200).layer, 'power');
  assert.equal(renderer.getStats().power, 1);
  assert.equal(renderer.getStats().filteredFeatures, 1);
  renderer.setLayers({ details: false });
  assert.equal(renderer.pick(700, 200).id, 'line', 'Hiding small objects cannot hide the electrical network');
  renderer.setLayers({ power: false });
  assert.equal(renderer.pick(128, 128), null);
  assert.equal(renderer.pick(700, 200), null);
});

test('selection overlay paints only the target without drawing the static scene again', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, roads: [
    { id: 'street', points: [{ x: 20, y: 100 }, { x: 350, y: 100 }], width: 6 },
    { id: 'other', points: [{ x: 20, y: 200 }, { x: 350, y: 200 }], width: 6 },
  ] }));
  const strokes = [], context = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, stroke(path) { strokes.push(path); } };
  const selected = renderer.pick(100, 100), view = { zoom: 1, cameraX: 200, cameraY: 150, width: 400, height: 300 };
  assert.equal(renderer.drawHighlight(context, view, selected), selected.key);
  assert.equal(strokes.length, 2);
  assert.equal(strokes[0], strokes[1], 'Only one cached path is used for halo and centre stroke');
  assert.equal(renderer.getStats().drawCount, 0, 'Highlighting must not call the full scene draw');
  assert.equal(renderer.getStats().highlightDrawCount, 1);
  renderer.setLayers({ roads: false });
  assert.equal(renderer.drawHighlight(context, view, selected.key), null);
  assert.equal(strokes.length, 2, 'A hidden selection must not leave overlay ink');
});

test('cached building and biome types remain distinct and cannot be mutated through descriptors', () => {
  const renderer = createDetailRenderer(world({ buildings: [
    { id: 'unknown', points: ring(20, 20, 60, 60), tags: { building: 'yes' }, type: 'yes' },
    { id: 'clinic', points: ring(100, 100, 200, 200), tags: { building: 'yes', amenity: 'clinic' }, type: 'yes' },
  ], details: [{ id: 'forest', geometry: 'polygon', points: ring(0, 0, 400, 400), tags: { natural: 'wood' } }] }));
  const unknown = renderer.pick(40, 40);
  assert.equal(unknown.typeId, 'building.unknown');
  assert.deepEqual(unknown.resourceProfileIds, []);
  assert(unknown.gameplayAssignment.roleId, 'Unknown facts still receive a separate game role');
  assert.equal(unknown.gameplayAssignment.roleOrigin, 'gameplay');
  assert.equal(unknown.gameplayAssignment.sourceFactType.typeId, 'building.unknown');
  const initialRole = unknown.roleId;
  unknown.gameplayAssignment.roleId = 'tampered'; unknown.source.gameplayAssignment.roleName = 'tampered';
  assert.equal(renderer.pick(40, 40).roleId, initialRole);
  assert.notEqual(renderer.pick(40, 40).roleName, 'tampered');
  const clinic = renderer.pick(150, 150);
  assert.equal(clinic.typeId, 'building.medical');
  assert(clinic.resourceProfileIds.includes('profile.medical'));
  clinic.resourceProfileIds.push('tampered'); clinic.gameplayType.resourceProfileIds.push('tampered');
  assert(!renderer.pick(150, 150).resourceProfileIds.includes('tampered'));
  const zones = renderer.zonesAt(150, 150);
  assert.deepEqual(zones.map(zone => zone.typeId), ['biome.forest']);
  zones[0].resourceProfileIds.push('tampered');
  assert(renderer.zonesAt(150, 150).every(zone => !zone.resourceProfileIds.includes('tampered')));
});

test('dry watercourses cannot inherit a water resource profile from their visual layer', () => {
  const renderer = createDetailRenderer(world({ rivers: [
    { id: 'dry', points: [{ x: 20, y: 50 }, { x: 500, y: 50 }], tags: { waterway: 'river', intermittent: 'yes' } },
    { id: 'wet', points: [{ x: 20, y: 100 }, { x: 500, y: 100 }], tags: { waterway: 'river' } },
  ] }));
  assert.equal(renderer.pick(100, 50).typeId, 'biome.seasonal_river');
  assert(!renderer.pick(100, 50).resourceProfileIds.includes('profile.water'));
  assert.equal(renderer.pick(100, 100).typeId, 'biome.water');
  assert(renderer.pick(100, 100).resourceProfileIds.includes('profile.water'));
});

function recordingContext() {
  const strokes = [], fills = [], dashes = [];
  return {
    strokes, fills, dashes,
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    fillRect() { fills.push({ color: this.fillStyle, matte: true }); },
    setLineDash(value) { this.dash = [...value]; dashes.push([...value]); },
    stroke(path) { strokes.push({ path, color: this.strokeStyle, width: this.lineWidth, dash: [...(this.dash || [])] }); },
    fill(path) { fills.push(path); },
  };
}

const fullView = { zoom: 1, cameraX: 200, cameraY: 150, width: 400, height: 300 };

test('road junctions paint all casings before any core and class hiding also removes highlight ink', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, roads: [
    { id: 'west', type: 'residential', width: 6, points: [{ x: 20, y: 150 }, { x: 200, y: 150 }] },
    { id: 'east', type: 'residential', width: 6, points: [{ x: 200, y: 150 }, { x: 380, y: 150 }] },
    { id: 'south', type: 'residential', width: 6, points: [{ x: 200, y: 150 }, { x: 200, y: 280 }] },
  ] }));
  const context = recordingContext();
  renderer.draw(context, fullView);
  assert.deepEqual(context.strokes.map(stroke => stroke.color), ['#82816a', '#d2c6a1']);
  assert(context.strokes.every(stroke => stroke.dash.length === 0));
  const selected = renderer.pick(100, 150, 0);
  assert.equal(renderer.pick(300, 150, 0).key, selected.key);
  assert.equal(renderer.pick(200, 240, 0).key, selected.key);
  assert.equal(selected.paths.length, 3);
  renderer.setLayers({ biomes: false });
  renderer.setRoadClasses({ street: false });
  assert.equal(renderer.pick(100, 150, 0), null);
  assert.equal(renderer.drawHighlight(context, fullView, selected), null);
  assert.equal(context.strokes.length, 2);
  const hidden = recordingContext(); renderer.draw(hidden, fullView);
  assert.equal(hidden.strokes.length, 0);
  assert.equal(renderer.getStats().visibleRoads, 0);
});

test('power chains use continuous solid strips and highlights can resolve an original member id', () => {
  const tags = { power: 'line', voltage: '110000' };
  const renderer = createDetailRenderer(world({ width: 400, height: 300, details: [
    { id: 'way-100', geometry: 'line', points: [{ x: 20, y: 150 }, { x: 200, y: 150 }], tags },
    { id: 'way-200', geometry: 'line', points: [{ x: 200, y: 150 }, { x: 380, y: 150 }], tags },
  ] }));
  const context = recordingContext(); renderer.draw(context, fullView);
  assert.equal(renderer.getStats().sourcePowerLines, 2);
  assert.equal(renderer.getStats().displayPowerLines, 1);
  assert.equal(context.strokes.length, 2, 'The merged electrical path gets one casing and one continuous interior');
  assert(context.strokes.every(stroke => stroke.dash.length === 0));
  const first = renderer.pick(50, 150, 0), last = renderer.pick(350, 150, 0);
  assert.equal(first.key, last.key);
  assert.deepEqual(first.sourceIds.sort(), ['way-100', 'way-200']);
  assert.equal(renderer.drawHighlight(context, fullView, 'way-200'), first.key);
  assert.equal(context.strokes.length, 4);
});

test('removed town boundaries emit no scene or highlight ink', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, details: [
    { id: 'town', geometry: 'polygon', points: ring(20, 20, 380, 280), tags: { boundary: 'administrative', name: 'Town' } },
  ] }));
  const context = recordingContext(); renderer.draw(context, fullView);
  assert.equal(context.fills.length, 2, 'Only the opaque biome ground and its matte are painted');
  assert.equal(context.strokes.length, 0);
  assert.equal(renderer.drawHighlight(context, fullView, 'town'), null);
  assert.equal(context.fills.length, 2);
  assert.equal(context.strokes.length, 0);
});

test('closed substations paint a solid footprint and use the same interior for selection', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, details: [
    { id: 'substation', geometry: 'polygon', points: ring(100, 100, 250, 250), tags: { power: 'substation' } },
  ] }));
  renderer.setLayers({ biomes: false });
  const context = recordingContext(); renderer.draw(context, fullView);
  assert.equal(context.fills.length, 1, 'The full measured footprint is painted');
  assert.equal(context.fillStyle, '#8f9770');
  assert.equal(renderer.pick(180, 180, 0).layer, 'power');
  renderer.setLayers({ power: false });
  assert.equal(renderer.pick(180, 180, 0), null);
});

test('overlapping polygon components use union filling for both scene and selection', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, details: [
    { id: 'lake-west', geometry: 'polygon', points: ring(20, 20, 180, 250), tags: { natural: 'water', water: 'lake' } },
    { id: 'lake-east', geometry: 'polygon', points: ring(120, 20, 350, 250), tags: { natural: 'water', water: 'lake' } },
  ] }));
  const rules = [], context = recordingContext();
  context.fill = (_path, rule) => rules.push(rule);
  renderer.draw(context, fullView);
  assert.deepEqual(rules, ['nonzero', 'nonzero'], 'Fallback ground and the united lake share nonzero filling');
  const selected = renderer.pick(150, 120, 0);
  assert.equal(selected.parts.length, 1, 'Overlapping source pieces become one actual water surface');
  renderer.drawHighlight(context, fullView, selected);
  assert.deepEqual(rules, ['nonzero', 'nonzero', 'nonzero']);
  assert.equal(renderer.pick(50, 120, 0).key, selected.key);
  assert.equal(renderer.pick(250, 120, 0).key, selected.key);
});

test('every Nevada building keeps its colored role while nature and cities form an exclusive ground map', async () => {
  const { default: map } = await import('../maps/usa.js');
  const before = JSON.stringify(map), renderer = createDetailRenderer(map), stats = renderer.getStats(), features = renderer.getFeatures();
  assert.equal(stats.buildings, map.buildings.length);
  assert.equal(stats.sourceRoads, map.roads.length);
  assert.equal(stats.roads, 83);
  assert.equal(stats.displayWaterLines, 29);
  assert.equal(stats.displayWaterAreas, 11);
  assert(stats.biomes > 0);
  assert(stats.biomePartition.coverageError < 1e-5);
  assert(stats.biomePartition.cityFeatures > 0);
  assert.equal(stats.power, 6);
  assert.equal(JSON.stringify(map), before);
  const buildings = features.filter(feature => feature.layer === 'buildings');
  assert.equal(buildings.length, 893);
  assert(buildings.every(feature => feature.gameplayAssignment && feature.roleId && feature.roleName && /^#[a-f0-9]{6}$/i.test(feature.color)));
  assert.equal(new Set(buildings.map(feature => feature.id)).size, map.buildings.length);
  assert(new Set(buildings.map(feature => feature.categoryId)).size >= 8, 'Distinct gameplay uses, not one generic building color');
  assert.equal(stats.buildingAssignments.assigned, 893);
  assert.equal(stats.buildingAssignments.unassigned, 0);
  assert(!features.some(feature => feature.urbanFiller || ['residential', 'commercial', 'retail', 'industrial', 'healthcare', 'education', 'suburb', 'urban', 'dense'].includes(feature.biome)));
  for (const source of map.buildings) {
    const displayed = buildings.find(feature => feature.id === source.id);
    assert.deepEqual(displayed.rings, source.rings?.length ? source.rings : [source.points]);
  }
  const sand = features.find(feature => feature.sourceId === 'relation-15569711');
  assert.equal(sand.biome, 'sand');
  const originalSand = sand.members.find(member => member.sourceId === 'relation-15569711');
  assert(originalSand, 'The cut display partition retains the source sand geometry');
  assert.equal(originalSand.rings.length, 14);
  for (let y = 50; y < map.height; y += 113) for (let x = 50; x < map.width; x += 137) assert.equal(renderer.zonesAt(x, y).length, 1);
});

test('building fills use functional category colors at overview as well as detail scales', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, buildings: [
    { id: 'house', points: ring(20, 20, 60, 60), tags: { building: 'house' } },
    { id: 'shop', points: ring(80, 20, 120, 60), tags: { building: 'retail', shop: 'supermarket' } },
    { id: 'school', points: ring(140, 20, 180, 60), tags: { building: 'school', amenity: 'school' } },
    { id: 'clinic', points: ring(200, 20, 240, 60), tags: { building: 'hospital', amenity: 'clinic' } },
    { id: 'warehouse', points: ring(260, 20, 300, 60), tags: { building: 'warehouse' } },
  ] }));
  renderer.setLayers({ biomes: false });
  const colors = [], context = recordingContext();
  context.fill = function() { colors.push(this.fillStyle); };
  renderer.draw(context, fullView);
  const assigned = renderer.getFeatures().filter(feature => feature.layer === 'buildings');
  assert.deepEqual(colors, assigned.map(feature => feature.color));
  assert.equal(new Set(colors).size, 5, 'Home, shop, school, clinic and warehouse are immediately distinguishable');
  renderer.setLayers({ buildings: false });
  const hidden = recordingContext(); renderer.draw(hidden, fullView);
  assert.equal(hidden.fills.length, 0);
  assert.equal(renderer.pick(40, 40), null);
});

test('seasonal river ink is blue and dashed at the unchanged v12 width at both overview and detail scales', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, rivers: [
    { id: 'dry', width: .8, points: [{ x: 20, y: 50 }, { x: 380, y: 50 }], tags: { waterway: 'stream', intermittent: 'yes' } },
    { id: 'wet', width: 2, points: [{ x: 20, y: 100 }, { x: 380, y: 100 }], tags: { waterway: 'stream' } },
  ] }));
  for (const zoom of [1, 6]) {
    const context = recordingContext();
    renderer.draw(context, { ...fullView, zoom, width: 400 * zoom, height: 300 * zoom });
    const dry = context.strokes.filter(stroke => stroke.dash.length), wet = context.strokes.filter(stroke => !stroke.dash.length);
    assert.equal(dry.length, 2); assert.equal(wet.length, 2);
    assert(dry.every(stroke => stroke.dash[0] === 6 / zoom && stroke.dash[1] === 4 / zoom));
    assert.equal(dry[1].color, '#4c91bd'); assert.equal(wet[1].color, '#3f7eaa');
    assert(Math.abs(dry[0].width - (zoom === 1 ? 3.5 : 1.05)) < 1e-12);
    assert(Math.abs(dry[1].width - (zoom === 1 ? 1.1 : .8)) < 1e-12);
    assert(Math.abs(wet[0].width - (zoom === 1 ? 3.4 : 2 + 1 / 6)) < 1e-12);
    assert.equal(wet[1].width, 2);
  }
});

test('river selection follows visible dash ink outside the native ribbon and highlights the whole network with gaps', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, rivers: [
    { id: 'dry', width: .8, points: [{ x: 20, y: 50 }, { x: 200, y: 50 }], tags: { waterway: 'stream', intermittent: 'yes' } },
    { id: 'branch', width: .8, points: [{ x: 200, y: 50 }, { x: 380, y: 50 }], tags: { waterway: 'stream', intermittent: 'yes' } },
  ], details: [{ id: 'lake', geometry: 'polygon', points: ring(140, 40, 180, 60), tags: { natural: 'water' } }] }));
  renderer.draw(recordingContext(), fullView);
  assert.equal(renderer.zonesAt(22, 51)[0].biome, 'wasteland', 'Physical membership uses native width');
  const selected = renderer.pick(22, 51, 0);
  assert.equal(selected.waterKind, 'seasonal_river', 'The wider visible ink remains selectable');
  assert.equal(renderer.pick(28, 51, 0).biome, 'wasteland', 'A visual dash gap adds no expanded hit footprint');
  assert.equal(renderer.pick(152, 50, 0).biome, 'water', 'A higher priority lake clips river selection and ink');
  assert.equal(selected.paths.length, 2);
  const context = recordingContext(); renderer.drawHighlight(context, fullView, selected);
  assert.equal(context.fills.length, 0);
  assert.equal(context.strokes.length, 2);
  assert(context.strokes.every(stroke => stroke.dash.join(',') === '6,4'));
  assert.equal(context.strokes[0].path, context.strokes[1].path);
  renderer.setLayers({ biomes: false });
  assert.equal(renderer.drawHighlight(context, fullView, selected), null);
  assert.equal(renderer.pick(22, 51, 0), null);
});

test('city ground is opaque gray with an opaque biome matte and the biome switch removes every ground fill', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, buildings: Array.from({ length: 5 }, (_, index) => ({
    id: `house-${index}`, points: ring(130 + index * 25, 130, 145 + index * 25, 145), tags: { building: 'house' },
  })) }));
  renderer.setLayers({ buildings: false });
  const context = recordingContext(), colors = [];
  context.fill = function() { colors.push({ color: this.fillStyle, alpha: this.globalAlpha }); };
  renderer.draw(context, fullView);
  assert(colors.some(fill => fill.color === '#969b99' && fill.alpha === 1));
  assert(context.fills.some(fill => fill.matte && fill.color === '#a7a17d'));
  assert.equal(renderer.zonesAt(190, 138)[0].biome, 'city');
  renderer.setLayers({ biomes: false });
  const hidden = recordingContext(); renderer.draw(hidden, fullView);
  assert.equal(hidden.fills.length, 0); assert.equal(hidden.strokes.length, 0);
  assert.equal(renderer.zonesAt(190, 138)[0].biome, 'city');
});
