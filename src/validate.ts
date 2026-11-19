/**
 * Checking a manifest before a deployment does.
 *
 * **Schema-valid is necessary, not sufficient.** Some rules are not expressible
 * in JSON Schema and are checked by the platform on publish: cross-references
 * (the endpoint a widget binds, a `requires` term's connection, an endpoint's
 * service prefix), the features/blocks cross-check in both directions, UTF-8
 * byte-size caps, the rules tying a connection's `flow` and `token` to its
 * scope and fields, what a vendor `setup` writes to and a vendor `check`
 * reads, the bounds, ids and
 * endpoints of `schedules`, which terms each kind's schedules, actions, fields
 * and webhook events take, the unique keys and ids of `fields`, `parts`,
 * `actions` and `settings`, the unique values of a field's `options`, what a
 * part's nodes, a field's element actions and an action's endpoint and
 * `params` name, the permissions `permissions` declares and every page, field,
 * part, action and endpoint names, the placeholders in a part's text, and a
 * part's size and depth, and a tool plug-in's terms: the blocks it may carry,
 * its keys, what its items sit under, the kinds its fields' terms and
 * defaults fit, what its open conditions and actions name, and what its
 * layouts name, the looks they draw fields in and their size and depth.
 *
 * {@link validateManifest} runs the schema and then every one of those except
 * the byte caps. It also reports every term the contract does not declare: a
 * deployment drops such a term rather than refusing the manifest, so a
 * misspelt or retired field would otherwise do nothing without saying so. And
 * it adds one rule the platform does not check: an endpoint's `identity` must
 * name returns that endpoint actually sends.
 *
 * For a declarative plug-in it also parses every JSONata expression, and checks
 * that a plug-in is one kind or the other, what its requests and steps name, and
 * the hosts it calls.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import {
  ACTOR_KINDS,
  CAPS,
  CHARSETS,
  FEATURES,
  FIELDS,
  PLATFORM_CODES,
  TOOL_COLUMNS,
  TOOL_LAYOUT_FIELDS,
  type Endpoint,
  type FieldDisplay,
  type Feature,
  type ItemKind,
  type LayoutCardPart,
  type LayoutDetailPart,
  type Manifest,
  type PartNode,
  type Requires,
  type ToolField,
  type ToolFieldKind,
  type ToolLayouts,
  type ToolOperand,
  type VendorRequest,
} from "./contract.js";
import { ExpressionError, parseExpression } from "./expression.js";

/** Where a plug-in serves its manifest document. */
export const MANIFEST_PATH = "/.well-known/initiative-plugin.json";

/** The wire protocol this SDK speaks. */
export const PLUGIN_PROTOCOL_VERSION = 1;

/**
 * The document served at {@link MANIFEST_PATH}, of which {@link Manifest} is one
 * field: the plug-in's identity beside what it declares it can do. A registrar
 * refuses anything without a `protocol_version`, a `public_id`, a `kind` and a
 * `definition`.
 */
export interface PluginDocument {
  protocol_version: number;
  /** `<publisher>.<slug>`, the same id `definition.service.public_id` carries. */
  public_id: string;
  kind: "plugin";
  /** The catalog id: publisher-assigned, immutable, never reused. */
  uid?: string;
  name?: string;
  definition: Manifest;
}

/**
 * The document to serve at {@link MANIFEST_PATH}. Serve the same bytes every
 * time: a deployment hashes what it fetches and re-checks it.
 */
export function pluginDocument(
  manifest: Manifest,
  options: { uid?: string; name?: string } = {}
): PluginDocument {
  return {
    protocol_version: manifest.service?.protocol ?? PLUGIN_PROTOCOL_VERSION,
    public_id: manifest.service?.public_id ?? "",
    kind: "plugin",
    ...(options.uid ? { uid: options.uid } : {}),
    ...(options.name ? { name: options.name } : {}),
    definition: manifest,
  };
}

/**
 * Check a whole served document — the envelope, then the manifest inside it.
 *
 * {@link validateManifest} checks what a plug-in declares; this checks what a
 * registrar will actually fetch. Use it on the bytes you serve.
 */
export function validateDocument(document: unknown): ValidationProblem[] {
  if (typeof document !== "object" || document === null) {
    return [{ where: "", message: "a manifest document is a JSON object" }];
  }
  const body = document as Partial<PluginDocument>;
  const problems: ValidationProblem[] = [];

  if (body.protocol_version !== PLUGIN_PROTOCOL_VERSION) {
    problems.push({
      where: "/protocol_version",
      message: `must be ${PLUGIN_PROTOCOL_VERSION} — a registrar refuses a protocol it does not speak`,
    });
  }
  if (typeof body.public_id !== "string" || !body.public_id.trim()) {
    problems.push({ where: "/public_id", message: "a served document must name its plug-in" });
  }
  if (body.kind !== "plugin") {
    problems.push({ where: "/kind", message: `must be '${"plugin"}'` });
  }
  if (body.definition === undefined) {
    problems.push({
      where: "/definition",
      message: "the manifest goes here — a document without one declares nothing",
    });
    // Nothing further to say: every check below reads the definition.
    return problems;
  }
  // The two ids are the same id written twice, and a registration matched by
  // one while the capabilities are namespaced under the other is a mismatch
  // nothing downstream would report.
  const declared = (body.definition as Manifest)?.service?.public_id;
  if (typeof body.public_id === "string" && declared && declared !== body.public_id) {
    problems.push({
      where: "/public_id",
      message: `names '${body.public_id}' but the definition declares '${declared}'`,
    });
  }

  return [
    ...problems,
    ...validateManifest(body.definition, { publicId: body.public_id }).map((problem) => ({
      where: `/definition${problem.where}`,
      message: problem.message,
    })),
  ];
}

/**
 * Which manifest block backs each declared feature.
 *
 * Derived from the contract's feature list rather than restated: a feature and
 * its block share a name, and a second list could only ever be missing one —
 * which is what left this package unable to declare `dashboards` for a release.
 */
const FEATURE_BLOCKS = Object.fromEntries(
  FEATURES.map((feature) => [feature, feature])
) as Record<Feature, keyof Manifest>;

/** The generated schema, read from disk once. */
export function manifestSchema(): Record<string, unknown> {
  const here = dirname(fileURLToPath(import.meta.url));
  // Resolved relative to the built module so it works from `dist/` and `src/`.
  for (const candidate of ["../schemas/plugin-manifest.json", "../../schemas/plugin-manifest.json"]) {
    try {
      return JSON.parse(readFileSync(join(here, candidate), "utf-8"));
    } catch {
      continue;
    }
  }
  throw new Error("plugin-manifest.json is not packaged beside this module");
}

export interface ValidationProblem {
  /** A JSON Pointer-ish path into the manifest. */
  where: string;
  message: string;
}

/** Compiled once — Ajv's compile step is the expensive part, not validation. */
let ajv: Ajv2020 | undefined;
let compiled: ValidateFunction | undefined;

function schemaValidator(): ValidateFunction {
  if (!compiled) {
    ajv = new Ajv2020({ allErrors: true, strict: false });
    compiled = ajv.compile(manifestSchema());
  }
  return compiled;
}

/**
 * One of the contract's definitions as a check of a value rather than of a
 * manifest: what a declarative plug-in's `write` answered, held to `change` or
 * `targetedChange`.
 */
export function definitionValidator(name: string): ValidateFunction {
  const { $id } = schemaValidator().schema as { $id: string };
  return ajv!.getSchema(`${$id}#/$defs/${name}`)!;
}

/**
 * Everything this side can check: the schema, then the two cross-cutting rules
 * it cannot express.
 *
 * The schema runs first and short-circuits. A manifest whose shape is wrong
 * produces cascading nonsense from the reference checks — "binds 'undefined',
 * which is not a declared read endpoint" when the real answer is "endpoints
 * must be an array" — so the structural answer is worth giving alone.
 *
 * An empty array does not promise the platform will accept it — see the module
 * note — but a non-empty one is a definite refusal, so this is worth running in
 * CI and before a publish.
 *
 * A declarative plug-in's manifest has no `service` block to name the plug-in, so its
 * endpoint ids are checked against `publicId` when one is given.
 */
export function validateManifest(manifest: unknown, options: { publicId?: string } = {}): ValidationProblem[] {
  if (typeof manifest !== "object" || manifest === null) {
    return [{ where: "", message: "a manifest is a JSON object" }];
  }

  const validate = schemaValidator();
  if (!validate(manifest)) {
    return (validate.errors ?? []).map((error) =>
      // A closed object's unknown key, said the way an open one's is.
      error.keyword === "additionalProperties"
        ? {
            where: `${error.instancePath}/${error.params.additionalProperty}`,
            message: `'${error.params.additionalProperty}' is not a term of the manifest contract`,
          }
        : {
            where: error.instancePath,
            message: `${error.message ?? "is invalid"}${
              error.params && "allowedValues" in error.params
                ? ` (${(error.params.allowedValues as string[]).join(", ")})`
                : ""
            }`,
          }
    );
  }

  const body = manifest as Manifest;
  return [
    ...undeclaredProblems(body),
    ...featureProblems(body),
    ...referenceProblems(body, options.publicId),
    ...permissionProblems(body),
    ...connectionProblems(body),
    ...webhookProblems(body),
    ...setupProblems(body),
    ...checkProblems(body),
    ...scheduleProblems(body),
    ...partProblems(body),
    ...automationProblems(body),
    ...summaryProblems(body),
    ...measureProblems(body),
    ...toolProblems(body),
    // A tool plug-in is neither a container nor declarative: it carries none
    // of the blocks those two rules read.
    ...(body.plugin_kind === "tool" ? [] : [...kindProblems(body), ...declarativeProblems(body)]),
  ];
}

