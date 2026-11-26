/**
 * `scripts/sync-registry-schema.mjs`: how it takes the registry's listing
 * schema, what it refuses, and how it says the vendored copy has drifted.
 *
 * Each run is in a copy of the script under a temporary root, so nothing here
 * writes the repository's own `schemas/registry-listing.json`, and each takes
 * the schema from a file, so nothing here reaches the network.
 */

import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));

const schema = (pattern = "^[a-z]+$") => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:initiative-registry:schema:listing",
  type: "object",
  properties: { publisher: { type: "string", pattern } },
});

let root: string;
let registry: string;

/** Run the script in the temporary root, answering its exit code and what it said. */
async function sync(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      join(root, "scripts", "sync-registry-schema.mjs"),
      ...args,
    ]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
    return { code, stdout, stderr };
  }
}

const vendored = () => readFileSync(join(root, "schemas", "registry-listing.json"), "utf-8");
const publish = (document: unknown, spacing = 4) => writeFileSync(registry, JSON.stringify(document, null, spacing));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "registry-schema-"));
  for (const dir of ["scripts", "schemas"]) mkdirSync(join(root, dir));
  copyFileSync(join(scripts, "sync-registry-schema.mjs"), join(root, "scripts", "sync-registry-schema.mjs"));
  registry = join(root, "listing.schema.json");
  publish(schema());
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("sync-registry-schema", () => {
  it("writes the registry's schema, re-indented, from a file", async () => {
    expect((await sync("--from", registry)).code).toBe(0);
    expect(vendored()).toBe(`${JSON.stringify(schema(), null, 2)}\n`);
  });

  it("passes a check while the copy is the registry's, and fails once the registry's changes", async () => {
    await sync("--from", registry);
    expect((await sync("--check", "--from", registry)).code).toBe(0);

    publish(schema("^[a-z0-9_-]+$"));
    const drifted = await sync("--check", "--from", registry);
    expect(drifted.code).toBe(1);
    expect(drifted.stderr).toContain("registry-listing.json differs from");
    expect(vendored()).toBe(`${JSON.stringify(schema(), null, 2)}\n`);
  });

  it("fails a check when nothing has been taken yet", async () => {
    expect((await sync("--check", "--from", registry)).code).toBe(1);
  });

  it("refuses a document that is not the registry's listing schema", async () => {
    publish({ ...schema(), $id: "urn:initiative-registry:schema:publisher" });
    const refused = await sync("--from", registry);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("is not the registry's listing schema");
  });
});
