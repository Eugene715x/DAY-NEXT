#!/usr/bin/env node
/** Acquire a source extract and rebuild the checked-in Beatty map reproducibly. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as http from 'node:http';
import { parseOSM, convertOSM, validateBbox } from './lib/osm-converter.mjs';

export const BEATTY_BBOX = [-116.86, 36.86, -116.73, 36.94];
export const MAX_EXTRACT_BYTES = 80 * 1024 * 1024;
export const OSM_MAP_URL = `https://api.openstreetmap.org/api/0.6/map?bbox=${BEATTY_BBOX.join(',')}`;
export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// Only local ways are expanded to nodes. Country-wide route/boundary relations
// remain explicit partial metadata instead of pulling an unbounded database.
export const OVERPASS_QUERY = `[out:xml][timeout:120];way(36.86,-116.86,36.94,-116.73)->.ways;(.ways;node(w.ways);node(36.86,-116.86,36.94,-116.73);rel(36.86,-116.86,36.94,-116.73););out meta qt;`;
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));

class DownloadError extends Error {
  constructor(message, { retryable = false, status = null } = {}) {
    super(message); this.retryable = retryable; this.status = status;
  }
}

/** Bound the stream while reading; checking only after response.text() is too late. */
async function readBoundedResponse(response) {
  const advertised = Number(response.headers.get('content-length'));
  if (advertised > MAX_EXTRACT_BYTES) {
    await response.body?.cancel();
    throw new DownloadError('OSM extract exceeds the 80 MiB limit.');
  }
  if (!response.body) throw new DownloadError('OSM returned an empty response.');
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_EXTRACT_BYTES) throw new DownloadError('OSM extract exceeds the 80 MiB limit.');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

async function requestExtract(url, init, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init, signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'DAY-NEXT-map-refresh (https://github.com/Eugene715x/DAY-NEXT)', ...init.headers },
    });
  } catch (error) {
    const timeout = ['AbortError', 'TimeoutError'].includes(error.name);
    throw new DownloadError(timeout ? `OSM request timed out at ${new URL(url).hostname}.` : `Could not connect to ${new URL(url).hostname}. Check the environment's HTTPS egress permissions; no source files were changed.`, { retryable: timeout });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new DownloadError(`${new URL(url).hostname} returned HTTP ${response.status}.`, { status: response.status, retryable: response.status === 429 || response.status >= 500 });
  }
  const bytes = await readBoundedResponse(response);
  // A 200 response with a timeout <remark> is not a successful extract.
  validateSourceXML(bytes);
  return { bytes, responseDate: response.headers.get('date'), downloadedAt: new Date().toISOString() };
}

/** Primary: authoritative small-area /map API. Fallback: Overpass on transient errors. */
export async function downloadFreshExtract({ fetchImpl = globalThis.fetch, timeoutMs = 150000, onFallback = () => {} } = {}) {
  try {
    return { ...await requestExtract(OSM_MAP_URL, {}, fetchImpl, timeoutMs), sourceUrl: OSM_MAP_URL, acquisition: 'osm-map-api' };
  } catch (error) {
    if (!error.retryable) throw error;
    onFallback(error.message);
    return { ...await requestExtract(OVERPASS_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ data: OVERPASS_QUERY }) }, fetchImpl, timeoutMs), sourceUrl: OVERPASS_URL, query: OVERPASS_QUERY, acquisition: 'overpass-api' };
  }
}

