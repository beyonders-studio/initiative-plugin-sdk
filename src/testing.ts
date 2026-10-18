/**
 * `initiative-plugin-sdk/testing`: a declarative plug-in's requests, mappings and
 * writes, run against recorded vendor answers, with no server and no network.
 *
 * Each runner renders the requests the way Initiative makes them (method,
 * address with its query, headers, body), answers them from `responses` in
 * order, and maps the answers. It returns every request it rendered beside
 * what the run answered:
 *
 * - `{ result }`: the mapped answer;
 * - `{ unavailable, detail? }`: a code, from an `errors` rule, the defaults,
 *   the map itself, `range-too-large` from paging, or `mapping-failed` when an
 *   expression fails or a rendered address is not https on one of the plug-in's
 *   hosts (`detail` says which);
 * - `{ transient: true }`: a passing failure, which Initiative answers as one
 *   to retry;
 * - `{ refused }`: an `after_connect` that refused the connection.
 *
 * Every runner takes the install's `settings`, each setting's value by key, and
 * `aliases`, each unique setting's earlier values by key, which every
 * expression reads; both default to none.
 *
 * An action's run answers the `change` its `write` makes to the plug-in's values
 * on the item, and a schedule's or a delivery's the targeted `writes`, each held
 * to the contract's `change` or `targetedChange`, to one operation on each key,
 * and to the plug-in's fields: a list field's whole value is a list of
 * elements, and only a list's elements are upserted or removed. A `write`
 * answering nothing changes nothing.
 *
 * A rendered request carries no credential: Initiative adds the one its
 * `connection` names, as the plug-in's `auth` says. A predicate (`when`, `more`,
 * `refuse_when`) holds when JSONata's `$boolean` of its answer is true.
 *
 * A run fails, rather than answering, on a mistake in the test or the plug-in: a
 * request with no recorded response left for it, a recorded response nothing
 * asked for, a mapped answer that does not fit the declared returns, or a
 * `write` answering what is not a change.
 */

import type { Change, ConnectionState, ErrorRule, ItemKind, StatusMatch, TargetedChange, VendorRequest } from "./contract.js";
import { CAPS, PLATFORM_CODES } from "./contract.js";
import type { AnyPlugin, DeclarativeEndpoint, ReturnSpec } from "./define.js";
import { evaluate, ExpressionError } from "./expression.js";
import { definitionValidator } from "./validate.js";

export { evaluate, ExpressionError, parseExpression } from "./expression.js";

/** One answer the vendor gave, as a test records it. Status 200 and no headers when left out. */
export interface RecordedResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** One request as Initiative sends it, less the credential. */
export interface RenderedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  /** The connection whose credential Initiative would add. */
  connection?: string;
}

/** What a run made and what it answered. */
export type Run<T> = { requests: RenderedRequest[] } & (
  | { result: T }
  | { unavailable: string; detail?: string }
  | { transient: true }
  | { refused: string }
);

/** A declarative action's run: what it sent, and what its endpoint and its `write` answered. */
export type ActionRun = { requests: RenderedRequest[] } & (
  | {
      /** The endpoint's mapped answer, when the action names one. */
      result?: Record<string, unknown>;
      /** The change its `write` answered, when it has one that answered something. */
      change?: Change;
    }
  | { unavailable: string; detail?: string }
  | { transient: true }
);

/** A declarative schedule's run: what it sent, the endpoint's mapped answer, and the changes its `write` answered. */
export type ScheduleRun = { requests: RenderedRequest[] } & (
  | { result: Record<string, unknown>; writes: TargetedChange[] }
  | { unavailable: string; detail?: string }
  | { transient: true }
);

export interface Recorded {
  /** The vendor's answers, in the order the requests are made. */
  responses: RecordedResponse[];
  /** The time of the call: `now`, and what `$now()` and `$millis()` answer. Default: the present. */
  now?: Date | string | number;
}

/** The install's settings, as every expression reads them. */
export interface InstallSettings {
  /** Each setting's value, by key. */
  settings?: Record<string, string>;
  /** Each unique setting's earlier values, by key. */
  aliases?: Record<string, string[]>;
}

