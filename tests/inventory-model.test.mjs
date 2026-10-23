import test from 'node:test';
import assert from 'node:assert/strict';
import { createInventoryModel, DEMO_ITEMS, DEMO_PLACEMENTS, INVENTORY_CONTAINERS } from '../inventory-model.js';

const allPlacements = state => state.containers.flatMap(container => container.slots.filter(Boolean));
const byId = (state, id) => state.containers.find(container => container.id === id);

test('all five windows start with unique, accounted coloured spheres and cubes', () => {
  const model = createInventoryModel(), state = model.getState();
  assert.deepEqual(state.containers.map(container => container.id), ['equipment', 'inventory', 'ground', 'crafting', 'stats']);
  assert.deepEqual(state.containers.map(container => container.slots.length), [6, 16, 12, 4, 3]);
  assert.equal(allPlacements(state).length, 12);
  assert.equal(new Set(allPlacements(state)).size, 12);
  assert.deepEqual(new Set(allPlacements(state)), new Set(state.items.map(item => item.id)));
  assert.deepEqual(new Set(state.items.map(item => item.shape)), new Set(['sphere', 'cube']));
  assert(new Set(state.items.map(item => item.color)).size >= 5);
});

test('one item can travel through all five modules and an occupied slot swaps atomically', () => {
  const model = createInventoryModel(), itemId = 'sphere-blue';
  for (const containerId of ['ground', 'equipment', 'crafting', 'stats', 'inventory']) {
    const result = model.move(itemId, containerId);
    assert.equal(result.ok, true);
    assert.equal(model.locate(itemId).containerId, containerId);
  }
  const source = model.locate(itemId), occupant = model.getState().containers[0].slots[0];
  const result = model.move(itemId, 'equipment', 0);
  assert.equal(result.swappedItemId, occupant);
  assert.deepEqual(model.locate(itemId), { containerId: 'equipment', slot: 0 });
  assert.deepEqual(model.locate(occupant), source);
  assert.equal(allPlacements(model.getState()).length, 12);
});

test('invalid drops, a full automatic destination and same-slot drops preserve item state', () => {
  const model = createInventoryModel();
  model.move('sphere-blue', 'stats', 1);
  model.move('cube-coral', 'stats', 2);
  for (const [itemId, containerId, slot, reason] of [
    ['unknown', 'inventory', 0, 'unknown-item'],
    ['sphere-green', 'missing-window', 0, 'unknown-container'],
    ['sphere-green', 'inventory', -1, 'invalid-slot'],
    ['sphere-green', 'inventory', 16, 'invalid-slot'],
    ['sphere-green', 'inventory', .5, 'invalid-slot'],
    ['sphere-green', 'inventory', '0', 'invalid-slot'],
    ['sphere-green', 'stats', null, 'container-full'],
  ]) {
    const before = model.getState();
    assert.deepEqual(model.move(itemId, containerId, slot), { ok: false, changed: false, reason });
    assert.deepEqual(model.getState(), before);
  }
  const before = model.getState(), at = model.locate('sphere-green');
  assert.equal(model.move('sphere-green', at.containerId, at.slot).changed, false);
  assert.deepEqual(model.getState(), before);
});

test('long transfer/swap sequences conserve every item once, including same-window swaps', () => {
  const model = createInventoryModel();
  let random = 179;
  for (let step = 0; step < 800; step++) {
    random = (random * 1664525 + 1013904223) >>> 0;
    const item = DEMO_ITEMS[random % DEMO_ITEMS.length];
    random = (random * 1664525 + 1013904223) >>> 0;
    const container = INVENTORY_CONTAINERS[random % INVENTORY_CONTAINERS.length];
    random = (random * 1664525 + 1013904223) >>> 0;
    assert.equal(model.move(item.id, container.id, random % container.slotLabels.length).ok, true);
    const state = model.getState(), ids = allPlacements(state);
    assert.equal(ids.length, DEMO_ITEMS.length);
    assert.equal(new Set(ids).size, DEMO_ITEMS.length);
    for (const itemId of ids) {
      const at = model.locate(itemId);
      assert.equal(byId(state, at.containerId).slots[at.slot], itemId);
    }
  }
});

test('snapshots and move results cannot mutate the live inventory, and reset restores its seed', () => {
  const model = createInventoryModel(), pristine = model.getState();
  const exposed = model.getState();
  exposed.items[0].color = '#000000';
  exposed.containers[0].slots[0] = null;
  exposed.containers[0].slotLabels[0] = 'Changed';
  model.getItem('sphere-amber').name = 'Changed';
  model.locate('sphere-amber').slot = 99;
  assert.deepEqual(model.getState(), pristine);
  const result = model.move('sphere-amber', 'crafting', 0);
  result.to.slot = 99; result.from.slot = 99;
  assert.deepEqual(model.locate('sphere-amber'), { containerId: 'crafting', slot: 0 });
  const swap = model.move('sphere-amber', 'inventory', 0);
  swap.to.slot = 99; swap.from.slot = 99;
  assert.deepEqual(model.locate('sphere-amber'), { containerId: 'inventory', slot: 0 });
  assert.deepEqual(model.locate('sphere-blue'), { containerId: 'crafting', slot: 0 });
  const reset = model.reset();
  assert.deepEqual(reset.containers, pristine.containers);
  assert.deepEqual(reset.items, pristine.items);
  assert.equal(reset.revision, 3);
  assert.equal(createInventoryModel().getState().revision, 0, 'Instances do not share slots or revisions');
  assert.equal(model.getItem('missing'), null); assert.equal(model.locate('missing'), null);
});

test('invalid custom seeds fail before an inventory can lose, duplicate or overwrite an item', () => {
  const clone = value => structuredClone(value);
  const duplicateItems = clone(DEMO_ITEMS); duplicateItems[1].id = duplicateItems[0].id;
  assert.throws(() => createInventoryModel({ items: duplicateItems }), /duplicate inventory item/);
  const duplicatePlacement = clone(DEMO_PLACEMENTS); duplicatePlacement[1] = { ...duplicatePlacement[0] };
  assert.throws(() => createInventoryModel({ placements: duplicatePlacement }), /initial inventory placement/);
  const occupied = clone(DEMO_PLACEMENTS); occupied[1].containerId = occupied[0].containerId; occupied[1].slot = occupied[0].slot;
  assert.throws(() => createInventoryModel({ placements: occupied }), /initial inventory placement/);
  assert.throws(() => createInventoryModel({ placements: DEMO_PLACEMENTS.slice(1) }), /exactly one initial placement/);
});
