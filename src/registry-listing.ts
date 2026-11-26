/**
 * The registry's own rules for a source `listing.json`, as `build --registry`
 * holds what it writes to them.
 *
 * `schemas/registry-listing.json` is the registry's listing schema, vendored
 * from beyonders-studio/initiative-developer by
 * `scripts/sync-registry-schema.mjs` and never edited here. The build's own
 * checks of a listing speak in the definition's terms and run on every build;
 * this one speaks in the registry's, on the file the registry will read, so a
 * listing the registry would refuse when it is pinned is refused before it is
 * written.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

/** The vendored registry listing schema, read from disk once. */
export function registryListingSchema(): Record<string, unknown> {
  const here = dirname(fileURLToPath(import.meta.url));
  // Resolved relative to the built module so it works from `dist/` and `src/`.
  for (const candidate of ["../schemas/registry-listing.json", "../../schemas/registry-listing.json"]) {
    try {
      return JSON.parse(readFileSync(join(here, candidate), "utf-8"));
    } catch {
      continue;
    }
  }
  throw new Error("registry-listing.json is not packaged beside this module");
}

let compiled: ValidateFunction | undefined;

/**
 * Where a source listing breaks the registry's schema, each as
 * `<instancePath>: <message>`, with `listing.json` before the path; none when
 * the registry would take it.
 */
export function registryListingProblems(listing: unknown): string[] {
  // Compiled once: Ajv's compile step is the expensive part, not validation.
  compiled ??= new Ajv2020({ allErrors: true, strict: false }).compile(registryListingSchema());
  if (compiled(listing)) return [];
  return (compiled.errors ?? []).map((error) => `listing.json${error.instancePath}: ${error.message}`);
}
