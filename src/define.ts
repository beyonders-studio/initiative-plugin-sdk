/**
 * One typed definition of a plug-in.
 *
 * {@link definePlugin} takes everything a plug-in declares and does: its endpoints
 * with their handlers, its hooks and schedules, its widgets and pages, and
 * its listing. The same object routes Initiative's calls (`createPlugin`) and
 * becomes the manifest (`initiative-plugin build`), so nothing is stated twice.
 *
 * {@link defineEndpoint} types one endpoint from its own declaration: its
 * `params` type the handler's arguments and its `returns` type what the
 * handler answers with.
 *
 * A declarative plug-in gives each endpoint a `request` (or `steps`) and a `map`
 * in place of a handler, and names its `hosts`: Initiative then makes the
 * calls and maps the answers itself, and there is no service to run. One plug-in
 * is one kind or the other.
 *
 * Endpoints are named by their key. The manifest id is `plugin.<publicId>.<key>`,
 * and everywhere a definition refers to an endpoint (a widget, a sample, a
 * parameter's `options_from`, a bundled dashboard, `communitySummary`, an
 * action) it uses the key.
 */

import type {
  Action,
  ActorKind,
  PluginScope,
  BundledDashboard,
  BundledDashboardWidget,
  Connection,
  Page,
  Endpoint,
  EndpointParam,
  EndpointReturn,
  ErrorRule,
  Expression,
  Field,
  ItemKind,
  Manifest,
  Part,
  RequestStep,
  ReturnValueType,
  Scope,
  Vendor,
  VendorAuth,
  VendorRequest,
  WebhookEvent,
  Webhooks,
  Widget,
} from "./contract.js";
import { FEATURES } from "./contract.js";
import type { Client } from "./client.js";

/**
 * What every handler is handed as `context`: the value given to `createPlugin`.
 *
 * Empty until a plug-in says what it holds, by augmenting this interface:
 *
 * ```ts
 * declare module "initiative-plugin-sdk/manifest" {
 *   interface PluginContext { tracker: TrackerClient }
 * }
 * ```
 */
export interface PluginContext {}

/** One declared parameter, keyed by its name. */
export type ParamSpec = Omit<EndpointParam, "key">;

/** One declared return, keyed by its name: its type, or the whole declaration. */
export type ReturnSpec = ReturnValueType | Omit<EndpointReturn, "key">;

type Scalar<T> = T extends "int" ? number : T extends "bool" ? boolean : string;

type ReturnValue<S> = S extends ReturnValueType
  ? Scalar<S>
  : S extends { type: infer T; list: true }
    ? Array<Scalar<T>>
    : S extends { type: infer T }
      ? Scalar<T>
      : never;

/**
 * What an endpoint answers with: its declared returns, by name. A `list`
 * return is an array. Each may be left out or null; a key the endpoint does
 * not declare is refused.
 */
export type Result<R> = { [K in keyof R]?: ReturnValue<R[K]> | null };

/**
 * A parameter as a caller sent it. Initiative sends strings; an automation
 * may send numbers and booleans as they are.
 */
export type ParamValue = string | number | boolean;

/** The parameters a call carries, by their declared names. */
export type Params<P> = { [K in keyof P]?: P[K] extends { list: true } ? ParamValue[] : ParamValue };

/** Whose behalf a call is on: the community, or one of its members by this installation's reference for them. */
export type Actor = { kind: "installation" } | { kind: "member"; member: string };

/** One of Initiative's items, by its kind and id. */
export interface ItemRef {
  type: ItemKind;
  id: number;
}

/** What every handler is handed. */
export interface Call {
  /** The installation: the community, by the reference this plug-in's install knows it by. */
  installation: string;
  /** Initiative, acting as whoever the call is for. */
  client: Client;
  context: PluginContext;
}

export interface EndpointCall<P> extends Call {
  /** The endpoint's manifest id. */
  endpoint: string;
  params: Params<P>;
  /** Initiative's own calls, for a widget, are the community's. */
  actor: Actor;
  /** The plug-in that made this call through Initiative, by its public id, or null for Initiative's own. */
  caller: string | null;
  /** The initiative the call is confined to, when it is. */
  initiative: number | null;
  /** Connection id → the handle Initiative gives a token for, where the call depends on one. */
  connections: Record<string, string>;
  /** On a call one of the plug-in's actions made: the reader who ran it, by this installation's reference for them. */
  viewer: string | null;
  /** On a call one of the plug-in's actions made: the item it was run on. */
  subject: ItemRef | null;
}

