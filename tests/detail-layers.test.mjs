import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailRenderer } from '../detail-renderer.js';

// Picking uses the same cached source geometry in browsers. Node has no Canvas
// Path2D; only its inert construction methods are needed for these hit tests.
globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} ellipse() {} };
const ring = (x1, y1, x2, y2) => [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }, { x: x1, y: y1 }];
const world = changes => ({ width: 400, height: 300, metersPerUnit: 1, roads: [], buildings: [], areas: [], rivers: [], lakes: [], details: [], ...changes });

test('a present road on a former rail alignment has one selectable path with every source tag', () => {
  const points = [{ x: 20, y: 50 }, { x: 350, y: 50 }], tags = { highway: 'track', railway: 'abandoned', surface: 'dirt' };
  const input = world({ roads: [{ id: 'way-10-0', points, type: 'track', tags }], details: [{ id: 'way-10-0', points, geometry: 'line', kind: 'railway', tags }] });
  const before = structuredClone(input), renderer = createDetailRenderer(input);
  assert.equal(renderer.getFeatures().length, 1);
  assert.equal(renderer.pick(150, 50).kind, 'road');
  assert.equal(renderer.pick(150, 50).source.tags.railway, 'abandoned');
  renderer.setLayers({ roads: false });
  assert.equal(renderer.pick(150, 50), null, 'A duplicate railway style must not leak through the details layer');
  assert.deepEqual(input, before);
});

test('natural points, zone polygons and water follow their own switches during selection', () => {
  const renderer = createDetailRenderer(world({
    roads: [{ id: 'street', points: [{ x: 30, y: 50 }, { x: 370, y: 50 }], width: 6 }],
    details: [
      { id: 'zone', geometry: 'polygon', points: ring(0, 0, 400, 300), tags: { landuse: 'residential' }, kind: 'residential' },
      { id: 'tree', geometry: 'point', points: [{ x: 60, y: 100 }], kind: 'tree', tags: { natural: 'tree' } },
      { id: 'pool', geometry: 'polygon', points: ring(150, 150, 250, 250), kind: 'pool', tags: { leisure: 'swimming_pool' } },
      { id: 'fountain', geometry: 'point', points: [{ x: 100, y: 100 }], kind: 'fountain', tags: { amenity: 'fountain' } },
      { id: 'cliff', geometry: 'line', points: [{ x: 250, y: 100 }, { x: 350, y: 100 }], kind: 'cliff', tags: { natural: 'cliff' } },
    ],
  }));
  assert.equal(renderer.pick(200, 50).layer, 'roads', 'Road stroke sits above a residential biome');
  assert.equal(renderer.pick(60, 100).layer, 'landscape');
  assert.equal(renderer.pick(300, 100).layer, 'landscape');
  assert.equal(renderer.pick(200, 200).layer, 'water');
  assert.equal(renderer.pick(100, 100).layer, 'details');
  assert.equal(renderer.pick(300, 200).biome, 'residential');
  renderer.setLayers({ landscape: false });
  assert.equal(renderer.pick(60, 100), null);
  assert.equal(renderer.pick(300, 100), null);
  assert.equal(renderer.pick(200, 200).layer, 'water');
  assert.equal(renderer.pick(100, 100).layer, 'details');
  renderer.setLayers({ water: false, roads: false, details: false, buildings: false });
  for (const point of [[200, 50], [60, 100], [300, 100], [200, 200], [100, 100]]) assert.equal(renderer.pick(...point), null);
  assert(renderer.getFeatures().every(feature => !feature.enabled));
});

test('water holes remain land and generic seasonal waterways cannot escape the water switch', () => {
  const outer = ring(150, 130, 270, 250), inner = ring(190, 170, 230, 210);
  const renderer = createDetailRenderer(world({ details: [
    { id: 'biome', geometry: 'polygon', points: ring(0, 0, 400, 300), tags: { landuse: 'grass' } },
    { id: 'lake', geometry: 'polygon', points: outer, rings: [outer, inner], tags: { natural: 'water' } },
    { id: 'wash', geometry: 'line', points: [{ x: 50, y: 70 }, { x: 350, y: 70 }], tags: { waterway: 'river', intermittent: 'yes' } },
  ] }));
  assert.equal(renderer.pick(175, 155).layer, 'water');
  assert.equal(renderer.pick(210, 190).layer, 'landscape', 'The lake island cannot become a filled water hit target');
  assert.equal(renderer.pick(200, 70).layer, 'water');
  assert.equal(renderer.pick(200, 70).description, 'Сезонное русло');
  renderer.setLayers({ water: false });
  assert.equal(renderer.pick(200, 70).layer, 'landscape');
  assert.equal(renderer.pick(175, 155).layer, 'landscape');
});
