/**
 * Closed-vocabulary read of a FIELD_NAME → [0,1] at one cell (T-311 P4). A
 * name→plane binding (not a switch on kind): the 9 u8 planes normalise by 255;
 * surfaceLevel (f32, NaN sentinel) maps present→1 / NaN→0 (never /255 — that
 * would poison the FieldExpr sum with NaN). Shared by every client FieldExpr
 * consumer (scatter density/morph, surface roughness) so the binding can't
 * drift per consumer.
 */
import type { VegFieldGridData, SurfaceStateGridData, WaterGridData } from "@voxim/codecs";

export function sampleField(
  field: string,
  veg: VegFieldGridData | null,
  surf: SurfaceStateGridData | null,
  water: WaterGridData | null,
  cellIdx: number,
): number {
  if (veg) {
    if (field === "canopyLight") return veg.canopyLight[cellIdx] / 255;
    if (field === "corruption") return veg.corruption[cellIdx] / 255;
    if (field === "fertility") return veg.fertility[cellIdx] / 255;
  }
  if (surf) {
    if (field === "wetness") return surf.wetness[cellIdx] / 255;
    if (field === "overgrowth") return surf.overgrowth[cellIdx] / 255;
    if (field === "wear") return surf.wear[cellIdx] / 255;
    if (field === "variantIndex") return surf.variantIndex[cellIdx] / 255;
    if (field === "ruinAge") return surf.ruinAge[cellIdx] / 255;
    if (field === "traffic") return surf.traffic[cellIdx] / 255;
  }
  if (field === "surfaceLevel") return water && !Number.isNaN(water.surfaceLevel[cellIdx]) ? 1 : 0;
  return 0;
}
