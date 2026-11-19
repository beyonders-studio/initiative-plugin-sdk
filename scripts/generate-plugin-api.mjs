#!/usr/bin/env node
/**
 * Publish Initiative's plug-in API, and generate the typed client from it.
 *
 * Initiative describes every route an installed plug-in may call in its own
 * OpenAPI document. This SDK publishes that document as the plug-in API
 * contract, `schemas/plugin-api.json`, at its own version: `info.version` is
 * the package's version, and `info["x-initiative-source"]` names the Initiative
 * release and commit it was taken from. Every plug-in, in any language,
 * generates its client from that file; Initiative holds itself to it.
 *
 * Taking the document from Initiative (`--checkout`, `--release`, `--url`)
 * writes `schemas/plugin-api.json` and then the client. With no source, the
 * client is generated from `schemas/plugin-api.json` alone, never from
 * Initiative, and the file's `info.version` follows the package's version.
 * The client, `src/plugin-api.generated.ts`, is:
 *
 * - `PluginApiSchemas`, every schema the operations reach, and
 *   `PluginApiOperations`, each operation's arguments by where they go and its
 *   answer, as TypeScript by the emitter the contract's types use
 *   (`ts-emit.mjs`);
 * - the operations table (`{ method, path, scope }` per operation id, with
 *   `json` naming the query parameters sent as JSON) and the `PluginApi`
 *   methods `client.api` exposes.
 *
 * Take the document again when Initiative's plug-in API grows.
 *
 *   node scripts/generate-plugin-api.mjs --checkout ../initiative   # a local checkout (uv)
 *   node scripts/generate-plugin-api.mjs --release v0.75.0          # a release's attached asset
 *   node scripts/generate-plugin-api.mjs --url https://initiative.example.com
 *   node scripts/generate-plugin-api.mjs                            # the client from schemas/plugin-api.json
 *   node scripts/generate-plugin-api.mjs --check                    # exit non-zero if either is stale
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { emitter } from "./ts-emit.mjs";

const REPOSITORY = "https://github.com/beyonders-studio/initiative";
const RELEASES = `${REPOSITORY}/releases/download`;
const ASSET = "initiative-plugin-api.json";
const SERVER = "/api/v1/c/0";
const METHODS = ["get", "put", "post", "delete", "patch"];
const SOURCE = "x-initiative-source";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const published = join(root, "schemas", "plugin-api.json");
const output = join(root, "src", "plugin-api.generated.ts");
const contractVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited ${result.status}\n${result.stderr ?? ""}`);
  return result.stdout;
}

async function download(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) fail(`${url} answered ${response.status}`);
  return response.text();
}

/** A release tag's commit, the tag's own when it is annotated. */
function tagCommit(tag) {
  const lines = run("git", ["ls-remote", "--tags", `${REPOSITORY}.git`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`])
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const commit = (lines.find(([, ref]) => ref.endsWith("^{}")) ?? lines[0])?.[0];
  if (!commit) fail(`${REPOSITORY} has no tag ${tag}`);
  return commit;
}

/**
 * Initiative's document, and where it came from: the Initiative version and,
 * where it can be known, the commit.
 */
async function source(argv) {
  const [flag, value, ...rest] = argv;
  if (!value || rest.length) {
    fail("usage: generate-plugin-api.mjs [--checkout <path> | --release <vX.Y.Z> | --url <base> | --check]");
  }
  if (flag === "--checkout") {
    const checkout = resolve(value);
    const text = run("uv", ["run", "python", "scripts/export_openapi.py", "--plugin", "-"], {
      cwd: join(checkout, "backend"),
      stdio: ["ignore", "pipe", "inherit"],
    });
    let version;
    try {
      version = readFileSync(join(checkout, "VERSION"), "utf-8").trim();
    } catch {
      fail(`${checkout} has no VERSION file: is it an Initiative checkout?`);
    }
    const commit = run("git", ["-C", checkout, "rev-parse", "HEAD"]).trim();
    const dirty = run("git", ["-C", checkout, "status", "--porcelain"]).trim() !== "";
    return { text, initiative: { version, commit, ...(dirty ? { uncommitted_changes: true } : {}) } };
  }
  if (flag === "--release") {
    const text = await download(`${RELEASES}/${encodeURIComponent(value)}/${ASSET}`);
    return { text, initiative: { version: value.replace(/^v/, ""), release: value, commit: tagCommit(value) } };
  }
  if (flag === "--url") {
    const base = value.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
    const text = await download(`${base}/api/v1/plugin-platform/openapi.json`);
    let version;
    try {
      ({ version } = JSON.parse(await download(`${base}/api/v1/version`)));
    } catch {
      fail(`${base}/api/v1/version did not answer Initiative's version`);
    }
    if (typeof version !== "string") fail(`${base}/api/v1/version did not answer Initiative's version`);
    return { text, initiative: { version, url: base } };
  }
  fail(`unknown source ${flag}: use --checkout, --release or --url`);
}