/** Never silently replace a map with an HTML error, truncated XML or broken ways. */
export function validateSourceXML(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!bytes.length || bytes.length > MAX_EXTRACT_BYTES) throw new Error('OSM source must contain 1 byte to 80 MiB.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  if (!/^(?:<\?xml[^?]*\?>\s*)?<osm\b[^>]*>/.test(text) || !/<\/osm>\s*$/.test(text)) throw new Error('Expected a complete OSM XML document with a closing </osm> tag.');
  if (/<(?:remark|error)\b/i.test(text)) throw new Error('OSM response contains a server error/timeout remark; refusing partial data.');
  const parsed = parseOSM(text);
  const ids = new Set(), nodes = new Set();
  for (const element of parsed.elements) {
    const key = `${element.type}-${element.id}`;
    if (ids.has(key)) throw new Error(`Duplicate source element: ${key}`);
    ids.add(key);
    if (element.type === 'node') {
      if (!Number.isFinite(element.lon) || !Number.isFinite(element.lat) || Math.abs(element.lon) > 180 || Math.abs(element.lat) > 90) throw new Error(`Invalid source coordinates: ${key}`);
      nodes.add(String(element.id));
    }
  }
  for (const type of ['node', 'way', 'relation']) {
    // parseOSM deliberately tolerates fragments for browser imports; this updater
    // requires every opening source element to have been parsed in its entirety.
    const openings = [...text.matchAll(new RegExp(`<${type}\\b`, 'g'))].length;
    if (openings !== parsed.elements.filter(element => element.type === type).length) throw new Error(`Malformed or truncated ${type} element in source XML.`);
  }
  for (const way of parsed.elements.filter(element => element.type === 'way')) {
    if (!way.nodes?.length || way.nodes.some(ref => !nodes.has(String(ref)))) throw new Error(`Incomplete way-${way.id}: all referenced coordinate nodes must be present.`);
  }
  return parsed;
}

