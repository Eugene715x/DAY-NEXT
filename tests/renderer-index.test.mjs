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

test('power geometry shares independent visibility for point and line selection', () => {
  const renderer = createDetailRenderer(world({ details: [
    { id: 'pole', geometry: 'point', points: [{ x: 128, y: 128 }], kind: 'utility_pole', tags: { man_made: 'utility_pole' } },
    { id: 'line', geometry: 'line', points: [{ x: 20, y: 200 }, { x: 1000, y: 200 }], tags: { power: 'line' } },
  ] }));
  assert.equal(renderer.pick(128, 128).layer, 'power');
  assert.equal(renderer.pick(700, 200).layer, 'power');
  assert.equal(renderer.getStats().power, 2);
  renderer.setLayers({ details: false });
  assert.equal(renderer.pick(128, 128).id, 'pole', 'Hiding small objects cannot hide the electrical network');
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
