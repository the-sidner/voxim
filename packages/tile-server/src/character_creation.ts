/**
 * Character creation (T-071) — resolve a fresh player's join-time selections
 * against bootstrapped content.
 *
 * The client carries the player's choices in the join handshake
 * (`TileJoinRequest.speciesId` / `initialFragmentIds`). Those are advisory:
 * a malicious or stale client must never be able to spawn an undefined species
 * or "learn" a fragment that doesn't exist. This module is the single
 * validation point — pure, so it unit-tests without a World / session.
 *
 *   - species: must be a key of `game_config.species`. Invalid / absent →
 *     the `game_config.player.species` default (itself "human" when unset).
 *   - fragments: filtered to ids the content store knows; duplicates dropped,
 *     order preserved. Absent → empty.
 */
import type { ContentService } from "@voxim/content";

export interface CharacterSelections {
  speciesId?: string;
  initialFragmentIds?: string[];
}

export interface ResolvedCharacter {
  speciesId: string;
  fragmentIds: string[];
}

export function resolveCharacterSelections(
  content: ContentService,
  sel: CharacterSelections | undefined,
): ResolvedCharacter {
  const cfg = content.getGameConfig();
  const defaultSpecies = cfg.player.species ?? "human";

  const requested = sel?.speciesId;
  const speciesId = requested && requested in cfg.species ? requested : defaultSpecies;

  const seen = new Set<string>();
  const fragmentIds: string[] = [];
  for (const id of sel?.initialFragmentIds ?? []) {
    if (seen.has(id) || !content.loreFragments.has(id)) continue;
    seen.add(id);
    fragmentIds.push(id);
  }

  return { speciesId, fragmentIds };
}