/**
 * Whether {@link Manifest.community_summary} names something that can be rendered.
 *
 * Separate from {@link referenceProblems} for the same reason
 * {@link automationProblems} is: nothing downstream refuses this. A deployment
 * that cannot resolve the endpoint draws nothing and says nothing, which looks
 * exactly like a deployment that chose not to render it.
 */
function summaryProblems(body: Manifest): ValidationProblem[] {
  const id = body.community_summary;
  if (!id) return [];

  const endpoint = (body.endpoints ?? []).find((candidate) => candidate.id === id);
  if (!endpoint) {
    return [
      {
        where: "/community_summary",
        message: `'${id}' is not one of this plug-in's endpoints`,
      },
    ];
  }

  const problems: ValidationProblem[] = [];
  if (endpoint.direction !== "read") {
    problems.push({
      where: "/community_summary",
      message: `'${id}' is not a read — a summary is drawn, not performed`,
    });
  }
  if ((endpoint.returns ?? []).length === 0) {
    problems.push({
      where: "/community_summary",
      message: `'${id}' declares no returns, so there is nothing to draw`,
    });
  }
  const required = (endpoint.params ?? []).filter((param) => param.required);
  if (required.length > 0) {
    problems.push({
      where: "/community_summary",
      message:
        `'${id}' requires ${required.map((p) => `'${p.key}'`).join(", ")} — a summary is ` +
        "read for a community, and there is no form to answer a parameter in",
    });
  }
  return problems;
}

/**
 * Every return counted against something it cannot be counted against.
 *
 * `of` pairs a figure with its ceiling so a consumer can draw the two as one
 * measure. A pair is only drawable when both halves are one whole number each:
 * a list has no single figure, and a date or a label has no proportion.
 */
function measureProblems(body: Manifest): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  (body.endpoints ?? []).forEach((endpoint, e) => {
    const returns = endpoint.returns ?? [];
    returns.forEach((item, r) => {
      if (item.of === undefined) return;
      const where = `/endpoints/${e}/returns/${r}/of`;
      if (item.of === item.key) {
        problems.push({ where, message: `'${item.key}' is counted against itself` });
        return;
      }
      const ceiling = returns.find((candidate) => candidate.key === item.of);
      if (!ceiling) {
        problems.push({ where, message: `'${item.of}' is not a return of this endpoint` });
        return;
      }
      for (const half of [item, ceiling]) {
        if (half.type !== "int" || half.list) {
          problems.push({
            where,
            message: `'${half.key}' is not a single 'int', so the pair cannot be drawn as one measure`,
          });
        }
      }
    });
  });
  return problems;
}

/**
 * Every identity that names something its endpoint does not carry.
 *
 * What is left of a larger set of checks, and the reduction is the point: the
 * others covered terms that told a consumer how to DRAW a parameter, and those
 * terms are gone. An identity is not one of them. It says what an operation
 * TOUCHED, which only you can know, and it is what lets a consumer keep a
 * change your plug-in made from firing the automation that made it.
 *
 * Kept apart from {@link referenceProblems} because those are early copies of
 * platform refusals and this is not: nothing downstream refuses an identity
 * naming a return you do not send. It resolves to nothing, the suppression it
 * feeds looks configured, and a fire somebody was waiting on is silently
 * dropped. This is where that surfaces.
 */
function automationProblems(body: Manifest): ValidationProblem[] {
  const problems: ValidationProblem[] = [];

  (body.endpoints ?? []).forEach((endpoint, index) => {
    if (!endpoint.identity) return;
    const where = `/endpoints/${index}`;
    if (endpoint.direction === "read") {
      problems.push({
        where: `${where}/identity`,
        message: "a read touched nothing, so there is no echo to suppress",
      });
    }
    const single = new Set(
      (endpoint.returns ?? []).filter((value) => !value.list).map((value) => value.key)
    );
    for (const part of endpoint.identity.key) {
      if (!single.has(part)) {
        problems.push({
          where: `${where}/identity/key`,
          message:
            `'${part}' is not a single-valued return of this endpoint — an address built from ` +
            "the parts that happen to be there matches the wrong thing",
        });
      }
    }
  });

  return problems;
}

type SchemaNode = {
  $ref?: string;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  oneOf?: SchemaNode[];
  const?: unknown;
};

/**
 * Every key the contract does not declare, depth first.
 *
 * Walks the schema itself: a node names a `$ref`, carries `items`, or carries
 * `properties`, and each is followed the same way at every depth. A tagged
 * union is read as the member whose constants its value holds: a paging's
 * `kind`, a part node's `type`. An object the
 * contract leaves open (localized text, a widget's `meta`, a binding's
 * `params`) declares no properties, and nothing inside it is checked.
 */
function undeclaredProblems(body: Manifest): ValidationProblem[] {
  const schema = manifestSchema() as SchemaNode & { $defs?: Record<string, SchemaNode> };
  const defs = schema.$defs ?? {};
  const problems: ValidationProblem[] = [];

  const resolve = (node: SchemaNode | undefined): SchemaNode | undefined =>
    node?.$ref ? defs[node.$ref.slice("#/$defs/".length)] : node;

  const walk = (value: unknown, node: SchemaNode | undefined, where: string): void => {
    let shape = resolve(node);
    if (shape?.oneOf && typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      shape = shape.oneOf
        .map(resolve)
        .find((member) =>
          Object.entries(member?.properties ?? {}).every(([key, child]) => child.const === undefined || record[key] === child.const)
        );
    }
    if (!shape) return;
    if (shape.items) {
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, shape.items, `${where}/${index}`));
      }
      return;
    }
    if (!shape.properties || typeof value !== "object" || value === null || Array.isArray(value)) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const declared = shape.properties[key];
      if (!declared) {
        problems.push({
          where: `${where}/${key}`,
          message: `'${key}' is not a term of the manifest contract, and a deployment discards it`,
        });
        continue;
      }
      walk(child, declared, `${where}/${key}`);
    }
  };

  walk(body, schema, "");
  return problems;
}

/**
 * Every declared feature backed by a block, and every block declared.
 *
 * **An empty block is no block**, and testing for the key's presence instead is
 * the mistake this note exists to stop. The platform's normalizer drops empty
 * blocks *before* it runs this cross-check, so `"automation": {}` never reaches
 * it and the feature reads as declared over nothing — refused. A manifest with
 * one validates locally under a presence test and is turned away at
 * registration, which has happened to a real plug-in.
 *
 * So an empty block is reported twice over, deliberately: once as the feature it
 * fails to back, and once on its own, because leaving it out is the fix either
 * way and a block that is never sent cannot be misread.
 */
function featureProblems(body: Manifest): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const declared = new Set(body.features ?? []);
  for (const [feature, block] of Object.entries(FEATURE_BLOCKS) as Array<
    [Feature, keyof Manifest]
  >) {
    const value = body[block];
    // What survives the normalizer: present, and carrying something.
    const present =
      value !== undefined &&
      value !== null &&
      (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0);

    if (declared.has(feature) && !present) {
      problems.push({
        where: "/features",
        message:
          `the '${feature}' feature is declared but ${String(block)} is missing or empty — ` +
          "an empty block is dropped before the platform checks, so it reads as absent",
      });
    }
    if (present && !declared.has(feature)) {
      problems.push({
        where: `/${String(block)}`,
        message: `${String(block)} is present but the '${feature}' feature is not declared`,
      });
    }
    if (value !== undefined && !present) {
      problems.push({
        where: `/${String(block)}`,
        message: `${String(block)} is empty — leave it out instead`,
      });
    }
  }
  return problems;
}

