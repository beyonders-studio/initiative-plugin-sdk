/**
 * `scripts/generate-plugin-api.mjs`: what it publishes, what it refuses, and
 * how it says the published plug-in API or its client is stale.
 *
 * Each run is in a copy of the scripts under a temporary root, so nothing here
 * writes the repository's own `schemas/plugin-api.json`.
 */

import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));

const document = () => ({
  openapi: "3.1.0",
  info: { title: "Initiative plug-in API", version: "0.75.0" },
  servers: [{ url: "/api/v1/c/0" }],
  paths: {
    "/tasks/": {
      get: {
        operationId: "list_tasks",
        "x-plugin-scope": "projects:read",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
        responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "array", items: { type: "string" } } } } } },
      },
    },
  },
});

let root: string;
let server: Server;
let base: string;
let served: unknown;

/** Run the generator in the temporary root. */
const generate = (...args: string[]) =>
  promisify(execFile)(process.execPath, [join(root, "scripts", "generate-plugin-api.mjs"), ...args]);

const published = () => JSON.parse(readFileSync(join(root, "schemas", "plugin-api.json"), "utf-8"));
const client = () => readFileSync(join(root, "src", "plugin-api.generated.ts"), "utf-8");
const setVersion = (version: string) => writeFileSync(join(root, "package.json"), JSON.stringify({ version }));

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "plugin-api-"));
  for (const dir of ["scripts", "schemas", "src"]) mkdirSync(join(root, dir));
  for (const file of ["generate-plugin-api.mjs", "ts-emit.mjs"]) copyFileSync(join(scripts, file), join(root, "scripts", file));
  setVersion("4.2.0");
  served = document();
  server = createServer((request, response) => {
    if (request.url === "/api/v1/version") response.end(JSON.stringify({ version: "0.75.0" }));
    else if (request.url === "/api/v1/plugin-platform/openapi.json") response.end(JSON.stringify(served));
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("taking the document from Initiative", () => {
  it("publishes it at the package's version, naming the Initiative it came from", async () => {
    await generate("--url", base);
    const spec = published();
    expect(spec.info).toEqual({
      title: "Initiative plug-in API",
      version: "4.2.0",
      "x-initiative-source": { version: "0.75.0", url: base },
    });
    expect(spec.paths).toEqual(document().paths);
    expect(client()).toContain("from schemas/plugin-api.json, the plug-in API\n * taken from Initiative 0.75.0");
    expect(client()).toContain("listTasks(");
  });

  it("fails on a parameter with neither a schema nor JSON content, and publishes nothing", async () => {
    served = {
      ...document(),
      paths: {
        "/tasks/": {
          get: {
            operationId: "list_tasks",
            "x-plugin-scope": "projects:read",
            parameters: [{ name: "conditions", in: "query" }],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    await expect(generate("--url", base)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("list_tasks's query parameter conditions has neither a schema nor JSON content"),
    });
    expect(() => published()).toThrow();
  });
});

describe("a tool plug-in's scope", () => {
  const toolRoute = (parameter: string) => ({
    ...document(),
    paths: {
      "/plugin-tools/{kind}/": {
        get: {
          operationId: "list_plugin_tool_rows",
          "x-plugin-scope": { tool: "kind", access: "read" },
          parameters: [{ name: parameter, in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "OK" } },
        },
      },
    },
  });

  it("is the tool's scope for the kind its path names, in the table and the method's words", async () => {
    served = toolRoute("kind");
    await generate("--url", base);
    expect(client()).toContain('list_plugin_tool_rows: { method: "GET", path: "/plugin-tools/{kind}/", scope: { tool: "kind", access: "read" } },');
    expect(client()).toContain("needs `<tool kind>:read` for the tool its `kind` is or sits in.");
  });

  it("fails when no path parameter names the kind, and publishes nothing", async () => {
    served = toolRoute("type");
    await expect(generate("--url", base)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("list_plugin_tool_rows picks its tool by kind, which is not a path parameter"),
    });
    expect(() => published()).toThrow();
  });
});

describe("the client from the published document", () => {
  beforeEach(async () => {
    await generate("--url", base);
  });

  it("is current right after it is taken", async () => {
    await expect(generate("--check")).resolves.toMatchObject({ stdout: expect.stringContaining("4.2.0") });
  });

  it("is stale when the document changed and the client did not", async () => {
    const spec = published();
    spec.paths["/tasks/"].get.operationId = "list_every_task";
    writeFileSync(join(root, "schemas", "plugin-api.json"), `${JSON.stringify(spec, null, 2)}\n`);
    await expect(generate("--check")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("plugin-api.generated.ts is out of date"),
    });
    await generate();
    expect(client()).toContain("listEveryTask(");
    await expect(generate("--check")).resolves.toBeDefined();
  });

  it("is restamped when the package's version moves, and stale until it is", async () => {
    setVersion("4.3.0");
    await expect(generate("--check")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("plugin-api.json is out of date"),
    });
    const before = client();
    await generate();
    expect(published().info.version).toBe("4.3.0");
    expect(published().info["x-initiative-source"]).toEqual({ version: "0.75.0", url: base });
    expect(client()).toBe(before);
  });
});
