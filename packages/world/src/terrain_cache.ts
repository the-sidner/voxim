/**
 * terrain_cache.ts — Binary cache for pre-generated terrain buffers.
 *
 * File format (little-endian):
 *   Offset  Size   Field
 *   0       4      magic uint32 = 0x504D5856 ("VXMP")
 *   4       4      version uint32 = 2
 *   8       4      tileSize uint32
 *   12      4      zoneGridSize uint32
 *   16      4      reserved uint32 = 0
 *   20      tileSize*tileSize*4   heights Float32Array
 *   +       tileSize*tileSize*2   materials Uint16Array
 *   +       for each zone cell: u8 zoneIdLen, zoneId bytes, u8 biomeIdLen,
 *           biomeId bytes, f32 avgHeight, f32 corruption
 *
 * Version 2: zoneId and biomeId are length-prefixed UTF-8 strings (previously
 * u8 numeric enum values). Biome + zone sets are now data-driven, so names
 * are the stable identifiers.
 */

import type { ZoneGridData, ZoneCell } from "./zones.ts";
import { TILE_SIZE } from "./terrain.ts";
import { DEFAULT_TERRAIN_CONFIG } from "./terrain_config.ts";

const MAGIC = 0x504d5856; // "VXMP" little-endian
const VERSION = 2;
const HEADER_SIZE = 20;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function zoneCellByteLength(cell: ZoneCell): number {
  const zoneBytes = TEXT_ENCODER.encode(cell.zoneId).byteLength;
  const biomeBytes = TEXT_ENCODER.encode(cell.biomeId).byteLength;
  // u8 len + bytes, u8 len + bytes, f32 avgHeight, f32 corruption
  return 1 + zoneBytes + 1 + biomeBytes + 4 + 4;
}

/** Serialize terrain buffers and zone grid to a binary file. */
export async function saveTerrainCache(
  path: string,
  heightBuffer: Float32Array,
  materialBuffer: Uint16Array,
  zoneGrid: ZoneGridData,
): Promise<void> {
  const tileSize = TILE_SIZE;
  const zoneGridSize = zoneGrid.gridSize;
  const cellCount = tileSize * tileSize;

  let zoneBytes = 0;
  for (const cell of zoneGrid.cells) zoneBytes += zoneCellByteLength(cell);

  const totalBytes =
    HEADER_SIZE +
    cellCount * 4 + // heights
    cellCount * 2 + // materials
    zoneBytes;

  const buf = new ArrayBuffer(totalBytes);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, tileSize, true);
  view.setUint32(12, zoneGridSize, true);
  view.setUint32(16, 0, true);

  let offset = HEADER_SIZE;
  new Float32Array(buf, offset, cellCount).set(heightBuffer);
  offset += cellCount * 4;

  new Uint16Array(buf, offset, cellCount).set(materialBuffer);
  offset += cellCount * 2;

  for (const cell of zoneGrid.cells) {
    const zoneIdBytes = TEXT_ENCODER.encode(cell.zoneId);
    const biomeIdBytes = TEXT_ENCODER.encode(cell.biomeId);
    view.setUint8(offset, zoneIdBytes.byteLength); offset += 1;
    u8.set(zoneIdBytes, offset); offset += zoneIdBytes.byteLength;
    view.setUint8(offset, biomeIdBytes.byteLength); offset += 1;
    u8.set(biomeIdBytes, offset); offset += biomeIdBytes.byteLength;
    view.setFloat32(offset, cell.avgHeight, true); offset += 4;
    view.setFloat32(offset, cell.corruption, true); offset += 4;
  }

  await Deno.writeFile(path, new Uint8Array(buf));
}

/** Load terrain buffers and zone grid from a binary cache file. */
export async function loadTerrainCache(path: string): Promise<{
  heightBuffer: Float32Array;
  materialBuffer: Uint16Array;
  zoneGrid: ZoneGridData;
} | null> {
  let raw: Uint8Array;
  try {
    raw = await Deno.readFile(path);
  } catch {
    return null;
  }

  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

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

  let offset = HEADER_SIZE;
  const heightBuffer = new Float32Array(buf, offset, cellCount);
  offset += cellCount * 4;
  const materialBuffer = new Uint16Array(buf, offset, cellCount);
  offset += cellCount * 2;

  const cells: ZoneCell[] = new Array(zoneCount);
  for (let i = 0; i < zoneCount; i++) {
    const zoneIdLen = view.getUint8(offset); offset += 1;
    const zoneId = TEXT_DECODER.decode(u8.subarray(offset, offset + zoneIdLen));
    offset += zoneIdLen;
    const biomeIdLen = view.getUint8(offset); offset += 1;
    const biomeId = TEXT_DECODER.decode(u8.subarray(offset, offset + biomeIdLen));
    offset += biomeIdLen;
    const avgHeight = view.getFloat32(offset, true); offset += 4;
    const corruption = view.getFloat32(offset, true); offset += 4;
    cells[i] = { zoneId, biomeId, avgHeight, corruption };
  }

  return {
    heightBuffer,
    materialBuffer,
    zoneGrid: { gridSize: zoneGridSize, cells },
  };
}
