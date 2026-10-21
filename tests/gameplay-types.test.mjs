import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILDING_TYPES, BIOME_TYPES, RESOURCE_PROFILES, RESOURCE_KINDS,
  classifyBuilding, classifyBiome, collectResourceProfiles, collectResourceCandidates,
} from '../gameplay-types.js';
import map from '../maps/usa.js';

test('building function comes from explicit mapped tags before physical building form', () => {
  const hospital = classifyBuilding({ type: 'yes', tags: { building: 'yes', amenity: 'hospital' } });
  assert.equal(hospital.typeId, 'building.medical');
  assert.equal(hospital.sourceType, 'yes');
  assert.equal(hospital.classificationSource, 'amenity');
  assert(hospital.resourceProfileIds.includes('profile.medical'));
  assert.equal(classifyBuilding({ type: 'house', tags: { building: 'house', shop: 'convenience' } }).typeId, 'building.retail');
  assert.equal(classifyBuilding({ tags: { building: 'yes', amenity: 'place_of_worship' } }).typeId, 'building.religious');
  assert.equal(classifyBuilding({ tags: { building: 'yes', amenity: 'school' } }).typeId, 'building.education');
});

test('unmapped building purpose stays unknown instead of guessing from its name or surrounding zone', () => {
  for (const input of [
    { type: 'yes', name: 'Hospital Road House', tags: { building: 'yes', landuse: 'residential' } },
    { type: 'unfamiliar_roof', tags: { building: 'unfamiliar_roof' } },
    {},
  ]) {
    const type = classifyBuilding(input);
    assert.equal(type.typeId, 'building.unknown');
    assert.deepEqual(type.resourceProfileIds, [], 'Unknown purpose must not gain a guessed loot table');
  }
  assert.equal(classifyBuilding({ type: 'house' }).typeId, 'building.house');
  assert.equal(classifyBuilding({ tags: { building: 'apartments' } }).typeId, 'building.apartment');
  assert.equal(classifyBuilding({ tags: { building: 'residential' } }).typeId, 'building.residential', 'A generic residential building is not necessarily a detached house');
});

test('ruin condition does not erase a known medical or educational function', () => {
  const hospital = classifyBuilding({ type: 'ruins', ruins: true, tags: { building: 'ruins', amenity: 'hospital' } });
  assert.equal(hospital.typeId, 'building.medical');
  assert.equal(hospital.condition, 'ruined');
  const school = classifyBuilding({ type: 'school', tags: { building: 'school', historic: 'ruins' } });
  assert.equal(school.typeId, 'building.education');
  assert.equal(school.condition, 'ruined');
  assert.equal(classifyBuilding({ tags: { building: 'ruins' } }).typeId, 'building.ruin');
  assert.equal(classifyBuilding({ tags: { building: 'house', ruins: 'no', abandoned: 'no' } }).condition, 'standing');
  assert.equal(classifyBuilding({ tags: { building: 'house', abandoned: 'yes' } }).condition, 'abandoned');
});

test('administrative territory has a stable type without implying urban resources', () => {
  const type = classifyBiome('administrative');
  assert.equal(type.typeId, 'biome.administrative');
  assert.deepEqual(type.resourceProfileIds, []);
  assert.equal(classifyBiome({ tags: { boundary: 'census' }, geometry: 'polygon' }).typeId, 'biome.administrative');
  assert.equal(classifyBiome({ biome: 'parking' }).typeId, 'biome.parking');
  assert.equal(classifyBiome({ tags: { natural: 'wood' }, geometry: 'polygon' }).typeId, 'biome.forest');
  assert.equal(classifyBiome('unmapped_landcover').typeId, 'biome.unknown');
  for (const biome of ['desert', 'valley', 'gully']) assert.equal(classifyBiome(biome).typeId, `biome.${biome}`, 'The actual Nevada natural-feature vocabulary has explicit stable types');
  assert.equal(classifyBiome('dry_riverbed').typeId, 'biome.dry_riverbed');
  assert(!classifyBiome('dry_riverbed').resourceProfileIds.includes('profile.water'), 'A dry wash must not inherit a permanent-water resource profile');
  assert.equal(classifyBiome('city').typeId, 'biome.city');
  assert.equal(classifyBiome('seasonal_river').typeId, 'biome.seasonal_river');
  assert(!classifyBiome('seasonal_river').resourceProfileIds.includes('profile.water'), 'Seasonal water is not a guaranteed permanent-water resource');
});

