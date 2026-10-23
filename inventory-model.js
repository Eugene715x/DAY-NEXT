// Temporary item-transfer model. These shapes are interface samples, not loot
// derived from the map or a character progression/crafting economy.
const imFreezeList = list => Object.freeze(list.map(value => Object.freeze(value)));
const imLabels = (count, prefix = 'Ячейка') => Object.freeze(Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`));

export const INVENTORY_CONTAINERS = imFreezeList([
  { id: 'equipment', name: 'Снаряжение', slotLabels: Object.freeze(['Голова', 'Тело', 'Руки', 'Ноги', 'Инструмент', 'Рюкзак']) },
  { id: 'inventory', name: 'Инвентарь', slotLabels: imLabels(16) },
  { id: 'ground', name: 'На земле', slotLabels: imLabels(12, 'Место') },
  { id: 'crafting', name: 'Крафт', slotLabels: imLabels(4, 'Компонент') },
  { id: 'stats', name: 'Характеристики', slotLabels: imLabels(3, 'Образец') },
]);

export const DEMO_ITEMS = imFreezeList([
  { id: 'sphere-amber', name: 'Янтарная сфера', shape: 'sphere', color: '#e4b964' },
  { id: 'cube-teal', name: 'Бирюзовый куб', shape: 'cube', color: '#68c2bc' },
  { id: 'sphere-blue', name: 'Синяя сфера', shape: 'sphere', color: '#75a7e4' },
  { id: 'cube-coral', name: 'Коралловый куб', shape: 'cube', color: '#e48b76' },
  { id: 'sphere-green', name: 'Зелёная сфера', shape: 'sphere', color: '#9cc875' },
  { id: 'cube-violet', name: 'Фиолетовый куб', shape: 'cube', color: '#b295da' },
  { id: 'sphere-rose', name: 'Розовая сфера', shape: 'sphere', color: '#df93b4' },
  { id: 'cube-blue', name: 'Синий куб', shape: 'cube', color: '#75a7e4' },
  { id: 'sphere-teal', name: 'Бирюзовая сфера', shape: 'sphere', color: '#68c2bc' },
  { id: 'cube-amber', name: 'Янтарный куб', shape: 'cube', color: '#e4b964' },
  { id: 'sphere-violet', name: 'Фиолетовая сфера', shape: 'sphere', color: '#b295da' },
  { id: 'cube-green', name: 'Зелёный куб', shape: 'cube', color: '#9cc875' },
]);

export const DEMO_PLACEMENTS = imFreezeList([
  { itemId: 'sphere-amber', containerId: 'equipment', slot: 0 },
  { itemId: 'cube-teal', containerId: 'equipment', slot: 4 },
  { itemId: 'sphere-blue', containerId: 'inventory', slot: 0 },
  { itemId: 'cube-coral', containerId: 'inventory', slot: 1 },
  { itemId: 'sphere-green', containerId: 'inventory', slot: 2 },
  { itemId: 'cube-violet', containerId: 'inventory', slot: 4 },
  { itemId: 'sphere-rose', containerId: 'inventory', slot: 5 },
  { itemId: 'cube-blue', containerId: 'inventory', slot: 8 },
  { itemId: 'sphere-teal', containerId: 'ground', slot: 0 },
  { itemId: 'cube-amber', containerId: 'ground', slot: 1 },
  { itemId: 'sphere-violet', containerId: 'ground', slot: 4 },
  { itemId: 'cube-green', containerId: 'stats', slot: 0 },
]);

/**
 * All five windows use the same slots. An explicit occupied destination swaps
 * the two items atomically; an omitted slot selects free space and never
 * silently overwrites an item. Snapshots never expose mutable model storage.
 */
export function createInventoryModel({ items = DEMO_ITEMS, containers = INVENTORY_CONTAINERS, placements = DEMO_PLACEMENTS } = {}) {
  if (!Array.isArray(items) || !Array.isArray(containers) || !Array.isArray(placements)) throw new Error('Inventory configuration must contain arrays');
  const itemRecords = new Map(), containerRecords = new Map();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.id || itemRecords.has(item.id)
      || typeof item.name !== 'string' || !item.name || !['sphere', 'cube'].includes(item.shape)
      || typeof item.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(item.color)) throw new Error('Invalid or duplicate inventory item');
    itemRecords.set(item.id, { id: item.id, name: item.name, shape: item.shape, color: item.color });
  }
  for (const container of containers) {
    if (!container || typeof container.id !== 'string' || !container.id || containerRecords.has(container.id)
      || typeof container.name !== 'string' || !container.name || !Array.isArray(container.slotLabels)
      || !container.slotLabels.length || !container.slotLabels.every(label => typeof label === 'string' && label.length)) throw new Error('Invalid or duplicate inventory container');
    containerRecords.set(container.id, { id: container.id, name: container.name, slotLabels: [...container.slotLabels], slots: Array(container.slotLabels.length).fill(null) });
  }
  const locations = new Map();
  for (const placement of placements) {
    const container = containerRecords.get(placement?.containerId);
    if (!itemRecords.has(placement?.itemId) || locations.has(placement.itemId) || !container
      || !Number.isInteger(placement.slot) || placement.slot < 0 || placement.slot >= container.slots.length
      || container.slots[placement.slot] !== null) throw new Error('Invalid, duplicate or occupied initial inventory placement');
    container.slots[placement.slot] = placement.itemId;
    locations.set(placement.itemId, { containerId: placement.containerId, slot: placement.slot });
  }
  if (locations.size !== itemRecords.size) throw new Error('Every inventory item must have exactly one initial placement');
  const initialSlots = new Map([...containerRecords].map(([id, record]) => [id, [...record.slots]]));
  let revision = 0;

  const getState = () => ({
    version: 1, revision,
    items: [...itemRecords.values()].map(item => ({ ...item })),
    containers: [...containerRecords.values()].map(container => ({ ...container, slotLabels: [...container.slotLabels], slots: [...container.slots] })),
  });
  const locate = itemId => locations.has(itemId) ? { ...locations.get(itemId) } : null;
  const getItem = itemId => itemRecords.has(itemId) ? { ...itemRecords.get(itemId) } : null;

  function move(itemId, toContainerId, requestedSlot = null) {
    const from = locate(itemId), target = containerRecords.get(toContainerId);
    if (!from) return { ok: false, changed: false, reason: 'unknown-item' };
    if (!target) return { ok: false, changed: false, reason: 'unknown-container' };
    const automatic = requestedSlot === null || requestedSlot === undefined;
    const slot = automatic ? target.slots.indexOf(null) : requestedSlot;
    if (automatic && slot < 0) return { ok: false, changed: false, reason: 'container-full' };
    if (!Number.isInteger(slot) || slot < 0 || slot >= target.slots.length) return { ok: false, changed: false, reason: 'invalid-slot' };
    const to = { containerId: target.id, slot };
    if (from.containerId === to.containerId && from.slot === to.slot) return { ok: true, changed: false, from, to, swappedItemId: null };

    // Validate everything before changing either slot. There is no intermediate
    // state in which an item appears in two windows or in no window.
    const source = containerRecords.get(from.containerId), swappedItemId = target.slots[slot];
    target.slots[slot] = itemId;
    source.slots[from.slot] = swappedItemId;
    locations.set(itemId, { ...to });
    if (swappedItemId !== null) locations.set(swappedItemId, { ...from });
    revision++;
    return { ok: true, changed: true, from, to: { ...to }, swappedItemId };
  }

  function reset() {
    locations.clear();
    for (const [id, container] of containerRecords) {
      container.slots = [...initialSlots.get(id)];
      container.slots.forEach((itemId, slot) => { if (itemId !== null) locations.set(itemId, { containerId: id, slot }); });
    }
    revision++;
    return getState();
  }

  return { getState, snapshot: getState, move, reset, locate, getItem };
}