/** Where the published document came from, as the client's header says it. */
function provenance(initiative) {
  const where = initiative.commit
    ? `commit ${initiative.commit.slice(0, 9)}${initiative.uncommitted_changes ? ", with uncommitted changes" : ""}`
    : `served at ${initiative.url}`;
  return `Initiative ${initiative.version} (${where})`;
}

const SCHEMAS = "#/components/schemas/";

const camel = (id) => id.replace(/_([a-z0-9])/g, (_, next) => next.toUpperCase());
const quote = (value) => JSON.stringify(value);

/** A JSON value as a TypeScript literal, keys unquoted where they can be. */
function valueLiteral(value) {
  if (Array.isArray(value)) return `[${value.map(valueLiteral).join(", ")}]`;
  if (value === null || typeof value !== "object") return quote(value);
  const entries = Object.entries(value).map(([key, one]) => `${/^[A-Za-z_]\w*$/.test(key) ? key : quote(key)}: ${valueLiteral(one)}`);
  return `{ ${entries.join(", ")} }`;
}

/** A description's first paragraph, as one line. */
const firstParagraph = (text) => text.split(/\n\s*\n/)[0].replace(/\s+/g, " ").replace(/``/g, "`").trim();

/** A schema reference is a member of `PluginApiSchemas`. */
const { doc, objectType, tsType } = emitter({
  named: (node) => {
    if (node.$ref === undefined) return undefined;
    if (!node.$ref.startsWith(SCHEMAS)) fail(`cannot follow ${node.$ref}`);
    return `PluginApiSchemas[${quote(node.$ref.slice(SCHEMAS.length))}]`;
  },
  prose: firstParagraph,
});

function scopeProse(scope) {
  if (typeof scope === "string") return `needs \`${scope}\``;
  if ("by" in scope) return `needs the scope its \`${scope.by}\` names`;
  if ("tool" in scope) return `needs \`<tool kind>:${scope.access}\` for the tool its \`${scope.tool}\` is or sits in`;
  return `needs one of ${scope.any_of.map((one) => `\`${one}\``).join(", ")}`;
}

/** A parameter's schema: its own, or its JSON content's (OpenAPI's way to send a value as JSON). */
function parameterSchema(id, parameter) {
  const schema = parameter.schema ?? parameter.content?.["application/json"]?.schema;
  if (!schema) fail(`${id}'s ${parameter.in} parameter ${parameter.name} has neither a schema nor JSON content`);
  return schema;
}

/** Parameters in one place as an object schema, each described as its parameter is. */
function parameterObject(id, parameters) {
  return {
    type: "object",
    properties: Object.fromEntries(
      parameters.map((one) => {
        const schema = parameterSchema(id, one);
        return [one.name, { ...schema, description: one.description ?? schema.description }];
      })
    ),
    required: parameters.filter((one) => one.required).map((one) => one.name),
  };
}

