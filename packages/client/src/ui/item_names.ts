/**
 * Turn a content id ("iron_sword", "chopping_block") into a human label
 * ("Iron Sword", "Chopping Block") for the UI. A stopgap until content ships
 * per-item display names / icons — the single place that rule lives.
 */
export function humanizeItemType(id: string): string {
  return id
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
