#!/usr/bin/env node
/**
 * Vendor the registry's listing schema as `schemas/registry-listing.json`.
 *
 * `initiative-plugin build --registry` holds the `listing.json` it writes to
 * this schema before it writes anything, so a listing the registry would
 * refuse at review or at pin time is refused at the build instead. The schema
 * is the registry's, in beyonders-studio/initiative-developer at
 * `registry/schema/listing.schema.json`; this package carries a copy rather
 * than restating its rules, and this script is how the copy is taken.
 *
 * The copy is written as the registry's JSON, re-indented, and nothing else:
 * the schema refers only to its own `$defs`, so there is no second file to
 * carry beside it.
 *
 *   node scripts/sync-registry-schema.mjs                  # take it from the registry's main
 *   node scripts/sync-registry-schema.mjs --from <file>    # take it from a checkout
 *   node scripts/sync-registry-schema.mjs --from <url>     # take it from elsewhere
 *   node scripts/sync-registry-schema.mjs --check          # exit non-zero if the copy differs from main
 *   node scripts/sync-registry-schema.mjs --check --from <file>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendored = join(root, "schemas", "registry-listing.json");
const MAIN =
  "https://raw.githubusercontent.com/beyonders-studio/initiative-developer/main/registry/schema/listing.schema.json";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let checking = false;
let from = MAIN;
for (let index = 0; index < argv.length; index++) {
  if (argv[index] === "--check") checking = true;
  else if (argv[index] === "--from" && argv[index + 1]) from = argv[++index];
  else fail("usage: sync-registry-schema.mjs [--from <file or url>] [--check]");
}

/** The registry's schema as text, from a URL or a file. */
async function take(source) {
  if (/^https?:\/\//.test(source)) {
    let response;
    try {
      response = await fetch(source, { headers: { Accept: "application/json" } });
    } catch (error) {
      fail(`${source}: ${error.message}`);
    }
    if (!response.ok) fail(`${source} answered ${response.status}`);
    return response.text();
  }
  try {
    return readFileSync(resolve(source), "utf-8");
  } catch (error) {
    fail(`${source}: ${error.message}`);
  }
}

const text = await take(from);
let schema;
try {
  schema = JSON.parse(text);
} catch {
  fail(`${from} is not JSON`);
}
if (schema?.$id !== "urn:initiative-registry:schema:listing") {
  fail(`${from} is not the registry's listing schema: its $id is ${JSON.stringify(schema?.$id)}`);
}
const body = `${JSON.stringify(schema, null, 2)}\n`;

let current = null;
try {
  current = readFileSync(vendored, "utf-8");
} catch {
  /* not taken yet */
}
if (current === body) {
  process.stdout.write(`${vendored} is the registry's listing schema, as ${from} has it\n`);
} else if (checking) {
  fail(`${vendored} differs from ${from}: run 'npm run sync:registry-schema'`);
} else {
  writeFileSync(vendored, body, "utf-8");
  process.stdout.write(`wrote ${vendored} from ${from}\n`);
}