/** The types, the operations table and the `PluginApi` class, from the document. */
function emit(spec) {
  const schemas = spec.components?.schemas ?? {};
  const shapes = [];
  const table = [];
  const methods = [];
  const names = new Map();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const verb of METHODS) {
      const operation = item[verb];
      if (!operation) continue;
      const id = operation.operationId;
      const scope = operation["x-plugin-scope"];
      if (!id || !scope) fail(`${verb.toUpperCase()} ${path} has no operationId or x-plugin-scope`);
      const name = camel(id);
      if (names.has(name)) fail(`${id} and ${names.get(name)} are both ${name}`);
      names.set(name, id);

      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])];
      const inPath = parameters.filter((one) => one.in === "path");
      const inQuery = parameters.filter((one) => one.in === "query");
      if (typeof scope === "object" && "by" in scope && !inPath.some((one) => one.name === scope.by)) {
        fail(`${id} picks its scope by ${scope.by}, which is not a path parameter`);
      }
      if (typeof scope === "object" && "tool" in scope) {
        if (!inPath.some((one) => one.name === scope.tool)) fail(`${id} picks its tool by ${scope.tool}, which is not a path parameter`);
        if (scope.access !== "read" && scope.access !== "write") fail(`${id} needs ${scope.access} on its tool, which is neither read nor write`);
      }

      const shape = [`  ${id}: {`];
      const fields = [];
      const op = `PluginApiOperations[${quote(id)}]`;
      if (inPath.length) {
        shape.push(`    path: ${objectType(parameterObject(id, inPath), "    ")};`);
        fields.push(`path: ${op}["path"]`);
      }
      if (inQuery.length) {
        shape.push(`    query: ${objectType(parameterObject(id, inQuery), "    ")};`);
        fields.push(`query${inQuery.some((one) => one.required) ? "" : "?"}: ${op}["query"]`);
      }
      const body = operation.requestBody;
      if (body) {
        const json = body.content?.["application/json"];
        const form = body.content?.["multipart/form-data"];
        if (!json && !form) fail(`${id} takes a body that is neither JSON nor a form`);
        shape.push(`    body: ${json ? tsType(json.schema ?? {}, "    ") : "FormData"};`);
        fields.push(`body${body.required ? "" : "?"}: ${op}["body"]`);
      }
      const status = Object.keys(operation.responses).filter((code) => /^2\d\d$/.test(code)).sort()[0];
      if (!status) fail(`${id} has no success response`);
      const content = operation.responses[status].content;
      const answer = !content
        ? "void"
        : content["application/json"]
          ? tsType(content["application/json"].schema ?? {}, "    ")
          : "Blob";
      shape.push(`    answer: ${answer};`, "  };");
      shapes.push(shape.join("\n"));

      const required = fields.some((field) => !/^\w+\?/.test(field));
      const args = fields.length ? `args${required ? "" : "?"}: { ${fields.join("; ")} }` : "";
      const prose = doc(operation.description ?? operation.summary, "  ").slice(0, -1);
      const route = `   * \`${verb.toUpperCase()} ${path}\`, ${scopeProse(scope)}.`;
      const asJson = inQuery.filter((one) => one.schema === undefined).map((one) => one.name);
      const entry = { method: verb.toUpperCase(), path, scope, ...(asJson.length ? { json: asJson } : {}) };
      table.push(`  ${id}: ${valueLiteral(entry)},`);
      methods.push(
        [
          ...(prose.length ? [...prose, "   *", route] : ["  /**", route]),
          "   */",
          `  ${name}(${args}): Promise<${op}["answer"]> {`,
          `    return this.call(${quote(id)}${fields.length ? ", args" : ""}) as Promise<${op}["answer"]>;`,
          "  }",
        ].join("\n")
      );
    }
  }
  return `/** Initiative's schemas, by name: \`PluginApiSchemas["TaskRead"]\`. */
export interface PluginApiSchemas ${objectType({ properties: schemas, required: Object.keys(schemas) }, "")}

/** Each operation's arguments, by where they go, and its answer. */
export interface PluginApiOperations {
${shapes.join("\n")}
}

/**
 * Each operation a plug-in may call: its method, its path after \`${SERVER}\`, the
 * scope it needs, and the query parameters it takes as JSON.
 */
export const pluginApiOperations = {
${table.join("\n")}
} as const satisfies Record<string, PluginApiOperation>;

export type PluginApiOperationId = keyof typeof pluginApiOperations;

/** Every route Initiative's plug-in API describes, as a typed method. A client's \`api\` is one. */
export class PluginApi {
  constructor(private readonly call: (operation: PluginApiOperationId, args?: PluginApiArgs) => Promise<unknown>) {}

${methods.join("\n\n")}
}
`;
}

