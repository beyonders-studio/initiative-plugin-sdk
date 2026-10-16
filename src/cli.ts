#!/usr/bin/env node
/**
 * `initiative-plugin`: start, build, pack and upload a plug-in, and keys and
 * manifest checks.
 *
 *   initiative-plugin init [dir] [--example minimal]
 *   initiative-plugin build [--plugin <file> | --manifest <file>] [--registry <dir>] [--check]
 *   initiative-plugin pack [--plugin <file> | --manifest <file>] [--out <file>]
 *   initiative-plugin dev --initiative <url> [--api-key <key>] [--plugin <file>]
 *   initiative-plugin keygen [--alg RS256|ES256|EdDSA] [--kid <id>] [--out <dir>]
 *   initiative-plugin validate <file.json>   a manifest, or a served manifest document
 *   initiative-plugin schema                 print the schema a manifest is checked against
 *   initiative-plugin uid                    mint a catalog uid
 *
 * `build` reads the plug-in's definition (default `src/plugin.ts`) and writes
 * `manifest.json`, and with `--registry` the plug-in's registry source; see
 * `build.ts`; `--manifest` names a plug-in built outside TypeScript in place of
 * its definition. `pack` writes the plug-in's listing file, which a self-hosted
 * deployment publishes as its own plug-in (`pack.ts`), and `dev` uploads it to one
 * and again on each change (`dev.ts`); its key may be given as
 * `INITIATIVE_API_KEY` instead. `init` copies an example (`init.ts`).
 * `keygen` writes `private-key.pem` (mode 0600) and `jwks.json`
 * into `--out` and refuses to overwrite either.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { build } from "./build.js";
import { dev } from "./dev.js";
import { init, mintUid } from "./init.js";
import { generatePluginKeys, type PluginKeyAlgorithm } from "./keys.js";
import { pack } from "./pack.js";
import { manifestSchema, validateDocument, validateManifest } from "./validate.js";

function usage(): never {
  process.stderr.write(
    [
      "usage:",
      "  initiative-plugin init [dir] [--example minimal]",
      "  initiative-plugin build [--plugin <file> | --manifest <file>] [--registry <dir>] [--check]",
      "  initiative-plugin pack [--plugin <file> | --manifest <file>] [--out <file>]",
      "  initiative-plugin dev --initiative <url> [--api-key <key>] [--plugin <file>]",
      "  initiative-plugin keygen [--alg RS256|ES256|EdDSA] [--kid <id>] [--out <dir>]",
      "  initiative-plugin validate <file.json>",
      "  initiative-plugin schema",
      "  initiative-plugin uid",
      "",
    ].join("\n")
  );
  process.exit(2);
}

/** `--name value` pairs and the `--name` switches in `switches`, and nothing else. */
function flags(args: string[], values: string[], switches: string[] = []): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index].startsWith("--") ? args[index].slice(2) : "";
    if (switches.includes(name)) {
      out[name] = true;
    } else if (values.includes(name) && args[index + 1] !== undefined) {
      out[name] = args[index + 1];
      index += 1;
    } else usage();
  }
  return out;
}

function keygen(args: string[]): number {
  const options = flags(args, ["alg", "kid", "out"]) as Record<string, string>;
  const alg = (options.alg ?? "RS256") as PluginKeyAlgorithm;
  if (alg !== "RS256" && alg !== "ES256" && alg !== "EdDSA") {
    process.stderr.write(`unsupported --alg ${alg}: use RS256, ES256 or EdDSA\n`);
    return 2;
  }
  const dir = options.out ?? ".";
  const keyPath = join(dir, "private-key.pem");
  const jwksPath = join(dir, "jwks.json");
  for (const path of [keyPath, jwksPath]) {
    if (existsSync(path)) {
      process.stderr.write(`${path} already exists; choose another --out\n`);
      return 1;
    }
  }
  const keys = generatePluginKeys({ alg, ...(options.kid ? { kid: options.kid } : {}) });
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyPath, keys.privateKeyPem, { mode: 0o600, flag: "wx" });
  writeFileSync(jwksPath, `${JSON.stringify(keys.jwks, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(
    [
      `wrote ${keyPath} (keep it secret)`,
      `wrote ${jwksPath} (the public half, for the plug-in's listing or a deployment's operator)`,
      `kid: ${keys.kid}`,
      `alg: ${keys.alg}`,
      "",
    ].join("\n")
  );
  return 0;
}

function validate(path: string | undefined): number {
  if (!path) usage();
  let body: unknown;
  try {
    body = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    process.stderr.write(`${path}: ${(error as Error).message}\n`);
    return 1;
  }
  // A served document carries the manifest as its `definition`.
  const document = typeof body === "object" && body !== null && "definition" in body;
  const problems = document ? validateDocument(body) : validateManifest(body);
  if (problems.length === 0) {
    process.stdout.write(`${path}: no problems found (checked as a ${document ? "document" : "manifest"})\n`);
    return 0;
  }
  for (const problem of problems) process.stderr.write(`${path}${problem.where}: ${problem.message}\n`);
  return 1;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init": {
      const dir = rest[0]?.startsWith("--") === false ? rest.shift()! : ".";
      const options = flags(rest, ["example"]) as Record<string, string>;
      return init({ dir, example: options.example ?? "minimal" });
    }
    case "build": {
      const options = flags(rest, ["plugin", "manifest", "registry"], ["check"]);
      return build({
        root: process.cwd(),
        plugin: typeof options.plugin === "string" ? options.plugin : "src/plugin.ts",
        ...(typeof options.manifest === "string" ? { manifest: options.manifest } : {}),
        ...(typeof options.registry === "string" ? { registry: options.registry } : {}),
        check: options.check === true,
      });
    }
    case "pack": {
      const options = flags(rest, ["plugin", "manifest", "out"]) as Record<string, string>;
      return pack({ root: process.cwd(), plugin: options.plugin ?? "src/plugin.ts", manifest: options.manifest, out: options.out });
    }
    case "dev": {
      const options = flags(rest, ["initiative", "api-key", "plugin"]) as Record<string, string>;
      const apiKey = options["api-key"] ?? process.env.INITIATIVE_API_KEY;
      if (!options.initiative || !apiKey) {
        process.stderr.write("dev uploads the plug-in to your deployment: give --initiative <url> and --api-key <key>\n");
        return 2;
      }
      return dev({ root: process.cwd(), plugin: options.plugin ?? "src/plugin.ts", initiative: options.initiative, apiKey });
    }
    case "keygen":
      return keygen(rest);
    case "validate":
      return validate(rest[0]);
    case "schema":
      process.stdout.write(`${JSON.stringify(manifestSchema(), null, 2)}\n`);
      return 0;
    case "uid":
      process.stdout.write(`${mintUid()}\n`);
      return 0;
    default:
      usage();
  }
}

process.exit(await main(process.argv.slice(2)));
