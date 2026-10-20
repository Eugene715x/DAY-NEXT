import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertOSM, mergeOSMSources, parseOSM } from '../scripts/lib/osm-converter.mjs';
import { downloadSandSource, prepareSandSupplement, SAND_SOURCE_URL, writeSandSupplement } from '../scripts/enrich-sand.mjs';
import { BEATTY_BBOX, loadLocalSandSupplement, main as refreshMap, prepareMapUpdate, writeMapUpdate } from '../scripts/refresh-map.mjs';

const coordinates = [
  [-116.88, 36.84], [-116.71, 36.84], [-116.71, 36.90], [-116.88, 36.90],
  [-116.80, 36.87], [-116.79, 36.87], [-116.79, 36.88], [-116.80, 36.88],
  [-116.87, 36.88], [-116.85, 36.88], [-116.85, 36.89], [-116.87, 36.89],
];
const nodes = coordinates.map(([lon, lat], index) => ({ type: 'node', id: String(index + 1), lon, lat, version: 1, timestamp: '2026-01-01T00:00:00Z', tags: {} }));
const ways = [
  { type: 'way', id: '101', nodes: ['1', '2', '3'], tags: {} },
  { type: 'way', id: '102', nodes: ['3', '4'], tags: {} },
  { type: 'way', id: '103', nodes: ['1', '4'], tags: {} }, // Deliberately reversed.
  { type: 'way', id: '104', nodes: ['5', '6', '7', '8', '5'], tags: {} },
  { type: 'way', id: '105', nodes: ['9', '10', '11', '12', '9'], tags: {} },
];
const relation = { type: 'relation', id: '15569711', tags: { type: 'multipolygon', natural: 'sand' }, members: ways.map((way, index) => ({ type: 'way', ref: way.id, role: index < 3 ? 'outer' : 'inner' })) };
const fixture = (omit = []) => ({ elements: [...nodes, ...ways.filter(way => !omit.includes(way.id)), relation] });
const toXML = ({ elements }) => `<osm version="0.6">${elements.map(element => {
  const tags = Object.entries(element.tags).map(([k, v]) => `<tag k="${k}" v="${v}"/>`).join('');
  const metadata = `id="${element.id}"${element.version ? ` version="${element.version}"` : ''}${element.timestamp ? ` timestamp="${element.timestamp}"` : ''}`;
  if (element.type === 'node') return `<node ${metadata} lon="${element.lon}" lat="${element.lat}">${tags}</node>`;
  if (element.type === 'way') return `<way ${metadata}>${element.nodes.map(ref => `<nd ref="${ref}"/>`).join('')}${tags}</way>`;
  return `<relation ${metadata}>${element.members.map(member => `<member type="${member.type}" ref="${member.ref}" role="${member.role}"/>`).join('')}${tags}</relation>`;
}).join('')}</osm>`;
const options = { bbox: BEATTY_BBOX, downloadedAt: '2026-10-20T00:00:00Z' };
const sandFeatures = map => map.details.filter(feature => feature.sourceId === 'relation-15569711');

test('complete split sand boundary is assembled before clipping and keeps inner holes', () => {
  const map = convertOSM(fixture(), options), features = sandFeatures(map);
  assert.equal(features.length, 1);
  assert.equal(features[0].geometry, 'polygon');
  assert.equal(features[0].kind, 'sand');
  assert.equal(features[0].rings.length, 3, 'Both the internal hole and the hole crossing the map edge must survive.');
  for (const ring of features[0].rings) {
    assert.deepEqual(ring[0], ring.at(-1));
    assert(ring.every(point => point.x >= 0 && point.x <= map.width && point.y >= 0 && point.y <= map.height));
  }
  assert(features[0].rings[0].some(point => point.x === 0));
  assert.equal(map.relations[0].geometryComplete, true);
  assert.equal(map.coverage.partialRelations.length, 0);
});

test('settlement boundary outlines clip real source segments without stroking the polygon frame', () => {
  const source = fixture();
  source.elements = source.elements.map(element => element.type === 'relation' ? {
    ...element, tags: { type: 'boundary', boundary: 'administrative', name: 'Town' }, members: element.members.filter(member => member.role === 'outer'),
  } : element);
  const map = convertOSM(source, options), boundary = map.details.find(feature => feature.tags.boundary);
  assert.equal(boundary.geometry, 'polygon', 'Preserve complete source area geometry for provenance.');
  assert.equal(boundary.boundaryPaths.length, 1, 'Only the top source edge crosses the selected bounds.');
  assert.equal(boundary.boundaryPaths[0].length, 2);
  assert.equal(boundary.boundaryPaths[0][0].y, boundary.boundaryPaths[0][1].y);
  assert.equal(boundary.boundaryPaths[0][0].x, 3000);
  assert.equal(boundary.boundaryPaths[0][1].x, 0);
  assert(boundary.points.length > boundary.boundaryPaths[0].length, 'Fill clipping retains frame edges that the outline excludes.');
});

test('a missing sand outer or inner member cannot produce a filled biome', () => {
  for (const missing of ['103', '105']) {
    const map = convertOSM(fixture([missing]), options), features = sandFeatures(map);
    assert(features.length > 0, 'Retain the available mapped boundary fragments.');
    assert(features.every(feature => feature.geometry === 'line' && feature.geometryIncomplete));
    assert.equal(map.relations[0].geometryComplete, false);
    assert.deepEqual(map.relations[0].missingMemberIds, [`way-${missing}`]);
    assert.throws(() => prepareSandSupplement(toXML(fixture([missing]))), /every outer and inner/);
  }
});

