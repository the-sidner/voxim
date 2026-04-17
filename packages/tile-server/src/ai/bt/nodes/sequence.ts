/**
 * Sequence — runs children left-to-right. Fails on first child failure;
 * succeeds when all children succeed.
 */
import type { BTNode, BTNodeFactory, BTContext, BTOutput, NodeResult } from "../behavior_tree.ts";

export const sequenceNodeFactory: BTNodeFactory = {
  id: "sequence",
  build(spec: unknown, buildChild: (c: unknown) => BTNode): BTNode {
    const children = (spec as { children?: unknown }).children;
    if (!Array.isArray(children)) {
      throw new Error(`sequence: "children" must be an array, got ${typeof children}`);
    }
    const built = children.map(buildChild);
    return new SequenceNode(built);
  },
};

class SequenceNode implements BTNode {
  constructor(private readonly children: BTNode[]) {}
  tick(ctx: BTContext, out: BTOutput): NodeResult {
    for (const child of this.children) {
      if (child.tick(ctx, out) === "failure") return "failure";
    }
    return "success";
  }
}