/** Ids that must name something the manifest itself declares. */
function referenceProblems(body: Manifest, publicId: string | undefined): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const connectionIds = new Set((body.connections ?? []).map((c) => c.id));

  const checkRequires = (requires: Requires | undefined, where: string) => {
    if (!requires) return;
    // The schema already refused anything but exactly one operator, so this is
    // a cheap invariant rather than a second gate — it keeps the loop below
    // from reading a key that is not there if this is ever called directly.
    const named = (["all_of", "any_of"] as const).filter((key) => key in requires);
    if (named.length !== 1) return;
    for (const id of requires[named[0]] ?? []) {
      if (!connectionIds.has(id)) {
        problems.push({ where, message: `requires names unknown connection '${id}'` });
      }
    }
  };

  // One namespace across every direction, which is what lets a caller resolve
  // an id without being told which kind of thing it is first.
  const owner = body.service?.public_id ?? publicId;
  const prefix = `plugin.${owner}.`;
  const readable = new Set<string>();
  const declared = new Set<string>();
  // Kept by id so a parameter naming a source can be checked against what that
  // endpoint actually returns, not merely against its existence.
  const byId = new Map<string, Endpoint>();

  (body.endpoints ?? []).forEach((endpoint, index) => {
    const where = `/endpoints/${index}`;
    if (owner !== undefined && (!endpoint.id.startsWith(prefix) || endpoint.id.length === prefix.length)) {
      problems.push({
        where: `${where}/id`,
        message: `endpoint ids are namespaced under your service id — '${prefix}…'`,
      });
    }
    if (declared.has(endpoint.id)) {
      problems.push({ where: `${where}/id`, message: `'${endpoint.id}' is declared twice` });
    }
    declared.add(endpoint.id);
    if (endpoint.direction === "read") readable.add(endpoint.id);
    byId.set(endpoint.id, endpoint);
    checkRequires(endpoint.requires, `${where}/requires`);

    // An emission travels the other way — nobody calls it — so a caller side on
    // one describes a call that never happens: a form nobody fills, a gate
    // nobody passes, a cache with nothing to hold. The platform refuses it, and
    // the schema cannot say so because the rule is conditional on `direction`.
    //
    // `label`, `description`, `returns` and `group` are deliberately NOT in
    // this list: an emission is the one endpoint chosen without ever being
    // called, so describing it matters more here than anywhere.
    if (endpoint.direction === "emit") {
      for (const key of ["params", "requires", "cache_ttl_seconds", "actors", "public", "permission"]) {
        if ((endpoint as unknown as Record<string, unknown>)[key] !== undefined) {
          problems.push({
            where: `${where}/${key}`,
            message: `an emit endpoint has no ${key} — nobody calls it`,
          });
        }
      }
    }

    // Two returns under one name is a value a consumer cannot address: it binds
    // by name, and one of the two would silently never be reachable.
    const returned = new Set<string>();
    (endpoint.returns ?? []).forEach((value, position) => {
      if (returned.has(value.key)) {
        problems.push({
          where: `${where}/returns/${position}`,
          message: `'${value.key}' is returned twice — a consumer binds by name`,
        });
      }
      returned.add(value.key);
    });
  });

  // A parameter that names where its values come from, checked against the
  // endpoint it names. Nothing downstream refuses a bad one: a consumer asks
  // the deployment to resolve it, the deployment finds no such return, and the
  // form quietly offers nothing — which looks exactly like a vendor being slow.
  // This is where an author finds out instead.
  (body.endpoints ?? []).forEach((endpoint, index) => {
    (endpoint.params ?? []).forEach((param, position) => {
      const source = param.options_from;
      if (!source) return;
      const where = `/endpoints/${index}/params/${position}/options_from`;

      const named = byId.get(source.endpoint);
      if (!named) {
        problems.push({
          where,
          message: `names '${source.endpoint}', which this manifest does not declare`,
        });
        return;
      }
      if (named.direction !== "read") {
        // Filling in a form must not be able to change anything.
        problems.push({
          where,
          message: `names '${source.endpoint}', which is a ${named.direction} endpoint`,
        });
        return;
      }

      for (const [field, key] of [
        ["key", source.key],
        ["label_key", source.label_key],
      ] as const) {
        if (key === undefined) continue;
        const value = (named.returns ?? []).find((one) => one.key === key);
        if (!value) {
          problems.push({
            where: `${where}/${field}`,
            message: `'${key}' is not returned by '${source.endpoint}'`,
          });
        } else if (value.list !== true) {
          // A menu comes from a list. `returns` is how an endpoint says which
          // of its values hold several, and a consumer reading a scalar where
          // it expected a column has nowhere to put it.
          problems.push({
            where: `${where}/${field}`,
            message: `'${key}' is a single value — options come from a list`,
          });
        }
      }

      // What the source is told, checked at both ends: the name it is sent
      // under has to be a parameter that endpoint takes, and the answer sent
      // under it has to be one this endpoint collects. Either half wrong and
      // the source is called with a parameter it ignores or never called at
      // all, both of which reach a person as an empty menu.
      for (const [sends, answer] of Object.entries(source.needs ?? {})) {
        const at = `${where}/needs/${sends}`;
        if (!(named.params ?? []).some((one) => one.key === sends)) {
          problems.push({
            where: at,
            message: `'${source.endpoint}' takes no parameter '${sends}'`,
          });
        }
        if (answer === param.key) {
          // It would have to be answered before it could offer an answer.
          problems.push({
            where: at,
            message: `'${answer}' is this parameter — it cannot be told its own answer`,
          });
        } else if (!(endpoint.params ?? []).some((one) => one.key === answer)) {
          problems.push({
            where: at,
            message: `'${answer}' is not a parameter of this endpoint`,
          });
        }
      }
    });
  });

  for (const block of ["pages", "fields", "parts", "actions"] as const) {
    (body[block] ?? []).forEach((item, index) => checkRequires(item.requires, `/${block}/${index}/requires`));
  }
  if (body.sign_in && !(body.pages ?? []).some((page) => page.id === body.sign_in?.page)) {
    problems.push({
      where: "/sign_in/page",
      message: `names '${body.sign_in.page}', which is not one of this manifest's pages`,
    });
  }
  (body.actions ?? []).forEach((action, index) => {
    const where = `/actions/${index}`;
    if (action.endpoint === undefined) {
      if (action.params) problems.push({ where: `${where}/params`, message: "an action asks for its endpoint's parameters, and names no endpoint" });
      return;
    }
    // Initiative calls an action's endpoint for the reader. A container's does
    // the work, so it is a write; a declarative plug-in's `write` does the work,
    // so its endpoint may be a read that fetches what the write keeps.
    const named = byId.get(action.endpoint);
    const allowed = body.service === undefined ? ["read", "write"] : ["write"];
    if (!named || !allowed.includes(named.direction)) {
      problems.push({
        where: `${where}/endpoint`,
        message: named
          ? `names '${action.endpoint}', which is a ${named.direction} endpoint`
          : `names '${action.endpoint}', which this manifest does not declare`,
      });
      return;
    }
    // The endpoint is sent what the reader was asked for, and nothing else.
    const params = named.params ?? [];
    (action.params ?? []).forEach((key, position) => {
      if (!params.some((param) => param.key === key)) {
        problems.push({ where: `${where}/params/${position}`, message: `'${key}' is not a parameter of '${action.endpoint}'` });
      }
    });
    for (const param of params) {
      if (param.required && !action.params?.includes(param.key)) {
        problems.push({
          where: `${where}/params`,
          message: `'${action.endpoint}' requires '${param.key}', which the action does not ask for`,
        });
      }
    }
  });
  (body.widgets ?? []).forEach((widget, index) => {
    checkRequires(widget.requires, `/widgets/${index}/requires`);
    for (const id of widget.endpoints ?? []) {
      // The restriction is the widget's, not the endpoint's: a widget draws
      // what it is given, so it can only bind one that answers. An automation
      // reaching the same endpoint is under no such rule.
      if (!readable.has(id)) {
        problems.push({
          where: `/widgets/${index}/endpoints`,
          message: `binds '${id}', which is not a declared read endpoint`,
        });
      }
    }
  });

  return problems;
}

/**
 * The rules tying a connection's flow and token to its scope and fields, and
 * every `{…}` a flow or token names.
 *
 * The platform refuses each of these on publish; they are repeated here so an
 * author finds out before that.
 */
/**
 * Each permission declared once at its level, and every page, field, part,
 * action and endpoint naming one declared where it is held, or `use`, which
 * every plug-in has at each level. A page is held at each level it renders in;
 * the rest inside an initiative.
 */
function permissionProblems(body: Manifest): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const declared = new Set<string>();
  (body.permissions ?? []).forEach((permission, index) => {
    const key = `${permission.level}:${permission.id}`;
    if (declared.has(key)) {
      problems.push({
        where: `/permissions/${index}/id`,
        message: `'${permission.id}' is declared twice at the ${permission.level} level`,
      });
    }
    declared.add(key);
  });
  const named = (entries: Array<{ permission?: string }> | undefined, block: string, levels: (index: number) => readonly string[]) =>
    (entries ?? []).forEach((entry, index) => {
      const id = entry.permission;
      if (id === undefined || id === "use") return;
      for (const level of levels(index)) {
        if (!declared.has(`${level}:${id}`)) {
          problems.push({
            where: `/${block}/${index}/permission`,
            message: `'${id}' is not a permission this manifest declares at the ${level} level`,
          });
        }
      }
    });
  named(body.pages, "pages", (index) => body.pages![index].scopes ?? ["community"]);
  for (const block of ["fields", "parts", "actions", "endpoints"] as const) named(body[block], block, () => ["initiative"]);
  return problems;
}