test('overlapping zones and a building merge profile references without multiplying candidates', () => {
  const parking = classifyBiome('parking'), residential = classifyBiome('residential'), clinic = classifyBuilding({ tags: { building: 'yes', amenity: 'clinic' } });
  const profiles = collectResourceProfiles([parking, residential], clinic, parking);
  assert.deepEqual(profiles, ['profile.household', 'profile.medical', 'profile.salvage', 'profile.vehicles']);
  const candidates = collectResourceCandidates([parking, residential, clinic, parking]);
  assert.equal(candidates.length, new Set(candidates.map(item => item.id)).size);
  assert(candidates.some(item => item.id === 'resource.medical_supplies'));
  assert(candidates.some(item => item.id === 'resource.vehicle_parts'));
  assert.deepEqual(collectResourceCandidates(classifyBiome('administrative')), []);
  assert.throws(() => collectResourceProfiles('profile.does_not_exist'), /Unknown/);
});

test('the complete catalog has valid stable IDs, references and no spawn parameters', () => {
  for (const [prefix, catalog] of [['building', BUILDING_TYPES], ['biome', BIOME_TYPES]]) {
    for (const [id, item] of Object.entries(catalog)) {
      assert.equal(item.id, id); assert(id.startsWith(`${prefix}.`)); assert(item.name);
      assert.equal(new Set(item.resourceProfileIds).size, item.resourceProfileIds.length);
      for (const profileId of item.resourceProfileIds) assert(RESOURCE_PROFILES[profileId], `Dangling reference ${id} -> ${profileId}`);
    }
  }
  for (const [id, profile] of Object.entries(RESOURCE_PROFILES)) {
    assert.equal(profile.id, id); assert(id.startsWith('profile.')); assert(profile.name);
    for (const resourceId of profile.candidateResourceIds) assert(RESOURCE_KINDS[resourceId], `Dangling resource ${id} -> ${resourceId}`);
    for (const key of ['chance', 'quantity', 'spawned', 'inventory', 'dropRate']) assert(!Object.hasOwn(profile, key));
  }
});

test('classification preserves real source geometry/tags and returns independent metadata', () => {
  const before = JSON.stringify(map);
  const types = map.buildings.map(classifyBuilding);
  assert(types.every(type => BUILDING_TYPES[type.typeId]));
  assert(types.some(type => type.typeId === 'building.unknown'));
  assert.equal(JSON.stringify(map), before);
  const first = classifyBuilding({ type: 'house' });
  first.resourceProfileIds.push('untrusted');
  assert(!classifyBuilding({ type: 'house' }).resourceProfileIds.includes('untrusted'));
  const candidate = collectResourceCandidates('profile.medical')[0];
  candidate.name = 'Changed outside catalog';
  assert.notEqual(RESOURCE_KINDS[candidate.id].name, candidate.name);
  assert(Object.isFrozen(BUILDING_TYPES)); assert(Object.isFrozen(RESOURCE_PROFILES['profile.medical'].candidateResourceIds));
});


test('derived ground and settlement density have stable independent gameplay types', () => {
  for (const key of ['wasteland', 'suburb', 'urban', 'dense', 'aircraft_parking']) {
    const type = classifyBiome(key);
    assert.equal(type.typeId, `biome.${key}`);
    assert(type.resourceProfileIds.length);
  }
  assert(classifyBiome('aircraft_parking').resourceProfileIds.includes('profile.vehicles'));
  assert.equal(classifyBuilding({ tags: { building: 'yes' }, biome: 'dense' }).typeId, 'building.unknown', 'Density does not infer a building function');
});
