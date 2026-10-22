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

test('building selection overlay paints only the target without drawing the static scene again', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, buildings: [
    { id: 'house', points: ring(60, 60, 140, 140), tags: { building: 'house' } },
    { id: 'other', points: ring(200, 60, 280, 140), tags: { building: 'house' } },
  ] }));
  const strokes = [], fills = [], context = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, stroke(path) { strokes.push(path); }, fill(path) { fills.push(path); } };
  const selected = renderer.pick(100, 100), view = { zoom: 1, cameraX: 200, cameraY: 150, width: 400, height: 300 };
  assert.equal(renderer.drawHighlight(context, view, selected), selected.key);
  assert.equal(strokes.length, 1); assert.equal(fills.length, 1);
  assert.equal(strokes[0], fills[0], 'Only the selected cached building footprint is painted');
  assert.equal(renderer.getStats().drawCount, 0, 'Highlighting must not call the full scene draw');
  assert.equal(renderer.getStats().highlightDrawCount, 1);
  renderer.setLayers({ buildings: false });
  assert.equal(renderer.drawHighlight(context, view, selected.key), null);
  assert.equal(strokes.length, 1, 'A hidden selection must not leave overlay ink');
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
    stroke(path) { strokes.push({ path, color: this.strokeStyle, width: this.lineWidth, dash: [...(this.dash || [])], cap: this.lineCap }); },
    fill(path) { fills.push(path); },
  };
}

const fullView = { zoom: 1, cameraX: 200, cameraY: 150, width: 400, height: 300 };

test('road junctions paint all casings before any core and class hiding removes hit targets', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, roads: [
    { id: 'west', type: 'residential', width: 6, points: [{ x: 20, y: 150 }, { x: 200, y: 150 }] },
    { id: 'east', type: 'residential', width: 6, points: [{ x: 200, y: 150 }, { x: 380, y: 150 }] },
    { id: 'south', type: 'residential', width: 6, points: [{ x: 200, y: 150 }, { x: 200, y: 280 }] },
  ] }));
  const context = recordingContext();
  renderer.draw(context, fullView);
  assert.deepEqual(context.strokes.map(stroke => stroke.color), ['#62686a', '#858b8c']);
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

test('power chains use continuous solid strips and hovering an original member paints no overlay', () => {
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
  assert.equal(renderer.drawHighlight(context, fullView, 'way-200'), null);
  assert.equal(context.strokes.length, 2);
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
  assert.deepEqual(rules, ['nonzero', 'nonzero'], 'Water hover keeps the ground fill unchanged');
  assert.equal(renderer.pick(50, 120, 0).key, selected.key);
  assert.equal(renderer.pick(250, 120, 0).key, selected.key);
});

