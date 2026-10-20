#!/usr/bin/env node
/** Acquire the complete mapped sand biome; never close a partial extract by hand. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as http from 'node:http';
import { convertOSM } from './lib/osm-converter.mjs';
import { BEATTY_BBOX, MAX_EXTRACT_BYTES, validateSourceXML } from './refresh-map.mjs';

export const SAND_RELATION_ID = '15569711';
export const SAND_SOURCE_URL = `https://api.openstreetmap.org/api/0.6/relation/${SAND_RELATION_ID}/full`;
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));

export async function downloadSandSource({ fetchImpl = globalThis.fetch, timeoutMs = 150000 } = {}) {
  let response;
  try {
    response = await fetchImpl(SAND_SOURCE_URL, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'DAY-NEXT-map-refresh (https://github.com/Eugene715x/DAY-NEXT)' },
    });
  } catch (error) {
    throw new Error(['AbortError', 'TimeoutError'].includes(error.name) ? 'Sand relation download timed out.' : 'Could not connect to the official OSM API; no sand source files were changed.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Official OSM sand relation returned HTTP ${response.status}; no source files were changed.`);
  }
  if (Number(response.headers.get('content-length')) > MAX_EXTRACT_BYTES) {
    await response.body?.cancel();
    throw new Error('Sand relation exceeds the 80 MiB limit.');
  }
  if (!response.body) throw new Error('OSM returned an empty sand relation response.');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_EXTRACT_BYTES) throw new Error('Sand relation exceeds the 80 MiB limit.');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return { bytes: Buffer.concat(chunks, size), downloadedAt: new Date().toISOString(), responseDate: response.headers.get('date') };
}

/** Validate references and topology before publishing the exact supplemental XML. */
export function prepareSandSupplement(input, { downloadedAt = null, importedAt = new Date().toISOString(), responseDate = null } = {}) {
  const bytes = Buffer.from(input), parsed = validateSourceXML(bytes);
  const relation = parsed.elements.find(element => element.type === 'relation' && String(element.id) === SAND_RELATION_ID);
  if (!relation || relation.tags.type !== 'multipolygon' || relation.tags.natural !== 'sand') throw new Error(`Expected the mapped sand multipolygon relation-${SAND_RELATION_ID}.`);
  const sourceIds = new Set(parsed.elements.map(element => `${element.type}-${element.id}`));
  if (!relation.members?.length || relation.members.some(member => member.type !== 'way' || !sourceIds.has(`way-${member.ref}`))) throw new Error('Sand supplement must include every outer and inner way member.');
  const map = convertOSM(parsed, { bbox: BEATTY_BBOX, downloadedAt: downloadedAt || importedAt });
  const polygons = map.details.filter(detail => detail.sourceId === `relation-${SAND_RELATION_ID}` && detail.geometry === 'polygon');
  const convertedRelation = map.relations.find(element => element.id === `relation-${SAND_RELATION_ID}`);
  if (!convertedRelation?.geometryComplete || !polygons.length || polygons.some(polygon => polygon.geometryIncomplete)) throw new Error('Sand relation has an open, ambiguous or incomplete ring; refusing an invented biome.');
  const timestamps = parsed.elements.map(element => element.timestamp).filter(Boolean).sort();
  const provenance = {
    provider: 'OpenStreetMap', copyright: '© OpenStreetMap contributors', license: 'ODbL-1.0',
    licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/', attributionUrl: 'https://www.openstreetmap.org/copyright',
    sourceUrl: SAND_SOURCE_URL, acquisition: 'osm-relation-full-api', relationId: `relation-${SAND_RELATION_ID}`,
    downloadedAt, importedAt, responseDate,
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    osmElementTimestampMin: timestamps[0] || null, osmElementTimestampMax: timestamps.at(-1) || null,
    counts: Object.fromEntries(['node', 'way', 'relation'].map(type => [type, parsed.elements.filter(element => element.type === type).length])),
    members: { outer: relation.members.filter(member => member.role !== 'inner').length, inner: relation.members.filter(member => member.role === 'inner').length },
    selectedBbox: [...BEATTY_BBOX],
    notes: ['Complete official relation with all outer and inner member ways and their nodes.', 'Original bytes and SHA-256 are preserved separately from the unchanged base extract.', 'Only complete source rings become biomes; clipping to the game bounds happens after assembly.'],
  };
  return { bytes, provenance };
}

export async function writeSandSupplement(bundle, outputRoot = REPOSITORY_ROOT) {
  const files = [['maps/source/beatty-sand.osm', bundle.bytes], ['maps/source/beatty-sand.provenance.json', JSON.stringify(bundle.provenance, null, 2) + '\n']];
  const staged = [];
  try {
    for (const [relative, data] of files) {
      const target = resolve(outputRoot, relative), temporary = `${target}.${randomUUID()}.tmp`;
      await mkdir(dirname(target), { recursive: true });
      staged.push({ target, temporary });
      await writeFile(temporary, data, { flag: 'wx' });
    }
    for (const { target, temporary } of staged) await rename(temporary, target);
  } finally { await Promise.all(staged.map(({ temporary }) => rm(temporary, { force: true }))); }
}

export async function main(args = process.argv.slice(2)) {
  let outputRoot = REPOSITORY_ROOT;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--output-root') throw new Error('Usage: node scripts/enrich-sand.mjs [--output-root PATH]');
    outputRoot = resolve(args[1]);
  }
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
    if (typeof http.setGlobalProxyFromEnv !== 'function') throw new Error('Downloads behind an HTTPS proxy require Node.js 24.5+.');
    http.setGlobalProxyFromEnv();
  }
  console.log(`Downloading full OSM sand relation ${SAND_RELATION_ID}…`);
  const source = await downloadSandSource(), bundle = prepareSandSupplement(source.bytes, source);
  await writeSandSupplement(bundle, outputRoot);
  console.log(`Saved ${bundle.provenance.bytes} bytes; ${bundle.provenance.members.outer} outer and ${bundle.provenance.members.inner} inner ways, SHA-256 ${bundle.provenance.sha256}.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`Sand enrichment failed: ${error.message}`); process.exitCode = 1; });
}
