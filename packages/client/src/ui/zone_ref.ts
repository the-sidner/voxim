/**
 * Per-player zone state (T-211).
 *
 * The local player's current zone is set from `ZoneEnteredEvent`
 * delivered in the binary state stream. UI components watch these
 * signals to render the "You are in: X" caption + react to traversal
 * class (path vs wilderness — wilderness might get a special icon or
 * subtle elevation badge).
 *
 * Empty `name` means the player is in a sub-threshold zone or
 * unzoned band; the UI should hide its caption in that case.
 */
import { signal } from "@preact/signals";

export const currentZoneName     = signal<string>("");
export const currentZoneRole     = signal<string>("");
export const currentZoneTraversal = signal<"path" | "wilderness">("path");