function connectionProblems(body: Manifest): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const vendorKeys = new Set((body.vendor?.fields ?? []).map((field) => field.key));

  (body.connections ?? []).forEach((connection, index) => {
    const where = `/connections/${index}`;
    const fieldKeys = new Set(connection.fields.map((field) => field.key));
    const flow = connection.flow;

    if (connection.scope === "interactive" && !flow) {
      problems.push({
        where,
        message: "an interactive connection declares a flow — each member authorizes their own account",
      });
    }
    if (connection.scope === "static" && !flow && connection.fields.length === 0) {
      problems.push({
        where: `${where}/fields`,
        message: "a static connection without a flow declares at least one field for an admin to fill in",
      });
    }
    if (connection.after_connect && (flow || connection.scope !== "static")) {
      problems.push({
        where: `${where}/after_connect`,
        message: "after_connect beside the fields is for a static connection without a flow; a flow names its own",
      });
    }
    if (!flow && !connection.after_connect && connection.fields.some((field) => field.managed === true)) {
      problems.push({
        where: `${where}/after_connect`,
        message: "managed values come from the after_connect hook, which this connection does not call",
      });
    }
    if (flow) {
      connection.fields.forEach((field, position) => {
        if (field.managed !== true) {
          problems.push({
            where: `${where}/fields/${position}`,
            message: "a connection with a flow holds only managed values — mark the field managed",
          });
        }
      });
      if (connection.fields.length > 0 && !flow.after_connect) {
        problems.push({
          where: `${where}/flow/after_connect`,
          message: "managed values come from the after_connect hook, which this flow does not call",
        });
      }
      if (flow.install_url !== undefined) {
        if (connection.scope !== "static") {
          problems.push({
            where: `${where}/flow/install_url`,
            message: "an install page is for a static connection, which an organization installs",
          });
        }
        if (!flow.after_connect) {
          problems.push({
            where: `${where}/flow/install_url`,
            message: "an installation-style flow calls after_connect, which checks who installed it",
          });
        }
      }
      if ((flow.revoke === "rfc7009" || flow.revoke === "github_grant") && !flow.revoke_url) {
        problems.push({
          where: `${where}/flow/revoke_url`,
          message: `${flow.revoke} revocation is sent to revoke_url, which is missing`,
        });
      }
    }
    if (connection.token && connection.scope !== "static") {
      problems.push({
        where: `${where}/token`,
        message: "a minted token belongs to a static connection",
      });
    }

    const templated: Array<[string, string | undefined]> = [];
    if (flow) {
      for (const key of [
        "authorize_url",
        "token_url",
        "client_id",
        "client_secret",
        "install_url",
        "revoke_url",
      ] as const) {
        templated.push([`${where}/flow/${key}`, flow[key]]);
      }
      for (const [name, value] of Object.entries(flow.authorize_params ?? {})) {
        templated.push([`${where}/flow/authorize_params/${name}`, value]);
      }
    }
    if (connection.token) {
      for (const key of ["exchange_url", "iss", "key"] as const) {
        templated.push([`${where}/token/${key}`, connection.token[key]]);
      }
      // Every string in an object body, at any depth, is rendered as the others
      // are. An expression body is parsed with the other expressions instead:
      // its braces are JSONata's.
      const strings = (value: unknown, at: string): void => {
        if (typeof value === "string") templated.push([at, value]);
        else if (value && typeof value === "object") {
          for (const [key, child] of Object.entries(value)) strings(child, `${at}/${key}`);
        }
      };
      if (typeof connection.token.exchange_body === "object") {
        strings(connection.token.exchange_body, `${where}/token/exchange_body`);
      }
    }
    for (const [at, value] of templated) {
      for (const name of templateNames(value ?? "")) {
        if (name.startsWith("vendor.")) {
          if (!vendorKeys.has(name.slice("vendor.".length))) {
            problems.push({ where: at, message: `'{${name}}' is not a field of the vendor block` });
          }
        } else if (!fieldKeys.has(name)) {
          problems.push({ where: at, message: `'{${name}}' is not a field of this connection` });
        }
      }
    }
  });

  return problems;
}

/**
 * What a webhooks block names: its secret is one vendor value or a managed
 * secret field of the routed connection, and its route is a field of a static
 * connection.
 */
function webhookProblems(body: Manifest): ValidationProblem[] {
  const webhooks = body.webhooks;
  if (!webhooks) return [];
  const problems: ValidationProblem[] = [];
  const vendorKeys = new Set((body.vendor?.fields ?? []).map((field) => field.key));
  const { connection: connectionId, field } = webhooks.route;
  const connection = (body.connections ?? []).find((entry) => entry.id === connectionId);
  const secret = webhooks.verify.secret;
  const names = templateNames(secret);
  const name = names.length === 1 && secret === `{${names[0]}}` ? names[0] : null;
  if (name === null) {
    problems.push({
      where: "/webhooks/verify/secret",
      message: "the signing secret is one vendor value, '{vendor.<key>}', or one field of the routed connection, '{<key>}'",
    });
  } else if (name.startsWith("vendor.")) {
    if (!vendorKeys.has(name.slice("vendor.".length))) {
      problems.push({
        where: "/webhooks/verify/secret",
        message: `'{${name}}' is not a field of the vendor block`,
      });
    }
  } else {
    const secretField = connection?.fields.find((entry) => entry.key === name);
    if (!secretField || secretField.managed !== true || secretField.type !== "secret") {
      problems.push({
        where: "/webhooks/verify/secret",
        message: `'{${name}}' is not a managed secret field of the connection '${connectionId}'`,
      });
    }
  }

  if ((webhooks.route.path === undefined) === (webhooks.route.header === undefined)) {
    problems.push({
      where: "/webhooks/route",
      message: "a delivery is routed by exactly one of 'path' and 'header'",
    });
  }
  if (!connection || connection.scope !== "static") {
    problems.push({
      where: "/webhooks/route/connection",
      message: `'${connectionId}' is not a static connection this plug-in declares`,
    });
  } else if (!connection.fields.some((entry) => entry.key === field)) {
    problems.push({
      where: "/webhooks/route/field",
      message: `'${field}' is not a field of the connection '${connectionId}'`,
    });
  }
  return problems;
}

/** GitHub's answers that are kept as secrets. */
const SECRET_VALUES = new Set(["client_secret", "pem", "webhook_secret"]);

/**
 * What a vendor setup writes to: each value is a field of the vendor block, an
 * answer that is a secret goes to a secret field, and no answer is written
 * twice.
 */
function setupProblems(body: Manifest): ValidationProblem[] {
  const setup = body.vendor?.setup;
  if (!setup) return [];
  const problems: ValidationProblem[] = [];
  const fields = new Map(body.vendor!.fields.map((field) => [field.key, field]));
  const written = new Set<string>();
  for (const [key, value] of Object.entries(setup.values)) {
    const where = `/vendor/setup/values/${key}`;
    const field = fields.get(key);
    if (!field) {
      problems.push({ where, message: `'${key}' is not a field of the vendor block` });
    } else if (SECRET_VALUES.has(value) && field.type !== "secret") {
      problems.push({ where, message: `'${value}' is a secret, and '${key}' is not a secret field` });
    }
    if (written.has(value)) {
      problems.push({ where, message: `'${value}' is written to more than one field` });
    }
    written.add(value);
  }
  return problems;
}

/**
 * What a vendor check reads and signs with: its rows name vendor fields, its
 * JWT is signed with one secret vendor value and issued by vendor values, its
 * credential's header is Initiative's to set, and every expression parses.
 */
function checkProblems(body: Manifest): ValidationProblem[] {
  const check = body.vendor?.check;
  if (!check) return [];
  const problems: ValidationProblem[] = [];
  const push = (where: string, message: string) => problems.push({ where, message });
  const fields = new Map(body.vendor!.fields.map((field) => [field.key, field]));
  const expression = (text: string | undefined, where: string) => {
    if (text === undefined) return;
    try {
      parseExpression(text);
    } catch (error) {
      const { message, position } = error as ExpressionError;
      push(where, `does not parse: ${message}${position === undefined ? "" : ` (at character ${position})`}`);
    }
  };

  const sign = check.sign;
  if (sign) {
    for (const name of templateNames(sign.iss)) {
      if (!name.startsWith("vendor.")) {
        push("/vendor/check/sign/iss", `'{${name}}' is not a vendor value: a check reads only the vendor block`);
      } else if (!fields.has(name.slice("vendor.".length))) {
        push("/vendor/check/sign/iss", `'{${name}}' is not a field of the vendor block`);
      }
    }
    const key = /^\{vendor\.([^{}]+)\}$/.exec(sign.key)?.[1];
    if (key === undefined) {
      push("/vendor/check/sign/key", "the signing key is one vendor value, '{vendor.<key>}'");
    } else if (!fields.has(key)) {
      push("/vendor/check/sign/key", `'{vendor.${key}}' is not a field of the vendor block`);
    } else if (fields.get(key)!.type !== "secret") {
      push("/vendor/check/sign/key", `'${key}' signs, so it is a secret field`);
    }
  } else if (check.auth) {
    push("/vendor/check/auth", "puts the signed JWT on the request, and there is none without 'sign'");
  }

  const request = check.request;
  const credentialHeader = (check.auth?.header ?? "Authorization").toLowerCase();
  expression(request.url, "/vendor/check/request/url");
  for (const [name, text] of Object.entries(request.query ?? {})) {
    expression(text, `/vendor/check/request/query/${name}`);
  }
  for (const [name, text] of Object.entries(request.headers ?? {})) {
    expression(text, `/vendor/check/request/headers/${name}`);
    if (sign && name.toLowerCase() === credentialHeader) {
      push(`/vendor/check/request/headers/${name}`, "the signed JWT's header is Initiative's to set");
    }
  }
  expression(request.body, "/vendor/check/request/body");

  check.expect.forEach((row, index) => {
    const where = `/vendor/check/expect/${index}`;
    expression(row.holds, `${where}/holds`);
    expression(row.shows, `${where}/shows`);
    row.fields.forEach((field, at) => {
      if (!fields.has(field)) push(`${where}/fields/${at}`, `'${field}' is not a field of the vendor block`);
    });
  });
  return problems;
}

/**
 * Each schedule's interval is within the bounds, and no two share an id. A
 * declarative plug-in's schedule makes a read as the installation, and its id
 * is no connection's.
 */
