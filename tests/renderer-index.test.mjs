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
    details: [{ id: 'whole-region', geometry: 'polygon', points: outer, rings: [outer, hole], tags: { landuse: 'residential' } }],
  }));
  assert.equal(renderer.pick(100, 400, 0).id, 'wide-road', 'A wide stroke must be indexed across its painted width');
  assert.equal(renderer.pick(9000, 9000, 0).id, 'whole-region');
  assert.deepEqual(renderer.zonesAt(6000, 6000), [], 'A large indexed polygon must retain its hole');
  assert.deepEqual(renderer.zonesAt(9000, 9000).map(zone => zone.biome), ['residential']);
  renderer.setLayers({ landscape: false });
  assert.equal(renderer.pick(9000, 9000), null);
  assert.deepEqual(renderer.zonesAt(9000, 9000).map(zone => zone.biome), ['residential']);
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
  ], details: [{ id: 'residential', geometry: 'polygon', points: ring(0, 0, 400, 400), tags: { landuse: 'residential' } }] }));
  const unknown = renderer.pick(40, 40);
  assert.equal(unknown.typeId, 'building.unknown');
  assert.deepEqual(unknown.resourceProfileIds, []);
  const clinic = renderer.pick(150, 150);
  assert.equal(clinic.typeId, 'building.medical');
  assert(clinic.resourceProfileIds.includes('profile.medical'));
  clinic.resourceProfileIds.push('tampered'); clinic.gameplayType.resourceProfileIds.push('tampered');
  assert(!renderer.pick(150, 150).resourceProfileIds.includes('tampered'));
  const zones = renderer.zonesAt(150, 150);
  assert.deepEqual(zones.map(zone => zone.typeId).sort(), ['biome.healthcare', 'biome.residential']);
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
  assert.deepEqual(context.strokes.map(stroke => stroke.color), ['#82816a', '#82816a', '#82816a', '#d2c6a1', '#d2c6a1', '#d2c6a1']);
  assert(context.strokes.every(stroke => stroke.dash.length === 0));
  const selected = renderer.pick(100, 150, 0);
  renderer.setRoadClasses({ street: false });
  assert.equal(renderer.pick(100, 150, 0), null);
  assert.equal(renderer.drawHighlight(context, fullView, selected), null);
  assert.equal(context.strokes.length, 6);
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

test('town boundaries never fill their interior during scene or selection rendering', () => {
  const renderer = createDetailRenderer(world({ width: 400, height: 300, details: [
    { id: 'town', geometry: 'polygon', points: ring(20, 20, 380, 280), tags: { boundary: 'administrative', name: 'Town' } },
  ] }));
  const context = recordingContext(); renderer.draw(context, fullView);
  assert.equal(context.fills.length, 0);
  assert.equal(context.strokes.length, 1);
  assert.equal(renderer.drawHighlight(context, fullView, 'town'), 'landscape:detail:town');
  assert.equal(context.fills.length, 0, 'Selection cannot introduce a town-wide highlight fill');
  assert.equal(context.strokes.length, 3);
});