test('every Nevada building keeps its colored role while nature and cities form an exclusive ground map', async () => {
  const { default: map } = await import('../maps/usa.js');
  const before = JSON.stringify(map), renderer = createDetailRenderer(map), stats = renderer.getStats(), features = renderer.getFeatures();
  assert.equal(stats.buildings, map.buildings.length);
  assert.equal(stats.sourceRoads, map.roads.length);
  assert.equal(stats.roads, 83);
  assert.equal(stats.displayWaterLines, 33);
  assert.equal(stats.coalescedWaterRelationFragments, 26);
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

test('seasonal river ink keeps native widths with smooth rounded dashes and open gaps at every map scale', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, rivers: [
    { id: 'dry', width: .8, points: [{ x: 20, y: 50 }, { x: 380, y: 50 }], tags: { waterway: 'stream', intermittent: 'yes' } },
    { id: 'wet', width: 2, points: [{ x: 20, y: 100 }, { x: 380, y: 100 }], tags: { waterway: 'stream' } },
  ] }));
  for (const zoom of [.32, .5, 1, 2, 6, 12, 24]) {
    const context = recordingContext();
    renderer.draw(context, { ...fullView, zoom, width: 400 * zoom, height: 300 * zoom });
    const dry = context.strokes.filter(stroke => stroke.dash.length), wet = context.strokes.filter(stroke => !stroke.dash.length);
    assert.equal(dry.length, 2); assert.equal(wet.length, 2);
    assert(dry.every(stroke => stroke.cap === 'round'));
    assert.deepEqual(dry[0].dash, dry[1].dash, 'Casing and centre share the same dash phase and openings');
    assert(dry[0].dash[0] >= dry[0].width * 2, 'At close scale dashes remain longer than the river is wide');
    assert(dry[0].dash[0] * zoom >= 7, 'Dashes retain a readable screen minimum at overview');
    assert((dry[0].dash[1] - dry[0].width) * zoom >= 4 - 1e-10, 'Rounded caps cannot close the visible gap');
    assert.equal(dry[1].color, '#4c91bd'); assert.equal(wet[1].color, '#3f7eaa');
    assert(Math.abs(dry[0].width - (Math.max(.8, 2 / zoom) + 1.5 / zoom)) < 1e-12);
    assert(Math.abs(dry[1].width - Math.max(.8, 1.1 / zoom)) < 1e-12);
    assert(Math.abs(wet[0].width - (Math.max(2, 2.4 / zoom) + 1 / zoom)) < 1e-12);
    assert.equal(wet[1].width, Math.max(2, 1.1 / zoom));
  }
});

test('river information follows visible dash ink outside the native ribbon without adding a hover overlay', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, rivers: [
    { id: 'dry', width: .8, points: [{ x: 20, y: 50 }, { x: 200, y: 50 }], tags: { waterway: 'stream', intermittent: 'yes' } },
    { id: 'branch', width: .8, points: [{ x: 200, y: 50 }, { x: 380, y: 50 }], tags: { waterway: 'stream', intermittent: 'yes' } },
  ], details: [{ id: 'lake', geometry: 'polygon', points: ring(140, 40, 180, 60), tags: { natural: 'water' } }] }));
  const painted = recordingContext(); renderer.draw(painted, fullView);
  assert.equal(renderer.zonesAt(22, 51)[0].biome, 'wasteland', 'Physical membership uses native width');
  const selected = renderer.pick(22, 51, 0);
  assert.equal(selected.waterKind, 'seasonal_river', 'The wider visible ink remains selectable');
  const [dashLength, gapLength] = painted.strokes.find(stroke => stroke.dash.length).dash;
  assert.equal(renderer.pick(20 + dashLength + gapLength / 2, 51, 0).biome, 'wasteland', 'A visual dash gap adds no expanded hit footprint');
  assert.equal(renderer.pick(20 + dashLength + .8, 51, 0).waterKind, 'seasonal_river', 'The round painted cap also supplies the correct hit target');
  assert.equal(renderer.pick(152, 50, 0).biome, 'water', 'A higher priority lake clips river selection and ink');
  assert.equal(selected.paths.length, 2);
  const context = recordingContext();
  assert.equal(renderer.drawHighlight(context, fullView, selected), null);
  assert.equal(context.fills.length, 0);
  assert.equal(context.strokes.length, 0);
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

