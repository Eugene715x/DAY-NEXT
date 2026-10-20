#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import * as http from 'node:http';
import { convertOSM, validateBbox } from './lib/osm-converter.mjs';

const usage = `Convert a local OpenStreetMap area into a DAY NEXT map.

node scripts/import-osm.mjs --input source.osm --bbox west,south,east,north --output maps/region.json --id region --name "Region"
node scripts/import-osm.mjs --bbox=-121.87,47.49,-121.75,47.56 --output maps/snoqualmie.json --id snoqualmie --name "Snoqualmie Valley" --region "Washington" --country "US"

Options:
  --input PATH       Overpass JSON or OSM XML; omit to download from Overpass
  --bbox W,S,E,N     Required local bounds, maximum 400 km² and 60 km per side
  --output PATH      Required destination JSON (or .js/.mjs for ES module)
  --id ID            Stable map ID
  --name NAME        Display title
  --region NAME     Region metadata
  --country NAME    Country metadata
  --url URL         Provenance URL for local input
  --endpoint URL    HTTPS Overpass endpoint (default: https://overpass-api.de/api/interpreter)
  --help            Show these instructions

No Google tiles, API keys, external libraries or disabled TLS verification. Keep OSM attribution when distributing converted maps.`;

async function main() {
  const args = process.argv.slice(2), options = {};
  const allowed = new Set(['input', 'bbox', 'output', 'id', 'name', 'region', 'country', 'url', 'endpoint']);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') { console.log(usage); return; }
    if (!args[i].startsWith('--')) throw new Error(`Unknown argument: ${args[i]}`);
    const [key, ...inline] = args[i].slice(2).split('=');
    if (!allowed.has(key)) throw new Error(`Unknown option: --${key}`);
    const value = inline.length ? inline.join('=') : args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = value;
  }
  if (!options.bbox || !options.output) throw new Error('--bbox and --output are required. Use --help for examples.');
  const bbox = validateBbox(options.bbox);
  let input, dataUrl, downloadedAt = new Date().toISOString();
  if (options.input) {
    input = await readFile(resolve(options.input), 'utf8');
    dataUrl = options.url || 'https://www.openstreetmap.org';
  } else {
    if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
      if (typeof http.setGlobalProxyFromEnv !== 'function') throw new Error('Automatic downloads behind an HTTPS proxy require Node.js 24.5 or newer. Local --input imports work on Node.js 20+.');
      try { http.setGlobalProxyFromEnv(); } catch { throw new Error('The configured HTTPS proxy could not be initialized. Check environment network settings.'); }
    }
    const endpoint = new URL(options.endpoint || 'https://overpass-api.de/api/interpreter');
    if (endpoint.protocol !== 'https:') throw new Error('Overpass endpoint must use HTTPS');
    const [west, south, east, north] = bbox;
    const area = `${south},${west},${north},${east}`;
    // Retrieve the local OSM data model instead of a lossy list of preferred tags.
    // Bounded geometry keeps continent-sized boundary/route relations from bloating a local map.
    const query = `[out:json][timeout:80];node(${area});out body;way(${area});out body geom;rel(${area});out body geom(${area});`;
    console.log(`Downloading local OSM extract from ${endpoint.hostname}…`);
    let response;
    try {
      response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'DAY-NEXT-map-import/0.3 (OpenStreetMap game prototype)' }, body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(100000) });
    } catch {
      throw new Error(`Could not reach ${endpoint.hostname} through the current network settings. Use a local --input extract or enable that destination in environment settings.`);
    }
    if (!response.ok) throw new Error(`Overpass returned HTTP ${response.status}. Download an .osm extract and use --input, or retry after the service is available.`);
    input = await response.text();
    if (Buffer.byteLength(input) > 80 * 1024 * 1024) throw new Error('Extract exceeds 80 MiB. Choose a smaller bbox.');
    dataUrl = endpoint.toString();
  }
  const map = convertOSM(input, { bbox, id: options.id, name: options.name, region: options.region, country: options.country, dataUrl, downloadedAt });
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  const json = JSON.stringify(map);
  await writeFile(output, /\.(?:mjs|js)$/i.test(output) ? `export default ${json};\n` : json + '\n');
  console.log(`Saved ${output}`);
  console.log(`${map.width}×${map.height}, ${map.metersPerUnit.toFixed(3)} m/unit; ${map.roads.length} roads, ${map.rivers.length} waterways, ${map.areas.length} land/water polygons, ${map.buildings.length} buildings, ${map.details.length} detail features, ${map.pois.length} places.`);
  console.log(`${map.source.copyright} · ${map.source.license} · ${map.source.url}`);
}

main().catch(error => { console.error(`Map import failed: ${error.message}`); process.exitCode = 1; });