test('a known but open sand ring is not artificially closed by map clipping', () => {
  const source = fixture();
  source.elements = source.elements.map(element => element.id === '103' ? { ...element, nodes: ['1', '5'] } : element);
  const map = convertOSM(source, options);
  assert(sandFeatures(map).every(feature => feature.geometry === 'line'));
  assert.throws(() => prepareSandSupplement(toXML(source)), /open, ambiguous or incomplete ring/);
});

test('source merging deduplicates OSM identities, uses newer versions and preserves input data', () => {
  const original = { elements: [{ ...nodes[0], tags: { name: 'Original' }, version: 4 }] };
  const before = JSON.stringify(original);
  const newer = { ...nodes[0], version: 5, tags: { name: 'Newer' } };
  const merged = mergeOSMSources(original, { elements: [{ ...nodes[0], version: 3 }, newer, nodes[1]] });
  assert.equal(merged.elements.length, 2);
  assert.equal(merged.elements[0].tags.name, 'Newer');
  assert.equal(JSON.stringify(original), before);
  assert.equal(parseOSM(toXML(original)).elements[0].version, 4);
  assert.throws(() => mergeOSMSources(), /At least one/);
});

test('sand acquisition is restricted to the official full-relation endpoint and bounded before decoding', async () => {
  const xml = toXML(fixture());
  const result = await downloadSandSource({ fetchImpl: async (url, init) => {
    assert.equal(url, SAND_SOURCE_URL);
    assert(init.signal instanceof AbortSignal);
    return new Response(xml, { headers: { date: 'Tue, 20 Oct 2026 20:00:00 GMT' } });
  } });
  assert.deepEqual(result.bytes, Buffer.from(xml));
  assert.equal(result.responseDate, 'Tue, 20 Oct 2026 20:00:00 GMT');
  await assert.rejects(downloadSandSource({ fetchImpl: async () => new Response('blocked', { status: 403 }) }), /HTTP 403/);
  await assert.rejects(downloadSandSource({ fetchImpl: async () => new Response('too much', { headers: { 'content-length': String(81 * 1024 * 1024) } }) }), /80 MiB/);
  await assert.rejects(downloadSandSource({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(81 * 1024 * 1024)); controller.close(); } })) }), /80 MiB/);
});

test('supplement fills the source gap with exact provenance while a rebuild preserves base bytes and date', async () => {
  const root = await mkdtemp(join(tmpdir(), 'day-next-sand-'));
  try {
    const baseBytes = Buffer.from(toXML(fixture(['103', '105']))), supplementalBytes = Buffer.from(toXML(fixture()));
    const baseOptions = { sourceUrl: 'https://api.openstreetmap.org/api/0.6/map?bbox=-116.86,36.86,-116.73,36.94', acquisition: 'osm-map-api', downloadedAt: '2026-10-01T12:30:00Z', importedAt: '2026-10-01T12:31:00Z' };
    const base = prepareMapUpdate(baseBytes, baseOptions);
    await writeMapUpdate(base, root);
    assert.equal(await loadLocalSandSupplement(root), null);
    const supplement = prepareSandSupplement(supplementalBytes, { downloadedAt: '2026-10-20T20:00:00Z' });
    await writeSandSupplement(supplement, root);
    const loaded = await loadLocalSandSupplement(root);
    const combined = prepareMapUpdate(baseBytes, { ...baseOptions, supplements: [loaded] });
    assert.equal(sandFeatures(combined.map).filter(feature => feature.geometry === 'polygon').length, 1);
    assert.equal(combined.map.source.sha256, createHash('sha256').update(baseBytes).digest('hex'));
    assert.equal(combined.map.source.supplementalSources[0].sha256, supplement.provenance.sha256);
    assert.equal(combined.coverage.sources.length, 2);
    assert.equal(combined.coverage.partialRelations.length, 0);
    assert.throws(() => prepareMapUpdate(baseBytes, { supplements: [{ ...loaded, bytes: Buffer.from('<osm/>') }] }), /SHA-256/);
    await refreshMap(['--rebuild', '--output-root', root]);
    assert.deepEqual(await readFile(join(root, 'maps/source/beatty.osm')), baseBytes);
    assert.deepEqual(await readFile(join(root, 'maps/source/beatty-sand.osm')), supplementalBytes);
    const saved = JSON.parse(await readFile(join(root, 'maps/source/beatty.provenance.json'), 'utf8'));
    assert.equal(saved.sha256, base.provenance.sha256);
    assert.equal(saved.downloadedAt, baseOptions.downloadedAt);
    assert.equal(saved.acquisition, baseOptions.acquisition);
    const savedMapText = await readFile(join(root, 'maps/usa.js'), 'utf8');
    const savedMap = JSON.parse(savedMapText.replace(/^export default /, '').replace(/;\s*$/, ''));
    assert.equal(sandFeatures(savedMap)[0].rings.length, 3);
    await rm(join(root, 'maps/source/beatty-sand.provenance.json'));
    await assert.rejects(loadLocalSandSupplement(root), /source\/provenance pair/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