test('biomes, roads and electrical objects remain inspectable without changing scene or overlay ink on hover', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, roads: [
    { id: 'street', points: [{ x: 20, y: 120 }, { x: 380, y: 120 }], type: 'residential', width: 3 },
  ], rivers: [{ id: 'wash', points: [{ x: 20, y: 60 }, { x: 380, y: 60 }], width: 3, tags: { waterway: 'stream', intermittent: 'yes' } }], details: [
    { id: 'forest', geometry: 'polygon', points: ring(0, 0, 400, 300), tags: { natural: 'wood' } },
    { id: 'line', geometry: 'line', points: [{ x: 20, y: 200 }, { x: 380, y: 200 }], tags: { power: 'line' } },
    { id: 'station', geometry: 'polygon', points: ring(300, 225, 350, 275), tags: { power: 'substation' } },
    { id: 'lake', geometry: 'polygon', points: ring(30, 225, 80, 275), tags: { natural: 'water' } },
  ] }));
  const capture = hover => {
    const context = recordingContext();
    context.fill = function(path, rule) { this.fills.push({ path, rule, color: this.fillStyle, alpha: this.globalAlpha }); };
    renderer.draw(context, { ...fullView, hoveredId: hover });
    return { fills: context.fills, strokes: context.strokes };
  };
  const baseline = capture(null);
  for (const feature of renderer.getFeatures()) {
    assert(['biomes', 'roads', 'power'].includes(feature.layer));
    assert.deepEqual(capture(feature.id), baseline, `${feature.layer} cannot change the static scene on hover`);
    const context = recordingContext();
    assert.equal(renderer.drawHighlight(context, fullView, feature), null);
    assert.equal(context.fills.length, 0); assert.equal(context.strokes.length, 0);
  }
  assert.equal(renderer.pick(120, 120, 0).layer, 'roads');
  assert.equal(renderer.pick(120, 200, 0).layer, 'power');
  assert.equal(renderer.pick(120, 250, 0).biome, 'forest');
  assert.equal(renderer.getStats().highlightDrawCount, 0);
});

test('a building hover cannot light up roads or electrical objects sharing its original OSM id', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, buildings: [
    { id: 'way-1', points: ring(60, 60, 140, 140), tags: { building: 'house' } },
  ], roads: [
    { id: 'way-1', points: [{ x: 20, y: 150 }, { x: 380, y: 150 }], type: 'residential', width: 3 },
  ], details: [
    { id: 'way-1', geometry: 'polygon', points: ring(220, 60, 280, 120), tags: { power: 'substation' } },
    { id: 'power-line', geometry: 'line', points: [{ x: 20, y: 200 }, { x: 380, y: 200 }], tags: { power: 'line' } },
  ] }));
  const building = renderer.getFeatures().find(feature => feature.layer === 'buildings');
  const baseline = recordingContext(), hovered = recordingContext();
  renderer.draw(baseline, fullView);
  renderer.draw(hovered, { ...fullView, hoveredKey: building.key });
  assert.equal(hovered.strokes.length, baseline.strokes.length, 'No extra road or power halo is drawn');
  let highlightedBuilding = 0;
  for (let index = 0; index < baseline.strokes.length; index++) {
    const before = baseline.strokes[index], after = hovered.strokes[index];
    if (after.color === '#eff0be') { highlightedBuilding++; assert.equal(before.path, after.path); }
    else assert.deepEqual(after, before, 'All other object strokes stay unchanged');
  }
  assert.equal(highlightedBuilding, 1, 'The original building highlight still works');
});

