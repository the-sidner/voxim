/**
 * Behavior tree module — registry + built-in nodes + bulk tree builder.
 *
 * To add a new node type: implement `BTNodeFactory` in a file under
 * `nodes/`, and register it below.
 *
 * `buildAllBehaviorTrees` is called once at server startup to turn every
 * BehaviorTreeSpec in ContentStore into a ready-to-tick `BTNode`. Failure
 * fast on unknown node types or malformed specs.
 */
import { Registry } from "@voxim/engine";
import type { ContentStore } from "@voxim/content";
import { buildBehaviorTree } from "./behavior_tree.ts";
import type { BTNode, BTNodeFactory } from "./behavior_tree.ts";
import { sequenceNodeFactory } from "./nodes/sequence.ts";
import { selectorNodeFactory } from "./nodes/selector.ts";
import { checkHungerCriticalFactory } from "./nodes/check_hunger_critical.ts";
import { checkThirstCriticalFactory } from "./nodes/check_thirst_critical.ts";
import { checkHealthCriticalFactory } from "./nodes/check_health_critical.ts";
import { checkCurrentJobNotFactory } from "./nodes/check_current_job_not.ts";
import { checkQueueEmptyOrExpiredFactory } from "./nodes/check_queue_empty_or_expired.ts";
import { checkPlanExpiredFactory } from "./nodes/check_plan_expired.ts";
import { setJobSeekFoodFactory } from "./nodes/set_job_seek_food.ts";
import { setJobSeekWaterFactory } from "./nodes/set_job_seek_water.ts";
import { setJobFleeFromNearestFactory } from "./nodes/set_job_flee_from_nearest.ts";
import { setJobAttackNearestFactory } from "./nodes/set_job_attack_nearest.ts";
import { setJobDefaultFactory } from "./nodes/set_job_default.ts";
import { setJobCraftAtWorkbenchFactory } from "./nodes/set_job_craft_at_workbench.ts";

export type {
  BTNode, BTNodeFactory, BTContext, BTOutput, NodeResult,
} from "./behavior_tree.ts";
export { buildBehaviorTree } from "./behavior_tree.ts";

export function createBTNodeRegistry(): Registry<BTNodeFactory> {
  return new Registry<BTNodeFactory>();
}

/** Register all built-in BT node factories. */
export function registerBuiltinBTNodes(registry: Registry<BTNodeFactory>): void {
  registry.register(sequenceNodeFactory);
  registry.register(selectorNodeFactory);
  registry.register(checkHungerCriticalFactory);
  registry.register(checkThirstCriticalFactory);
  registry.register(checkHealthCriticalFactory);
  registry.register(checkCurrentJobNotFactory);
  registry.register(checkQueueEmptyOrExpiredFactory);
  registry.register(checkPlanExpiredFactory);
  registry.register(setJobSeekFoodFactory);
  registry.register(setJobSeekWaterFactory);
  registry.register(setJobFleeFromNearestFactory);
  registry.register(setJobAttackNearestFactory);
  registry.register(setJobDefaultFactory);
  registry.register(setJobCraftAtWorkbenchFactory);
}

/**
 * Build every BehaviorTreeSpec in the ContentStore into a BTNode.
 * Fails fast on malformed specs or unknown node types.
 */
export function buildAllBehaviorTrees(
  content: ContentStore,
  nodeRegistry: Registry<BTNodeFactory>,
): Map<string, BTNode> {
  const built = new Map<string, BTNode>();
  for (const spec of content.getAllBehaviorTrees()) {
    try {
      built.set(spec.id, buildBehaviorTree(spec.root, nodeRegistry));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to build behavior tree "${spec.id}": ${msg}`);
    }
  }
  return built;
}
