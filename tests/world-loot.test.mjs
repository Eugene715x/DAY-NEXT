import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldLoot } from '../world-loot.js';
import { DEMO_ITEMS } from '../inventory-model.js';
import { createBuildingAssignments } from '../building-roles.js';
import { createRealWorld } from '../real-world.js';
import map from '../maps/usa.js';

const p = (x, y) => ({ x, y });
const ring = (x1, y1, x2, y2) => [p(x1, y1), p(x2, y1), p(x2, y2), p(x1, y2), p(x1, y1)];
const house = (id, x1, y1, x2, y2) => ({ id, sourceId: id, points: ring(x1, y1, x2, y2), tags: { building: 'house' } });
const fixture = (changes = {}) => ({ id: 'loot-test', width: 1000, height: 800, metersPerUnit: 1, cellSize: 5, start: p(20, 20), buildings: [house('house-a', 100, 100, 140, 140), house('house-b', 220, 100, 260, 140)], ...changes });
const currentIds = model => model.getState().containers.find(container => container.id === 'ground').slots.filter(Boolean);
const storage = (model, id) => model.exportState().containers.find(container => container.id === id);
function conserve(model) {
  const state = model.exportState(), allIds = state.items.map(item => item.id), placed = state.containers.flatMap(container => container.slots.filter(Boolean));
  assert.equal(new Set(allIds).size, allIds.length);
  assert.equal(new Set(placed).size, placed.length, 'each item occurs in exactly one slot');
  assert.deepEqual(placed.toSorted(), allIds.toSorted(), 'every generated item remains placed');
  for (const container of state.containers) container.slots.forEach((id, slot) => {
    if (id) { const location = model.locate(id); assert.equal(location.storeId, container.id); assert.equal(location.slot, slot); }
  });
}

test('every house starts with reproducible shape loot while unopened houses keep their role state', () => {
  const world = fixture(), before = JSON.stringify(world), first = createWorldLoot(world), second = createWorldLoot({ ...world, buildings: [...world.buildings].reverse() });
  assert.equal(first.getBuildingStates().length, 2);
  for (const state of first.getBuildingStates()) {
    assert.equal(state.visited, false); assert(state.itemCount >= 2 && state.itemCount <= 5);
    assert.deepEqual(storage(first, `building:${state.id}`), storage(second, `building:${state.id}`));
  }
  assert.equal(first.getState().containers.length, 5);
  assert.equal(first.getState().items.filter(item => !item.id.startsWith('loot:')).length, DEMO_ITEMS.length);
  assert.deepEqual(first.getGroundPiles()[0].preview.length, 3);
  assert.equal(JSON.stringify(world), before);
  conserve(first);
});

test('separate outdoor caches stay at their true positions and remote items cannot be grabbed', () => {
  const model = createWorldLoot(fixture()), initial = model.getGroundPiles()[0], seed = currentIds(model)[0];
  assert.equal(model.move(seed, 'inventory').ok, true);
  model.setPosition(p(400.25, 340.75));
  assert.equal(model.getContext().kind, 'ground');
  const token = model.getContext().id;
  assert.equal(model.move(seed, 'ground', null, { contextId: token }).ok, true);
  assert.equal(model.getGroundPiles().length, 2);
  const second = model.getGroundPiles().find(pile => pile.id !== initial.id);
  assert.deepEqual([second.x, second.y], [400.25, 340.75]);
  model.setPosition(p(20, 20));
  assert.equal(model.move(seed, 'inventory').reason, 'not-accessible');
  assert.equal(model.getContext().id, initial.id);
  model.setPosition(p(410, 340.75));
  assert.equal(model.getContext().id, second.id);
  assert.equal(model.move('sphere-blue', 'ground').ok, true, 'nearby drops merge into the same local cache');
  assert.equal(model.getGroundPiles().length, 2);
  for (const id of currentIds(model)) assert.equal(model.move(id, 'inventory').ok, true);
  assert.equal(model.getGroundPiles().length, 1, 'the circle vanishes when its final item is removed');
  model.setPosition(p(400.25, 340.75));
  assert.equal(model.getContext().kind, 'ground');
  conserve(model);
});

test('building footprints own their contents, courtyard holes and gaps between multipart footprints remain outdoors', () => {
  const donut = { id: 'donut', parts: [[ring(100, 100, 200, 200), ring(130, 130, 170, 170)], [ring(240, 100, 260, 120)]] };
  const model = createWorldLoot(fixture({ buildings: [donut] }));
  model.setPosition(p(110, 110));
  assert.equal(model.getContext().id, 'building:donut');
  assert.equal(model.move('sphere-blue', 'ground').ok, true);
  assert.equal(model.getGroundPiles().length, 1, 'no ground cache appears inside a house');
  const added = model.locate('sphere-blue'); assert.equal(added.storeId, 'building:donut');
  model.setPosition(p(150, 150)); assert.equal(model.getContext().kind, 'ground', 'the courtyard is excluded from the footprint');
  assert.equal(model.move('sphere-blue', 'inventory').reason, 'not-accessible');
  assert.equal(model.move('cube-coral', 'ground').ok, true);
  assert.equal(model.getGroundPiles().length, 2);
  model.setPosition(p(250, 110)); assert.equal(model.getContext().kind, 'building');
  model.setPosition(p(220, 110)); assert.equal(model.getContext().kind, 'ground');
  conserve(model);
});