test('exact waterway relation duplicates inherit native seasonal ink and keep original relation facts', () => {
  const input = world({ width: 400, height: 300, rivers: [
    { id: 'way-10', sourceId: 'way-10', name: 'Amargosa River', width: 3, points: [{ x: 20, y: 60 }, { x: 380, y: 60 }], tags: { waterway: 'river', intermittent: 'yes', layer: '-1', tunnel: 'culvert' } },
    { id: 'way-20', sourceId: 'way-20', name: 'Permanent river', width: 2, points: [{ x: 20, y: 120 }, { x: 380, y: 120 }], tags: { waterway: 'river' } },
  ], details: [
    { id: 'relation-30-member-0', sourceId: 'relation-30', name: 'Amargosa River', geometry: 'line', points: [{ x: 380, y: 60 }, { x: 20, y: 60 }], tags: { type: 'waterway', waterway: 'river', name: 'Amargosa River' } },
  ] });
  const before = structuredClone(input), renderer = createDetailRenderer(input);
  assert.deepEqual(input, before);
  const seasonal = renderer.getFeatures().find(feature => feature.waterKind === 'seasonal_river');
  assert(seasonal); assert.equal(seasonal.paths.length, 1); assert.equal(seasonal.width, 3);
  assert.deepEqual(seasonal.sourceIds, ['relation-30', 'way-10']);
  const relation = seasonal.members.find(member => member.sourceId === 'relation-30');
  assert.deepEqual(relation.tags, before.details[0].tags, 'Missing relation-level intermittent tags stay missing as source facts');
  assert.deepEqual(relation.points, before.details[0].points);
  assert.equal(renderer.getStats().coalescedWaterRelationFragments, 1);
  assert.equal(renderer.getStats().displayWaterLines, 2);
  for (const zoom of [.5, 1, 6]) {
    const context = recordingContext();
    renderer.draw(context, { ...fullView, zoom, width: 400 * zoom, height: 300 * zoom });
    const dashed = context.strokes.filter(stroke => stroke.dash.length);
    const solid = context.strokes.filter(stroke => !stroke.dash.length);
    assert.equal(dashed.length, 2, 'The duplicate relation cannot leave an extra continuous centerline');
    assert.equal(solid.length, 2, 'A genuinely permanent river keeps its two continuous strokes');
    assert.equal(dashed[1].color, '#4c91bd'); assert.equal(solid[1].color, '#3f7eaa');
  }
});

test('an abstract valley axis is hidden while real valley polygons and unrelated natural lines survive', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, details: [
    { id: 'oasis-axis', geometry: 'line', name: 'Oasis Valley', points: [{ x: 20, y: 20 }, { x: 380, y: 280 }], tags: { natural: 'valley' } },
    { id: 'implicit-axis', points: [{ x: 20, y: 30 }, { x: 380, y: 290 }], tags: { natural: 'valley' } },
    { id: 'valley-area', geometry: 'polygon', points: ring(40, 40, 120, 120), tags: { natural: 'valley' } },
    { id: 'gully-line', geometry: 'line', points: [{ x: 200, y: 20 }, { x: 200, y: 280 }], tags: { natural: 'gully' } },
    { id: 'valley-water', geometry: 'line', points: [{ x: 250, y: 20 }, { x: 250, y: 280 }], tags: { natural: 'valley', waterway: 'stream', intermittent: 'yes' } },
    { id: 'valley-road', geometry: 'line', points: [{ x: 300, y: 20 }, { x: 300, y: 280 }], tags: { natural: 'valley', highway: 'service' } },
  ] }));
  const features = renderer.getFeatures();
  assert(!features.some(feature => ['oasis-axis', 'implicit-axis'].includes(feature.sourceId)));
  assert(features.some(feature => feature.sourceId === 'valley-area' && feature.biome === 'valley'));
  assert(features.some(feature => feature.sourceId === 'gully-line'));
  assert(features.some(feature => feature.sourceId === 'valley-water' && feature.water));
  assert(features.some(feature => feature.sourceId === 'valley-road' && feature.layer === 'roads'));
});