function scheduleProblems(body: Manifest): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const seen = new Set<string>();
  const declarative = body.service === undefined;
  const connections = new Set((body.connections ?? []).map((connection) => connection.id));
  (body.schedules ?? []).forEach((schedule, index) => {
    const where = `/schedules/${index}`;
    if (seen.has(schedule.id)) {
      problems.push({ where: `${where}/id`, message: `'${schedule.id}' is declared twice` });
    }
    seen.add(schedule.id);
    if (declarative && connections.has(schedule.id)) {
      problems.push({
        where: `${where}/id`,
        message: `'${schedule.id}' is also a connection's id, and Initiative keys connection health checks by connection id`,
      });
    }
    problems.push(...intervalProblems(schedule.every, `${where}/every`));
    if (!declarative || schedule.endpoint === undefined) return;
    const named = (body.endpoints ?? []).find((endpoint) => endpoint.id === schedule.endpoint);
    if (named?.direction !== "read") {
      problems.push({
        where: `${where}/endpoint`,
        message: named
          ? `names '${schedule.endpoint}', which is a ${named.direction} endpoint`
          : `names '${schedule.endpoint}', which this manifest does not declare`,
      });
    } else if (!named.actors?.includes("installation")) {
      problems.push({
        where: `${where}/endpoint`,
        message: `'${schedule.endpoint}' does not take the installation as its actor, and no person is present when a schedule runs`,
      });
    }
  });
  return problems;
}

/**
 * Fields, parts, actions and settings: each declared once, as is each of a
 * field's options, every part a tree Initiative can draw on every item kind it
 * is offered on, and a list field's element actions offered wherever the field
 * is. A node or a field naming a
 * field or an action that is not offered where it is would draw nothing there,
 * and a part's text names only the placeholders Initiative fills.
 */
function partProblems(body: Manifest): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  // Where each is offered, by its key or id, reporting one declared twice.
  const declared = (block: string, name: "key" | "id", items: Array<[string, ItemKind[]]>) => {
    const kinds = new Map<string, ItemKind[]>();
    items.forEach(([id, on], index) => {
      if (kinds.has(id)) problems.push({ where: `/${block}/${index}/${name}`, message: `'${id}' is declared twice` });
      kinds.set(id, on);
    });
    return kinds;
  };
  const fields = declared("fields", "key", (body.fields ?? []).map((field) => [field.key, field.on]));
  const actions = declared("actions", "id", (body.actions ?? []).map((action) => [action.id, action.on]));
  declared("parts", "id", (body.parts ?? []).map((part) => [part.id, part.on]));
  const settings = declared("settings", "key", (body.settings ?? []).map((setting) => [setting.key, []]));
  // What a part's node or a field names, offered on every kind its holder is.
  const reaches = (what: string, kinds: ItemKind[] | undefined, on: ItemKind[], holder: "part" | "field", where: string) => {
    if (!kinds) {
      problems.push({ where, message: `'${what}' is not declared by this manifest` });
      return;
    }
    const missing = on.filter((kind) => !kinds.includes(kind));
    if (missing.length) {
      problems.push({ where, message: `'${what}' is not offered on ${missing.join(", ")}, where this ${holder} is` });
    }
  };

  (body.fields ?? []).forEach((field, index) => {
    const where = `/fields/${index}/actions`;
    if (field.actions && !field.list) problems.push({ where, message: "actions are offered on a list's elements, and this field is not a list" });
    field.actions?.forEach((id, position) => reaches(id, actions.get(id), field.on, "field", `${where}/${position}`));
    const values = (field.options ?? []).map((option) => option.value);
    values.forEach((value, position) => {
      if (values.indexOf(value) !== position) {
        problems.push({ where: `/fields/${index}/options/${position}/value`, message: `'${value}' is declared twice` });
      }
    });
  });

  (body.parts ?? []).forEach((part, index) => {
    let count = 0;
    const visit = (node: PartNode, depth: number, where: string): void => {
      count += 1;
      if (depth > CAPS.partDepth) {
        problems.push({ where, message: `nested deeper than ${CAPS.partDepth}` });
        return;
      }
      if (node.type === "field" || node.type === "value") {
        reaches(node.props.field, fields.get(node.props.field), part.on, "part", `${where}/props/field`);
      }
      if (node.type === "button") reaches(node.props.action, actions.get(node.props.action), part.on, "part", `${where}/props/action`);
      if (node.type === "text") {
        for (const [language, words] of Object.entries(node.props.text)) {
          for (const name of typeof words === "string" ? templateNames(words) : []) {
            if (name === "item.id" || (name.startsWith("settings.") && settings.has(name.slice("settings.".length)))) continue;
            problems.push({
              where: `${where}/props/text/${language}`,
              message: name.startsWith("settings.")
                ? `'{${name}}' names a setting this manifest does not declare`
                : `'{${name}}' is not a placeholder: a part's text names '{item.id}' and '{settings.<key>}'`,
            });
          }
        }
      }
      if (node.type === "section" || node.type === "stack") {
        (node.children ?? []).forEach((child, position) => visit(child, depth + 1, `${where}/children/${position}`));
      }
    };
    visit(part.tree, 1, `/parts/${index}/tree`);
    if (count > CAPS.partNodes) {
      problems.push({ where: `/parts/${index}/tree`, message: `holds ${count} nodes, more than ${CAPS.partNodes}` });
    }
  });
  return problems;
}

/** An interval, a schedule's or a health check's, within the schedule bounds. */
function intervalProblems(every: string, where: string): ValidationProblem[] {
  const count = Number(every.slice(0, -1));
  const minutes = every.endsWith("h") ? count * 60 : count;
  if (minutes >= CAPS.scheduleMinMinutes && minutes <= CAPS.scheduleMaxMinutes) return [];
  return [{ where, message: `every is at least ${CAPS.scheduleMinMinutes}m and at most ${CAPS.scheduleMaxMinutes / 60}h` }];
}

/** What a tool plug-in carries beside its tool: it runs no code, so nothing that serves or calls. */
const TOOL_PLUGIN_TERMS: ReadonlySet<string> = new Set([
  "plugin_kind",
  "tool",
  "features",
  "default_name",
  "min_plugin_api",
  "minimum_age",
  "availability",
  "help",
]);

/** The comparisons an open condition makes between a number or counter field and an operand. */
const TOOL_COMPARISONS = ["below", "at_most", "above", "at_least", "equals", "not_equals"] as const;

/** The field kinds a counter's bounds and a comparison read. */
const TOOL_NUMBERS: ReadonlySet<ToolFieldKind> = new Set(["number", "counter"]);

/**
 * What is wrong with a key a tool declares, or undefined: a lower-case letter,
 * then lower-case letters, digits and '_', at most `toolKeyLength`
 * characters. Checked one character at a time; the schema's pattern says the
 * same for a reader of the schema alone.
 */
export function toolKeyProblem(key: string): string | undefined {
  if (key.length === 0) return "a key is not empty";
  if (key.length > CAPS.toolKeyLength) return `a key is at most ${CAPS.toolKeyLength} characters`;
  const first = key[0];
  if (first < "a" || first > "z") return "a key starts with a lower-case letter";
  for (const character of key) {
    if (!CHARSETS.toolKey.includes(character)) {
      return `a key holds lower-case letters, digits and '_', not '${character}'`;
    }
  }
  return undefined;
}