/** What a handler answers with. `actor` says whose credential ran it; absent, the call's actor. */
export interface Outcome<R> {
  result: Result<R>;
  actor?: ActorKind;
}

type Described = Omit<Endpoint, "id" | "direction" | "params" | "returns" | "request" | "steps" | "map" | "errors">;

/** An endpoint Initiative calls: a `read`, or a `write` another plug-in calls through it. */
export interface CallableEndpoint<P, R, D extends "read" | "write" = "read" | "write"> extends Described {
  direction: D;
  params?: P;
  returns?: R;
  handler: (call: EndpointCall<P>) => Promise<Outcome<R>>;
}

/**
 * An endpoint a declarative plug-in answers without code: Initiative makes the
 * `request`, or each of the `steps` in order, and `map` turns the answer into
 * the endpoint's returns.
 */
export type DeclarativeEndpoint<P, R, D extends "read" | "write" = "read" | "write"> = Described & {
  direction: D;
  params?: P;
  returns?: R;
  map: Expression;
  errors?: ErrorRule[];
} & ({ request: VendorRequest; steps?: never } | { steps: RequestStep[]; request?: never });

/** An announcement the plug-in emits: declared, never called. */
export interface EmittedEndpoint<R> extends Described {
  direction: "emit";
  returns?: R;
}

export type EndpointDeclaration =
  | CallableEndpoint<any, any>
  | DeclarativeEndpoint<any, any>
  | EmittedEndpoint<any>;

/** One endpoint, typed from its own `params` and `returns`. */
export function defineEndpoint<const R extends Record<string, ReturnSpec> = {}>(
  endpoint: EmittedEndpoint<R>
): EmittedEndpoint<R>;
export function defineEndpoint<
  D extends "read" | "write",
  const P extends Record<string, ParamSpec> = {},
  const R extends Record<string, ReturnSpec> = {},
>(endpoint: CallableEndpoint<P, R, D>): CallableEndpoint<P, R, D>;
export function defineEndpoint<
  D extends "read" | "write",
  const P extends Record<string, ParamSpec> = {},
  const R extends Record<string, ReturnSpec> = {},
>(endpoint: DeclarativeEndpoint<P, R, D>): DeclarativeEndpoint<P, R, D>;
export function defineEndpoint(endpoint: EndpointDeclaration): EndpointDeclaration {
  return endpoint;
}

/** What `after_connect` is sent, once a connection's flow has exchanged its code. */
export interface AfterConnectCall extends Call {
  /** The connection's manifest id. */
  connection: string;
  /** `member` for a member's own account, `installation` for the community's. */
  actor: ActorKind;
  /** The access token the flow just obtained, to look the account up with. */
  access_token: string;
  /** The flow's parameters, such as the `installation_id` an install page returned. */
  params: Record<string, string>;
}

/** The connection's managed values and the account's label, or a refusal. */
export type AfterConnectAnswer =
  | { values?: Record<string, unknown>; account_label?: string }
  | { refuse: true };

/** What `revoke` is sent when a connection whose flow says `revoke: "hook"` ends. */
export interface RevokeCall extends Call {
  connection: string;
  access_token: string | null;
  refresh_token: string | null;
}

/** One vendor webhook delivery, which Initiative checked and routed to this installation. */
export interface WebhookCall extends Call {
  /** The static connection the delivery was routed by. */
  connection: string;
  /** The vendor's `x-` headers, lowercased. */
  headers: Record<string, string>;
  /** The body exactly as the vendor sent it. */
  body: string;
}

/** One due schedule, for one installation. */
export interface ScheduleCall extends Call {
  schedule: string;
  /** When this schedule last succeeded for the installation (ISO 8601), or null the first time. */
  since: string | null;
}

/** The hooks Initiative calls while it runs connections and receives the vendor's webhooks. */
export interface Hooks {
  after_connect?: (call: AfterConnectCall) => Promise<AfterConnectAnswer>;
  revoke?: (call: RevokeCall) => Promise<void>;
  webhook?: (call: WebhookCall) => Promise<void>;
}