/** An answer as an expression reads it, `response` or `steps.<name>`. */
interface Answer {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

type Answered = { unavailable: string; detail?: string } | { transient: true };

/** A run's answer, thrown from wherever it is decided. */
class Outcome {
  constructor(readonly answer: Answered) {}
}

class Context {
  readonly requests: RenderedRequest[] = [];
  readonly now: string;
  /** What every expression reads of the install. */
  readonly installed: Required<InstallSettings>;
  private readonly clock: Date | string | number;
  private readonly responses: RecordedResponse[];

  constructor(
    readonly hosts: readonly string[],
    recorded: Recorded & InstallSettings,
    /** The endpoint's own rules, and whether an answer outside 2xx fails the run. */
    readonly rules: readonly ErrorRule[] | null
  ) {
    this.clock = recorded.now ?? new Date();
    this.now = new Date(this.clock).toISOString();
    this.installed = { settings: recorded.settings ?? {}, aliases: recorded.aliases ?? {} };
    this.responses = [...recorded.responses];
  }

  async value(text: string, document: object, where: string): Promise<unknown> {
    try {
      return await evaluate(text, document, { now: this.clock });
    } catch (error) {
      if (!(error instanceof ExpressionError)) throw error;
      throw new Outcome({ unavailable: "mapping-failed", detail: `${where}: ${error.message}` });
    }
  }

  async holds(text: string, document: object, where: string): Promise<boolean> {
    return (await evaluate("$boolean($)", await this.value(text, document, where))) === true;
  }