/** Whether `value` is a 'YYYY-MM-DD' date that exists, checked one character at a time. */
function isDate(value: string): boolean {
  if (value.length !== 10 || value[4] !== "-" || value[7] !== "-") return false;
  for (const at of [0, 1, 2, 3, 5, 6, 8, 9]) {
    if (value[at] < "0" || value[at] > "9") return false;
  }
  const [year, month, day] = [value.slice(0, 4), value.slice(5, 7), value.slice(8, 10)].map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Whether `value` is an ISO 8601 date and time with its offset. */
function isDateTime(value: string): boolean {
  if (value[10] !== "T" || !isDate(value.slice(0, 10)) || Number.isNaN(Date.parse(value))) return false;
  const time = value.slice(11);
  return time.endsWith("Z") || time.includes("+") || time.includes("-");
}

/** Whether `value` is a colour as '#rrggbb'. */
function isColor(value: string): boolean {
  if (value.length !== 7 || value[0] !== "#") return false;
  for (const character of value.slice(1)) {
    if (!"0123456789abcdefABCDEF".includes(character)) return false;
  }
  return true;
}

/** Whether `value` is an http or https address. */
function isAddress(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** What is wrong with a field's default for its kind, or undefined. */
function toolDefaultProblem(field: ToolField): string | undefined {
  const value: unknown = field.default;
  const options = new Set((field.options ?? []).map((option) => option.value));
  const kind = field.kind;
  switch (kind) {
    case "text":
      return typeof value === "string" ? undefined : "a text field's default is a string";
    case "url":
      return typeof value === "string" && isAddress(value) ? undefined : "a url field's default is an http or https address";
    case "date":
      return typeof value === "string" && isDate(value) ? undefined : "a date field's default is a 'YYYY-MM-DD' date";
    case "datetime":
      return typeof value === "string" && isDateTime(value)
        ? undefined
        : "a datetime field's default is an ISO 8601 date and time with its offset";
    case "color":
      return typeof value === "string" && isColor(value) ? undefined : "a color field's default is '#rrggbb'";
    case "number":
    case "currency":
      return typeof value === "number" && Number.isFinite(value) ? undefined : `a ${kind} field's default is a number`;
    case "scale":
      return typeof value === "number" && value >= 0 && value <= 100
        ? undefined
        : "a scale field's default is a number from 0 to 100";
    case "checkbox":
      return typeof value === "boolean" ? undefined : "a checkbox field's default is true or false";
    case "select":
      return typeof value === "string" && options.has(value) ? undefined : "a select field's default is one of its options' values";
    case "multi_select":
      return Array.isArray(value) &&
        new Set(value).size === value.length &&
        value.every((entry) => typeof entry === "string" && options.has(entry))
        ? undefined
        : "a multi_select field's default is a list of its options' values, each at most once";
    case "counter":
      return "a counter field starts at its counter's 'initial', not at a default";
    case "user_reference":
      return "a person is never a default";
  }
}

/**
 * A tool plug-in's terms. It carries its tool and the listing terms beside it,
 * and nothing that serves or calls; only a tool plug-in carries a tool. Its
 * keys are well formed, unique where they must be, and never a universal
 * column; its items sit under the tool or under an item that does; each
 * field's options, currency, counter and default fit its kind; an open
 * condition reads one of its item's fields of a kind that fits it; and every
 * action runs on the tool or an item, asks for that table's fields, and
 * writes an expression that parses.
 */
function toolProblems(body: Manifest): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const push = (where: string, message: string) => problems.push({ where, message });

  if (body.plugin_kind !== "tool") {
    if (body.tool !== undefined) push("/tool", "only a tool plug-in declares a tool: its plugin_kind is 'tool'");
    return problems;
  }
  for (const term of FIELDS.manifest) {
    if (body[term] !== undefined && !TOOL_PLUGIN_TERMS.has(term)) {
      push(
        `/${term}`,
        "a tool plug-in runs no code: beside its tool it carries only features, default_name, min_plugin_api, minimum_age, availability and help"
      );
    }
  }
  if (body.features.length !== 1 || body.features[0] !== "tool") {
    push("/features", "a tool plug-in's features are exactly ['tool']");
  }
  const tool = body.tool;
  if (tool === undefined) {
    push("/tool", "a tool plug-in declares its tool");
    return problems;
  }

  const key = (value: string, where: string) => {
    const problem = toolKeyProblem(value);
    if (problem) push(where, problem);
  };
  key(tool.key, "/tool/key");

  // The tool's own rows, then each item table, with where each sits.
  const items = tool.items ?? [];
  const tables = new Map<string, { where: string; fields: ToolField[]; layouts: ToolLayouts }>([
    [tool.key, { where: "/tool", fields: tool.fields ?? [], layouts: tool.layouts }],
  ]);
  items.forEach((item, index) => {
    const where = `/tool/items/${index}`;
    key(item.key, `${where}/key`);
    if (item.key === tool.key) push(`${where}/key`, `'${item.key}' is the tool's key`);
    else if (tables.has(item.key)) push(`${where}/key`, `'${item.key}' is declared twice`);
    else tables.set(item.key, { where, fields: item.fields, layouts: item.layouts });
  });
  const parents = new Map(items.map((item) => [item.key, item.parent]));
  items.forEach((item, index) => {
    if (item.parent === undefined) return;
    const where = `/tool/items/${index}/parent`;
    if (item.parent === item.key) push(where, "an item does not sit under itself");
    else if (!parents.has(item.parent)) {
      push(where, `'${item.parent}' is not one of the tool's items; leave 'parent' out for an item under the tool`);
    } else if (parents.get(item.parent) !== undefined) {
      push(where, `'${item.parent}' sits under another item, and items go two levels deep at most`);
    }
  });

  for (const { where, fields } of tables.values()) {
    const byKey = new Map<string, ToolField>();
    fields.forEach((field, index) => {
      const at = `${where}/fields/${index}`;
      key(field.key, `${at}/key`);
      if ((TOOL_COLUMNS as readonly string[]).includes(field.key)) {
        push(`${at}/key`, `'${field.key}' is a column every tool's rows have`);
      } else if ((TOOL_LAYOUT_FIELDS as readonly string[]).includes(field.key)) {
        push(`${at}/key`, `'${field.key}' is a field every tool's rows have`);
      } else if (field.key.endsWith("_id")) {
        push(`${at}/key`, `'${field.key}' ends in '_id', as Initiative's keys to a parent do`);
      }
      if (byKey.has(field.key)) push(`${at}/key`, `'${field.key}' is declared twice`);
      else byKey.set(field.key, field);
    });
    fields.forEach((field, index) => {
      const at = `${where}/fields/${index}`;
      const select = field.kind === "select" || field.kind === "multi_select";
      if (field.options && !select) push(`${at}/options`, "only a select or multi_select field has options");
      const values = (field.options ?? []).map((option) => option.value);
      values.forEach((value, o) => {
        if (values.indexOf(value) !== o) push(`${at}/options/${o}/value`, `'${value}' is an option twice`);
      });
      if (field.currency !== undefined && field.kind !== "currency") {
        push(`${at}/currency`, "only a currency field names a currency");
      }
      if (field.counter && field.kind !== "counter") push(`${at}/counter`, "only a counter field has a counter");
      if (field.counter && field.kind === "counter") {
        const bounds = field.counter;
        for (const name of ["min", "max", "step", "initial"] as const) {
          const bound = bounds[name];
          if (typeof bound !== "string") continue;
          if (byKey.get(bound)?.kind !== "number") {
            push(`${at}/counter/${name}`, `'${bound}' is not a number field of this table`);
          }
        }
        if (typeof bounds.step === "number" && bounds.step <= 0) push(`${at}/counter/step`, "a step is above 0");
        if (typeof bounds.min === "number" && typeof bounds.max === "number" && bounds.min > bounds.max) {
          push(`${at}/counter`, "its min is above its max");
        }
      }
      if (field.default !== undefined) {
        const problem = toolDefaultProblem(field);
        if (problem) push(`${at}/default`, problem);
      }
    });
  }

  for (const [table, { where, fields, layouts }] of tables) {
    problems.push(...layoutProblems(table, fields, layouts, `${where}/layouts`));
  }

  items.forEach((item, index) => {
    const condition = item.open_while;
    if (!condition) return;
    const where = `/tool/items/${index}/open_while`;
    const fields = new Map(item.fields.map((field) => [field.key, field]));
    const terms = Object.keys(condition).filter((term) => term !== "field");
    if (terms.length !== 1) {
      push(where, `an open condition is one condition on its field, not ${terms.map((term) => `'${term}'`).join(" and ")}`);
      return;
    }
    const [term] = terms;
    const field = fields.get(condition.field);
    if (!field) {
      push(`${where}/field`, `'${condition.field}' is not a field of this item`);
      return;
    }
    const fits = (kinds: readonly ToolFieldKind[], what: string) => {
      if (!kinds.includes(field.kind)) push(`${where}/${term}`, `'${term}' reads ${what}, and '${field.key}' is a ${field.kind} field`);
    };
    if ((TOOL_COMPARISONS as readonly string[]).includes(term)) {
      fits([...TOOL_NUMBERS], "a number or counter field");
      const operand = condition[term as (typeof TOOL_COMPARISONS)[number]] as ToolOperand;
      if (typeof operand === "object" && !TOOL_NUMBERS.has(fields.get(operand.field)?.kind as ToolFieldKind)) {
        push(`${where}/${term}/field`, `'${operand.field}' is not a number or counter field of this item`);
      }
    } else if (term === "is") {
      fits(["checkbox"], "a checkbox field");
    } else if (term === "in") {
      fits(["select"], "a select field");
      const options = new Set((field.options ?? []).map((option) => option.value));
      (condition.in ?? []).forEach((value, at) => {
        if (field.kind === "select" && !options.has(value)) push(`${where}/in/${at}`, `'${value}' is not an option of '${field.key}'`);
      });
    } else if (term === "not_passed") {
      fits(["date", "datetime"], "a date or datetime field");
    }
  });

  const actionIds = new Set<string>();
  (tool.actions ?? []).forEach((action, index) => {
    const where = `/tool/actions/${index}`;
    if (actionIds.has(action.id)) push(`${where}/id`, `'${action.id}' is declared twice`);
    actionIds.add(action.id);
    const table = tables.get(action.on);
    if (!table) push(`${where}/on`, `'${action.on}' is neither the tool's key nor one of its items' keys`);
    const fields = new Set((table?.fields ?? []).map((field) => field.key));
    (action.params ?? []).forEach((param, at) => {
      if (table && !fields.has(param)) push(`${where}/params/${at}`, `'${param}' is not a field of '${action.on}'`);
    });
    try {
      parseExpression(action.write);
    } catch (error) {
      const { message, position } = error as ExpressionError;
      push(`${where}/write`, `does not parse: ${message}${position === undefined ? "" : ` (at character ${position})`}`);
    }
  });
  return problems;
}

/** The looks a scale and a counter field are drawn in on a list. */
const TOOL_LOOKS: Partial<Record<ToolFieldKind, readonly FieldDisplay[]>> = {
  scale: ["number", "stars", "bar"],
  counter: ["number", "bar", "clock"],
};

/** The kinds of field that are never empty, so a layout never requires one. */
const NEVER_EMPTY: ReadonlySet<ToolFieldKind> = new Set(["counter", "checkbox"]);

/**
 * What is wrong with one table's layouts: every field they name is one the
 * table declares or one every row has; a field drawn in a look is a scale or
 * counter field the look fits; a required field is one the table declares and
 * a person can leave empty; and each layout holds at most `layoutNodes` parts
 * (a table's columns count as parts), at most `layoutDepth` deep. Which parts
 * and props it may hold, and which list holds a card or columns, the schema
 * says.
 */
function layoutProblems(table: string, fields: ToolField[], layouts: ToolLayouts, at: string): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const push = (where: string, message: string) => problems.push({ where, message });
  const declared = new Map(fields.map((field) => [field.key, field]));
  const names = (field: string, where: string) => {
    if (!declared.has(field) && !(TOOL_LAYOUT_FIELDS as readonly string[]).includes(field)) {
      push(where, `'${field}' is not a field of '${table}'`);
    }
  };
  // Every part of a tree, counted, with how deep it sits.
  const measure = (where: string) => {
    let count = 0;
    let deepest = 0;
    const visit = (part: LayoutCardPart | LayoutDetailPart, depth: number, path: string): void => {
      count += 1;
      deepest = Math.max(deepest, depth);
      if (part.type === "field") {
        names(part.props.field, `${path}/props/field`);
        if ("required" in part.props && part.props.required) {
          const field = declared.get(part.props.field);
          if (!field) {
            push(`${path}/props/required`, `only a field '${table}' declares can be required, and '${part.props.field}' is every row's`);
          } else if (NEVER_EMPTY.has(field.kind)) {
            push(`${path}/props/required`, `'${field.key}' is a ${field.kind} field, which is never empty`);
          }
        }
      }
      if ("children" in part) {
        (part.children ?? []).forEach((child, index) => visit(child, depth + 1, `${path}/children/${index}`));
      }
    };
    const done = (loose: number) => {
      if (count + loose > CAPS.layoutNodes) push(where, `holds ${count + loose} parts, more than ${CAPS.layoutNodes}`);
      if (deepest > CAPS.layoutDepth) push(where, `nests parts ${deepest} deep, deeper than ${CAPS.layoutDepth}`);
    };
    return { visit, done };
  };

  const list = layouts.list;
  const listed = measure(`${at}/list`);
  if (list.card) listed.visit(list.card, 1, `${at}/list/card`);
  (list.columns ?? []).forEach((field, index) => names(field, `${at}/list/columns/${index}`));
  listed.done(list.columns?.length ?? 0);
  for (const [key, look] of Object.entries(list.displays ?? {})) {
    const where = `${at}/list/displays/${key}`;
    const field = declared.get(key);
    const looks = field && TOOL_LOOKS[field.kind];
    if (!field) push(where, `'${key}' is not a field '${table}' declares`);
    else if (!looks) push(where, `'${key}' is a ${field.kind} field, and only a scale or counter field has a look`);
    else if (!looks.includes(look)) push(where, `a ${field.kind} field is drawn as ${looks.map((each) => `'${each}'`).join(", ")}, not '${look}'`);
  }

  const shown = measure(`${at}/detail`);
  for (const region of ["header", "main", "side"] as const) {
    (layouts.detail[region] ?? []).forEach((part, index) => shown.visit(part, 1, `${at}/detail/${region}/${index}`));
  }
  shown.done(0);
  return problems;
}

