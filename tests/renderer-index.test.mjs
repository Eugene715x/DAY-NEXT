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
  assert.equal(renderer.pick(9000, 9000, 0).id, 'whole-region');
  assert.deepEqual(renderer.zonesAt(6000, 6000), [], 'A large indexed polygon must retain its hole');
  assert.deepEqual(renderer.zonesAt(9000, 9000).map(zone => zone.biome), ['forest']);
  renderer.setLayers({ landscape: false });
  assert.equal(renderer.pick(9000, 9000), null);
  assert.deepEqual(renderer.zonesAt(9000, 9000).map(zone => zone.biome), ['forest']);
});

test('power line visibility is independent while utility support markers are omitted', () => {
  const renderer = createDetailRenderer(world({ details: [
    { id: 'pole', geometry: 'point', points: [{ x: 128, y: 128 }], kind: 'utility_pole', tags: { man_made: 'utility_pole' } },
    { id: 'line', geometry: 'line', points: [{ x: 20, y: 200 }, { x: 1000, y: 200 }], tags: { power: 'line' } },
  ] }));
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
  assert.equal(renderer.pick(100, 50).typeId, 'biome.dry_riverbed');
  assert(!renderer.pick(100, 50).resourceProfileIds.includes('profile.water'));
  assert.equal(renderer.pick(100, 100).typeId, 'biome.water');
  assert(renderer.pick(100, 100).resourceProfileIds.includes('profile.water'));
});

function recordingContext() {
  const strokes = [], fills = [], dashes = [];
  return {
    strokes, fills, dashes,
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
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
  assert.equal(context.fills.length, 0);
  assert.equal(context.strokes.length, 0);
  assert.equal(renderer.drawHighlight(context, fullView, 'town'), null);
  assert.equal(context.fills.length, 0);
  assert.equal(context.strokes.length, 0);
});

test('closed substations paint a solid footprint and use the same interior for selection', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, details: [
    { id: 'substation', geometry: 'polygon', points: ring(100, 100, 250, 250), tags: { power: 'substation' } },
  ] }));
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
  assert.deepEqual(rules, ['nonzero']);
  const selected = renderer.pick(150, 120, 0);
  assert.equal(selected.parts.length, 2);
  renderer.drawHighlight(context, fullView, selected);
  assert.deepEqual(rules, ['nonzero', 'nonzero']);
  assert.equal(renderer.pick(50, 120, 0).key, selected.key);
  assert.equal(renderer.pick(250, 120, 0).key, selected.key);
});

test('every Nevada footprint receives a colored game role while urban zones retire and natural geometry stays exact', async () => {
  const { default: map } = await import('../maps/usa.js');
  const before = JSON.stringify(map), renderer = createDetailRenderer(map), stats = renderer.getStats(), features = renderer.getFeatures();
  assert.equal(stats.buildings, map.buildings.length);
  assert.equal(stats.sourceRoads, map.roads.length);
  assert.equal(stats.roads, 83);
  assert.equal(stats.water, 53);
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
  assert.equal(sand.rings.length, 14, 'The complete mapped sand biome and its 13 holes remain');
});

test('building fills use functional category colors at overview as well as detail scales', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, buildings: [
    { id: 'house', points: ring(20, 20, 60, 60), tags: { building: 'house' } },
    { id: 'shop', points: ring(80, 20, 120, 60), tags: { building: 'retail', shop: 'supermarket' } },
    { id: 'school', points: ring(140, 20, 180, 60), tags: { building: 'school', amenity: 'school' } },
    { id: 'clinic', points: ring(200, 20, 240, 60), tags: { building: 'hospital', amenity: 'clinic' } },
    { id: 'warehouse', points: ring(260, 20, 300, 60), tags: { building: 'warehouse' } },
  ] }));
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