  answer(request: RenderedRequest): Answer {
    const recorded = this.responses.shift();
    if (!recorded) throw new Error(`no recorded response is left for ${request.method} ${request.url}`);
    return {
      status: recorded.status ?? 200,
      headers: Object.fromEntries(Object.entries(recorded.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
      body: recorded.body === undefined ? undefined : JSON.parse(JSON.stringify(recorded.body)),
    };
  }

  async run<S extends object>(work: () => Promise<S | Answered>): Promise<{ requests: RenderedRequest[] } & (S | Answered)> {
    let answered: S | Answered;
    try {
      answered = await work();
    } catch (error) {
      if (!(error instanceof Outcome)) throw error;
      answered = error.answer;
    }
    if (this.responses.length) {
      throw new Error(`${this.responses.length} recorded response(s) were not asked for`);
    }
    return { requests: this.requests, ...answered };
  }
}

const matches = (status: StatusMatch, actual: number) =>
  typeof status === "number" ? status === actual : status[0] === String(actual)[0];

/** What an answer outside 2xx means when no rule says. */
function byDefault(status: number): Answered {
  if (status === 401 || status === 403) return { unavailable: "not-authorized" };
  if (status === 404) return { unavailable: "not-found" };
  if (status !== 429 && status >= 400 && status < 500) return { unavailable: "invalid" };
  return { transient: true };
}

function onHost(url: URL, hosts: readonly string[]): boolean {
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  return hosts.some((host) => {
    if (!host.startsWith("*.")) return url.hostname === host;
    const label = url.hostname.slice(0, -(host.length - 1));
    return url.hostname.endsWith(host.slice(1)) && label.length > 0 && !label.includes(".");
  });
}

/** The address a Link header gives as `rel="next"`, if any. */
function nextLink(header: string | undefined, base: string): string | undefined {
  for (const link of (header ?? "").split(",")) {
    const [, target, rest] = /^\s*<([^>]*)>(.*)$/.exec(link) ?? [];
    const rel = /;\s*rel="?([^";]*)"?/i.exec(rest ?? "")?.[1];
    if (target !== undefined && rel?.split(/\s+/).includes("next")) return new URL(target, base).toString();
  }
  return undefined;
}

const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

async function render(
  request: VendorRequest,
  document: object,
  context: Context,
  where: string,
  page: { number: number; url?: string; cursor?: unknown }
): Promise<RenderedRequest> {
  const address = page.url ?? (await context.value(request.url, document, `${where}/url`));
  let url: URL;
  try {
    url = new URL(String(address));
  } catch {
    throw new Outcome({ unavailable: "mapping-failed", detail: `${where}/url: ${text(address)} is not an address` });
  }
  if (page.url === undefined) {
    for (const [name, expression] of Object.entries(request.query ?? {})) {
      const value = await context.value(expression, document, `${where}/query/${name}`);
      for (const one of Array.isArray(value) ? value : [value]) {
        if (one !== undefined && one !== null) url.searchParams.append(name, text(one));
      }
    }
  }
  const paging = request.paging;
  if (paging?.kind === "page_number") {
    url.searchParams.set(paging.page_param, String(page.number));
    if (paging.per_page_param) url.searchParams.set(paging.per_page_param, String(paging.per_page));
  }
  if (paging?.kind === "cursor" && paging.param && page.number > 1) url.searchParams.set(paging.param, text(page.cursor));
  if (!onHost(url, context.hosts)) {
    throw new Outcome({
      unavailable: "mapping-failed",
      detail: `${where}: ${url} is not https on one of the plug-in's hosts (${context.hosts.join(", ")})`,
    });
  }

  const headers: Record<string, string> = {};
  for (const [name, expression] of Object.entries(request.headers ?? {})) {
    const value = await context.value(expression, document, `${where}/headers/${name}`);
    if (value !== undefined && value !== null) headers[name] = text(value);
  }
  let body = request.body === undefined ? undefined : await context.value(request.body, document, `${where}/body`);
  if (request.graphql) {
    let variables = request.graphql.variables
      ? await context.value(request.graphql.variables, document, `${where}/graphql/variables`)
      : undefined;
    if (paging?.kind === "cursor" && paging.variable && page.number > 1) {
      variables = { ...(variables as object), [paging.variable]: page.cursor };
    }
    body = { query: request.graphql.query, ...(variables === undefined ? {} : { variables }) };
  }
  return {
    method: request.method,
    url: url.toString(),
    headers,
    ...(body === undefined ? {} : { body }),
    ...(request.connection ? { connection: request.connection } : {}),
  };
}

/**
 * One request, every page of it, as `response` then reads it. Each answer is
 * held to the endpoint's rules and then the defaults, unless the context
 * judges none (a health check, whose states do).
 */
async function perform(request: VendorRequest, document: object, context: Context, where: string): Promise<Answer> {
  const paging = request.paging;
  const items: unknown[] = [];
  const page: { number: number; url?: string; cursor?: unknown } = { number: 1 };
  for (;;) {
    const rendered = await render(request, document, context, where, page);
    context.requests.push(rendered);
    const answer = context.answer(rendered);
    if (context.rules) {
      const read = { ...document, response: answer };
      for (const [index, rule] of context.rules.entries()) {
        if (!matches(rule.status, answer.status)) continue;
        if (rule.when !== undefined && !(await context.holds(rule.when, read, `errors/${index}/when`))) continue;
        throw new Outcome(rule.code === "transient" ? { transient: true } : { unavailable: rule.code });
      }
      if (answer.status < 200 || answer.status > 299) throw new Outcome(byDefault(answer.status));
    }
    if (!paging) return answer;

    const read = { ...document, response: answer };
    const got = paging.items === undefined ? answer.body : await context.value(paging.items, read, `${where}/paging/items`);
    if (Array.isArray(got)) items.push(...got);
    else if (got !== undefined) items.push(got);
    let more: boolean;
    if (paging.kind === "page_number") {
      more = (Array.isArray(got) ? got.length : got === undefined ? 0 : 1) >= paging.per_page;
    } else if (paging.kind === "link_header") {
      page.url = nextLink(answer.headers.link, rendered.url);
      more = page.url !== undefined;
    } else {
      more = await context.holds(paging.more, read, `${where}/paging/more`);
      page.cursor = await context.value(paging.next, read, `${where}/paging/next`);
    }
    if (more && page.number === paging.max_pages && paging.on_limit === "refuse") {
      throw new Outcome({ unavailable: "range-too-large" });
    }
    if (!more || page.number === paging.max_pages) return { ...answer, body: items };
    page.number += 1;
  }
}

/** Holds a mapped answer to the declared returns: declared names, of their declared types. */
function fits(answer: unknown, returns: Record<string, ReturnSpec> | undefined, where: string): Record<string, unknown> {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    throw new Error(`${where} answered ${text(answer)}, which is not an object of the declared returns`);
  }
  for (const [key, value] of Object.entries(answer)) {
    const spec = returns?.[key];
    if (spec === undefined) throw new Error(`${where} answered '${key}', which is not a declared return`);
    if (value === null) continue;
    const { type, list } = typeof spec === "string" ? { type: spec, list: false } : spec;
    if (list && !Array.isArray(value)) {
      throw new Error(
        `${where} answered '${key}' as ${text(value)}, and it is declared a list ` +
          "(a JSONata path matching one item answers it alone: end the path with [] to keep a list)"
      );
    }
    for (const one of list ? (value as unknown[]) : [value]) {
      const ok =
        type === "int" ? Number.isInteger(one) : type === "bool" ? typeof one === "boolean" : typeof one === "string";
      if (!ok) throw new Error(`${where} answered '${key}' as ${text(one)}, which is not ${type}`);
    }
  }
  return answer as Record<string, unknown>;
}