/** The endpoint terms that make it declarative. */
const DECLARATIVE_TERMS = ["request", "steps", "map", "errors"] as const;

/**
 * A plug-in is one kind or the other. A declarative plug-in — no `service` block —
 * names its hosts, and every read and write it offers is a request and a map:
 * there is no container for a handler, hook or page to run in, so its schedules
 * and actions say in expressions what Initiative does. It asks only for read
 * scopes. A container plug-in uses none of the declarative terms.
 */
function kindProblems(body: Manifest): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const push = (where: string, message: string) => problems.push({ where, message });
  const endpoints = body.endpoints ?? [];
  const connections = body.connections ?? [];

  if (body.service === undefined) {
    if (!body.hosts) push("/hosts", "a declarative plug-in (one with no service block) names the hosts it calls");
    if (body.pages) push("/pages", "a declarative plug-in has no pages: a page is served by a container");
    (body.scopes ?? []).forEach((scope, index) => {
      if (!scope.endsWith(":read")) {
        push(
          `/scopes/${index}`,
          "a declarative plug-in asks only for read scopes: it keeps its own values on items it can read, and does not call Initiative"
        );
      }
    });
    (body.schedules ?? []).forEach((schedule, index) => {
      if (schedule.endpoint === undefined || schedule.write === undefined) {
        push(
          `/schedules/${index}`,
          "a declarative plug-in's schedule names the read it makes and the write it makes from the answer: there is no hook to call"
        );
      }
    });
    (body.actions ?? []).forEach((action, index) => {
      if (action.endpoint === undefined && action.write === undefined) {
        push(`/actions/${index}`, "a declarative plug-in's action names an endpoint, a write, or both");
      }
    });
    endpoints.forEach((endpoint, index) => {
      const where = `/endpoints/${index}`;
      if (endpoint.direction === "emit") {
        for (const key of DECLARATIVE_TERMS) {
          if (endpoint[key] !== undefined) push(`${where}/${key}`, "an emit endpoint makes no call: a webhook event emits it");
        }
      } else if ((endpoint.request === undefined) === (endpoint.steps === undefined)) {
        push(where, "a declarative endpoint gives exactly one of 'request' and 'steps'");
      } else if (endpoint.map === undefined) {
        push(`${where}/map`, "a declarative endpoint maps its answer");
      }
    });
    connections.forEach((connection, index) => {
      if (connection.after_connect) {
        push(`/connections/${index}/after_connect`, "a declarative plug-in has no after_connect hook to check what an admin types");
      }
      const where = `/connections/${index}/flow`;
      if (connection.flow?.after_connect === true) {
        push(`${where}/after_connect`, "a declarative plug-in gives after_connect's request and map: there is no hook to call");
      }
      if (connection.flow?.revoke === "hook") push(`${where}/revoke`, "a declarative plug-in has no revoke hook");
    });
    if (body.webhooks && !body.webhooks.events && !body.webhooks.status) {
      push("/webhooks", "a declarative plug-in maps deliveries with 'events' or 'status': there is no hook to forward them to");
    }
  } else {
    for (const key of ["hosts", "auth"] as const) {
      if (body[key] !== undefined) push(`/${key}`, `'${key}' is a declarative plug-in's term; a container plug-in makes its own calls`);
    }
    if (body.scopes !== undefined) push("/scopes", "a container plug-in declares its scopes in its service block");
    (body.schedules ?? []).forEach((schedule, index) => {
      for (const key of ["endpoint", "params", "write"] as const) {
        if (schedule[key] !== undefined) push(`/schedules/${index}/${key}`, "a container plug-in's schedule calls its schedule hook");
      }
    });
    (body.actions ?? []).forEach((action, index) => {
      if (action.endpoint === undefined) {
        push(`/actions/${index}`, "a container plug-in's action names the write endpoint its handler answers");
      }
      if (action.write !== undefined) push(`/actions/${index}/write`, "a container plug-in's action is answered by its handler");
    });
    (body.fields ?? []).forEach((field, index) => {
      if (field.actions !== undefined) {
        push(`/fields/${index}/actions`, "a container plug-in's action is not told which element it was run from: its handler is handed the item alone");
      }
    });
    endpoints.forEach((endpoint, index) => {
      for (const key of DECLARATIVE_TERMS) {
        if (endpoint[key] !== undefined) {
          push(`/endpoints/${index}/${key}`, "a container plug-in's endpoint is answered by its handler");
        }
      }
    });
    connections.forEach((connection, index) => {
      if (typeof connection.flow?.after_connect === "object") {
        push(`/connections/${index}/flow/after_connect`, "a container plug-in sets after_connect true and answers it in its hook");
      }
      if (connection.health) push(`/connections/${index}/health`, "health is a declarative plug-in's: a container checks its own connections");
    });
    for (const key of ["events", "status"] as const) {
      if (body.webhooks?.[key]) push(`/webhooks/${key}`, "a container plug-in's webhook hook receives each delivery");
    }
  }
  return problems;
}

/** The step names an expression reads at its root, as `steps.<name>` or `$$.steps.<name>`. */
function stepReads(node: unknown, names: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    for (const child of node) stepReads(child, names);
  } else if (node && typeof node === "object") {
    const { type, steps } = node as { type?: string; steps?: Array<{ type: string; value: unknown }> };
    if (type === "path" && Array.isArray(steps)) {
      const start = steps[0]?.type === "variable" && steps[0].value === "$" ? 1 : 0;
      if (steps[start]?.type === "name" && steps[start].value === "steps" && steps[start + 1]?.type === "name") {
        names.add(String(steps[start + 1].value));
      }
    }
    for (const child of Object.values(node)) stepReads(child, names);
  }
  return names;
}

/** True when a host is well formed: labels of 1 to 63 characters, not edged with '-', and a name rather than an address. */
function wellFormedHost(host: string): boolean {
  const labels = (host.startsWith("*.") ? host.slice(2) : host).split(".");
  return (
    labels.every((label) => label.length <= 63 && !label.startsWith("-") && !label.endsWith("-")) &&
    !/^[0-9]+$/.test(labels[labels.length - 1])
  );
}

/**
 * What a declarative plug-in's terms say: every expression parses, every request
 * names what it may, a request naming a member's connection for every call is
 * on an endpoint whose `requires` names it and whose actors leave out the
 * installation, a request naming a connection per actor names one for each of
 * the endpoint's actors (the member's interactive, the installation's static),
 * steps read only the steps before them, every event row emits a declared
 * emission with its map, writes, or both, and each refusal names a code the
 * endpoint has.
 */