test('street and building presentation omits real identities while preserving game roles and archived inputs', () => {
  const input = world({ width: 400, height: 300, buildings: [
    { id: 'way-100', name: 'REAL_BUILDING_SIGN', address: 'REAL_POSTAL_ADDRESS', points: ring(30, 30, 100, 100), tags: { building: 'yes', name: 'REAL_BUILDING_SIGN', 'name:en': 'REAL_TRANSLATED_SIGN', 'addr:street': 'REAL_STREET', 'addr:housenumber': '999' } },
  ], roads: [
    { id: 'way-200', name: 'REAL_STREET', points: [{ x: 20, y: 180 }, { x: 200, y: 180 }], tags: { highway: 'residential', name: 'REAL_STREET', ref: 'REAL_ROUTE_REF', 'tiger:name_base': 'REAL_TIGER_STREET' } },
    { id: 'way-201', name: 'REAL_OLD_STREET', points: [{ x: 200, y: 180 }, { x: 380, y: 180 }], tags: { highway: 'residential', name: 'REAL_OLD_STREET' } },
  ], pois: [
    { id: 'node-300', x: 60, y: 60, name: 'REAL_OCCUPANT_SIGN', tags: { shop: 'convenience', name: 'REAL_OCCUPANT_SIGN' } },
  ] });
  const before = structuredClone(input), renderer = createDetailRenderer(input);
  const building = renderer.pick(60, 60, 0), road = renderer.pick(200, 180, 0);
  assert.equal(building.roleId, 'role.shop_food', 'Contained functional evidence still assigns the same playable purpose');
  assert.equal(building.name, building.roleName);
  assert.equal(building.gameplayAssignment.displayName, building.roleName);
  assert.equal(building.gameplayAssignment.occupants[0].roleId, 'role.shop_food');
  assert.equal(road.name, 'Улица и проезд');
  assert.equal(road.memberIds.length, 2);
  const presented = JSON.stringify([building, road, renderer.getFeatures().filter(feature => ['buildings', 'roads'].includes(feature.layer))]);
  assert(!presented.includes('REAL_'), 'Nested source tags, members and occupants cannot leak original signs or addresses');
  assert.deepEqual(input, before, 'The source map remains available for provenance and functional classification');
});

test('named roads no longer paint their real street names at close zoom', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, roads: [
    { id: 'way-1', name: 'REAL_STREET_LABEL', points: [{ x: 20, y: 150 }, { x: 380, y: 150 }], tags: { highway: 'residential', name: 'REAL_STREET_LABEL' } },
  ] }));
  const labels = [], context = recordingContext();
  context.fillText = text => labels.push(text); context.strokeText = text => labels.push(text);
  renderer.draw(context, { ...fullView, zoom: 6, width: 2400, height: 1800 });
  assert.deepEqual(labels, []);
  assert(context.strokes.length > 0, 'The road remains visible without its real label');
});

test('elevation ground hook paints below water ink and objects independently of biome visibility', () => {
  const input = world({ width: 400, height: 300, roads: [
    { id: 'road', type: 'residential', points: [{ x: 20, y: 180 }, { x: 380, y: 180 }], width: 3 },
  ], rivers: [
    { id: 'river', points: [{ x: 20, y: 120 }, { x: 380, y: 120 }], width: 3, tags: { waterway: 'stream', intermittent: 'yes' } },
  ], lakes: [
    { id: 'lake', geometry: 'polygon', points: ring(20, 210, 80, 270), tags: { natural: 'water', water: 'lake' } },
  ], buildings: [
    { id: 'building', points: ring(260, 30, 300, 70), tags: { building: 'house' } },
  ] });
  const before = structuredClone(input), renderer = createDetailRenderer(input);
  const capture = () => {
    const events = [], context = recordingContext();
    context.fill = function(path) { events.push({ type: 'fill', color: this.fillStyle, alpha: this.globalAlpha, path }); };
    context.stroke = function(path) { events.push({ type: 'stroke', color: this.strokeStyle, path }); };
    context.fillRect = function() { events.push({ type: 'matte', color: this.fillStyle }); };
    const view = { ...fullView, groundOverlay(ctx, passedView) { assert.equal(ctx, context); assert.equal(passedView, view); events.push({ type: 'elevation' }); } };
    renderer.draw(context, view);
    return events;
  };
  const visible = capture(), overlay = visible.findIndex(event => event.type === 'elevation');
  assert(visible.slice(0, overlay).every(event => event.type === 'matte'), 'Only the fallback matte lies beneath the height surface');
  assert.equal(visible.filter(event => event.type === 'elevation').length, 1);
  assert(visible.slice(overlay + 1).some(event => event.type === 'fill' && event.color === '#3f7eaa'), 'Lake water remains visible above the opaque height surface');
  assert(visible.slice(overlay + 1).some(event => event.type === 'fill' && event.alpha > 0 && event.alpha < 1), 'Biome colors tint the relief rather than hide it');
  for (const color of ['#4c91bd', '#62686a', '#c3b88e']) assert(visible.slice(overlay + 1).some(event => event.color === color), `${color} object ink stays above elevation`);
  renderer.setLayers({ biomes: false });
  const hidden = capture();
  assert.equal(hidden[0].type, 'elevation', 'The height layer does not depend on biome visibility');
  assert(!hidden.some(event => ['#4c91bd', '#3f7eaa'].includes(event.color)), 'Hiding biomes still hides river and lake ink');
  assert(hidden.some(event => event.color === '#62686a'));
  assert.deepEqual(input, before);
});

