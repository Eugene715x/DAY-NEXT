import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadFreshExtract, prepareMapUpdate, validateSourceXML, writeMapUpdate, OSM_MAP_URL, OVERPASS_URL, OVERPASS_QUERY, MAX_EXTRACT_BYTES } from '../scripts/refresh-map.mjs';

const timestamp = '2025-06-01T12:00:00Z';
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
<node id="1" lon="-116.80" lat="36.90" timestamp="${timestamp}"/>
<node id="2" lon="-116.7999" lat="36.90" timestamp="${timestamp}"/>
<node id="3" lon="-116.7999" lat="36.9001" timestamp="${timestamp}"/>
<node id="4" lon="-116.80" lat="36.9001" timestamp="${timestamp}"/>
<way id="10" timestamp="${timestamp}"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/><tag k="building" v="house"/></way>
<relation id="20" timestamp="${timestamp}"><member type="way" ref="10" role=""/><member type="way" ref="999" role=""/><tag k="type" v="route"/><tag k="route" v="hiking"/></relation>
</osm>\n`;

test('map refresh preserves exact source bytes, honest dates, checksum and coverage', () => {
  const bytes = Buffer.from(xml);
  const bundle = prepareMapUpdate(bytes, { sourceUrl: OSM_MAP_URL, downloadedAt: '2025-06-02T00:00:00Z', importedAt: '2025-06-03T00:00:00Z', acquisition: 'osm-map-api' });
  assert.deepEqual(bundle.bytes, bytes);
  assert.equal(bundle.provenance.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(bundle.provenance.osmElementTimestampMax, timestamp);
  assert.equal(bundle.provenance.downloadedAt, '2025-06-02T00:00:00Z');
  assert.equal(bundle.map.source.snapshotAt, timestamp);
  assert.equal(bundle.map.source.sha256, bundle.provenance.sha256);
  assert.equal(bundle.map.buildings.length, 1);
  assert.equal(bundle.map.buildings[0].sourceId, 'way-10');
  assert.equal(bundle.map.buildings[0].points.length, 5);
  assert.deepEqual(bundle.provenance.counts, { node: 4, way: 1, relation: 1 });
  assert.equal(bundle.coverage.representedSourceElements, bundle.coverage.eligibleInBounds);
  assert.deepEqual(bundle.coverage.partialRelations, [{ id: 'relation-20', available: 1, missing: 1, incomplete: 0 }]);
  assert.equal(prepareMapUpdate(bytes).provenance.downloadedAt, null, 'local import must not claim that its read time is the original acquisition time');
});

test('map refresh refuses server errors, duplicate elements and incomplete source geometry', () => {
  for (const bad of [
    '<html>Bad gateway</html>',
    xml.replace('</osm>', ''),
    xml.replace('</osm>', '<remark>runtime error: timeout</remark></osm>'),
    xml.replace('<nd ref="2"/>', '<nd ref="9999"/>'),
    xml.replace('</osm>', '<way id="30"><nd ref="1"/></osm>'),
    xml.replace('</osm>', '<node id="1" lon="-116.80" lat="36.90"/></osm>'),
    xml.replace('lon="-116.80"', 'lon="NaN"'),
  ]) assert.throws(() => validateSourceXML(bad));
  assert.throws(() => prepareMapUpdate(xml, { sourceUrl: 'http://example.org' }), /HTTPS/);
  assert.throws(() => prepareMapUpdate(xml, { sourceUrl: 'https://secret:password@example.org' }), /credentials/);
});

test('official OSM API is used first and successful source is not re-requested', async () => {
  const calls = [];
  const source = await downloadFreshExtract({ fetchImpl: async (url, init) => {
    calls.push([url, init]); return new Response(xml, { headers: { 'content-type': 'text/xml' } });
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], OSM_MAP_URL);
  assert.equal(source.acquisition, 'osm-map-api');
  assert.deepEqual(source.bytes, Buffer.from(xml));
  assert(Number.isFinite(Date.parse(source.downloadedAt)));
});

test('only transient errors use the documented Overpass fallback', async () => {
  const calls = [], fallback = [];
  const source = await downloadFreshExtract({
    fetchImpl: async (url, init) => { calls.push([url, init]); return calls.length === 1 ? new Response('unavailable', { status: 503 }) : new Response(xml); },
    onFallback: message => fallback.push(message),
  });
  assert.equal(calls.length, 2);
  assert.equal(fallback.length, 1);
  assert.equal(calls[1][0], OVERPASS_URL);
  assert.equal(calls[1][1].method, 'POST');
  assert.equal(calls[1][1].body.get('data'), OVERPASS_QUERY);
  assert.equal(source.query, OVERPASS_QUERY);
  assert.equal(source.acquisition, 'overpass-api');
  let deniedCalls = 0;
  await assert.rejects(downloadFreshExtract({ fetchImpl: async () => { deniedCalls++; return new Response('denied', { status: 403 }); } }), /403/);
  assert.equal(deniedCalls, 1, 'authorization failure must stop, rather than retry other destinations');
  let partialCalls = 0;
  await assert.rejects(downloadFreshExtract({ fetchImpl: async () => { partialCalls++; return new Response(xml.replace('</osm>', '')); } }), /complete/);
  assert.equal(partialCalls, 1, 'an invalid 200 response must not silently become a different source');
});

test('response size is checked before buffering an advertised oversized extract', async () => {
  await assert.rejects(downloadFreshExtract({ fetchImpl: async () => new Response(xml, { headers: { 'content-length': String(MAX_EXTRACT_BYTES + 1) } }) }), /80 MiB/);
});

test('published source, provenance and generated map all match a single validated bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'day-next-map-refresh-'));
  try {
    const bundle = prepareMapUpdate(xml, { sourceUrl: OSM_MAP_URL });
    await writeMapUpdate(bundle, root);
    assert.deepEqual(await readFile(join(root, 'maps/source/beatty.osm')), Buffer.from(xml));
    assert.deepEqual(JSON.parse(await readFile(join(root, 'maps/source/beatty.provenance.json'), 'utf8')), bundle.provenance);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'maps/source/coverage.json'), 'utf8')), bundle.coverage);
    const moduleText = await readFile(join(root, 'maps/usa.js'), 'utf8');
    assert.deepEqual(JSON.parse(moduleText.replace(/^export default /, '').trim().replace(/;$/, '')), bundle.map);
  } finally { await rm(root, { recursive: true, force: true }); }
});
