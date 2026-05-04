-- Phase 5: per-cell river segments live alongside biome + gates.
-- jsonb stays extensible — when later phases add roads, mountain spines,
-- or other linear features, they can either land here as additional
-- columns (when the system stabilises around a fixed schema) or fold
-- into a single extensible payload column (when it doesn't).
ALTER TABLE atlas_world_cells
  ADD COLUMN rivers jsonb NOT NULL DEFAULT '[]'::jsonb;
