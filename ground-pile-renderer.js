// Screen-sized markers, anchored to the actual position of each outdoor cache.
export function createGroundPileRenderer() {
  let piles = [];
  const enabled = view => view.layers?.details !== false;
  function setPiles(next) { piles = structuredClone(next); }
  function pick(x, y, view) {
    if (!enabled(view)) return null;
    const radius = 17 / view.zoom;
    return piles.filter(pile => Math.hypot(pile.x - x, pile.y - y) <= radius)
      .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0] || null;
  }
  function draw(ctx, view) {
    if (!enabled(view)) return;
    for (const pile of piles) {
      const x = (pile.x - view.cameraX) * view.zoom + view.width / 2;
      const y = (pile.y - view.cameraY) * view.zoom + view.height / 2;
      if (x < -30 || y < -30 || x > view.width + 30 || y > view.height + 30) continue;
      const hovered = pile.id === view.hoveredId;
      ctx.save(); ctx.translate(pile.x, pile.y); ctx.scale(1 / view.zoom, 1 / view.zoom);
      ctx.beginPath(); ctx.arc(0, 0, hovered ? 17 : 15, 0, Math.PI * 2);
      ctx.fillStyle = '#26372fee'; ctx.fill(); ctx.strokeStyle = hovered ? '#f4e9bd' : '#c8ba8c'; ctx.lineWidth = hovered ? 2 : 1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.strokeStyle = '#b9ba8b33'; ctx.lineWidth = 1; ctx.stroke();
      pile.preview.forEach((item, index) => {
        const count = pile.preview.length, px = count === 1 ? 0 : index === 0 ? -5 : 5;
        const py = count === 3 ? index === 2 ? 5 : -4 : 0;
        ctx.fillStyle = item.color; ctx.strokeStyle = '#17291e'; ctx.lineWidth = 1;
        ctx.beginPath();
        if (item.shape === 'cube') ctx.rect(px - 3.5, py - 3.5, 7, 7);
        else ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#ffffff66'; ctx.fillRect(px - 2, py - 2, 2, 1.5);
      });
      ctx.restore();
    }
  }
  return { setPiles, pick, draw };
}
