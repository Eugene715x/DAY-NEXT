import { INVENTORY_CONTAINERS, DEMO_ITEMS, DEMO_PLACEMENTS } from './inventory-model.js';

// One item catalogue and canonical placement table back the personal windows,
// individual buildings and outdoor caches. The UI's "ground" is a local alias.
const wlClone = value => structuredClone(value);
const wlCount = container => container?.slots.reduce((count, id) => count + Number(id !== null), 0) || 0;
const wlHash = value => { let hash = 2166136261; for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); } return hash >>> 0; };
const wlPoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
const wlParts = feature => feature.parts?.length ? feature.parts : feature.rings?.length ? [feature.rings] : feature.points?.length ? [[feature.points]] : [];
function wlInRing(x, y, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index], b = ring[previous];
    const cross = (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
    if (Math.abs(cross) < 1e-8 && x >= Math.min(a.x, b.x) - 1e-9 && x <= Math.max(a.x, b.x) + 1e-9 && y >= Math.min(a.y, b.y) - 1e-9 && y <= Math.max(a.y, b.y) + 1e-9) return true;
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
const wlContains = (building, point) => building.parts.some(rings => rings.reduce((inside, ring) => inside !== wlInRing(point.x, point.y, ring), false));
function wlGrow(container, maximumSlots) {
  if (container.kind === 'personal') return;
  const last = container.slots.findLastIndex(Boolean), size = Math.min(maximumSlots, Math.max(12, Math.ceil((last + 5) / 4) * 4));
  while (container.slots.length < size) container.slots.push(null);
}
const wlRejected = reason => ({ ok: false, changed: false, reason });

export function createWorldLoot(world = {}, { buildingAssignments = [], start = world.start || { x: 0, y: 0 }, reachMeters = 12 } = {}) {
  const scale = Number(world.metersPerUnit) > 0 ? world.metersPerUnit : 1;
  const reach = Number.isFinite(reachMeters) && reachMeters > 0 ? reachMeters : 12;
  const reachUnits = reach / scale, bucketSize = Math.max(12, Number(world.cellSize) * 8 || 48);
  const worldId = String(world.id || `world:${world.width || 0}:${world.height || 0}:${world.bbox?.join(',') || ''}`);
  const assignments = buildingAssignments instanceof Map ? new Map(buildingAssignments) : new Map((Array.isArray(buildingAssignments) ? buildingAssignments : buildingAssignments.assignments || buildingAssignments.features || []).map(value => [value.sourceId || value.id, value.gameplayAssignment || value]));
  const buildings = new Map(), buildingBuckets = new Map();
  for (const source of world.buildings || []) {
    const id = String(source.sourceId || source.id || '');
    if (!id || buildings.has(id)) continue;
    const parts = wlParts(source).map(rings => rings.filter(ring => Array.isArray(ring) && ring.length >= 3 && ring.every(wlPoint)).map(ring => ring.map(point => ({ x: point.x, y: point.y })))).filter(rings => rings.length);
    if (!parts.length) continue;
    const points = parts.flat(2), minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
    const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
    const assignment = assignments.get(id) || assignments.get(source.id) || {};
    const building = { id, parts, bounds: { minX, maxX, minY, maxY }, name: assignment.roleName || assignment.typeName || 'Здание', assignment };
    buildings.set(id, building);
    for (let row = Math.floor(minY / bucketSize); row <= Math.floor(maxY / bucketSize); row++) for (let column = Math.floor(minX / bucketSize); column <= Math.floor(maxX / bucketSize); column++) {
      const key = `${column},${row}`; if (!buildingBuckets.has(key)) buildingBuckets.set(key, []); buildingBuckets.get(key).push(building);
    }
  }
  const buildingAt = position => {
    const candidates = buildingBuckets.get(`${Math.floor(position.x / bucketSize)},${Math.floor(position.y / bucketSize)}`) || [];
    return candidates.find(building => wlContains(building, position)) || null;
  };
  const validPosition = position => wlPoint(position) && position.x >= 0 && position.y >= 0
    && (!(world.width > 0) || position.x < world.width) && (!(world.height > 0) || position.y < world.height);
  let position = validPosition(start) ? { x: start.x, y: start.y } : { x: 0, y: 0 }, moving = false;
  let items = new Map(), containers = new Map(), locations = new Map(), nextPileId = 1;
  let revision = 0, contextRevision = 0, lastContextKey = '';
  // Spare slots support arbitrary manual placement, with a finite ceiling so
  // dragging into the last cell repeatedly cannot grow a save indefinitely.
  const maximumWorldSlots = () => Math.max(12, Math.ceil((items.size + 12) / 4) * 4);

  function buildInitialState() {
    items = new Map(DEMO_ITEMS.map(item => [item.id, { ...item }])); containers = new Map(); locations = new Map(); nextPileId = 1;
    for (const spec of INVENTORY_CONTAINERS) if (spec.id !== 'ground') containers.set(spec.id, { id: spec.id, kind: 'personal', name: spec.name, slotLabels: [...spec.slotLabels], slots: Array(spec.slotLabels.length).fill(null) });
    for (const building of buildings.values()) {
      const seed = wlHash(building.id), count = 2 + seed % 4;
      const container = { id: `building:${building.id}`, buildingId: building.id, kind: 'building', name: building.name, visited: false, slots: Array(12).fill(null) };
      for (let index = 0; index < count; index++) {
        const pick = wlHash(`${building.id}:${index}:${building.assignment.roleId || ''}`), sample = DEMO_ITEMS[pick % DEMO_ITEMS.length];
        const color = /^#[0-9a-f]{6}$/i.test(building.assignment.color || '') ? building.assignment.color : sample.color;
        const id = `loot:${building.id}:${index}`, shape = pick & 1 ? 'sphere' : 'cube';
        items.set(id, { id, name: `${shape === 'sphere' ? 'Сфера' : 'Куб'} · ${building.name}`, shape, color });
        container.slots[index] = id; locations.set(id, { containerId: container.id, slot: index });
      }
      containers.set(container.id, container);
    }
    let ground = null;
    for (const placement of DEMO_PLACEMENTS) {
      let container = containers.get(placement.containerId);
      if (placement.containerId === 'ground') {
        if (!ground) { const building = buildingAt(position); ground = building ? containers.get(`building:${building.id}`) : createPile(position); }
        container = ground;
      }
      let slot = placement.slot;
      if (container.slots[slot] !== null) slot = container.slots.indexOf(null);
      if (slot < 0) { slot = container.slots.length; container.slots.push(null); }
      container.slots[slot] = placement.itemId; locations.set(placement.itemId, { containerId: container.id, slot }); wlGrow(container, maximumWorldSlots());
    }
    refreshContextRevision();
  }
  function createPile(point) {
    const id = `pile-${nextPileId++}`;
    const pile = { id, kind: 'pile', name: 'Предметы на земле', x: point.x, y: point.y, slots: Array(12).fill(null) };
    containers.set(id, pile); return pile;
  }
  function currentContainer() {
    const building = buildingAt(position);
    if (building) return containers.get(`building:${building.id}`);
    let nearest = null, minimum = reachUnits;
    for (const container of containers.values()) if (container.kind === 'pile' && wlCount(container) > 0) {
      const distance = Math.hypot(container.x - position.x, container.y - position.y);
      if (distance <= minimum) { minimum = distance; nearest = container; }
    }
    return nearest;
  }
  const emptyContextId = () => `ground:${Math.round(position.x / reachUnits)}:${Math.round(position.y / reachUnits)}`;
  function refreshContextRevision() {
    const current = currentContainer(), key = `${current?.id || emptyContextId()}:${moving}`;
    if (key !== lastContextKey) { lastContextKey = key; contextRevision++; }
  }
  function getContext() {
    const current = currentContainer(), kind = current?.kind === 'building' ? 'building' : current ? 'pile' : 'ground';
    return { id: current?.id || emptyContextId(), kind, name: current?.name || 'На земле', buildingId: current?.buildingId || null,
      x: current?.kind === 'pile' ? current.x : position.x, y: current?.kind === 'pile' ? current.y : position.y,
      position: { ...position }, itemCount: wlCount(current), accessible: !moving, moving, reachMeters: reach,
      revision: contextRevision, worldRevision: revision };
  }
  function setPosition(next, options = {}) {
    if (!validPosition(next)) return wlRejected('invalid-position');
    position = { x: next.x, y: next.y }; moving = options?.moving === true; refreshContextRevision(); return getContext();
  }
  function openContext(expectedId = null) {
    const context = getContext(), id = typeof expectedId === 'object' ? expectedId?.contextId || expectedId?.id : expectedId;
    if (id && id !== context.id) return { ...context, ...wlRejected('stale-context') };
    if (!context.accessible) return { ...context, ...wlRejected('moving') };
    const container = currentContainer(); let changed = false;
    if (container?.kind === 'building' && !container.visited) { container.visited = true; revision++; changed = true; }
    return { ...getContext(), ok: true, changed };
  }
  function getBuildingState(id) {
    const sourceId = String(id || '').replace(/^building:/, ''), container = containers.get(`building:${sourceId}`);
    if (!container) return null;
    const itemCount = wlCount(container); return { id: sourceId, sourceId, visited: container.visited, itemCount, empty: itemCount === 0, revision };
  }
  const getBuildingStates = () => [...buildings.keys()].map(getBuildingState);
  const getGroundPiles = () => [...containers.values()].filter(container => container.kind === 'pile' && wlCount(container) > 0).map(container => ({
    id: container.id, x: container.x, y: container.y, itemCount: wlCount(container),
    preview: container.slots.filter(Boolean).slice(0, 3).map(id => { const item = items.get(id); return { id, shape: item.shape, color: item.color }; }),
  }));
  function getState() {
    const current = currentContainer(), context = getContext();
    const localGround = current ? { id: 'ground', name: current.name, slotLabels: current.slots.map((_, index) => `Место ${index + 1}`), slots: [...current.slots], context }
      : { id: 'ground', name: 'На земле', slotLabels: Array.from({ length: 12 }, (_, index) => `Место ${index + 1}`), slots: Array(12).fill(null), context };
    return { version: 2, revision, contextRevision, context, items: [...items.values()].map(item => ({ ...item })),
      containers: INVENTORY_CONTAINERS.map(spec => spec.id === 'ground' ? localGround : wlClone(containers.get(spec.id))) };
  }
  function locate(id) {
    const location = locations.get(id); if (!location) return null;
    const current = currentContainer(), container = containers.get(location.containerId);
    return { containerId: container.kind === 'personal' ? container.id : current?.id === container.id ? 'ground' : container.id,
      storeId: container.id, slot: location.slot, contextId: container.kind === 'personal' ? null : container.id, world: container.kind !== 'personal' };
  }
  const getItem = id => items.has(id) ? { ...items.get(id) } : null;
  function move(itemId, toContainerId, requestedSlot = null, options = {}) {
    const origin = locations.get(itemId), source = origin && containers.get(origin.containerId);
    if (!source) return wlRejected('unknown-item');
    const local = currentContainer(), usesGround = toContainerId === 'ground' || source.kind !== 'personal';
    if (usesGround && options?.contextId && options.contextId !== getContext().id) return wlRejected('stale-context');
    if (usesGround && moving) return wlRejected('moving');
    if (source.kind !== 'personal' && source.id !== local?.id) return wlRejected('not-accessible');
    let target = toContainerId === 'ground' ? local : containers.get(toContainerId);
    if (toContainerId !== 'ground' && (!target || target.kind !== 'personal')) return wlRejected('unknown-container');
    const automatic = requestedSlot === null || requestedSlot === undefined;
    let slot = automatic ? target ? target.slots.indexOf(null) : 0 : requestedSlot;
    if (automatic && slot < 0 && target?.kind === 'personal') return wlRejected('container-full');
    if (!automatic && (!Number.isInteger(slot) || slot < 0 || slot >= (target?.slots.length || 12))) return wlRejected('invalid-slot');
    if (automatic && slot < 0) slot = target.slots.length;
    if (!target) target = createPile(position);
    if (source.id === target.id && origin.slot === slot) return { ok: true, changed: false, from: locate(itemId), to: locate(itemId), swappedItemId: null };
    while (target.slots.length <= slot) target.slots.push(null);
    const swappedItemId = target.slots[slot];
    const from = { containerId: source.kind === 'personal' ? source.id : 'ground', storeId: source.id, slot: origin.slot };
    target.slots[slot] = itemId; source.slots[origin.slot] = swappedItemId;
    locations.set(itemId, { containerId: target.id, slot });
    if (swappedItemId !== null) locations.set(swappedItemId, { containerId: source.id, slot: origin.slot });
    for (const container of [source, target]) {
      if (container.kind === 'building') container.visited = true;
      wlGrow(container, maximumWorldSlots());
      if (container.kind === 'pile' && wlCount(container) === 0) containers.delete(container.id);
    }
    revision++; refreshContextRevision();
    return { ok: true, changed: true, from, to: { containerId: target.kind === 'personal' ? target.id : 'ground', storeId: target.id, slot }, swappedItemId };
  }
  function exportState() {
    return { version: 1, worldId, nextPileId, items: [...items.values()].map(item => ({ ...item })), containers: [...containers.values()].map(container => wlClone(container)) };
  }
  function importState(snapshot) {
    try {
      if (!snapshot || snapshot.version !== 1 || snapshot.worldId !== worldId || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.containers)
        || snapshot.items.length !== items.size || !Number.isSafeInteger(snapshot.nextPileId) || snapshot.nextPileId < 1) return wlRejected('invalid-snapshot');
      const nextItems = new Map();
      for (const item of snapshot.items) {
        const expected = items.get(item?.id);
        if (!expected || nextItems.has(item.id) || ['id', 'name', 'shape', 'color'].some(key => item[key] !== expected[key])) return wlRejected('invalid-items');
        nextItems.set(item.id, { ...expected });
      }
      const nextContainers = new Map(), nextLocations = new Map(); let maximumPile = 0;
      for (const candidate of snapshot.containers) {
        if (!candidate || typeof candidate.id !== 'string' || nextContainers.has(candidate.id) || !Array.isArray(candidate.slots)
          || candidate.slots.length > maximumWorldSlots()) return wlRejected('invalid-containers');
        let record;
        if (candidate.kind === 'pile') {
          const number = /^pile-(\d+)$/.exec(candidate.id);
          const sequence = Number(number?.[1]);
          if (!number || !Number.isSafeInteger(sequence) || sequence < 1 || candidate.id !== `pile-${sequence}` || !validPosition(candidate) || buildingAt(candidate) || !candidate.slots.some(Boolean)) return wlRejected('invalid-pile');
          maximumPile = Math.max(maximumPile, sequence);
          record = { id: candidate.id, kind: 'pile', name: 'Предметы на земле', x: candidate.x, y: candidate.y, slots: [...candidate.slots] };
        } else {
          const original = containers.get(candidate.id);
          if (!original || original.kind === 'pile' || original.kind !== candidate.kind) return wlRejected('invalid-container');
          if (original.kind === 'personal' && candidate.slots.length !== original.slots.length || original.kind === 'building' && (candidate.buildingId !== original.buildingId || typeof candidate.visited !== 'boolean' || candidate.slots.length < 12)) return wlRejected('invalid-container');
          record = { ...wlClone(original), slots: [...candidate.slots] };
          if (original.kind === 'building') record.visited = candidate.visited;
        }
        for (let slot = 0; slot < record.slots.length; slot++) {
          const id = record.slots[slot];
          if (id !== null && (!nextItems.has(id) || nextLocations.has(id))) return wlRejected('invalid-placement');
          if (id !== null) nextLocations.set(id, { containerId: record.id, slot });
        }
        wlGrow(record, maximumWorldSlots()); nextContainers.set(record.id, record);
      }
      for (const container of containers.values()) if (container.kind !== 'pile' && !nextContainers.has(container.id)) return wlRejected('missing-container');
      if (nextLocations.size !== nextItems.size || snapshot.nextPileId <= maximumPile) return wlRejected('invalid-placement');
      items = nextItems; containers = nextContainers; locations = nextLocations; nextPileId = snapshot.nextPileId; revision++; refreshContextRevision();
      return { ok: true, changed: true };
    } catch { return wlRejected('invalid-snapshot'); }
  }
  function reset() { position = validPosition(start) ? { x: start.x, y: start.y } : { x: 0, y: 0 }; moving = false; buildInitialState(); revision++; return getState(); }
  buildInitialState();
  return { getState, snapshot: getState, move, reset, locate, getItem, setPosition, getContext, openContext, visit: openContext,
    getBuildingState, getBuildingStates, getGroundPiles, getRevision: () => revision, exportState, importState };
}