function declarativeProblems(body: Manifest): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const push = (where: string, message: string) => problems.push({ where, message });
  const connectionIds = new Set((body.connections ?? []).map((connection) => connection.id));
  const interactive = new Set(
    (body.connections ?? []).filter((connection) => connection.scope === "interactive").map((connection) => connection.id)
  );
  const authHeader = (body.auth?.header ?? "Authorization").toLowerCase();

  /** Parses, and with `steps` given, reads only those steps. */
  const expression = (text: string | undefined, where: string, steps?: ReadonlySet<string>) => {
    if (text === undefined) return;
    let ast: unknown;
    try {
      ast = parseExpression(text);
    } catch (error) {
      const { message, position } = error as ExpressionError;
      push(where, `does not parse: ${message}${position === undefined ? "" : ` (at character ${position})`}`);
      return;
    }
    if (!steps) return;
    for (const name of stepReads(ast, new Set())) {
      if (!steps.has(name)) push(where, `reads steps.${name}, which is not a step before it`);
    }
  };

  const request = (value: VendorRequest, where: string, owned: boolean, steps?: ReadonlySet<string>) => {
    expression(value.url, `${where}/url`, steps);
    for (const [name, text] of Object.entries(value.query ?? {})) expression(text, `${where}/query/${name}`, steps);
    for (const [name, text] of Object.entries(value.headers ?? {})) {
      expression(text, `${where}/headers/${name}`, steps);
      if (name.toLowerCase() === authHeader) {
        push(`${where}/headers/${name}`, "the credential's header is Initiative's to set");
      }
    }
    expression(value.body, `${where}/body`, steps);
    expression(value.graphql?.variables, `${where}/graphql/variables`, steps);
    if (value.body !== undefined && value.graphql !== undefined) {
      push(where, "a request sends a body or a GraphQL query, not both");
    }
    if (value.graphql !== undefined && value.method !== "POST") {
      push(`${where}/method`, "a GraphQL request is sent by POST");
    }
    if (owned && value.connection !== undefined) {
      push(`${where}/connection`, "carries the credential of the connection it belongs to, and names none");
    } else if (!owned && value.connection === undefined) {
      push(where, "names the connection whose credential it carries");
    } else if (typeof value.connection === "string" && !connectionIds.has(value.connection)) {
      push(`${where}/connection`, `'${value.connection}' is not a connection this plug-in declares`);
    }
    const paging = value.paging;
    if (paging) {
      expression(paging.items, `${where}/paging/items`, steps);
      if (paging.kind === "cursor") {
        expression(paging.next, `${where}/paging/next`, steps);
        expression(paging.more, `${where}/paging/more`, steps);
        if ((paging.param === undefined) === (paging.variable === undefined)) {
          push(`${where}/paging`, "a cursor is sent in exactly one of 'param' and 'variable'");
        } else if (paging.variable !== undefined && value.graphql === undefined) {
          push(`${where}/paging/variable`, "a cursor is sent in a variable only of a GraphQL request");
        }
      }
    }
  };

  (body.hosts ?? []).forEach((host, index) => {
    if (!wellFormedHost(host)) push(`/hosts/${index}`, `'${host}' is not a host name`);
  });

  const emits = new Set(
    (body.endpoints ?? []).filter((endpoint) => endpoint.direction === "emit").map((endpoint) => endpoint.id)
  );

  (body.endpoints ?? []).forEach((endpoint, index) => {
    const where = `/endpoints/${index}`;
    const names = new Set<string>();
    // A member's own connection is resolved for the caller by `requires`, so a
    // request carrying one on every call names it there too. A request naming a
    // connection per actor carries the member's only on a call made as the
    // member, which requires it.
    const required = new Set(Object.values(endpoint.requires ?? {}).flat());
    const actorConnection = (value: VendorRequest, at: string) => {
      const named = value.connection;
      if (typeof named === "string") {
        if (!interactive.has(named)) return;
        if (!required.has(named)) {
          push(`${at}/connection`, `its request uses the member connection '${named}', which requires does not name`);
        }
        if (endpoint.actors?.includes("installation")) {
          push(
            `${at}/connection`,
            `its request uses the member connection '${named}', which a call made as the installation does not have: name a connection per actor`
          );
        }
      } else if (named !== undefined) {
        if (!endpoint.actors) {
          push(`${at}/connection`, "names a connection per actor, and the endpoint declares no actors");
        } else {
          for (const actor of ACTOR_KINDS) {
            const id = named[actor];
            const entry = `${at}/connection/${actor}`;
            if (id === undefined) {
              if (endpoint.actors.includes(actor)) push(`${at}/connection`, `names no connection for '${actor}', one of the endpoint's actors`);
            } else if (!endpoint.actors.includes(actor)) {
              push(entry, `'${actor}' is not one of the endpoint's actors`);
            } else if (!connectionIds.has(id)) {
              push(entry, `'${id}' is not a connection this plug-in declares`);
            } else if (actor === "member" && !interactive.has(id)) {
              push(entry, `'${id}' is not an interactive connection: a call made as the member carries the member's own credential`);
            } else if (actor === "installation" && interactive.has(id)) {
              push(entry, `'${id}' is not a static connection: a call made as the installation carries the community's credential`);
            }
          }
        }
      }
    };
    if (endpoint.request) {
      request(endpoint.request, `${where}/request`, false, names);
      actorConnection(endpoint.request, `${where}/request`);
    }
    (endpoint.steps ?? []).forEach((step, position) => {
      const at = `${where}/steps/${position}`;
      request(step.request, `${at}/request`, false, new Set(names));
      actorConnection(step.request, `${at}/request`);
      if (names.has(step.name)) push(`${at}/name`, `'${step.name}' names two steps`);
      names.add(step.name);
    });
    expression(endpoint.map, `${where}/map`, names);
    const codes = new Set<string>([...(endpoint.unavailable ?? []), ...PLATFORM_CODES, "transient"]);
    (endpoint.errors ?? []).forEach((rule, position) => {
      expression(rule.when, `${where}/errors/${position}/when`, names);
      if (!codes.has(rule.code)) {
        push(`${where}/errors/${position}/code`, `'${rule.code}' is not one of this endpoint's unavailable codes`);
      }
    });
  });

  (body.connections ?? []).forEach((connection, index) => {
    const where = `/connections/${index}`;
    const after = connection.flow?.after_connect;
    if (typeof after === "object") {
      const at = `${where}/flow/after_connect`;
      const names = new Set<string>();
      if (after.request) request(after.request, `${at}/request`, true, names);
      (after.steps ?? []).forEach((step, position) => {
        request(step.request, `${at}/steps/${position}/request`, true, new Set(names));
        if (names.has(step.name)) push(`${at}/steps/${position}/name`, `'${step.name}' names two steps`);
        names.add(step.name);
      });
      expression(after.map, `${at}/map`, names);
      expression(after.refuse_when, `${at}/refuse_when`, names);
      if ((after.refuse_when === undefined) !== (after.code === undefined)) {
        push(at, "a refusal gives both 'refuse_when' and the 'code' it answers");
      }
    }
    // Either kind's token may answer its body with an expression.
    const exchange = connection.token?.exchange_body;
    if (typeof exchange === "string") expression(exchange, `${where}/token/exchange_body`);
    const health = connection.health;
    if (health) {
      request(health.request, `${where}/health/request`, true);
      health.states.forEach((row, position) => expression(row.when, `${where}/health/states/${position}/when`));
      problems.push(...intervalProblems(health.every, `${where}/health/every`));
    }
  });

  (body.webhooks?.events ?? []).forEach((event, index) => {
    const where = `/webhooks/events/${index}`;
    expression(event.when, `${where}/when`);
    expression(event.map, `${where}/map`);
    expression(event.write, `${where}/write`);
    if (event.emit === undefined && event.write === undefined) push(where, "an event row emits, writes, or both");
    if ((event.emit === undefined) !== (event.map === undefined)) {
      push(where, "an event row gives both 'emit' and the 'map' of its payload");
    }
    if (event.emit !== undefined && !emits.has(event.emit)) {
      push(`${where}/emit`, `'${event.emit}' is not an emit endpoint this plug-in declares`);
    }
  });
  (body.actions ?? []).forEach((action, index) => expression(action.write, `/actions/${index}/write`));
  (body.schedules ?? []).forEach((schedule, index) => {
    expression(schedule.params, `/schedules/${index}/params`);
    expression(schedule.write, `/schedules/${index}/write`);
  });
  (body.webhooks?.status ?? []).forEach((row, index) => {
    const where = `/webhooks/status/${index}`;
    expression(row.when, `${where}/when`);
    if (!connectionIds.has(row.connection)) {
      push(`${where}/connection`, `'${row.connection}' is not a connection this plug-in declares`);
    }
    if (row.state === "unavailable") {
      push(`${where}/state`, "a delivery says a connection is ok, suspended or removed");
    }
  });

  return problems;
}

/** Every `{name}` in a template, in order. */
export function templateNames(value: string): string[] {
  const names: string[] = [];
  let start = value.indexOf("{");
  while (start !== -1) {
    const end = value.indexOf("}", start + 1);
    if (end === -1) break;
    names.push(value.slice(start + 1, end));
    start = value.indexOf("{", end + 1);
  }
  return names;
}