test('opening grays a house, emptying crosses it, refilling removes only its empty state and never regenerates loot', () => {
  const model = createWorldLoot(fixture());
  model.setPosition(p(110, 110)); const initial = currentIds(model);
  assert.equal(model.getBuildingState('house-a').visited, false, 'entering alone does not mark a house searched');
  assert.equal(model.openContext().changed, true);
  assert.equal(model.openContext().changed, false);
  assert.equal(model.getBuildingState('house-a').visited, true);
  for (const id of initial) assert.equal(model.move(id, 'inventory').ok, true);
  assert.deepEqual({ visited: model.getBuildingState('house-a').visited, empty: model.getBuildingState('house-a').empty }, { visited: true, empty: true });
  model.setPosition(p(700, 700)); model.setPosition(p(110, 110)); model.openContext();
  assert.equal(currentIds(model).length, 0, 'revisit never fills a cleared house');
  assert.equal(model.move(initial[0], 'ground').ok, true);
  assert.equal(model.getBuildingState('house-a').visited, true);
  assert.equal(model.getBuildingState('house-a').empty, false);
  assert.equal(model.getGroundPiles().length, 1);
  assert.equal(model.getBuildingState('house-b').visited, false);
  conserve(model);
});

test('moving and stale context tokens block local transfers without blocking personal inventory rearrangement', () => {
  const model = createWorldLoot(fixture()), token = model.getContext().id, seed = currentIds(model)[0], before = model.exportState();
  model.setPosition(p(20, 20), { moving: true });
  assert.equal(model.openContext().reason, 'moving');
  assert.equal(model.move(seed, 'inventory', null, { contextId: token }).reason, 'moving');
  assert.deepEqual(model.exportState(), before);
  assert.equal(model.move('sphere-blue', 'equipment', 1).ok, true);
  model.setPosition(p(400, 400), { moving: false });
  assert.equal(model.move('sphere-blue', 'ground', null, { contextId: token }).reason, 'stale-context');
  assert.equal(model.move(seed, 'inventory').reason, 'not-accessible');
  assert.equal(model.openContext(token).reason, 'stale-context');
  const previous = model.exportState();
  assert.equal(model.move('sphere-blue', 'building:house-a').reason, 'unknown-container');
  assert.equal(model.setPosition(p(Infinity, 1)).reason, 'invalid-position');
  assert.deepEqual(model.exportState(), previous);
  conserve(model);
});

test('world revision changes for contents and visits but not for movement or context reads', () => {
  const model = createWorldLoot(fixture()), revision = model.getRevision(), contextRevision = model.getContext().revision;
  for (let index = 0; index < 20; index++) { model.setPosition(p(300 + index, 300)); model.getContext(); model.getState(); }
  assert.equal(model.getRevision(), revision); assert(model.getContext().revision > contextRevision);
  model.setPosition(p(110, 110)); model.openContext(); assert.equal(model.getRevision(), revision + 1);
  model.openContext(); assert.equal(model.getRevision(), revision + 1);
});

test('a full personal container rejects auto transfers and explicit swaps conserve both world and personal items', () => {
  const many = Array.from({ length: 12 }, (_, index) => house(`house-${index}`, 100 + index * 50, 100, 140 + index * 50, 140));
  const model = createWorldLoot(fixture({ buildings: many }));
  for (let index = 0; index < many.length; index++) {
    model.setPosition(p(110 + index * 50, 110));
    for (const id of currentIds(model)) model.move(id, 'inventory');
  }
  assert.equal(storage(model, 'inventory').slots.filter(Boolean).length, 16);
  const id = currentIds(model)[0], before = model.exportState();
  assert.equal(model.move(id, 'inventory').reason, 'container-full');
  assert.deepEqual(model.exportState(), before);
  const swapped = storage(model, 'inventory').slots[0];
  assert.equal(model.move(id, 'inventory', 0).swappedItemId, swapped);
  assert.equal(model.locate(swapped).containerId, 'ground');
  assert.equal(model.locate(id).storeId, 'inventory');
  conserve(model);
});