const PREAMBLE = `import type { Scope } from "./contract.js";

/**
 * The scope an operation needs: one scope; the scope an argument picks
 * (\`by\`); any one of several, when Initiative checks each item (\`per\`); or
 * a tool plug-in's, \`<tool kind>:read\` or \`<tool kind>:write\`, for the tool
 * the kind an argument names is or sits in (\`tool\`).
 */
export type PluginApiScope =
  | Scope
  | { by: string; scopes: Readonly<Record<string, Scope>> }
  | { per: string; any_of: readonly Scope[] }
  | { tool: string; access: "read" | "write" };

export interface PluginApiOperation {
  method: "GET" | "PUT" | "POST" | "DELETE" | "PATCH";
  path: string;
  scope: PluginApiScope;
  /** The query parameters sent as one JSON string each. */
  json?: readonly string[];
}

export interface PluginApiArgs {
  path?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
}
`;

/** The client's text, from the published document. */
function client(spec) {
  return `/**
 * Generated by scripts/generate-plugin-api.mjs from schemas/plugin-api.json, the plug-in API
 * taken from ${provenance(spec.info[SOURCE])}. Do not edit: regenerate.
 */

${PREAMBLE}
${emit(spec)}`;
}

/** The document at the contract's version, its keys in Initiative's order. */
function stamped(spec, initiative) {
  return { ...spec, info: { ...spec.info, version: contractVersion, [SOURCE]: initiative } };
}

const argv = process.argv.slice(2);
const checking = argv.length === 1 && argv[0] === "--check";
let spec;
if (argv.length && !checking) {
  const { text, initiative } = await source(argv);
  let taken;
  try {
    taken = JSON.parse(text);
  } catch {
    fail(`the plug-in API document from ${provenance(initiative)} is not JSON`);
  }
  if (taken.servers?.[0]?.url !== SERVER) fail(`expected the plug-in API's server to be ${SERVER}, not ${taken.servers?.[0]?.url}`);
  spec = stamped(taken, initiative);
} else {
  let text;
  try {
    text = readFileSync(published, "utf-8");
  } catch {
    fail(`${published} is missing: take it from Initiative with --checkout, --release or --url`);
  }
  let current;
  try {
    current = JSON.parse(text);
  } catch {
    fail(`${published} is not JSON: take it again`);
  }
  if (!current.info?.[SOURCE]?.version) fail(`${published} names no Initiative in info["${SOURCE}"]: take it again`);
  spec = stamped(current, current.info[SOURCE]);
}

// The client is emitted first: a document it cannot be generated from is not published.
const generated = client(spec);
const outputs = [
  [published, `${JSON.stringify(spec, null, 2)}\n`],
  [output, generated],
];
let stale = false;
for (const [path, body] of outputs) {
  let current = null;
  try {
    current = readFileSync(path, "utf-8");
  } catch {
    /* not written yet */
  }
  if (current === body) continue;
  if (checking) {
    process.stderr.write(`${path} is out of date — run 'npm run generate:plugin-api'\n`);
    stale = true;
  } else {
    writeFileSync(path, body, "utf-8");
    process.stdout.write(`wrote ${path}\n`);
  }
}
if (stale) process.exit(1);
if (checking) process.stdout.write(`the plug-in API ${contractVersion} and its client are current\n`);
else console.log(`plug-in API ${contractVersion}, from ${provenance(spec.info[SOURCE])}`);
