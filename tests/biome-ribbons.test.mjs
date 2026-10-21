import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWaterRibbonParts } from '../biome-ribbons.js';

const pt = (x, y) => ({ x, y });
const inRing = (x, y, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};
const contains = (parts, x, y) => parts.some(rings => inRing(x, y, rings[0]) && !rings.slice(1).some(ring => inRing(x, y, ring)));
const ringArea = ring => Math.abs(ring.reduce((area, p, i) => { const next = ring[(i + 1) % ring.length]; return area + p.x * next.y - next.x * p.y; }, 0) / 2);
const area = parts => parts.reduce((sum, rings) => sum + ringArea(rings[0]) - rings.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0), 0);

test('native width stays exact on a straight river while rounded caps add only endpoint area', () => {
  const input = [[pt(0, 0), pt(100, 0)]], before = JSON.stringify(input);
  const parts = buildWaterRibbonParts(input, 10), points = parts.flat(2);
  assert.equal(parts.length, 1);
  assert.equal(Math.min(...points.map(p => p.y)), -5);
  assert.equal(Math.max(...points.map(p => p.y)), 5);
  assert.equal(Math.min(...points.map(p => p.x)), -5);
  assert.equal(Math.max(...points.map(p => p.x)), 105);
  assert(contains(parts, 50, 4.999)); assert(!contains(parts, 50, 5.001));
  assert(Math.abs(area(parts) - (1000 + Math.PI * 25)) < 2.1);
  assert.equal(JSON.stringify(input), before);
});

test('separate water paths retain their genuine gap and connected elbows have no missing joint', () => {
  const separate = buildWaterRibbonParts([[pt(0, 0), pt(10, 0)], [pt(30, 0), pt(40, 0)]], 4);
  assert.equal(separate.length, 2); assert(!contains(separate, 20, 0));
  const elbow = buildWaterRibbonParts([[pt(0, 0), pt(10, 0), pt(10, 10)]], 4);
  assert.equal(elbow.length, 1); assert(contains(elbow, 10, 0)); assert(contains(elbow, 11, -1));
  assert(!contains(elbow, 13, -3));
  assert.deepEqual(buildWaterRibbonParts([[pt(0, 0), pt(10, 0)], [pt(30, 0), pt(40, 0)]], 4), separate);
});

test('a closed water loop keeps its land island rather than filling the enclosed area', () => {
  const parts = buildWaterRibbonParts([[pt(0, 0), pt(100, 0), pt(100, 100), pt(0, 100), pt(0, 0)]], 10);
  assert.equal(parts.length, 1); assert.equal(parts[0].length, 2);
  assert(contains(parts, 50, 1)); assert(!contains(parts, 50, 50));
  assert(contains(parts, -3, -3)); assert(!contains(parts, -4, -4));
});

test('thin strokes and repeated points remain finite without changing input or joining paths', () => {
  const input = [[pt(1000, 1000), pt(1000, 1000), pt(1000.1, 1000)], [pt(1010, 1010)]];
  const before = JSON.stringify(input), parts = buildWaterRibbonParts(input, 1e-5);
  assert.equal(parts.length, 2); assert(parts.flat(2).every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  assert(contains(parts, 1000.05, 1000)); assert(!contains(parts, 1000.05, 1000.00001));
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(buildWaterRibbonParts([], 3), []);
  assert.throws(() => buildWaterRibbonParts([], 0), /positive/);
  assert.throws(() => buildWaterRibbonParts([[pt(NaN, 2)]], 2), /finite/);
});
