/**
 * `initiative-plugin build`: the files a plug-in's definition produces.
 *
 * - `manifest.json`: the manifest, with each widget's module bundled into its
 *   `module_source`, after `validateManifest` has passed it. That parses
 *   every JSONata expression a declarative plug-in gives, so one that does not
 *   parse fails the build at its place in the manifest.
 * - With `--registry <dir>`, the plug-in's registry source under
 *   `<dir>/<publisher>/<uid>/`: `listing.json`, this version's
 *   `<version>/manifest.json`, the avatar and any images. It is written
 *   only while the listing names the package's own version: between releases
 *   the package runs ahead of its listing, and what the listing already
 *   publishes is left as it was.
 *
 * With `--check` nothing is written, and any file that differs from what would
 * be written is a failure.
 *
 * A plug-in built outside TypeScript gives `--manifest <file>` in place of its
 * definition: a JSON file holding its manifest and its listing
 * ({@link BuiltPlugin}). It is checked as a definition's manifest is, and its
 * registry source is written from its listing, which states the version it
 * lists; no `manifest.json` is written beside it.
 *
 * Bundling uses esbuild, which the plug-in installs beside the SDK
 * (`npm install --save-dev esbuild`). Nothing at run time needs it.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CAPS } from "./contract.js";
import { ENTITLEMENT_ISSUER_KEY_ENV, ENTITLEMENT_ISSUER_KEY_FACT } from "./statements.js";
import { manifestOf, type AnyPlugin, type ListingDeclaration, type RuntimeDeclaration } from "./define.js";
import type { Manifest } from "./contract.js";
import { validateManifest } from "./validate.js";

export interface BuildOptions {
  /** The plug-in's package directory. */
  root: string;
  /** The module whose default export is the plug-in's definition, relative to `root`. */
  plugin: string;
  /** A plug-in built outside TypeScript, in place of `plugin`: its {@link BuiltPlugin} file, relative to `root`. */
  manifest?: string;
  /** Where registry sources live; the plug-in's is written under `<publisher>/<uid>/`. */
  registry?: string;
  check: boolean;
}

type Esbuild = typeof import("esbuild");

/** esbuild, or null after saying how to install it. */
export async function bundler(command: string): Promise<Esbuild | null> {
  try {
    return await import("esbuild");
  } catch {
    process.stderr.write(`initiative-plugin ${command} bundles with esbuild: npm install --save-dev esbuild\n`);
    return null;
  }
}

/**
 * A plug-in whose manifest is built outside TypeScript, as `--manifest` reads
 * it: what a definition names beside its manifest, and the manifest itself.
 */
export interface BuiltPlugin {
  publicId: string;
  uid: string;
  name: string;
  manifest: Manifest;
  listing?: ListingDeclaration;
}

/** What the listing writers read of a plug-in: its definition, or a {@link BuiltPlugin}'s. */
export type ListedPlugin = Pick<AnyPlugin, "publicId" | "uid" | "name" | "scopes" | "hosts" | "hooks" | "listing">;

/** What a definition builds: the plug-in and its manifest, or every problem that stops it. */
export type Compiled = { plugin: ListedPlugin; manifest: Manifest; problems?: never } | { problems: string[] };

/**
 * The plug-in `options` names, compiled: from its definition, or from the
 * {@link BuiltPlugin} file `options.manifest` names. Null when its definition
 * needs esbuild and it is not installed.
 */
export async function load(
  command: string,
  root: string,
  options: { plugin: string; manifest?: string }
): Promise<Compiled | null> {
  if (options.manifest !== undefined) return compileBuilt(root, options.manifest);
  const esbuild = await bundler(command);
  return esbuild ? compile(esbuild, root, options.plugin) : null;
}

