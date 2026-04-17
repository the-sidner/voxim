/**
 * Selector (fallback) — runs children left-to-right. Succeeds on first
 * child success; fails only if every child fails.
 */
import type { BTNode, BTNodeFactory, BTContext, BTOutput, NodeResult } from "../behavior_tree.ts";

export const selectorNodeFactory: BTNodeFactory = {
  id: "selector",
  build(spec: unknown, buildChild: (c: unknown) => BTNode): BTNode {
    const children = (spec as { children?: unknown }).children;
    if (!Array.isArray(children)) {
      throw new Error(`selector: "children" must be an array, got ${typeof children}`);
    }
    const built = children.map(buildChild);
    return new SelectorNode(built);
  },
};

class SelectorNode implements BTNode {
  constructor(private readonly children: BTNode[]) {}
  tick(ctx: BTContext, out: BTOutput): NodeResult {
    for (const child of this.children) {
      if (child.tick(ctx, out) === "success") return "success";
    }
    return "failure";
  }
}