export interface ScheduleDeclaration {
  /** A whole number of minutes (`15m`) or hours (`6h`). */
  every: `${number}${"m" | "h"}`;
  run: (call: ScheduleCall) => Promise<void>;
}

/** A member opening one of the plug-in's pages, as the handoff token names them. */
export interface Handoff extends Call {
  page: string;
  /** The member, by this installation's reference for them. */
  viewer: string;
  /** Whether the viewer administers the community. For shaping screens; not a grant. */
  admin: boolean;
  /** The initiative the page was opened in, or null for the whole community. */
  initiative: number | null;
}

export interface PageCall {
  request: Request;
  /** Null for a request that carries no handoff token, such as the page's own files. */
  handoff: Handoff | null;
}

/**
 * A page of the plug-in that Initiative frames. The page is the plug-in's own; a
 * request under its path that carries a handoff token reaches the handler with
 * the handoff verified.
 */
export interface PageDeclaration extends Omit<Page, "id"> {
  handler?: (call: PageCall) => Promise<Response>;
}

type ReadName<E> = {
  [K in keyof E]: E[K] extends { direction: "read" } ? K : never;
}[keyof E] &
  string;

type WriteName<E> = {
  [K in keyof E]: E[K] extends { direction: "write" } ? K : never;
}[keyof E] &
  string;

type EmitName<E> = {
  [K in keyof E]: E[K] extends { direction: "emit" } ? K : never;
}[keyof E] &
  string;

/** The vendor's webhooks. A declarative plug-in's events name the emit endpoint by its key. */
export type WebhooksDeclaration<E> = Omit<Webhooks, "events"> & {
  events?: Array<Omit<WebhookEvent, "emit"> & { emit: EmitName<E> }>;
};

type ReturnsOf<X> = X extends { returns?: infer R } ? NonNullable<R> : {};

/** A dashboard tile the plug-in contributes. `module` is the widget's source file. */
export interface WidgetDeclaration<E> extends Omit<Widget, "id" | "module_source" | "endpoints" | "sample_data"> {
  /** Read endpoints the widget may be bound to. */
  endpoints?: readonly ReadName<E>[];
  /**
   * The widget's TypeScript module, relative to the plug-in's package: it exports
   * `render(data)`. The build bundles it into the manifest's `module_source`.
   */
  module: string;
  /** What each endpoint would answer, for a preview with no network call. */
  sample_data?: { [K in ReadName<E>]?: Result<ReturnsOf<E[K]>> };
}

/** Something a reader runs on one item. `endpoint` names a write endpoint by its key. */
export interface ActionDeclaration<E> extends Omit<Action, "id" | "endpoint"> {
  endpoint: WriteName<E>;
}

export interface DashboardDeclaration<E, W> extends Omit<BundledDashboard, "widgets"> {
  widgets: Array<
    Omit<BundledDashboardWidget, "type" | "binding"> & {
      type: keyof W & string;
      binding: Omit<BundledDashboardWidget["binding"], "endpoint_id"> & { endpoint_id: ReadName<E> };
    }
  >;
}

/**
 * The plug-in's registry listing. `initiative-plugin build --registry <dir>` writes it
 * while `version` is the package's own version.
 */
export interface ListingDeclaration {
  /** The publisher's prefix, the part of the public id before the first dot. */
  publisher: string;
  /** One or two sentences for the listing's card. */
  summary: string;
  /** The listing page's longer text. Markdown. */
  description?: string;
  /** The listing's picture, relative to the plug-in's package. */
  avatar: string;
  /**
   * Screenshots for the listing page, in order: at most 12, each a PNG, JPEG,
   * WebP, GIF, AVIF or SVG file relative to the plug-in's package, with `alt`
   * text of 1 to 300 characters describing it for someone who cannot see it.
   * The registry signs each one, like the avatar. Only a registry listing
   * carries them; `pack` leaves them out.
   */
  images?: Array<{ path: string; alt: string }>;
  version: string;
  /** The oldest Initiative release this version runs on. */
  minAppVersion?: string;
  releaseNotes?: string;
  /**
   * A container plug-in's image for this version, pinned by digest. Every
   * deployment runs its own copy and gives the key it signs with, so a listing
   * names no keys. A declarative plug-in has none.
   */
  image?: string;
  /** The most the plug-in may ever be granted. Absent: its `scopes`. */
  scopeCeiling?: Array<Scope | PluginScope>;
  referenceSectors?: string[];
  /**
   * The Docker Compose service an operator copies to run the image beside
   * Initiative. `service` is the fragment, YAML text of at most 4096
   * characters. Initiative fills two placeholders when it shows it: `${IMAGE}`,
   * `image` above, and `${INITIATIVE_URL}`, the deployment's public address;
   * any other `${…}` is refused. `baseUrl` is where the service answers on the
   * Compose network, such as `http://tracker:8080`: an http or https URL of at
   * most 512 characters. A container plug-in's only.
   */
  compose?: { service: string; baseUrl: string };
}