/**
 * Holds what a `write` answered to the contract's definition `name`, `change`
 * or `targetedChange`, to one operation on each key, and to the plug-in's
 * fields: a list field's whole value is a list of elements, and only a list's
 * elements are upserted or removed. Each value, and each element, is held to
 * the cap on one value.
 */
function fitsChange(plugin: AnyPlugin, answer: unknown, name: "change" | "targetedChange", where: string): void {
  const check = definitionValidator(name);
  if (!check(answer)) {
    const why = (check.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
    throw new Error(`${where} answered ${text(answer)}, which is not a ${name === "change" ? "change" : "targeted change"}: ${why}`);
  }
  const { set = {}, upsert = {}, remove = {} } = answer as Change;
  const keys = [...Object.keys(set), ...Object.keys(upsert), ...Object.keys(remove)];
  const twice = keys.find((key, index) => keys.indexOf(key) !== index);
  if (twice !== undefined) throw new Error(`${where} changes '${twice}' twice: a change sets, upserts or removes a key`);
  const list = (key: string) => plugin.fields?.[key]?.list === true;
  for (const key of [...Object.keys(upsert), ...Object.keys(remove)]) {
    if (plugin.fields?.[key] && !list(key)) throw new Error(`${where} changes elements of '${key}', which is not a list field`);
  }
  const values = Object.entries(upsert).flatMap(([key, elements]) => elements.map((element): [string, unknown] => [key, element]));
  const element = definitionValidator("listElement");
  for (const [key, value] of Object.entries(set)) {
    if (value === null) continue;
    if (!list(key)) values.push([key, value]);
    else if (Array.isArray(value) && value.every((one) => element(one))) values.push(...value.map((one): [string, unknown] => [key, one]));
    else throw new Error(`${where} sets '${key}', a list field, to ${text(value)}, which is not a list of elements`);
  }
  for (const [key, value] of values) {
    if (Buffer.byteLength(JSON.stringify(value), "utf-8") > CAPS.metadataValueBytes) {
      throw new Error(`${where} gives '${key}' a value of more than ${CAPS.metadataValueBytes} bytes as JSON`);
    }
  }
}

/** What a `write` answered, as targeted changes: a list of at most `writeTargets`. Nothing is no change. */
function targeted(plugin: AnyPlugin, answer: unknown, where: string): TargetedChange[] {
  if (answer === undefined) return [];
  if (!Array.isArray(answer)) {
    throw new Error(
      `${where} answered ${text(answer)}, which is not a list of targeted changes ` +
        "(a JSONata path matching one item answers it alone: wrap the answer in [ ] to keep a list)"
    );
  }
  if (answer.length > CAPS.writeTargets) throw new Error(`${where} answered ${answer.length} changes, more than ${CAPS.writeTargets}`);
  answer.forEach((change, index) => fitsChange(plugin, change, "targetedChange", `${where}/${index}`));
  return answer;
}

/** A declarative endpoint of the plug-in, by its key. */
function declarative(plugin: AnyPlugin, name: string): DeclarativeEndpoint<any, any> {
  const endpoint = plugin.endpoints?.[name];
  if (!endpoint || !("map" in endpoint)) throw new TypeError(`'${name}' is not a declarative endpoint of this plug-in`);
  return endpoint;
}

/**
 * One declarative endpoint's request or steps, answered in `context`, and its
 * map held to the declared returns: what {@link runEndpoint} runs, and what an
 * action or a schedule runs for the endpoint it names. An action's call also
 * reads its `subject`: the `item`, and the `element` it was run from.
 */
async function answerEndpoint(
  endpoint: DeclarativeEndpoint<any, any>,
  call: { params?: Record<string, unknown>; connections?: Record<string, Record<string, unknown>>; subject?: object },
  context: Context
): Promise<{ result: Record<string, unknown> } | { unavailable: string }> {
  const given = call.connections ?? {};
  const required = [...(endpoint.requires?.all_of ?? []), ...(endpoint.requires?.any_of ?? [])];
  const connections = Object.fromEntries(required.filter((id) => Object.hasOwn(given, id)).map((id) => [id, given[id]]));
  const base = { params: call.params ?? {}, connections, now: context.now, ...context.installed, ...call.subject };
  const steps = endpoint.steps ?? [{ name: "", request: endpoint.request! }];
  const answers: Record<string, Answer> = {};
  let read: object = base;
  for (const [index, step] of steps.entries()) {
    read = {
      ...base,
      connection: given[step.request.connection ?? ""] ?? {},
      ...(endpoint.steps ? { steps: { ...answers } } : {}),
    };
    const where = endpoint.steps ? `steps/${index}/request` : "request";
    const response = await perform(step.request, read, context, where);
    if (endpoint.steps) answers[step.name] = response;
    read = { ...read, ...(endpoint.steps ? { steps: { ...answers } } : {}), response };
  }
  const answer = await context.value(endpoint.map, read, "map");
  if (answer && typeof answer === "object" && "unavailable" in answer) {
    const code = (answer as { unavailable: unknown }).unavailable;
    if (typeof code !== "string" || ![...(endpoint.unavailable ?? []), ...PLATFORM_CODES].includes(code)) {
      throw new Error(`map answered unavailable ${text(code)}, which is not one of this endpoint's codes`);
    }
    return { unavailable: code };
  }
  return { result: fits(answer, endpoint.returns, "map") };
}

/**
 * One declarative endpoint: its request or steps rendered from `params`, the
 * `connections`' non-secret fields (keyed by connection id), the install's
 * `settings` and `aliases`, and `now`, answered from `responses`, and its map
 * held to the declared returns. An expression reads `connection`, the fields
 * of the connection its request names, and `connections`, the fields of each
 * connection the endpoint's `requires` names that `connections` holds, by id.
 * The call has no actor: who may run it, and on whose credential, is
 * Initiative's to decide.
 */
export async function runEndpoint(
  plugin: AnyPlugin,
  name: string,
  call: Recorded &
    InstallSettings & {
      params?: Record<string, unknown>;
      connections?: Record<string, Record<string, unknown>>;
    }
): Promise<Run<Record<string, unknown>>> {
  const endpoint = declarative(plugin, name);
  const context = new Context(plugin.hosts ?? [], call, endpoint.errors ?? []);
  return context.run(() => answerEndpoint(endpoint, call, context));
}

/**
 * A declarative action, run on one item with the `params` the reader answered,
 * from one of a list field's elements when `element` names its `ref`. Its
 * endpoint, when it names one, is sent those params and rendered and answered
 * as {@link runEndpoint} does it, its expressions also reading `item` and
 * `element`; an answer of unavailable or transient is the run's, and nothing is
 * written. Its `write`, when it has one, then answers the change Initiative
 * makes to the plug-in's values on the item, reading `item`, `held` (those
 * values as they stand, by key), `result` (the endpoint's mapped answer, absent
 * with no endpoint), `params`, `element`, `settings`, `aliases` and `now`. Like
 * the endpoint's, an expression that fails answers `mapping-failed`.
 */
export async function runAction(
  plugin: AnyPlugin,
  name: string,
  call: Omit<Recorded, "responses"> &
    InstallSettings & {
      /** The vendor's answers to the endpoint's calls; none when the action names no endpoint. */
      responses?: RecordedResponse[];
      item: { kind: ItemKind; id: number; title: string };
      held?: Record<string, unknown>;
      /** What the reader answered, for the params the action asks for. */
      params?: Record<string, unknown>;
      /** The `ref` of the list element it was run from. */
      element?: string;
      connections?: Record<string, Record<string, unknown>>;
    }
): Promise<ActionRun> {
  const action = plugin.actions?.[name];
  if (!action) throw new TypeError(`'${name}' is not an action of this plug-in`);
  if (!action.on.includes(call.item.kind)) throw new TypeError(`'${name}' is not offered on ${call.item.kind}`);
  const unasked = Object.keys(call.params ?? {}).find((key) => !action.params?.includes(key));
  if (unasked !== undefined) throw new TypeError(`'${name}' does not ask for '${unasked}'`);
  if (call.element !== undefined && !Object.values(plugin.fields ?? {}).some((field) => field.actions?.includes(name))) {
    throw new TypeError(`'${name}' is offered on no list's elements`);
  }
  const endpoint = action.endpoint === undefined ? undefined : declarative(plugin, action.endpoint);
  const context = new Context(plugin.hosts ?? [], { ...call, responses: call.responses ?? [] }, endpoint?.errors ?? []);
  const subject = { item: call.item, ...(call.element === undefined ? {} : { element: call.element }) };
  return context.run<{ result?: Record<string, unknown>; change?: Change }>(async () => {
    const sent = { params: call.params, connections: call.connections, subject };
    const called = endpoint && (await answerEndpoint(endpoint, sent, context));
    if (called && !("result" in called)) return called;
    const read = { ...subject, held: call.held ?? {}, ...called, params: call.params ?? {}, ...context.installed, now: context.now };
    const change = action.write === undefined ? undefined : await context.value(action.write, read, "write");
    if (change !== undefined) fitsChange(plugin, change, "change", "write");
    return { ...called, ...(change === undefined ? {} : { change: change as Change }) };
  });
}

/**
 * A declarative schedule's run in one community. Its `params` answer the
 * endpoint's params from `since`, `now`, `connection` (the fields of the
 * connection the endpoint's first request names), `settings` and `aliases`; the
 * endpoint is rendered and answered with them as {@link runEndpoint} does it;
 * and its `write` answers, from the endpoint's mapped answer as `result` beside
 * `since`, `now`, `settings` and `aliases`, the changes Initiative makes as the
 * install. `since` is when the schedule last succeeded there, as ISO 8601:
 * null, the default, the first time.
 */
export async function runSchedule(
  plugin: AnyPlugin,
  name: string,
  call: Recorded &
    InstallSettings & {
      since?: string | null;
      connections?: Record<string, Record<string, unknown>>;
    }
): Promise<ScheduleRun> {
  const schedule = plugin.schedules?.[name];
  if (!schedule || "run" in schedule) throw new TypeError(`'${name}' is not a declarative schedule of this plug-in`);
  const endpoint = declarative(plugin, schedule.endpoint);
  const context = new Context(plugin.hosts ?? [], call, endpoint.errors ?? []);
  return context.run<{ result: Record<string, unknown>; writes: TargetedChange[] }>(async () => {
    const since = call.since ?? null;
    const first = endpoint.steps?.[0].request ?? endpoint.request!;
    const connection = call.connections?.[first.connection ?? ""] ?? {};
    const read = { since, now: context.now, ...context.installed };
    const params = schedule.params === undefined ? undefined : await context.value(schedule.params, { ...read, connection }, "params");
    if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params))) {
      throw new Error(`params answered ${text(params)}, which is not an object of the endpoint's params`);
    }
    const sent = { params: params as Record<string, unknown> | undefined, connections: call.connections };
    const called = await answerEndpoint(endpoint, sent, context);
    if (!("result" in called)) return called;
    const writes = targeted(plugin, await context.value(schedule.write, { result: called.result, ...read }, "write"), "write");
    return { result: called.result, writes };
  });
}