/** Pure preparation: all validation/conversion finishes before any file is touched. */
export function prepareMapUpdate(input, { sourceUrl = 'https://www.openstreetmap.org', downloadedAt = null, importedAt = new Date().toISOString(), acquisition = 'local-file', responseDate = null, query, sourceFile } = {}) {
  const bytes = Buffer.from(input), parsed = validateSourceXML(bytes);
  const url = new URL(sourceUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Source provenance must be an HTTPS URL without credentials.');
  const timestamps = parsed.elements.map(element => element.timestamp).filter(Boolean).sort();
  const map = convertOSM(bytes.toString('utf8'), {
    bbox: validateBbox(BEATTY_BBOX), id: 'beatty-rhyolite', name: 'Битти / Райолит', region: 'Невада, США', country: 'US',
    dataUrl: sourceUrl, downloadedAt: downloadedAt || importedAt,
  });
  if (map.coverage.partialWays.length || map.coverage.omittedCounts.invalidCoordinate || map.coverage.representedSourceElements !== map.coverage.eligibleInBounds) throw new Error('Source geometry failed the conversion coverage audit.');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  Object.assign(map.source, { downloadedAt, importedAt, sha256, sourceFile: 'maps/source/beatty.osm', acquisition });
  const provenance = {
    provider: map.source.provider, copyright: map.source.copyright, license: map.source.license,
    licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/', attributionUrl: map.source.url,
    sourceUrl, acquisition, ...(query ? { query } : {}), ...(sourceFile ? { importedFile: basename(sourceFile) } : {}),
    downloadedAt, importedAt, responseDate, sha256, bytes: bytes.length,
    osmElementTimestampMin: timestamps[0] || null, osmElementTimestampMax: timestamps.at(-1) || null,
    selectedBbox: [...BEATTY_BBOX], selectedRegion: 'Beatty / Rhyolite, Nye County, Nevada, USA',
    counts: Object.fromEntries(['node', 'way', 'relation'].map(type => [type, parsed.elements.filter(element => element.type === type).length])),
    convertedCounts: map.statistics,
    notes: ['Exact source bytes are preserved alongside the generated map and SHA-256.', 'The timestamp range describes element edits; downloadedAt records the actual acquisition date.', 'Coverage is relative to this extract. OSM can lack real-world objects; missing relation members are never invented.'],
  };
  const coverage = {
    source: 'beatty.osm', snapshotAt: map.source.snapshotAt, downloadedAt, sha256, bbox: [...BEATTY_BBOX], ...map.coverage,
    notes: ['Coverage is relative to the exact source file and selected bounds, not a promise that every real-world structure has been surveyed.', 'Untagged vertices are coordinate geometry; partial relations retain known members and missing references.'],
  };
  return { bytes, map, provenance, coverage };
}

/** Stage all four outputs first, then replace; a failed acquisition leaves them intact. */
export async function writeMapUpdate(bundle, outputRoot = REPOSITORY_ROOT) {
  const files = [
    ['maps/source/beatty.osm', bundle.bytes],
    ['maps/source/beatty.provenance.json', JSON.stringify(bundle.provenance, null, 2) + '\n'],
    ['maps/source/coverage.json', JSON.stringify(bundle.coverage, null, 2) + '\n'],
    ['maps/usa.js', `export default ${JSON.stringify(bundle.map)};\n`],
  ];
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

const usage = `Refresh the bundled Beatty / Rhyolite source and map (OSM, ODbL).

node scripts/refresh-map.mjs
node scripts/refresh-map.mjs --input source.osm --source-url https://example.org/source.osm --downloaded-at 2026-10-20T00:00:00Z

Options:
  --input PATH          Import an existing complete OSM XML file without network
  --source-url HTTPS    Actual provenance URL for a local file
  --downloaded-at ISO   Actual acquisition time for a local file (otherwise unknown)
  --output-root PATH    Alternate repository/output root; default is this repository
  --help                Show help

The official OSM small-area API is primary. HTTP 429/5xx or a timeout uses
Overpass once; authorization and invalid/partial responses stop the update.
Raw XML, SHA-256 provenance, coverage and maps/usa.js are written only after
validation. Run npm test && npm run build afterwards. No API key is required.`;

export async function main(args = process.argv.slice(2)) {
  const options = {}, allowed = new Set(['input', 'source-url', 'downloaded-at', 'output-root']);
  for (let index = 0; index < args.length; index++) {
    if (['--help', '-h'].includes(args[index])) { console.log(usage); return; }
    const match = /^--([^=]+)(?:=(.*))?$/.exec(args[index]);
    if (!match || !allowed.has(match[1])) throw new Error(`Unknown argument: ${args[index]}`);
    const value = match[2] ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${match[1]}`);
    options[match[1]] = value;
  }
  if (!options.input && (options['source-url'] || options['downloaded-at'])) throw new Error('--source-url and --downloaded-at are for a local --input file only.');
  if (options['downloaded-at'] && !Number.isFinite(Date.parse(options['downloaded-at']))) throw new Error('--downloaded-at must be an ISO date/time.');
  const outputRoot = resolve(options['output-root'] || REPOSITORY_ROOT);
  let source;
  if (options.input) {
    source = { bytes: await readFile(resolve(options.input)), sourceUrl: options['source-url'] || 'https://www.openstreetmap.org', downloadedAt: options['downloaded-at'] || null, acquisition: 'local-file', sourceFile: options.input };
  } else {
    if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
      if (typeof http.setGlobalProxyFromEnv !== 'function') throw new Error('Downloads behind an HTTPS proxy require Node.js 24.5+; local --input works on Node.js 20+.');
      try { http.setGlobalProxyFromEnv(); } catch { throw new Error('Could not initialize the configured HTTPS proxy.'); }
    }
    console.log('Downloading the official OSM source for Beatty / Rhyolite…');
    source = await downloadFreshExtract({ onFallback: reason => console.log(`${reason} Trying the Overpass mirror once…`) });
  }
  const bundle = prepareMapUpdate(source.bytes, source);
  let previous = null;
  try {
    const text = await readFile(resolve(outputRoot, 'maps/usa.js'), 'utf8');
    previous = JSON.parse(text.replace(/^export default\s+/, '').replace(/;\s*$/, ''));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous?.source?.snapshotAt && bundle.map.source.snapshotAt < previous.source.snapshotAt) throw new Error('The source is older than the bundled map; refusing to downgrade.');
  await writeMapUpdate(bundle, outputRoot);
  console.log(`Buildings: ${previous?.buildings?.length ?? '—'} → ${bundle.map.buildings.length}; roads: ${bundle.map.roads.length}; details: ${bundle.map.details.length}.`);
  console.log(`Coverage ${bundle.coverage.representedSourceElements}/${bundle.coverage.eligibleInBounds}; partial relations: ${bundle.coverage.partialRelations.length}.`);
  console.log(`Source SHA-256 ${bundle.provenance.sha256}; newest element ${bundle.map.source.snapshotAt || 'unknown'}.`);
  console.log('Saved raw XML, provenance, coverage and maps/usa.js. Run npm test && npm run build to validate and package the game.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`Map refresh failed: ${error.message}`); process.exitCode = 1; });
}