export interface PluginDefinition<E, W> {
  /** `<publisher>.<slug>`. */
  publicId: string;
  /** The catalog id: 14 characters of Crockford base32, minted once (`initiative-plugin uid`). */
  uid: string;
  name: string;
  /** How old somebody must be to use it, by ISO 3166-1 alpha-2 country, with `default` for the rest: `{ default: 16, US: 13 }`. */
  minimumAge?: Record<string, number>;
  /**
   * The oldest plug-in API contract the plug-in needs, as `"MAJOR.MINOR"`: the
   * SDK version whose `client.api` it was written against, such as `"4.1"`. A
   * deployment serving a contract of the same major version and at least this
   * minor runs it (`pluginApiCompatible`). Absent: no claim. Beside
   * `listing.minAppVersion`, the oldest Initiative release it runs on.
   */
  minPluginApi?: string;
  scopes?: Array<Scope | PluginScope>;
  /** A declarative plug-in's hosts: every host its requests may reach. Naming them makes the plug-in declarative. */
  hosts?: string[];
  /** How a declarative plug-in's requests carry their credential. Absent: `Authorization: Bearer <token>`. */
  auth?: VendorAuth;
  vendor?: Vendor;
  /** Keyed by connection id. */
  connections?: Record<string, Omit<Connection, "id">>;
  webhooks?: WebhooksDeclaration<E>;
  /** Keyed by schedule id. Each runs through the `schedule` hook. */
  schedules?: Record<string, ScheduleDeclaration>;
  endpoints?: E;
  /** A read endpoint describing the community's standing with the plug-in's service. */
  communitySummary?: ReadName<E>;
  hooks?: Hooks;
  widgets?: W;
  /** Pages and panels, keyed by page id. */
  pages?: Record<string, PageDeclaration>;
  dashboards?: DashboardDeclaration<E, W>[];
  /** How the plug-in's metadata is shown on items, keyed by metadata key. */
  fields?: Record<string, Omit<Field, "key">>;
  /** Pieces of items' pages and views, keyed by part id. A `tree` may be written as JSX (`initiative-plugin-sdk/parts`). */
  parts?: Record<string, Omit<Part, "id">>;
  /** What a reader may run on an item, keyed by action id. */
  actions?: Record<string, ActionDeclaration<E>>;
  listing?: ListingDeclaration;
}

/** Any plug-in's definition, as the server and the build read it. */
export type AnyPlugin = Omit<PluginDefinition<any, any>, "endpoints" | "widgets"> & {
  endpoints?: Record<string, EndpointDeclaration>;
  widgets?: Record<string, WidgetDeclaration<any>>;
};

/** The plug-in, declared once. */
export function definePlugin<
  const E extends Record<string, EndpointDeclaration> = {},
  const W extends Record<string, WidgetDeclaration<E>> = {},
>(definition: PluginDefinition<E, W>): PluginDefinition<E, W> {
  return definition;
}

/** An endpoint's manifest id. */
export function endpointId(plugin: { publicId: string }, name: string): string {
  return `plugin.${plugin.publicId}.${name}`;
}

/**
 * The manifest a definition declares: its handlers left out, its keys made
 * ids, in the contract's order. Each widget's `module_source` is taken from
 * `modules` by widget id. A definition naming `hosts` is declarative, and its
 * manifest has no `service` block.
 */
