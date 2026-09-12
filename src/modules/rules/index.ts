export { registerRulesRoutes } from "./rules.routes.js";
export {
  createRuleService,
  type RuleCreateResult,
  type RuleJobDispatcher,
  type RuleService,
  type RuleServiceDependencies,
} from "./rules.service.js";
export {
  createRulesRepository,
  rulesRepository,
  type RuleRepository,
  type RuleRow,
} from "./rules.repository.js";
export { matchRules } from "./categorization.js";
export type {
  RuleForMatching,
  TransactionForMatching,
} from "./categorization.js";
export { applyRuleRetroactively, ruleForMatching } from "./retroactive.js";