/**
 * A declarative `after_connect`: its request or steps made with the flow's
 * `params`, mapped, and refused when it says. The map and `refuse_when` read
 * the last answer as `response` and, with steps, each one's as `steps.<name>`.
 */
export async function runAfterConnect(
  plugin: AnyPlugin,
  connection: string,
  call: Recorded & InstallSettings & { params?: Record<string, string> }
): Promise<Run<{ values?: Record<string, unknown>; account_label?: string }>> {
  const after = plugin.connections?.[connection]?.flow?.after_connect;
  if (typeof after !== "object") throw new TypeError(`'${connection}' has no declarative after_connect`);
  const context = new Context(plugin.hosts ?? [], call, []);
  return context.run<{ result: { values?: Record<string, unknown>; account_label?: string } } | { refused: string }>(async () => {
    const base = { params: call.params ?? {}, now: context.now, ...context.installed };
    const steps = after.steps ?? [{ name: "", request: after.request! }];
    const answers: Record<string, Answer> = {};
    let read: object = base;
    for (const [index, step] of steps.entries()) {
      read = { ...base, ...(after.steps ? { steps: { ...answers } } : {}) };
      const where = after.steps ? `after_connect/steps/${index}/request` : "after_connect/request";
      const response = await perform(step.request, read, context, where);
      if (after.steps) answers[step.name] = response;
      read = { ...base, ...(after.steps ? { steps: { ...answers } } : {}), response };
    }
    const result = await context.value(after.map, read, "after_connect/map");
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error(`after_connect/map answered ${text(result)}, which is not {values, account_label}`);
    }
    if (after.refuse_when && (await context.holds(after.refuse_when, { ...read, result }, "refuse_when"))) {
      return { refused: after.code ?? "" };
    }
    return { result: result as { values?: Record<string, unknown>; account_label?: string } };
  });
}

