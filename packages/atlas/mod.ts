/**
 * @voxim/atlas — procedural level service.
 *
 * Owns world-map and tile-map generation end-to-end. Writes outputs into the
 * shared DB; tile-server reads them at boot and applies player edits on top.
 *
 * See DESIGN.md for the architectural plan and phased rollout.
 */
export { startAtlasServer } from "./src/server.ts";
export type { AtlasServerConfig } from "./src/server.ts";
