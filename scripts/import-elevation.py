#!/usr/bin/env python3
"""Acquire a small USGS 3DEP grid, retaining the original GeoTIFF and provenance.

Authoring only: Python 3.12, numpy and rasterio. The game has no Python or
network dependency. GitHub Actions installs the pinned authoring packages.
Run --rebuild to recreate the game grid from preserved source bytes offline.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sys
import tempfile
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

SERVICE = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer"
BBOX = [-116.86, 36.86, -116.73, 36.94]
ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "maps/source/beatty-elevation.tif"
PROVENANCE = ROOT / "maps/source/beatty-elevation.provenance.json"
SERVICE_METADATA = ROOT / "maps/source/beatty-elevation.service.json"
EXPORT_METADATA = ROOT / "maps/source/beatty-elevation.export.json"
OUTPUT = ROOT / "maps/beatty-elevation.js"


def compact(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def request_bytes(url, timeout=90):
    error = None
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers={"User-Agent": "DAY-NEXT-elevation-import/0.15 (public USGS terrain preview)"}), timeout=timeout) as response:
                return response.read(), dict(response.headers), response.url
        except Exception as exc:
            error = exc
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"Download failed for {url}: {error}") from error


def request_json(url):
    raw, headers, final_url = request_bytes(url)
    result = json.loads(raw)
    if "error" in result:
        raise RuntimeError(f"USGS service error: {compact(result['error'])}")
    return result, raw, headers, final_url


def parameters(bbox, columns, rows):
    west, south, east, north = bbox
    dx, dy = (east - west) / (columns - 1), (north - south) / (rows - 1)
    # ArcGIS export bounds describe pixel EDGES. Expanding by half a cell puts
    # the first and last pixel CENTRES exactly on our world bbox endpoints.
    image_bounds = [west - dx / 2, south - dy / 2, east + dx / 2, north + dy / 2]
    return {
        "f": "json", "bbox": ",".join(format(v, ".15g") for v in image_bounds),
        "bboxSR": "4326", "imageSR": "4326", "size": f"{columns},{rows}",
        "format": "tiff", "pixelType": "F32", "noData": "-9999",
        "noDataInterpretation": "esriNoDataMatchAny", "adjustAspectRatio": "false",
        "interpolation": "RSP_BilinearInterpolation",
        "renderingRule": compact({"rasterFunction": "None"}),
    }


def grid_from_tiff(raw, bbox, columns, rows):
    import numpy as np
    import rasterio
    from rasterio.io import MemoryFile
    from rasterio.transform import xy

    with MemoryFile(raw) as memory:
        with memory.open() as dataset:
            if dataset.count != 1 or dataset.width != columns or dataset.height != rows:
                raise ValueError(f"Unexpected source raster dimensions/bands: {dataset.width}x{dataset.height}, {dataset.count} bands")
            if dataset.dtypes[0] not in ("float32", "float64"):
                raise ValueError(f"Expected unstyled floating-point elevations, got {dataset.dtypes[0]}")
            if dataset.crs is None or dataset.crs.to_epsg() != 4326:
                raise ValueError(f"Expected the requested geographic WGS84 grid, got {dataset.crs}")
            if dataset.transform.a <= 0 or dataset.transform.e >= 0 or dataset.transform.b or dataset.transform.d:
                raise ValueError("Expected north-to-south rows and west-to-east columns without raster rotation")
            west, south, east, north = bbox
            nw = xy(dataset.transform, 0, 0, offset="center")
            se = xy(dataset.transform, rows - 1, columns - 1, offset="center")
            actual = [nw[0], se[1], se[0], nw[1]]
            if any(abs(a - b) > 1e-7 for a, b in zip(actual, bbox)):
                raise ValueError(f"Export sample centres do not match requested bbox: {actual} vs {bbox}")
            raster = dataset.read(1, masked=True)
            valid = ~np.ma.getmaskarray(raster) & np.isfinite(raster.filled(float("nan")))
            count = int(valid.sum())
            if count / (columns * rows) < 0.999:
                raise ValueError(f"Incomplete USGS elevation coverage: {count}/{columns * rows} samples")
            heights = np.asarray(raster.data, dtype=float)
            if not count or float(heights[valid].min()) < -12000 or float(heights[valid].max()) > 12000:
                raise ValueError("DEM values outside physical elevation bounds; refusing a rendered color image as terrain")
            if bbox == BBOX and (float(heights[valid].min()) < 500 or float(heights[valid].max()) > 4000 or float(heights[valid].max() - heights[valid].min()) < 30):
                raise ValueError("Implausible Beatty terrain range; refusing a styled image or flat server fallback")
            # 0.1 m is storage rounding, NOT a claim of vertical measurement accuracy.
            values = [None if not good else (int(v) if float(v).is_integer() else float(v)) for v, good in zip(np.round(heights, 1).flat, valid.flat)]
            stats = {"minimumMeters": round(float(heights[valid].min()), 3), "maximumMeters": round(float(heights[valid].max()), 3), "meanMeters": round(float(heights[valid].mean()), 3), "validSamples": count, "noDataSamples": columns * rows - count}
            raster_info = {"crs": dataset.crs.to_string(), "transform": list(dataset.transform)[:6], "nodata": dataset.nodata, "dataType": dataset.dtypes[0], "bands": dataset.count, "width": dataset.width, "height": dataset.height, "tags": dataset.tags(), "northWestSample": list(nw), "southEastSample": list(se)}
            return values, stats, raster_info


def write_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))
    temp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rebuild", action="store_true", help="Use preserved GeoTIFF and metadata without network access")
    parser.add_argument("--columns", type=int, default=769)
    parser.add_argument("--rows", type=int, default=593)
    args = parser.parse_args()
    if args.columns < 3 or args.rows < 3 or args.columns > 2049 or args.rows > 2049:
        raise ValueError("Grid dimensions must be 3..2049")
    if args.rebuild:
        provenance = json.loads(PROVENANCE.read_text())
        bbox = provenance["bbox"]
        columns, rows = provenance["columns"], provenance["rows"]
        raw = SOURCE.read_bytes()
        if hashlib.sha256(raw).hexdigest() != provenance["sha256"]:
            raise ValueError("Preserved source SHA-256 mismatch")
        service_metadata = json.loads(SERVICE_METADATA.read_text())
        export_metadata = json.loads(EXPORT_METADATA.read_text())
    else:
        bbox, columns, rows = BBOX, args.columns, args.rows
        service_metadata, service_raw, _, _ = request_json(SERVICE + "?f=json")
        params = parameters(bbox, columns, rows)
        export_url = SERVICE + "/exportImage?" + urlencode(params)
        export_metadata, export_raw, _, _ = request_json(export_url)
        href = export_metadata.get("href")
        if not href or not href.startswith("https://"):
            raise ValueError("USGS export did not return a secure GeoTIFF download URL")
        raw, headers, final_url = request_bytes(href)
        if len(raw) < 1000 or raw[:4] not in (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+"):
            raise ValueError("USGS response is not a GeoTIFF; refusing to overwrite the map")
        downloaded_at = datetime.now(timezone.utc).isoformat()
        provenance = {
            "version": 1, "provider": "USGS 3D Elevation Program (3DEP)",
            "serviceUrl": SERVICE, "exportRequestUrl": export_url, "exportParameters": params,
            "downloadUrl": final_url, "downloadedAt": downloaded_at,
            "sourceFile": "maps/source/beatty-elevation.tif", "sourceBytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(), "bbox": bbox, "columns": columns, "rows": rows,
            "units": "m", "rowOrder": "north-to-south", "samplePlacement": "bbox endpoints are sample centres; columns west-to-east",
            "sampling": "USGS service bilinear resampling; no local synthetic terrain or gap filling",
            "storageRoundingMeters": 0.1,
            "sourceResolution": "Dynamic USGS 3DEP service; native product resolution varies. The exported grid spacing is recorded separately.",
            "verticalDatum": None,
            "verticalDatumNote": "No vertical datum transformation performed. Service metadata and original GeoTIFF retained; an unreported vertical datum is not inferred.",
            "acquisitionDate": None, "acquisitionDateNote": "Download time is not the terrain survey date; the service mosaics source surveys.",
            "attribution": "Elevation: U.S. Geological Survey, 3D Elevation Program (3DEP).",
            "copyrightText": service_metadata.get("copyrightText", ""),
            "license": "USGS-authored U.S. elevation data are public domain; retain source attribution.",
            "licenseUrl": "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
            "responseHeaders": {k: v for k, v in headers.items() if k.lower() in ["content-type", "content-length", "last-modified", "etag"]},
        }
    values, stats, raster_info = grid_from_tiff(raw, bbox, columns, rows)
    midpoint = (bbox[1] + bbox[3]) / 2
    spacing = {"x": (bbox[2] - bbox[0]) * 111320 * math.cos(math.radians(midpoint)) / (columns - 1), "y": (bbox[3] - bbox[1]) * 111320 / (rows - 1)}
    provenance.update({"gridSpacingMetersApprox": {k: round(v, 3) for k, v in spacing.items()}, "statistics": stats, "raster": raster_info})
    source = {key: provenance[key] for key in ["provider", "serviceUrl", "downloadedAt", "sourceFile", "sha256", "attribution", "license", "licenseUrl", "verticalDatum", "sourceResolution", "gridSpacingMetersApprox", "storageRoundingMeters"]}
    result = {"format": "day-next-elevation", "version": 1, "id": "beatty-usgs-3dep", "bbox": bbox, "columns": columns, "rows": rows, "units": "m", "rowOrder": "north-to-south", "samplePlacement": "bbox-vertices", "values": values, "statistics": stats, "source": source}
    # All validation precedes writes. A failed download/transform cannot publish
    # a partial source, fake flat grid, server error page or silently shifted DEM.
    if not args.rebuild:
        write_atomic(SOURCE, raw)
        write_atomic(SERVICE_METADATA, service_raw)
        write_atomic(EXPORT_METADATA, export_raw)
    write_atomic(PROVENANCE, json.dumps(provenance, ensure_ascii=False, allow_nan=False, indent=2) + "\n")
    write_atomic(OUTPUT, "export default " + compact(result) + ";\n")
    print(f"USGS elevation: {columns}x{rows}; {stats['minimumMeters']}..{stats['maximumMeters']} m; {stats['noDataSamples']} missing samples")
    print(f"Original GeoTIFF: {len(raw)} bytes; SHA-256 {provenance['sha256']}")
    print(f"Game grid: {OUTPUT.relative_to(ROOT)}; approximate spacing {spacing['x']:.2f}x{spacing['y']:.2f} m")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Elevation import failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