/** A connection's health check: its request made with the connection's non-secret `fields`, and the state it reads. */
export async function runHealth(
  plugin: AnyPlugin,
  connection: string,
  call: Recorded & InstallSettings & { fields?: Record<string, unknown> }
): Promise<Run<ConnectionState>> {
  const health = plugin.connections?.[connection]?.health;
  if (!health) throw new TypeError(`'${connection}' declares no health check`);
  const context = new Context(plugin.hosts ?? [], call, null);
  return context.run(async () => {
    const document = { params: {}, connection: call.fields ?? {}, now: context.now, ...context.installed };
    const response = await perform(health.request, document, context, "health/request");
    for (const [index, row] of health.states.entries()) {
      if (row.status !== undefined && !matches(row.status, response.status)) continue;
      if (row.when !== undefined && !(await context.holds(row.when, { ...document, response }, `states/${index}/when`))) continue;
      return { result: row.state };
    }
    return { result: response.status >= 200 && response.status <= 299 ? "ok" : "unavailable" };
  });
}

/** What one delivery emits, the changes it makes, and the connection state it sets. */
export interface WebhookRun {
  event?: { emit: string; payload: Record<string, unknown> };
  /** The targeted changes the matching `events` row's `write` answered, when it has one. */
  writes?: TargetedChange[];
  status?: { connection: string; state: ConnectionState };
}

