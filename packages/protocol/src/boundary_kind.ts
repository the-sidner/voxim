/**
 * Boundary-kind wire vocabulary.
 *
 * Atlas assigns every closed pixel (openMask = 0) a boundary-kind id
 * describing what kind of obstacle it is (stone wall, forest wall, water,
 * grassy berm, …); open pixels get `open`. KindGrid ships these ids on the
 * wire (see @voxim/codecs's components.ts), so — like ComponentType — this
 * is wire vocabulary, not an atlas-internal implementation detail. Atlas
 * remains the canonical *definer* (packages/atlas/src/tilemap/pipeline/
 * boundary_kinds.ts re-exports these), but the numeric ids themselves live
 * here so every consumer (client, tile-server) reads one shared source
 * instead of mirroring bare literals.
 *
 * RULE: ids are wire format — never reassign or reuse an id.
 */
export const BoundaryKind = {
  open: 0,
  stone: 1,
  forest: 2,
  water: 3,
  grassMound: 4,
} as const;
