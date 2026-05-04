-- Worldgen tuning knobs persisted on the world row.
-- Each baked world stores the full GenParams object (jsonb) alongside its
-- seed/dims so re-bakes are reproducible and inspector tooling can show
-- what parameters produced what world.
--
-- Existing rows (the bootstrap world from migration 0011) get '{}' which
-- the loader merges over DEFAULT_GEN_PARAMS — so they continue working
-- exactly as before this migration landed.
ALTER TABLE worlds
  ADD COLUMN params jsonb NOT NULL DEFAULT '{}'::jsonb;