export function manifestOf(plugin: AnyPlugin, modules: Record<string, string> = {}): Manifest {
  const id = (name: string) => endpointId(plugin, name);
  const blocks: Partial<Manifest> = {
    vendor: plugin.vendor,
    connections: listOf(plugin.connections, (key, connection) => ({ id: key, ...connection })),
    webhooks: plugin.webhooks && {
      ...plugin.webhooks,
      ...(plugin.webhooks.events ? { events: plugin.webhooks.events.map((event) => ({ ...event, emit: id(event.emit) })) } : {}),
    },
    schedules: listOf(plugin.schedules, (key, schedule) => ({ id: key, every: schedule.every })),
    endpoints: listOf(plugin.endpoints, (key, endpoint) => endpointOf(id(key), endpoint, id)),
    community_summary: plugin.communitySummary === undefined ? undefined : id(plugin.communitySummary),
    widgets: listOf(plugin.widgets, (key, widget) => widgetOf(key, widget, modules[key] ?? "", id)),
    pages: listOf(plugin.pages, (key, page) => {
      const { handler: _handler, ...declared } = page;
      return { id: key, ...declared };
    }),
    dashboards: plugin.dashboards?.map((dashboard) => ({
      ...dashboard,
      widgets: dashboard.widgets.map((widget) => ({
        ...widget,
        binding: { ...widget.binding, endpoint_id: id(widget.binding.endpoint_id) },
      })),
    })),
    fields: listOf(plugin.fields, (key, field) => ({ key, ...field })),
    parts: listOf(plugin.parts, (key, part) => ({ id: key, ...part })),
    actions: listOf(plugin.actions, (key, action) => ({ id: key, ...action, endpoint: id(action.endpoint) })),
  };
  const present = Object.fromEntries(
    Object.entries(blocks).filter(([, value]) => value !== undefined)
  ) as Partial<Manifest>;
  return {
    plugin_kind: "service",
    ...(plugin.hosts
      ? {}
      : { service: { public_id: plugin.publicId, protocol: 1, ...(plugin.scopes ? { scopes: [...plugin.scopes] } : {}) } }),
    features: FEATURES.filter((feature) => present[feature] !== undefined),
    default_name: plugin.name,
    ...(plugin.minimumAge ? { minimum_age: { ...plugin.minimumAge } } : {}),
    ...(plugin.minPluginApi !== undefined ? { min_plugin_api: plugin.minPluginApi } : {}),
    ...(plugin.hosts ? { hosts: [...plugin.hosts] } : {}),
    ...(plugin.auth ? { auth: plugin.auth } : {}),
    ...present,
  };
}

/** A record's entries as a list, or undefined when it holds none. */
function listOf<T, U>(record: Record<string, T> | undefined, build: (key: string, value: T) => U): U[] | undefined {
  const entries = Object.entries(record ?? {});
  return entries.length ? entries.map(([key, value]) => build(key, value)) : undefined;
}

/** The declaration in the author's own order, with its keys made ids. */
function endpointOf(endpointIdValue: string, endpoint: EndpointDeclaration, id: (name: string) => string): Endpoint {
  const out: Record<string, unknown> = { id: endpointIdValue };
  for (const [key, value] of Object.entries(endpoint)) {
    if (key === "handler") continue;
    if (key === "params") {
      out.params = Object.entries(value as Record<string, ParamSpec>).map(([name, param]) => ({
        key: name,
        ...param,
        ...(param.options_from ? { options_from: { ...param.options_from, endpoint: id(param.options_from.endpoint) } } : {}),
      }));
    } else if (key === "returns") {
      out.returns = Object.entries(value as Record<string, ReturnSpec>).map(([name, spec]) =>
        typeof spec === "string" ? { key: name, type: spec } : { key: name, ...spec }
      );
    } else out[key] = value;
  }
  return out as unknown as Endpoint;
}

function widgetOf(
  key: string,
  widget: WidgetDeclaration<any>,
  source: string,
  id: (name: string) => string
): Widget {
  const out: Record<string, unknown> = { id: key };
  for (const [field, value] of Object.entries(widget)) {
    if (field === "module") out.module_source = source;
    else if (field === "endpoints") out.endpoints = (value as string[]).map(id);
    else if (field === "sample_data") {
      out.sample_data = Object.fromEntries(Object.entries(value as object).map(([name, sample]) => [id(name), sample]));
    } else out[field] = value;
  }
  return out as unknown as Widget;
}
