/**
 * terrain_cache.ts — Binary cache for pre-generated terrain buffers.
 *
 * File format (little-endian):
 *   Offset  Size   Field
 *   0       4      magic uint32 = 0x504D5856 ("VXMP")
 *   4       4      version uint32 = 1
 *   8       4      tileSize uint32
 *   12      4      zoneGridSize uint32
 *   16      4      reserved uint32 = 0
 *   20      tileSize*tileSize*4   heights Float32Array
 *   +       tileSize*tileSize*2   materials Uint16Array
 *   +       zoneGridSize*zoneGridSize*10  zone cells (1+1+4+4 bytes each)
 */

import type { ZoneGridData, ZoneCell } from "./zones.ts";
import { TILE_SIZE } from "./terrain.ts";
import { DEFAULT_TERRAIN_CONFIG } from "./terrain_config.ts";

const MAGIC = 0x504d5856; // "VXMP" little-endian
const VERSION = 1;
const HEADER_SIZE = 20;
const ZONE_CELL_BYTES = 10; // 1 (zoneType) + 1 (biomeId) + 4 (avgHeight f32) + 4 (corruption f32)

/**
 * Serialize terrain buffers and zone grid to a binary file.
 */
export async function saveTerrainCache(
  path: string,
  heightBuffer: Float32Array,
  materialBuffer: Uint16Array,
  zoneGrid: ZoneGridData,
): Promise<void> {
  const tileSize = TILE_SIZE;
  const zoneGridSize = zoneGrid.gridSize;
  const cellCount = tileSize * tileSize;
  const zoneCount = zoneGridSize * zoneGridSize;

  const totalBytes =
    HEADER_SIZE +
    cellCount * 4 + // Float32Array heights
    cellCount * 2 + // Uint16Array materials
    zoneCount * ZONE_CELL_BYTES;

  const buf = new ArrayBuffer(totalBytes);
  const view = new DataView(buf);

  // Header
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, tileSize, true);
  view.setUint32(12, zoneGridSize, true);
  view.setUint32(16, 0, true); // reserved

  // Heights — copy Float32Array
  let offset = HEADER_SIZE;
  new Float32Array(buf, offset, cellCount).set(heightBuffer);
  offset += cellCount * 4;

  // Materials — copy Uint16Array
  new Uint16Array(buf, offset, cellCount).set(materialBuffer);
  offset += cellCount * 2;

  // Zone cells
  for (let i = 0; i < zoneCount; i++) {
    const cell = zoneGrid.cells[i];
    view.setUint8(offset, cell.zoneType);
    view.setUint8(offset + 1, cell.biomeId);
    view.setFloat32(offset + 2, cell.avgHeight, true);
    view.setFloat32(offset + 6, cell.corruption, true);
    offset += ZONE_CELL_BYTES;
  }

  await Deno.writeFile(path, new Uint8Array(buf));
}

/**
 * Load terrain buffers and zone grid from a binary cache file.
 * Returns null if the file is absent or the header does not match
 * expected magic/version/tileSize values — caller should regenerate.
 */
export async function loadTerrainCache(path: string): Promise<{
  heightBuffer: Float32Array;
  materialBuffer: Uint16Array;
  zoneGrid: ZoneGridData;
} | null> {
  let raw: Uint8Array;
  try {
    raw = await Deno.readFile(path);
  } catch {
    // File does not exist — normal cold-start path
    return null;
  }

  // Copy into a fresh ArrayBuffer to guarantee byteOffset === 0
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const view = new DataView(buf);

  if (buf.byteLength < HEADER_SIZE) {
    console.warn(`[terrain_cache] ${path}: file too small to contain header`);
    return null;
  }

  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  const tileSize = view.getUint32(8, true);
  const zoneGridSize = view.getUint32(12, true);

  if (magic !== MAGIC) {
    console.warn(`[terrain_cache] ${path}: magic mismatch (got 0x${magic.toString(16).toUpperCase()})`);
    return null;
  }
  if (version !== VERSION) {
    console.warn(`[terrain_cache] ${path}: version mismatch (got ${version}, expected ${VERSION})`);
    return null;
  }
  if (tileSize !== TILE_SIZE) {
    console.warn(`[terrain_cache] ${path}: tileSize mismatch (got ${tileSize}, expected ${TILE_SIZE})`);
    return null;
  }

  const expectedZoneGridSize = DEFAULT_TERRAIN_CONFIG.zone.gridSize;
  if (zoneGridSize !== expectedZoneGridSize) {
    console.warn(
      `[terrain_cache] ${path}: zoneGridSize mismatch (got ${zoneGridSize}, expected ${expectedZoneGridSize})`,
    );
    return null;
  }

  const cellCount = tileSize * tileSize;
  const zoneCount = zoneGridSize * zoneGridSize;

  const expectedSize =
    HEADER_SIZE +
    cellCount * 4 +
    cellCount * 2 +
    zoneCount * ZONE_CELL_BYTES;

  if (buf.byteLength < expectedSize) {
    console.warn(`[terrain_cache] ${path}: file truncated (${buf.byteLength} < ${expectedSize})`);
    return null;
  }

  let offset = HEADER_SIZE;

  // Heights
  const heightBuffer = new Float32Array(buf, offset, cellCount);
  offset += cellCount * 4;

  // Materials
  const materialBuffer = new Uint16Array(buf, offset, cellCount);
  offset += cellCount * 2;

  // Zone cells
  const cells: ZoneCell[] = new Array(zoneCount);
  for (let i = 0; i < zoneCount; i++) {
    cells[i] = {
      zoneType: view.getUint8(offset),
      biomeId: view.getUint8(offset + 1),
      avgHeight: view.getFloat32(offset + 2, true),
      corruption: view.getFloat32(offset + 6, true),
    };
    offset += ZONE_CELL_BYTES;
  }

  return {
    heightBuffer,
    materialBuffer,
    zoneGrid: { gridSize: zoneGridSize, cells },
  };
}
