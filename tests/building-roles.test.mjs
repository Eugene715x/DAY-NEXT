import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILDING_CATEGORIES, BUILDING_ROLES, createBuildingAssignments } from '../building-roles.js';
import { BUILDING_TYPES, RESOURCE_PROFILES, classifyBuilding, collectResourceProfiles } from '../gameplay-types.js';
import { createRealWorld } from '../real-world.js';
import map from '../maps/usa.js';

const p = (x, y) => ({ x, y });
const rect = (id, x1, y1, x2, y2, tags = {}) => {
  const points = [p(x1, y1), p(x2, y1), p(x2, y2), p(x1, y2), p(x1, y1)];
  return { id, geometry: 'polygon', points, rings: [points], tags };
};
const building = (id, x1, y1, x2, y2, tags = {}) => rect(id, x1, y1, x2, y2, { building: 'yes', ...tags });
const point = (id, x, y, tags) => ({ id, geometry: 'point', points: [p(x, y)], tags });
const assign = (buildings, details = [], more = {}) => createBuildingAssignments({ metersPerUnit: 1, buildings, details, ...more });
const a = feature => feature.gameplayAssignment;

test('every game role has a stable visible category, readable label and valid shared resource profiles', () => {
  assert.equal(Object.keys(BUILDING_CATEGORIES).length, 12);
  for (const [id, role] of Object.entries(BUILDING_ROLES)) {
    assert.equal(role.id, id); assert(role.name); assert(role.icon);
    assert(BUILDING_CATEGORIES[role.categoryId]); assert(BUILDING_TYPES[role.typeId]);
    assert(role.resourceProfileIds.length); assert(role.resourceProfileIds.every(id => RESOURCE_PROFILES[id]));
  }
  for (const category of Object.values(BUILDING_CATEGORIES)) for (const key of ['color', 'fill', 'roof', 'stroke']) assert.match(category[key], /^#[a-f0-9]{6}$/i);
  assert(Object.isFrozen(BUILDING_ROLES)); assert(Object.isFrozen(BUILDING_CATEGORIES));
  assert.notEqual(BUILDING_CATEGORIES['category.medical'].fill, BUILDING_CATEGORIES['category.housing'].fill);
});

test('mapped purpose overrides structural shape and ruin condition does not erase its role', () => {
  const input = [building('clinic', 0, 0, 10, 10, { building: 'ruins', amenity: 'hospital', shop: 'convenience' }), building('food', 20, 0, 30, 10, { building: 'house', shop: 'convenience' }), building('roof', 40, 0, 50, 10, { building: 'roof', amenity: 'fuel' }), building('hangar', 60, 0, 70, 10, { aeroway: 'hangar' })];
  const result = assign(input).features;
  assert.deepEqual(result.map(f => a(f).roleId), ['role.hospital', 'role.shop_food', 'role.fuel', 'role.hangar']);
  assert.equal(a(result[0]).condition, 'ruined');
  assert(result.every(f => a(f).roleOrigin === 'mapped' && a(f).confidence === 1));
  assert.deepEqual(input.map(f => f.tags.building), ['ruins', 'house', 'roof', 'yes']);
});

test('a measured business point inside a footprint identifies the building while a courtyard point does not', () => {
  const ring = building('donut', 0, 0, 100, 100);
  ring.rings.push(rect('courtyard', 30, 30, 70, 70).points);
  const details = [point('node-1', 15, 15, { shop: 'hardware', name: 'Tools' }), point('node-2', 50, 50, { amenity: 'hospital' })];
  const [result] = assign([ring], details).features;
  assert.equal(a(result).roleId, 'role.shop_hardware'); assert.equal(a(result).displayName, 'Tools');
  assert.deepEqual(a(result).evidenceIds, ['node-1']);
  assert.equal(a(result).provenance.method, 'contained-mapped-points');
  assert.equal(a(result).sourceFactType.typeId, 'building.unknown');
  const [onlyHole] = assign([ring], [details[1]]).features;
  assert.equal(a(onlyHole).roleOrigin, 'gameplay'); assert(!a(onlyHole).evidenceIds.includes('node-2'));
});

test('several mapped businesses retain mixed use and all profile references instead of an arbitrary primary shop', () => {
  const input = building('mixed', 0, 0, 100, 100);
  const result = assign([input], [point('node-2', 10, 10, { shop: 'supermarket' }), point('node-1', 20, 20, { amenity: 'pharmacy' })]).features[0];
  assert.equal(a(result).roleId, 'role.mixed_use');
  assert.deepEqual(a(result).evidenceIds, ['node-1', 'node-2']);
  assert.deepEqual(a(result).occupants.map(o => o.roleId), ['role.pharmacy', 'role.shop_food']);
  assert(a(result).resourceProfileIds.includes('profile.food')); assert(a(result).resourceProfileIds.includes('profile.medical'));
});

test('functional grounds identify untyped school and airport buildings without consuming explicit garage or building holes', () => {
  const school = rect('school-site', 0, 0, 100, 100, { amenity: 'school' });
  const airport = rect('airport-site', 200, 0, 400, 200, { aeroway: 'aerodrome' });
  const inputs = [building('classroom', 10, 10, 40, 40), building('garage', 45, 10, 60, 30, { building: 'garage' }), building('terminal', 220, 20, 270, 70), building('annex', 300, 20, 320, 40), building('crossing', 90, 30, 120, 50)];
  const result = assign(inputs, [school, airport]).features;
  assert.equal(a(result[0]).roleId, 'role.school'); assert.equal(a(result[0]).roleOrigin, 'context');
  assert.equal(a(result[1]).roleId, 'role.garage'); assert.equal(a(result[1]).roleOrigin, 'mapped');
  assert.equal(a(result[2]).roleId, 'role.airport'); assert.equal(a(result[3]).roleId, 'role.hangar');
  assert.equal(a(result[4]).roleOrigin, 'gameplay', 'A footprint crossing the school boundary must not inherit the whole site');
  assert.deepEqual(a(result[0]).evidenceIds, ['school-site']);
});

test('all untyped footprints receive reproducible game roles with explicit fictional provenance while facts stay unknown', () => {
  const inputs = [building('small', 0, 0, 4, 4), building('home', 100, 0, 110, 10), building('large', 200, 0, 240, 40), building('retail', 500, 0, 520, 20)];
  const plots = [rect('retail-site', 480, -20, 560, 60, { landuse: 'retail' })];
  const before = JSON.stringify({ inputs, plots }), first = assign(inputs, plots), second = assign([...inputs].reverse(), [...plots].reverse());
  assert.equal(first.report.assigned, inputs.length); assert.equal(first.report.unassigned, 0);
  for (const item of first.features) {
    const assignment = a(item), reversed = second.features.find(f => f.id === item.id);
    assert.deepEqual(assignment, a(reversed)); assert.equal(assignment.roleOrigin, 'gameplay');
    assert.equal(assignment.provenance.fictional, true); assert.equal(assignment.sourceFactType.typeId, 'building.unknown');
    assert.equal(classifyBuilding(item).typeId, 'building.unknown');
  }
  assert.equal(JSON.stringify({ inputs, plots }), before);
  assert(a(first.features[3]).roleId.startsWith('role.shop_') || ['role.cafe', 'role.office'].includes(a(first.features[3]).roleId));
  a(first.features[0]).evidenceIds.push('mutation'); assert(!a(assign(inputs, plots).features[0]).evidenceIds.includes('mutation'));
});

test('actual Nevada assignments are complete and identical before and after runtime navigation snapping', () => {
  const before = JSON.stringify(map), raw = createBuildingAssignments(map), runtime = createBuildingAssignments(createRealWorld(map));
  assert.equal(raw.report.total, 893); assert.equal(raw.report.unassigned, 0);
  assert.equal(raw.report.sourceKnown + raw.report.sourceUnknown, raw.report.total);
  assert(raw.report.origins.mapped > 60 && raw.report.origins.context > 0 && raw.report.origins.gameplay > 0);
  assert.deepEqual(raw.features.map(f => [f.id, a(f)]), runtime.features.map(f => [f.id, a(f)]));
  assert.deepEqual(raw.features.map(f => f.id), map.buildings.map(f => f.id));
  for (let i = 0; i < raw.features.length; i++) {
    const { gameplayAssignment, ...source } = raw.features[i]; assert.deepEqual(source, map.buildings[i]);
  }
  for (const role of ['role.school', 'role.airport', 'role.hangar', 'role.shop_food', 'role.clinic', 'role.warehouse', 'role.factory']) assert(raw.features.some(f => a(f).roleId === role), `Missing meaningful actual role ${role}`);
  assert.equal(JSON.stringify(map), before);
});

test('role metadata supplies resource profiles without changing the factual unknown type', () => {
  const [result] = assign([building('game-home', 0, 0, 10, 10)]).features;
  assert.equal(classifyBuilding(result).typeId, 'building.unknown');
  assert.deepEqual(collectResourceProfiles(result), a(result).resourceProfileIds);
});
