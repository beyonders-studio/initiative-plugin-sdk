/**
 * `initiative-plugin-sdk/manifest`: the contract as types, the plug-in's one
 * definition, checking a manifest before a deployment does, and the rule for
 * which plug-in API contract a manifest's `min_plugin_api` runs on.
 */

export * from "./contract.js";

export {
  definePlugin,
  defineEndpoint,
  type ActionDeclaration,
  type Actor,
  type AfterConnectAnswer,
  type AfterConnectCall,
  type PluginContext,
  type PluginDefinition,
  type Call,
  type CallableEndpoint,
  type CommunityHook,
  type CommunityStatusCall,
  type EntitlementCall,
  COMMUNITY_HOOKS,
  type DashboardDeclaration,
  type EmittedEndpoint,
  type EndpointCall,
  type EndpointDeclaration,
  type Handoff,
  type Hooks,
  type ItemRef,
  type ListingDeclaration,
  type Outcome,
  type PageCall,
  type PageDeclaration,
  type Params,
  type ParamSpec,
  type ParamValue,
  type Result,
  type ReturnSpec,
  type RevokeCall,
  type RuntimeDeclaration,
  type RuntimeFact,
  type ScheduleCall,
  type ScheduleDeclaration,
  type WebhookCall,
  type WidgetDeclaration,
} from "./define.js";

export {
  MANIFEST_PATH,
  manifestSchema,
  validateDocument,
  validateManifest,
  type PluginDocument,
  type ValidationProblem,
} from "./validate.js";

export { pluginApiCompatible } from "./plugin-api.js";

export type { Jwks, PublicJwk } from "./keys.js";