/** A {@link BuiltPlugin} file, checked as a definition's manifest is. */
function compileBuilt(root: string, file: string): Compiled {
  let built: BuiltPlugin;
  try {
    built = JSON.parse(readFileSync(resolve(root, file), "utf-8")) as BuiltPlugin;
  } catch (error) {
    return { problems: [`${file}: ${(error as Error).message}`] };
  }
  const missing = (["publicId", "uid", "name"] as const).filter((key) => typeof built[key] !== "string");
  if (missing.length || typeof built.manifest !== "object" || built.manifest === null) {
    return { problems: [`${file}: a built plug-in names its ${[...missing, "manifest"].join(", ")}`] };
  }
  const { manifest, ...named } = built;
  return checked({ ...named, scopes: manifest.service?.scopes, hosts: manifest.hosts }, manifest, []);
}

/**
 * Load the plug-in's definition, bundle its widgets and check the manifest they
 * make, with nothing written.
 */
export async function compile(esbuild: Esbuild, root: string, entry: string): Promise<Compiled> {
  const plugin = await loadPlugin(esbuild, root, entry);
  const modules: Record<string, string> = {};
  const problems: string[] = [];
  for (const [id, widget] of Object.entries(plugin.widgets ?? {})) {
    const source = await bundleWidget(esbuild, root, widget.module);
    const bytes = Buffer.byteLength(source, "utf-8");
    if (bytes > CAPS.moduleSourceBytes) {
      problems.push(`widget ${id}: ${widget.module} bundles to ${bytes} bytes, over the ${CAPS.moduleSourceBytes}-byte cap`);
    }
    modules[id] = source;
  }
  return checked(plugin, manifestOf(plugin, modules), problems);
}

/**
 * Listing terms this contract no longer has, named rather than dropped: a
 * built plug-in is JSON, and a key it still carries would otherwise vanish
 * without a word.
 */
function retiredProblems(plugin: ListedPlugin): string[] {
  const listing = (plugin.listing ?? {}) as Record<string, unknown>;
  const runtime = (listing.runtime ?? {}) as Record<string, unknown>;
  return [
    ...("referenceSectors" in listing
      ? ["listing.referenceSectors was removed in 7.0: whether a plug-in is billable is a package's to state, not its listing's"]
      : []),
    ...("integrations" in runtime
      ? [
          "listing.runtime.integrations was removed in 7.2: billing reaches a plug-in only through Initiative, and its signed entitlement statements are verified with the entitlement_issuer_key fact",
        ]
      : []),
  ];
}

/** The plug-in and its manifest, or every problem with them beside `problems`. */
function checked(plugin: ListedPlugin, manifest: Manifest, problems: string[]): Compiled {
  problems.push(
    ...validateManifest(manifest, { publicId: plugin.publicId }).map((problem) => `manifest${problem.where}: ${problem.message}`)
  );
  problems.push(...kindProblems(plugin));
  problems.push(...retiredProblems(plugin));
  if (plugin.listing?.compose) problems.push(...composeProblems(plugin.listing.compose));
  if (plugin.listing?.runtime) problems.push(...runtimeProblems(plugin.listing.runtime, plugin.hooks?.entitlement !== undefined));
  if (plugin.listing?.images) problems.push(...imageProblems(plugin.listing));
  return problems.length ? { problems } : { plugin, manifest };
}