/**
 * One webhook delivery, as a declarative plug-in maps it: the first matching
 * `events` row's event (by the emit endpoint's key, its payload held to that
 * endpoint's returns) and the changes its `write` answers, and the state the
 * first matching `status` row sets. A delivery nothing matches answers neither.
 * An expression that fails throws {@link ExpressionError}.
 */
export async function runWebhook(
  plugin: AnyPlugin,
  delivery: InstallSettings & {
    headers?: Record<string, string>;
    payload: unknown;
    /** The routed connection's non-secret fields. */
    connection?: Record<string, unknown>;
    now?: Date | string | number;
  }
): Promise<WebhookRun> {
  const clock = delivery.now ?? new Date();
  const document = {
    headers: Object.fromEntries(Object.entries(delivery.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
    payload: delivery.payload,
    connection: delivery.connection ?? {},
    now: new Date(clock).toISOString(),
    settings: delivery.settings ?? {},
    aliases: delivery.aliases ?? {},
  };
  const holds = async (expression: string) =>
    (await evaluate("$boolean($)", await evaluate(expression, document, { now: clock }))) === true;
  const out: WebhookRun = {};
  for (const row of plugin.webhooks?.events ?? []) {
    if (!(await holds(row.when))) continue;
    if (row.emit !== undefined) {
      const payload = await evaluate(row.map, document, { now: clock });
      out.event = { emit: row.emit, payload: fits(payload, plugin.endpoints?.[row.emit]?.returns, `the ${row.emit} event`) };
    }
    if (row.write !== undefined) out.writes = targeted(plugin, await evaluate(row.write, document, { now: clock }), "write");
    break;
  }
  for (const row of plugin.webhooks?.status ?? []) {
    if (await holds(row.when)) {
      out.status = { connection: row.connection, state: row.state };
      break;
    }
  }
  return out;
}
