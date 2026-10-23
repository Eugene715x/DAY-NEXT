import { INVENTORY_CONTAINERS } from './inventory-model.js';

const iuClamp = (value, low, high) => Math.max(low, Math.min(high, value));
const iuNames = {
  equipment: { title: 'Снаряжение', kicker: '01 / ПУТНИК', subtitle: 'Надето и под рукой', key: 'E', icon: 'equipment' },
  inventory: { title: 'Инвентарь', kicker: '02 / ПОКЛАЖА', subtitle: 'Всё, что несёшь с собой', key: 'I', icon: 'inventory' },
  ground: { title: 'На земле', kicker: '03 / ОКРУЖЕНИЕ', subtitle: 'Предметы рядом с путником', key: 'G', icon: 'ground' },
  crafting: { title: 'Крафт', kicker: '04 / МАСТЕРСКАЯ', subtitle: 'Место для будущих рецептов', key: 'C', icon: 'crafting' },
  stats: { title: 'Характеристики', kicker: '05 / РАЗВИТИЕ', subtitle: 'Будущие навыки и улучшения', key: 'P', icon: 'stats' },
};
const iuIcons = {
  equipment: '<circle cx="12" cy="5" r="3"/><path d="M8 9h8l3 5-3 2v6h-3v-7h-2v7H8v-6l-3-2 3-5Z"/>',
  inventory: '<path d="M7 7V5a5 5 0 0 1 10 0v2M5 7h14l2 15H3L5 7Z"/><path d="M7 12h10v6H7zM8 7v3m8-3v3"/>',
  ground: '<path d="m3 15 9-4 9 4-9 5-9-5Zm2 5 7 3 7-3M7 7l5-3 5 3-5 3-5-3Z"/>',
  crafting: '<path d="m4 21 9-9m2-7 4-3 3 4-4 3-3-4Zm-2 7-3-3 3-3 4 4-4 4Z"/><path d="m3 3 5 2 1 4-4 1-2-7Zm6 7 12 11"/>',
  stats: '<path d="M4 20V10m8 10V4m8 16v-7M2 22h20"/><path d="m8 5 4-3 4 3"/>',
};
const iuIcon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${iuIcons[name] || ''}</svg>`;

/** Independent demo windows. Map/game state is deliberately not owned here. */
export function createInventoryUI({ root, model, onVisibilityChange = () => {} } = {}) {
  if (!root || !model?.getState || !model?.move) throw new Error('Inventory windows need a root and an item model');
  root.classList.add('item-workspace');
  root.setAttribute('aria-label', 'Предметы и персонаж');
  const specs = INVENTORY_CONTAINERS;
  const windows = new Map(), positions = new Map(), slots = new Map();
  const visible = new Set();
  let zOrder = [], selectedItemId = null, draggedItemId = null, windowDrag = null, suppressClickUntil = 0, destroyed = false;

  const dock = document.createElement('nav'); dock.className = 'item-module-dock'; dock.hidden = true; dock.setAttribute('aria-label', 'Окна персонажа');
  const dockName = document.createElement('span'); dockName.className = 'item-dock-title'; dockName.textContent = 'ПУТНИК'; dock.append(dockName);
  for (const spec of specs) {
    const info = iuNames[spec.id];
    if (!info) continue;
    const button = document.createElement('button'); button.type = 'button'; button.dataset.windowToggle = spec.id;
    button.className = 'item-module-toggle'; button.innerHTML = `${iuIcon(info.icon)}<span>${info.title}</span><kbd>${info.key}</kbd>`;
    button.setAttribute('aria-controls', `item-window-${spec.id}`); button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => toggleWindow(spec.id)); dock.append(button);
  }
  const closeAllButton = document.createElement('button'); closeAllButton.type = 'button'; closeAllButton.className = 'item-workspace-close'; closeAllButton.textContent = '×'; closeAllButton.title = 'Закрыть все окна'; closeAllButton.setAttribute('aria-label', 'Закрыть все окна'); closeAllButton.addEventListener('click', closeAll); dock.append(closeAllButton);
  root.append(dock);
  const notice = document.createElement('div'); notice.className = 'item-transfer-notice'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); notice.hidden = true; root.append(notice);

  for (const spec of specs) {
    const info = iuNames[spec.id]; if (!info) continue;
    const panel = document.createElement('section'); panel.className = `item-window item-window-${spec.id}`; panel.id = `item-window-${spec.id}`;
    panel.dataset.windowId = spec.id; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'false'); panel.setAttribute('aria-labelledby', `item-window-title-${spec.id}`);
    const header = document.createElement('header'); header.className = 'item-window-header'; header.dataset.windowDrag = spec.id;
    header.innerHTML = `<span class="item-window-icon">${iuIcon(info.icon)}</span><div class="item-window-heading"><span class="item-window-kicker">${info.kicker}</span><h2 id="item-window-title-${spec.id}">${info.title}</h2></div>`;
    const close = document.createElement('button'); close.type = 'button'; close.dataset.windowClose = spec.id; close.className = 'item-window-close'; close.textContent = '×'; close.title = 'Закрыть окно'; close.setAttribute('aria-label', `Закрыть: ${info.title}`); close.addEventListener('click', () => closeWindow(spec.id)); header.append(close);
    const body = document.createElement('div'); body.className = 'item-window-body';
    const intro = document.createElement('p'); intro.className = 'item-window-subtitle'; intro.textContent = info.subtitle; body.append(intro);
    if (spec.id === 'equipment') {
      const silhouette = document.createElement('div'); silhouette.className = 'equipment-silhouette'; silhouette.setAttribute('aria-hidden', 'true');
      silhouette.innerHTML = '<svg viewBox="0 0 160 235"><path class="silhouette-ring" d="M80 4v227M10 65h140M16 164h128"/><circle cx="80" cy="34" r="19"/><path d="m61 59-17 8-17 66 16 5 14-42 3 60-7 65 18 3 9-63 9 63 18-3-7-65 3-60 14 42 16-5-17-66-17-8H61Z"/><path class="silhouette-detail" d="M61 66h38l-5 72H66L61 66Zm5 72h28M80 72v60M56 160l24-7 24 7"/></svg><span>СЕВЕР</span>';
      body.append(silhouette);
    }
    if (spec.id === 'stats') {
      const bars = document.createElement('div'); bars.className = 'item-stat-preview'; bars.setAttribute('aria-label', 'Макет характеристик');
      bars.innerHTML = '<div><span>Сила</span><i style="--stat-level:42%"></i><b>—</b></div><div><span>Ловкость</span><i style="--stat-level:67%"></i><b>—</b></div><div><span>Выживание</span><i style="--stat-level:54%"></i><b>—</b></div>';
      body.append(bars);
      const label = document.createElement('span'); label.className = 'item-grid-caption'; label.textContent = 'ОБРАЗЦЫ ДЛЯ ИЗУЧЕНИЯ'; body.append(label);
    }
    const grid = document.createElement('div'); grid.className = `item-slot-grid item-slot-grid-${spec.id}`; grid.setAttribute('aria-label', `${info.title}: предметы`);
    for (let index = 0; index < spec.slotLabels.length; index++) {
      const cell = document.createElement('button'); cell.type = 'button'; cell.className = 'module-slot'; cell.dataset.containerId = spec.id; cell.dataset.slotIndex = String(index);
      cell.addEventListener('click', () => slotClick(spec.id, index));
      cell.addEventListener('dragstart', event => beginItemDrag(event, spec.id, index));
      cell.addEventListener('dragend', clearDrag);
      cell.addEventListener('dragover', event => { if (!draggedItemId) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; cell.classList.add('is-drag-over'); });
      cell.addEventListener('dragleave', () => cell.classList.remove('is-drag-over'));
      cell.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); const itemId = draggedItemId || event.dataTransfer.getData('application/x-day-next-item'); clearDrag(); if (itemId) transfer(itemId, spec.id, index); suppressClickUntil = performance.now() + 150; });
      grid.append(cell); slots.set(`${spec.id}:${index}`, cell);
    }
    body.append(grid);
    if (spec.id === 'crafting') {
      const future = document.createElement('div'); future.className = 'item-craft-future'; future.innerHTML = '<span aria-hidden="true">↳</span><span>Результат появится здесь</span><span class="item-future-output" aria-hidden="true">◇</span>'; body.append(future);
    }
    const footer = document.createElement('footer'); footer.className = 'item-window-footer'; footer.innerHTML = '<span class="item-window-hint">Перетащи предмет или выбери два слота</span><span class="item-demo-mark">ПРОБНЫЕ ПРЕДМЕТЫ</span>';
    panel.append(header, body, footer); root.append(panel); windows.set(spec.id, panel);
    panel.addEventListener('pointerdown', () => bringFront(spec.id));
    header.addEventListener('pointerdown', event => beginWindowDrag(event, spec.id));
  }

  function defaultPositions() {
    const vw = innerWidth, vh = innerHeight;
    const gap = 14, totalWidth = Math.min(910, vw - 32), eqWidth = Math.round(totalWidth * .27), middleWidth = Math.round(totalWidth * .37), rightWidth = totalWidth - eqWidth - middleWidth - 2 * gap;
    const totalHeight = Math.max(360, Math.min(620, vh - 170));
    const left = Math.round((vw - totalWidth) / 2), top = Math.max(88, Math.round((vh - totalHeight) / 2) - 10);
    const firstMiddle = Math.round(totalHeight * .55), firstRight = Math.round(totalHeight * .50);
    return {
      equipment: { x: left, y: top, width: eqWidth, height: totalHeight },
      inventory: { x: left + eqWidth + gap, y: top, width: middleWidth, height: firstMiddle },
      crafting: { x: left + eqWidth + gap, y: top + firstMiddle + gap, width: middleWidth, height: totalHeight - firstMiddle - gap },
      ground: { x: left + eqWidth + middleWidth + 2 * gap, y: top, width: rightWidth, height: firstRight },
      stats: { x: left + eqWidth + middleWidth + 2 * gap, y: top + firstRight + gap, width: rightWidth, height: totalHeight - firstRight - gap },
    };
  }
  function applyPosition(id) {
    const panel = windows.get(id), value = positions.get(id); if (!panel || !value) return;
    value.width = Math.min(value.width, Math.max(210, innerWidth - 24)); value.height = Math.min(value.height, Math.max(220, innerHeight - 110));
    value.x = iuClamp(value.x, 12, Math.max(12, innerWidth - value.width - 12)); value.y = iuClamp(value.y, 88, Math.max(88, innerHeight - value.height - 52));
    panel.style.left = `${value.x}px`; panel.style.top = `${value.y}px`; panel.style.width = `${value.width}px`; panel.style.height = `${value.height}px`;
  }
  function bringFront(id) {
    if (!visible.has(id)) return;
    zOrder = zOrder.filter(value => value !== id); zOrder.push(id);
    for (let index = 0; index < zOrder.length; index++) windows.get(zOrder[index]).style.zIndex = String(10 + index);
  }
  function syncVisibility() {
    for (const [id, panel] of windows) panel.hidden = !visible.has(id);
    for (const button of dock.querySelectorAll('[data-window-toggle]')) button.setAttribute('aria-pressed', String(visible.has(button.dataset.windowToggle)));
    dock.hidden = !visible.size; notice.hidden = !visible.size; onVisibilityChange(visible.size > 0);
  }
  function openWindow(id, focus = true) {
    if (!windows.has(id)) return false;
    if (!positions.has(id)) { const defaults = defaultPositions(); for (const key of Object.keys(defaults)) if (!positions.has(key)) positions.set(key, defaults[key]); }
    visible.add(id); applyPosition(id); bringFront(id); syncVisibility();
    if (focus) windows.get(id).querySelector('.item-window-close').focus({ preventScroll: true });
    return true;
  }
  function closeWindow(id) {
    if (!visible.has(id)) return false;
    visible.delete(id); zOrder = zOrder.filter(value => value !== id); syncVisibility(); return true;
  }
  function closeAll() { visible.clear(); zOrder = []; selectedItemId = null; clearDrag(); render(); syncVisibility(); }
  function toggleWindow(id) { return visible.has(id) ? closeWindow(id) : openWindow(id); }
  function toggleWorkspace() {
    if (visible.size) { closeAll(); return false; }
    for (const spec of specs) openWindow(spec.id, false);
    notice.textContent = 'Переноси сферы и кубы между окнами. Заголовки окон можно перетаскивать.';
    bringFront('inventory');
    windows.get('inventory')?.querySelector('.item-window-close').focus({ preventScroll: true });
    return true;
  }
  function closeTop() { const top = zOrder.at(-1); return top ? closeWindow(top) : false; }

  function itemElement(item) {
    const token = document.createElement('span'); token.className = 'item-token'; token.style.setProperty('--item-color', item.color);
    const shape = document.createElement('span'); shape.className = `item-token-shape item-shape-${item.shape}`; shape.setAttribute('aria-hidden', 'true');
    if (item.shape === 'cube') shape.innerHTML = '<i></i><i></i><i></i>';
    const name = document.createElement('span'); name.className = 'item-token-name'; name.textContent = item.name;
    token.append(shape, name); return token;
  }
  function render() {
    const state = model.getState(), items = new Map(state.items.map(item => [item.id, item]));
    if (selectedItemId && !items.has(selectedItemId)) selectedItemId = null;
    for (const container of state.containers) for (let index = 0; index < container.slots.length; index++) {
      const cell = slots.get(`${container.id}:${index}`); if (!cell) continue;
      const item = items.get(container.slots[index]); cell.replaceChildren();
      cell.classList.toggle('has-item', !!item); cell.classList.toggle('is-selected', !!item && item.id === selectedItemId); cell.classList.toggle('can-receive', !!selectedItemId && item?.id !== selectedItemId);
      cell.draggable = !!item;
      if (item) { cell.dataset.itemId = item.id; cell.append(itemElement(item)); }
      else { delete cell.dataset.itemId; const empty = document.createElement('span'); empty.className = 'item-empty-slot'; empty.textContent = container.id === 'equipment' ? '＋' : '·'; empty.setAttribute('aria-hidden', 'true'); cell.append(empty); }
      const label = document.createElement('span'); label.className = 'item-slot-label'; label.textContent = container.slotLabels[index]; cell.append(label);
      cell.setAttribute('aria-label', `${iuNames[container.id]?.title || container.name}: ${container.slotLabels[index]}, ${item ? item.name : 'пусто'}`);
      cell.setAttribute('aria-pressed', String(!!item && item.id === selectedItemId));
      cell.title = item ? `${item.name} · перетащить или выбрать` : `${container.slotLabels[index]} · положить выбранный предмет`;
    }
  }
  function slotClick(containerId, index) {
    if (performance.now() < suppressClickUntil) return;
    const state = model.getState(), container = state.containers.find(value => value.id === containerId), itemId = container?.slots[index];
    if (selectedItemId && selectedItemId !== itemId) { transfer(selectedItemId, containerId, index); return; }
    selectedItemId = itemId && selectedItemId !== itemId ? itemId : null;
    notice.textContent = selectedItemId ? 'Выбери, куда положить предмет. Занятый слот обменяет предметы местами.' : 'Переноси предметы между окнами. Заголовки окон можно перетаскивать.';
    render(); slots.get(`${containerId}:${index}`)?.focus({ preventScroll: true });
  }
  function transfer(itemId, containerId, index) {
    const before = model.getState().items.find(item => item.id === itemId), result = model.move(itemId, containerId, index);
    if (result.ok) { selectedItemId = null; notice.textContent = result.swappedItemId ? 'Предметы поменялись местами.' : `${before?.name || 'Предмет'}: ${iuNames[containerId]?.title || containerId}.`; }
    else notice.textContent = 'Не удалось перенести предмет. Выбери свободное место.';
    render(); slots.get(`${containerId}:${index}`)?.focus({ preventScroll: true }); return result;
  }
  function beginItemDrag(event, containerId, index) {
    const state = model.getState(), itemId = state.containers.find(value => value.id === containerId)?.slots[index];
    if (!itemId || !event.dataTransfer) { event.preventDefault(); return; }
    draggedItemId = itemId; selectedItemId = null; root.classList.add('is-item-dragging');
    for (const cell of slots.values()) cell.classList.toggle('can-receive', cell.dataset.itemId !== itemId);
    event.dataTransfer.setData('application/x-day-next-item', itemId); event.dataTransfer.setData('text/plain', itemId); event.dataTransfer.effectAllowed = 'move';
    notice.textContent = 'Отпусти предмет в нужном слоте. Занятый слот обменяет предметы местами.';
  }
  function clearDrag() {
    draggedItemId = null; root.classList.remove('is-item-dragging');
    for (const cell of slots.values()) { cell.classList.remove('is-drag-over'); cell.classList.remove('can-receive'); }
  }
  function beginWindowDrag(event, id) {
    if (event.button !== 0 || event.target.closest('button')) return;
    event.preventDefault(); event.stopPropagation(); bringFront(id);
    const position = positions.get(id); if (!position) return;
    windowDrag = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: position.x, y: position.y };
    event.currentTarget.setPointerCapture(event.pointerId); windows.get(id).classList.add('is-window-dragging');
  }
  function moveWindow(event) {
    if (!windowDrag || event.pointerId !== windowDrag.pointerId) return;
    event.preventDefault(); const value = positions.get(windowDrag.id); value.x = windowDrag.x + event.clientX - windowDrag.startX; value.y = windowDrag.y + event.clientY - windowDrag.startY; applyPosition(windowDrag.id);
  }
  function stopWindowDrag(event) {
    if (!windowDrag || event.pointerId !== windowDrag.pointerId) return;
    windows.get(windowDrag.id)?.classList.remove('is-window-dragging'); windowDrag = null;
  }
  function resize() {
    const defaults = defaultPositions();
    for (const id of windows.keys()) {
      if (!positions.has(id)) continue;
      // Size changes keep all windows reachable; manual order and placement stay.
      const position = positions.get(id); position.width = defaults[id].width; position.height = defaults[id].height; applyPosition(id);
    }
  }
  function keydown(event) {
    const target = event.target;
    if (event.altKey || event.ctrlKey || event.metaKey || target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    const inside = root.contains(target);
    if (event.key === 'Escape' && visible.size) { event.preventDefault(); event.stopImmediatePropagation(); closeTop(); return; }
    const id = Object.keys(iuNames).find(key => iuNames[key].key.toLowerCase() === event.key.toLowerCase());
    if (id && !event.repeat) { event.preventDefault(); event.stopImmediatePropagation(); toggleWindow(id); return; }
    if (inside) event.stopPropagation();
  }
  function focusIn() { if (visible.size) onVisibilityChange(true); }
  function stopPointer(event) { event.stopPropagation(); }
  root.addEventListener('pointerdown', stopPointer); root.addEventListener('focusin', focusIn);
  window.addEventListener('pointermove', moveWindow); window.addEventListener('pointerup', stopWindowDrag); window.addEventListener('pointercancel', stopWindowDrag); window.addEventListener('resize', resize); window.addEventListener('keydown', keydown, true);
  render();
  return {
    toggleWorkspace, toggleWindow, closeAll, closeTop, hasOpenWindows: () => visible.size > 0,
    reset() { model.reset(); selectedItemId = null; clearDrag(); render(); notice.textContent = 'Набор пробных предметов восстановлен.'; },
    getState: () => ({ openWindows: [...visible], positions: Object.fromEntries([...positions].map(([id, value]) => [id, { ...value }])), selectedItemId, draggedItemId, model: model.getState() }),
    destroy() { if (destroyed) return; destroyed = true; window.removeEventListener('pointermove', moveWindow); window.removeEventListener('pointerup', stopWindowDrag); window.removeEventListener('pointercancel', stopWindowDrag); window.removeEventListener('resize', resize); window.removeEventListener('keydown', keydown, true); root.removeEventListener('pointerdown', stopPointer); root.removeEventListener('focusin', focusIn); root.replaceChildren(); },
  };
}