/** Build, or check, the plug-in's files. Answers the process's exit code. */
export async function build(options: BuildOptions): Promise<number> {
  const root = resolve(options.root);
  const compiled = await load("build", root, options);
  if (!compiled) return 1;
  if (compiled.problems) {
    for (const problem of compiled.problems) process.stderr.write(`${problem}\n`);
    return 1;
  }
  const { plugin, manifest } = compiled;

  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const outputs: Array<[string, string | Buffer]> =
    options.manifest === undefined ? [[join(root, "manifest.json"), manifestText]] : [];
  if (options.registry !== undefined) {
    const listing = plugin.listing;
    if (!listing) {
      process.stderr.write("--registry was given, but the plug-in declares no listing\n");
      return 1;
    }
    const version =
      options.manifest === undefined
        ? (JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { version: string }).version
        : listing.version;
    if (version === listing.version) {
      const avatar = readFileSync(resolve(root, listing.avatar));
      const images = (listing.images ?? []).map((image) => readFileSync(resolve(root, image.path)));
      const source = resolve(root, options.registry, listing.publisher, plugin.uid);
      outputs.push(
        [join(source, "listing.json"), `${JSON.stringify(listingSource(plugin, avatar, images), null, 2)}\n`],
        [join(source, listing.version, "manifest.json"), manifestText],
        [join(source, "assets", basename(listing.avatar)), avatar],
        ...(listing.images ?? []).map(
          (image, index): [string, Buffer] => [join(source, "assets", basename(image.path)), images[index]]
        )
      );
    } else {
      process.stdout.write(`the registry source lists ${listing.version}; ${version} is listed at its release\n`);
    }
  }

  let stale = false;
  for (const [path, content] of outputs) {
    const name = relative(process.cwd(), path);
    if (options.check) {
      const current = existsSync(path) ? readFileSync(path) : null;
      if (!current || !current.equals(Buffer.from(content))) {
        process.stderr.write(`${name} is out of date: run initiative-plugin build\n`);
        stale = true;
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      process.stdout.write(`wrote ${name}\n`);
    }
  }
  return stale ? 1 : 0;
}

/** The plug-in's definition, compiled from its TypeScript and imported. */
async function loadPlugin(esbuild: Esbuild, root: string, entry: string): Promise<AnyPlugin> {
  const outfile = join(root, "node_modules", ".cache", "initiative-plugin", `plugin-${process.pid}-${Date.now()}.mjs`);
  await esbuild.build({
    entryPoints: [resolve(root, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "error",
  });
  try {
    const loaded = (await import(pathToFileURL(outfile).href)) as { default?: AnyPlugin };
    const plugin = loaded.default;
    if (!plugin || typeof plugin.publicId !== "string") {
      throw new Error(`${entry} must export the plug-in's definition as its default export`);
    }
    return plugin;
  } finally {
    rmSync(outfile, { force: true });
  }
}

/**
 * One widget as the single script the sandbox runs: its module and everything
 * it imports, with `render` left as a global.
 */
async function bundleWidget(esbuild: Esbuild, root: string, module: string): Promise<string> {
  const path = `./${relative(root, resolve(root, module)).split("\\").join("/")}`;
  const result = await esbuild.build({
    stdin: {
      contents: `import { render } from ${JSON.stringify(path)};\nglobalThis.render = render;\n`,
      resolveDir: root,
      sourcefile: "widget.js",
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "neutral",
    target: "es2020",
    charset: "utf8",
    legalComments: "none",
    logLevel: "error",
  });
  return result.outputFiles[0].text.trimEnd();
}

/**
 * What a definition says that its manifest does not show: a declarative plug-in
 * runs no hooks and asks for no scopes, and only a container plug-in's listing
 * names an image.
 */
function kindProblems(plugin: ListedPlugin): string[] {
  const problems: string[] = [];
  if (plugin.hosts) {
    if (Object.keys(plugin.hooks ?? {}).length) problems.push("hooks: a declarative plug-in runs no hooks");
    if (plugin.scopes) problems.push("scopes: a declarative plug-in asks for none, since it does not call Initiative");
    if (plugin.listing?.image || plugin.listing?.compose || plugin.listing?.runtime) {
      problems.push("listing: a declarative plug-in has no image, compose service or runtime");
    }
  } else if (plugin.listing && !plugin.listing.image) {
    problems.push("listing: a container plug-in names its image");
  }
  return problems;
}

/** The registry's rules for a compose snippet: its size, its two placeholders, its address. */
function composeProblems({ service, baseUrl }: NonNullable<ListingDeclaration["compose"]>): string[] {
  const problems: string[] = [];
  if (!service || service.length > 4096) {
    problems.push("listing compose: the service is 1 to 4096 characters");
  }
  for (const [placeholder] of service.matchAll(/\$\{(?!(?:IMAGE|INITIATIVE_URL)\})[^}]*\}?/g)) {
    problems.push(`listing compose: ${placeholder} is not a placeholder; Initiative fills \${IMAGE} and \${INITIATIVE_URL}`);
  }
  if (baseUrl.length > 512 || !/^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[^\s?#]*)?$/.test(baseUrl)) {
    problems.push("listing compose: baseUrl is an http or https URL of at most 512 characters");
  }
  return problems;
}

const PICTURE = /\.(png|jpe?g|webp|gif|avif|svg)$/i;
const MAX_IMAGES = 12;

/**
 * The registry's rules for a listing's screenshots: how many, their alt text,
 * their file types, and a name of their own in the listing's `assets/`, where
 * the avatar sits beside them.
 */
function imageProblems({ avatar, images = [] }: ListingDeclaration): string[] {
  const problems: string[] = [];
  if (images.length > MAX_IMAGES) problems.push(`listing images: at most ${MAX_IMAGES}, not ${images.length}`);
  const names = new Set([basename(avatar)]);
  for (const { path, alt } of images) {
    if (!PICTURE.test(path)) problems.push(`listing images: ${path} is not a PNG, JPEG, WebP, GIF, AVIF or SVG file`);
    if (typeof alt !== "string" || !alt.trim() || alt.length > 300) {
      problems.push(`listing images: ${path} needs alt text of 1 to 300 characters`);
    }
    const name = basename(path);
    if (names.has(name)) problems.push(`listing images: ${path} has the same file name as another picture`);
    names.add(name);
  }
  return problems;
}

const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const PATH = /^\/[A-Za-z0-9._~/-]*$/;

/**
 * The registry's rules for a runtime that a build can see by itself: names,
 * the port, paths and variable names. The registry checks the rest.
 */
function runtimeProblems(runtime: RuntimeDeclaration, entitled: boolean): string[] {
  const problems: string[] = [];
  const say = (problem: string) => problems.push(`listing runtime: ${problem}`);
  if (!/^[a-z]([a-z0-9-]{0,18}[a-z0-9])?$/.test(runtime.name)) say("name is a DNS label of at most 20 characters");
  if (!Number.isInteger(runtime.port) || runtime.port < 1024 || runtime.port > 65535) say("port is 1024 to 65535");
  for (const path of [runtime.health.ready, runtime.health.live, ...(runtime.publicPaths ?? []), ...(runtime.metrics ? [runtime.metrics.path] : [])]) {
    if (!PATH.test(path) || path.length > 200) say(`${path} is not an absolute path`);
  }
  const added = entitled && runtime.facts?.[ENTITLEMENT_ISSUER_KEY_ENV] === undefined ? [ENTITLEMENT_ISSUER_KEY_ENV] : [];
  const envs = [
    ...Object.keys(runtime.facts ?? {}),
    ...added,
    ...(runtime.settings ?? []).map((setting) => setting.env),
    ...(runtime.signingKey ? [runtime.signingKey.env] : []),
    ...(runtime.database?.roles ?? []).map((role) => role.env),
    ...(runtime.secrets ?? []).map((secret) => secret.env),
    ...(runtime.metrics ? [runtime.metrics.tokenEnv] : []),
  ];
  for (const env of envs) if (!ENV.test(env)) say(`${env} is not an environment variable name`);
  const seen = new Set<string>();
  for (const env of envs) {
    if (seen.has(env)) say(`${env} is filled twice`);
    seen.add(env);
  }
  for (const [env, fact] of Object.entries(runtime.facts ?? {})) {
    if ((fact === ENTITLEMENT_ISSUER_KEY_FACT) !== (env === ENTITLEMENT_ISSUER_KEY_ENV)) {
      say(`${ENTITLEMENT_ISSUER_KEY_FACT} goes in ${ENTITLEMENT_ISSUER_KEY_ENV}, where the SDK reads it, and nothing else does`);
    }
  }
  if (runtime.facts && Object.values(runtime.facts).includes("page_origin") && !runtime.pages) {
    say("page_origin is a plug-in's own origin, which only one that serves pages has");
  }
  if (runtime.database && !/^\/[A-Za-z0-9._/-]+\.sql$/.test(runtime.database.provisionSql)) {
    say("database provisionSql is an absolute path to a .sql file in the image");
  }
  return problems;
}

/** The registry source listing: what the catalogue shows, this version, and the registration, a container's or a declarative plug-in's. */
function listingSource(plugin: ListedPlugin, avatar: Buffer, images: Buffer[]): Record<string, unknown> {
  const listing = plugin.listing!;
  return {
    schema: 1,
    uid: plugin.uid,
    public_id: plugin.publicId,
    publisher: listing.publisher,
    kind: "plugin",
    name: plugin.name,
    summary: listing.summary,
    ...(listing.description !== undefined ? { description: listing.description } : {}),
    avatar: {
      path: `assets/${basename(listing.avatar)}`,
      sha256: createHash("sha256").update(avatar).digest("hex"),
    },
    ...(listing.images?.length
      ? {
          images: listing.images.map((image, index) => ({
            path: `assets/${basename(image.path)}`,
            sha256: createHash("sha256").update(images[index]).digest("hex"),
            alt: image.alt,
          })),
        }
      : {}),
    versions: [
      {
        version: listing.version,
        definition: `${listing.version}/manifest.json`,
        ...(listing.minAppVersion !== undefined ? { min_app_version: listing.minAppVersion } : {}),
        ...(listing.releaseNotes !== undefined ? { release_notes: listing.releaseNotes } : {}),
      },
    ],
    registration: registrationOf(plugin),
  };
}

/** A listing's registration: the plug-in's kind, and a container's image, Compose service and runtime. */
export function registrationOf(plugin: ListedPlugin): Record<string, unknown> {
  const listing = plugin.listing!;
  return {
    ...(plugin.hosts ? { kind: "declarative" } : { kind: "container", image: listing.image }),
    scope_ceiling: [...(listing.scopeCeiling ?? plugin.scopes ?? [])],
    ...(listing.compose ? { compose: { service: listing.compose.service, base_url: listing.compose.baseUrl } } : {}),
    ...(listing.runtime ? { runtime: runtimeOf(listing.runtime, plugin.hooks?.entitlement !== undefined) } : {}),
  };
}

/**
 * A runtime as the registry spells it. Variable names stay as they are; only
 * field names change. A plug-in with an `entitlement` hook is given billing's
 * statement key whether or not it asked, so it can verify what the hook carries.
 */
function runtimeOf(runtime: RuntimeDeclaration, entitled: boolean): Record<string, unknown> {
  const defined = (entries: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
  const { health, database, metrics } = runtime;
  const facts: Record<string, string> | undefined =
    runtime.facts || entitled
      ? { ...runtime.facts, ...(entitled ? { [ENTITLEMENT_ISSUER_KEY_ENV]: ENTITLEMENT_ISSUER_KEY_FACT } : {}) }
      : undefined;
  return defined({
    name: runtime.name,
    port: runtime.port,
    health: defined({ ready: health.ready, live: health.live, startup_seconds: health.startupSeconds }),
    stop_grace_seconds: runtime.stopGraceSeconds,
    migrates_on_start: runtime.migratesOnStart,
    pages: runtime.pages,
    public_paths: runtime.publicPaths && [...runtime.publicPaths],
    facts,
    settings: runtime.settings?.map((setting) => defined({ env: setting.env, required: setting.required })),
    signing_key: runtime.signingKey && { env: runtime.signingKey.env },
    database:
      database &&
      defined({
        min_major: database.minMajor,
        dsn_scheme: database.dsnScheme,
        roles: database.roles.map((role) => ({ id: role.id, login: role.login, env: role.env })),
        provision_sql: database.provisionSql,
      }),
    secrets: runtime.secrets?.map((secret) => ({ id: secret.id, kind: secret.kind, env: secret.env })),
    metrics: metrics && { path: metrics.path, token_env: metrics.tokenEnv },
  });
}
