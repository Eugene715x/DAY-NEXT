import test from 'node:test';
import assert from 'node:assert/strict';
import { createLandmarkMarkers } from '../landmark-markers.js';
import map from '../maps/usa.js';

const point = (id, tags, x = 20, y = 20, extra = {}) => ({ id, sourceId: id, geometry: 'point', points: [{ x, y }], tags, ...extra });
const world = changes => ({ width: 100, height: 100, details: [], pois: [], areas: [], ...changes });

test('only mapped mining and summit types become landmarks, with source-facet deduplication', () => {
  const peak = point('node-1', { natural: 'peak', name: 'Real Summit', ele: '1234' });
  const source = world({ details: [peak, point('node-2', { historic: 'mine', name: 'Private Organisation', 'addr:street': 'Real Street' }), point('node-3', { man_made: 'adit' }), point('node-4', { man_made: 'mineshaft', fixme: 'Uncertain' }), point('node-5', { tourism: 'museum', name: 'Prominent Mine Museum' }), point('node-6', { landuse: 'quarry' })], pois: [{ ...peak, x: 20, y: 20 }] });
  const before = structuredClone(source), markers = createLandmarkMarkers(source).getMarkers();
  assert.deepEqual(markers.map(marker => marker.sourceId).sort(), ['node-1', 'node-2', 'node-3', 'node-4']);
  assert.equal(markers.find(marker => marker.sourceId === 'node-1').name, 'Real Summit');
  assert.equal(markers.find(marker => marker.sourceId === 'node-2').name, 'Шахта');
  assert(!JSON.stringify(markers).includes('Private Organisation')); assert(!JSON.stringify(markers).includes('Real Street'));
  assert.equal(markers.find(marker => marker.sourceId === 'node-4').uncertain, true);
  markers[0].tags.natural = 'changed'; assert.deepEqual(source, before);
});

test('elevation comes from genuine DEM when available, otherwise only numeric metre tags', () => {
  const source = world({ details: [point('node-1', { natural: 'peak', ele: '1300 m' }), point('node-2', { natural: 'peak', ele: '900 ft' }, 40), point('node-3', { natural: 'peak' }, 60)] });
  const markers = createLandmarkMarkers(source, { elevationAt: x => x === 20 ? 1294.4 : null }).getMarkers();
  assert.equal(markers[0].elevationMeters, 1294.4); assert.equal(markers[0].elevationSource, 'USGS 3DEP');
  assert.equal(markers[1].elevationMeters, null); assert.equal(markers[2].elevationMeters, null);
  assert.equal(createLandmarkMarkers(source).getMarkers()[0].elevationMeters, 1300);
});

test('picking obeys independent biome/details layers and preserves inaccessible mapped locations', () => {
  const source = world({ cols: 10, cellSize: 10, cells: Array.from({ length: 100 }, () => ({ walkable: false })), details: [point('node-1', { natural: 'peak' }), point('node-2', { man_made: 'adit' }, 60)] });
  const renderer = createLandmarkMarkers(source);
  assert.equal(renderer.pick(20, 20, 5)?.kind, 'peak');
  assert.equal(renderer.pick(20, 20, 5, { layers: { biomes: false } }), null);
  assert.equal(renderer.pick(60, 20, 5)?.kind, 'adit');
  assert.equal(renderer.pick(60, 20, 5, { layers: { details: false } }), null);
  assert.equal(renderer.pick(60, 20, 5).reachable, false); assert.equal(renderer.pick(60, 20, 5).x, 60);
  assert.equal(renderer.pick(NaN, 20), null);
});

test('area landmarks stay on real polygon ground outside courtyard holes', () => {
  const ring = (left, top, right, bottom) => [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
  const [marker] = createLandmarkMarkers(world({ areas: [{ id: 'way-1', geometry: 'polygon', rings: [ring(1, 1, 99, 99), ring(20, 20, 80, 80)], tags: { historic: 'mine' } }] })).getMarkers();
  assert(marker.x > 1 && marker.x < 99 && marker.y > 1 && marker.y < 99);
  assert(!(marker.x > 20 && marker.x < 80 && marker.y > 20 && marker.y < 80));
});

test('all actual mapped Nevada peaks and mining sources are represented without source changes', () => {
  const before = JSON.stringify(map), renderer = createLandmarkMarkers(map), markers = renderer.getMarkers();
  assert.equal(markers.length, 41);
  assert.deepEqual(Object.fromEntries(['peak', 'mine', 'adit', 'mineshaft'].map(kind => [kind, markers.filter(marker => marker.kind === kind).length])), { peak: 14, mine: 7, adit: 8, mineshaft: 12 });
  assert.equal(new Set(markers.map(marker => marker.sourceId)).size, 41);
  assert(markers.every(marker => marker.mapped && marker.x >= 0 && marker.x < map.width && marker.y >= 0 && marker.y < map.height));
  assert.equal(JSON.stringify(map), before);
});

test('drawing keeps icon sizes screen-stable, clusters close entrances only on overview and honors layers', () => {
  const source = world({ details: [point('node-1', { natural: 'peak' }, 10), point('node-2', { man_made: 'adit' }, 50), point('node-3', { man_made: 'mineshaft' }, 52)] });
  const scales = [], labels = [];
  const ctx = new Proxy({ scale: (x, y) => scales.push([x, y]), fillText: text => labels.push(text), measureText: text => ({ width: text.length * 5 }) }, { get: (target, key) => target[key] || (() => {}), set: (target, key, value) => { target[key] = value; return true; } });
  const renderer = createLandmarkMarkers(source), view = { cameraX: 50, cameraY: 50, width: 300, height: 300, zoom: .5, layers: {} };
  assert.deepEqual(renderer.draw(ctx, view), { drawn: 3, symbols: 2, labels: 0 }); assert(scales.every(([x, y]) => x === 2 && y === 2));
  scales.length = 0; renderer.draw(ctx, { ...view, zoom: 2, layers: { biomes: false } });
  assert.equal(renderer.getStats().drawn, 2); assert.equal(renderer.getStats().symbols, 2); assert(scales.every(([x, y]) => x === .5 && y === .5));
  assert(labels.includes('Штольня'));
});