test('world containers grow beyond twelve slots without deleting or overwriting loot', () => {
  const many = Array.from({ length: 10 }, (_, index) => house(`house-${index}`, 100 + index * 50, 100, 140 + index * 50, 140));
  const model = createWorldLoot(fixture({ buildings: many })), destination = p(800, 600);
  for (let index = 0; index < many.length; index++) {
    model.setPosition(p(110 + index * 50, 110));
    const ids = currentIds(model);
    for (const id of ids) assert.equal(model.move(id, 'inventory').ok, true);
    model.setPosition(destination);
    for (const id of ids) assert.equal(model.move(id, 'ground').ok, true);
  }
  assert(model.getContext().itemCount > 12);
  assert(model.getState().containers.find(container => container.id === 'ground').slots.length > 12);
  assert.equal(model.getGroundPiles().length, 2);
  conserve(model);
});

test('save roundtrip preserves every item, location, cache and visited state, and snapshots cannot mutate the model', () => {
  const model = createWorldLoot(fixture());
  model.setPosition(p(110, 110)); model.openContext();
  const item = currentIds(model)[0]; model.move(item, 'inventory'); model.setPosition(p(560.75, 410.25)); model.move(item, 'ground');
  const saved = model.exportState(), fresh = createWorldLoot(fixture());
  assert.equal(fresh.importState(JSON.parse(JSON.stringify(saved))).ok, true);
  assert.deepEqual(fresh.exportState(), saved);
  fresh.setPosition(p(560.75, 410.25)); assert.deepEqual(currentIds(fresh), [item]);
  saved.items[0].name = 'altered'; saved.containers[0].slots[0] = null;
  const ui = fresh.getState(); ui.items[0].color = '#000000'; ui.containers[0].slots[0] = null;
  assert.notEqual(fresh.getItem('sphere-amber').name, 'altered');
  assert.equal(fresh.locate('sphere-amber').storeId, 'equipment');
  conserve(fresh);
});

test('repeated sparse last-slot drops remain bounded and always import into a fresh model', () => {
  const model = createWorldLoot(fixture());
  model.setPosition(p(110, 110));
  const id = currentIds(model)[0];
  for (let index = 0; index < 100; index++) {
    const slots = model.getState().containers.find(container => container.id === 'ground').slots;
    assert.equal(model.move(id, 'ground', slots.length - 1).ok, true);
  }
  const saved = model.exportState(), fresh = createWorldLoot(fixture());
  assert(storage(model, 'building:house-a').slots.length <= saved.items.length + 15);
  assert.equal(fresh.importState(saved).ok, true);
  assert.deepEqual(fresh.exportState(), saved);
  conserve(fresh);
});

test('corrupt imports reject atomically rather than duplicate or lose items', () => {
  const model = createWorldLoot(fixture()), initial = model.exportState(), revision = model.getRevision();
  const corruptions = [
    state => { state.worldId = 'different-map'; },
    state => { state.version = 999; },
    state => { state.nextPileId = Number.MAX_SAFE_INTEGER + 1; },
    state => { state.items.pop(); },
    state => { state.items[0].color = '#000000'; },
    state => { state.containers[0].slots[1] = state.containers[0].slots[0]; },
    state => { state.containers[0].slots[0] = null; },
    state => { state.containers.pop(); },
    state => { state.containers.find(container => container.kind === 'pile').x = 110; state.containers.find(container => container.kind === 'pile').y = 110; },
    state => { state.containers.find(container => container.kind === 'pile').id = 'pile-01'; },
    state => { state.containers.find(container => container.kind === 'building').visited = 'yes'; },
    state => { state.containers.find(container => container.kind === 'personal').slots.push(null); },
  ];
  for (const corrupt of corruptions) {
    const state = structuredClone(initial); corrupt(state);
    assert.equal(model.importState(state).ok, false);
    assert.deepEqual(model.exportState(), initial);
    assert.equal(model.getRevision(), revision);
  }
  assert.equal(model.importState(null).ok, false);
});

test('reset restores the initial world state without leaving generated items behind', () => {
  const model = createWorldLoot(fixture()), initial = model.exportState();
  model.setPosition(p(110, 110)); model.openContext(); model.move(currentIds(model)[0], 'inventory');
  model.setPosition(p(800, 500)); model.move('cube-green', 'ground'); model.reset();
  assert.deepEqual(model.exportState(), initial);
  assert.deepEqual(model.getContext().position, fixture().start);
  conserve(model);
});

test('the shipped map seeds all 893 buildings by their assigned gameplay purpose without changing source facts', () => {
  const world = createRealWorld(map), assignments = createBuildingAssignments(world), before = JSON.stringify(world.buildings);
  const model = createWorldLoot(world, { buildingAssignments: assignments });
  assert.equal(model.getBuildingStates().length, 893);
  assert(model.getBuildingStates().every(state => !state.visited && state.itemCount >= 2 && state.itemCount <= 5));
  const first = assignments.features[0], item = model.getItem(storage(model, `building:${first.sourceId || first.id}`).slots[0]);
  assert.equal(item.color, first.gameplayAssignment.color);
  assert(item.name.endsWith(first.gameplayAssignment.roleName));
  assert.equal(JSON.stringify(world.buildings), before);
  conserve(model);
});