test('highways and paved roads contrast with dirt members without splitting their selectable network', () => {
  const input = world({ width: 400, height: 300, roads: [
    { id: 'highway', type: 'primary', points: [{ x: 20, y: 40 }, { x: 380, y: 40 }], width: 3, tags: { highway: 'primary', surface: 'asphalt' } },
    { id: 'road', type: 'secondary', points: [{ x: 20, y: 90 }, { x: 380, y: 90 }], width: 3, tags: { highway: 'secondary', surface: 'asphalt' } },
    { id: 'paved-street', type: 'residential', points: [{ x: 20, y: 150 }, { x: 200, y: 150 }], width: 3, tags: { highway: 'residential', surface: 'asphalt' } },
    { id: 'dirt-street', type: 'residential', points: [{ x: 200, y: 150 }, { x: 380, y: 150 }], width: 3, tags: { highway: 'residential', surface: 'gravel' } },
    { id: 'track', type: 'track', points: [{ x: 20, y: 230 }, { x: 380, y: 230 }], width: 3, tags: { highway: 'track' } },
  ] });
  const before = structuredClone(input), renderer = createDetailRenderer(input), context = recordingContext();
  renderer.draw(context, fullView);
  for (const color of ['#45494b', '#747a7c', '#858b8c', '#b4a582']) assert(context.strokes.some(stroke => stroke.color === color), `${color} has its own surface ink`);
  assert.equal(context.strokes.filter(stroke => stroke.color === '#b4a582').length, 2, 'An explicit gravel street and a track both use the dirt palette');
  const paved = renderer.pick(80, 150, 0), dirt = renderer.pick(300, 150, 0);
  assert.equal(paved.key, dirt.key, 'Different surface paint cannot split a connected gameplay object');
  assert.equal(paved.memberIds.length, 2);
  assert.equal(renderer.getStats().displayRoads, 4);
  assert.deepEqual(input, before, 'Styling cannot edit source surface tags or geometry');
});

test('city and natural colors remain translucent over relief but return to opaque biomes when relief is hidden', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, buildings: Array.from({ length: 5 }, (_, index) => ({
    id: `house-${index}`, points: ring(130 + index * 25, 130, 145 + index * 25, 145), tags: { building: 'house' },
  })), details: [{ id: 'park', geometry: 'polygon', points: ring(40, 40, 80, 80), tags: { leisure: 'park' } }] }));
  renderer.setLayers({ buildings: false });
  const capture = relief => {
    const events = [], context = recordingContext();
    context.fill = function() { events.push({ kind: 'biome', color: this.fillStyle, alpha: this.globalAlpha }); };
    renderer.draw(context, { ...fullView, groundOverlay: relief ? () => events.push({ kind: 'relief' }) : null });
    return events;
  };
  const tinted = capture(true), height = tinted.findIndex(event => event.kind === 'relief');
  assert(height >= 0);
  assert(tinted.findIndex(event => event.color === '#969b99') > height);
  assert(tinted.some(event => event.color === '#969b99' && event.alpha === .42), 'Gray city shows the measured relief below');
  assert(tinted.some(event => event.color === '#829b61' && event.alpha === .38), 'Park green also transmits the ground');
  assert(capture(false).every(event => event.alpha === 1), 'The ordinary biome map has no translucent gaps');
});
