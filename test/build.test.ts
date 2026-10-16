/**
 * `initiative-plugin build`: the manifest with each widget bundled into it, and
 * the registry source while the listing names the package's version, or a
 * check that the committed files are what the definition produces. `pack`,
 * the listing file a deployment publishes as its own plug-in, and `dev`, which
 * uploads it to one as Initiative's listing upload takes it, again on each
 * change.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { build } from "../src/build.js";
import { dev } from "../src/dev.js";
import { pack } from "../src/pack.js";

const here = dirname(fileURLToPath(import.meta.url));
const sdk = join(here, "..", "src", "manifest.js");
const avatar = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

let root: string;
let errors: string[];
let output: string[];

function plugin(extra = "", listing = ""): string {
  return `
import { definePlugin, defineEndpoint } from ${JSON.stringify(sdk)};

export const count = defineEndpoint({
  direction: "read",
  returns: { total: "int" },
  handler: async () => ({ result: { total: 1 } }),
});

export default definePlugin({
  publicId: "acme.tracker",
  uid: "K7M2QX8N4TVB9C",
  name: "Tracker",
  endpoints: { count },
  widgets: { total: { meta: { name: { en: "Total" } }, endpoints: ["count"], module: "widgets/total.ts" } },
  listing: {
    publisher: "acme",
    summary: "Tickets.",
    avatar: "assets/avatar.png",
    version: "1.2.0",
    releaseNotes: "First.",
    image: "ghcr.io/acme/tracker@sha256:${"a".repeat(64)}",
    ${listing}
  },
  ${extra}
});
`;
}

/** A declarative plug-in: one read Initiative makes and maps itself. */
function declarative(map: string, extra = ""): string {
  return `
import { definePlugin, defineEndpoint } from ${JSON.stringify(sdk)};

export default definePlugin({
  publicId: "acme.tracker",
  uid: "K7M2QX8N4TVB9C",
  name: "Tracker",
  hosts: ["api.tracker.example"],
  connections: {
    account: {
      scope: "interactive",
      label: { en: "Account" },
      fields: [],
      flow: { type: "oauth2", authorize_url: "https://tracker.example/a", token_url: "https://tracker.example/t", client_id: "tracker" },
    },
  },
  endpoints: {
    count: defineEndpoint({
      direction: "read",
      requires: { all_of: ["account"] },
      returns: { total: "int" },
      request: { method: "GET", url: '"https://api.tracker.example/count"', connection: "account" },
      map: ${JSON.stringify(map)},
    }),
  },
  listing: { publisher: "acme", summary: "Tickets.", avatar: "assets/avatar.png", version: "1.2.0", ${extra} },
});
`;
}

const WIDGET = `
import { label } from "./words.js";

export function render(data: { values: { total?: number } }) {
  return { v: 1, scene: { kind: "metric" as const, value: data.values.total ?? 0, label } };
}
`;

function write(files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const run = (options: { registry?: string; check?: boolean } = {}) =>
  build({ root, plugin: "src/plugin.ts", check: false, ...options });

beforeEach(() => {
  root = mkdtempSync(join(here, ".build-"));
  errors = [];
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
  write({
    "package.json": JSON.stringify({ name: "tracker", version: "1.2.0" }),
    "src/plugin.ts": plugin(),
    "widgets/total.ts": WIDGET,
    "widgets/words.ts": 'export const label = "Open";\n',
    "assets/avatar.png": avatar,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const manifest = () => JSON.parse(readFileSync(join(root, "manifest.json"), "utf-8"));

describe("build", () => {
  it("writes the manifest with each widget bundled into one script that leaves render as a global", async () => {
    expect(await run()).toBe(0);
    const [widget] = manifest().widgets;
    expect(widget).toMatchObject({ id: "total", endpoints: ["plugin.acme.tracker.count"] });
    expect(widget.module_source).not.toMatch(/\bimport\b|\bexport\b/);
    const sandbox: Record<string, unknown> = {};
    runInNewContext(widget.module_source, sandbox);
    expect((sandbox.render as (data: unknown) => unknown)({ values: { total: 4 } })).toEqual({
      v: 1,
      scene: { kind: "metric", value: 4, label: "Open" },
    });
  });

  it("checks the committed files, and fails once a widget changes without a build", async () => {
    await run();
    expect(await run({ check: true })).toBe(0);
    write({ "widgets/words.ts": 'export const label = "Still open";\n' });
    expect(await run({ check: true })).toBe(1);
    expect(errors.join("")).toContain("manifest.json is out of date");
  });

  it("refuses a manifest that does not validate, and writes nothing", async () => {
    write({ "src/plugin.ts": plugin('schedules: { sweep: { every: "1m", run: async () => {} } },') });
    expect(await run()).toBe(1);
    expect(errors.join("")).toContain("/schedules/0/every");
    expect(existsSync(join(root, "manifest.json"))).toBe(false);
  });

  it("refuses a widget over the size cap", async () => {
    write({ "widgets/words.ts": `export const label = "${"x".repeat(70_000)}";\n` });
    expect(await run()).toBe(1);
    expect(errors.join("")).toContain("over the 65536-byte cap");
  });

  it("writes a part written as JSX as its plain tree", async () => {
    const parts = join(here, "..", "src", "parts.js");
    write({
      // The SDK's own source stands in for the installed package.
      "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx", jsxImportSource: join(here, "..", "src") } }),
      "src/plugin.tsx": `import { Field, Section } from ${JSON.stringify(parts)};\n${plugin(`
  fields: { "demo.link": { name: { en: "Demo" }, kind: "link", on: ["task"] } },
  parts: { demo: { name: { en: "Demo" }, on: ["task"], tree: <Section><><Field field="demo.link" /></></Section> } },`)}`,
    });
    expect(await build({ root, plugin: "src/plugin.tsx", check: false })).toBe(0);
    expect(manifest().parts).toEqual([
      { id: "demo", name: { en: "Demo" }, on: ["task"], tree: { type: "section", children: [{ type: "field", props: { field: "demo.link" } }] } },
    ]);
  });
});

describe("the registry source", () => {
  it("is the listing, this version's manifest and the avatar, while the listing names the package's version", async () => {
    expect(await run({ registry: "registry" })).toBe(0);
    const source = join(root, "registry", "acme", "K7M2QX8N4TVB9C");
    expect(JSON.parse(readFileSync(join(source, "listing.json"), "utf-8"))).toEqual({
      schema: 1,
      uid: "K7M2QX8N4TVB9C",
      public_id: "acme.tracker",
      publisher: "acme",
      kind: "plugin",
      name: "Tracker",
      summary: "Tickets.",
      avatar: { path: "assets/avatar.png", sha256: createHash("sha256").update(avatar).digest("hex") },
      versions: [{ version: "1.2.0", definition: "1.2.0/manifest.json", release_notes: "First." }],
      registration: {
        kind: "container",
        image: `ghcr.io/acme/tracker@sha256:${"a".repeat(64)}`,
        scope_ceiling: [],
      },
    });
    expect(JSON.parse(readFileSync(join(source, "1.2.0", "manifest.json"), "utf-8"))).toEqual(manifest());
    expect(readFileSync(join(source, "assets", "avatar.png"))).toEqual(avatar);
    expect(await run({ registry: "registry", check: true })).toBe(0);
  });

  it("carries the listing's compose snippet in its registration", async () => {
    const service = "tracker:\n  image: ${IMAGE}\n  environment:\n    INITIATIVE_URL: ${INITIATIVE_URL}\n";
    write({
      "src/plugin.ts": plugin("", `compose: { service: ${JSON.stringify(service)}, baseUrl: "http://tracker:8080" },`),
    });
    expect(await run({ registry: "registry" })).toBe(0);
    const listing = JSON.parse(
      readFileSync(join(root, "registry", "acme", "K7M2QX8N4TVB9C", "listing.json"), "utf-8")
    );
    expect(listing.registration.compose).toEqual({ service, base_url: "http://tracker:8080" });
  });

  it("refuses a compose snippet with another placeholder or an address that is not http", async () => {
    const service = "tracker:\n  image: ${IMAGES}\n  command: [\"$${HOME}\"]\n";
    write({
      "src/plugin.ts": plugin("", `compose: { service: ${JSON.stringify(service)}, baseUrl: "ftp://tracker" },`),
    });
    expect(await run()).toBe(1);
    const text = errors.join("");
    expect(text).toContain("${IMAGES} is not a placeholder");
    expect(text).toContain("${HOME} is not a placeholder");
    expect(text).toContain("baseUrl is an http or https URL");
    expect(existsSync(join(root, "manifest.json"))).toBe(false);
  });

  it("carries the listing's runtime in the registry's spelling, variable names untouched", async () => {
    const runtime = `runtime: {
      name: "tracker",
      port: 8200,
      health: { ready: "/readyz", live: "/healthz", startupSeconds: 120 },
      migratesOnStart: true,
      pages: true,
      facts: { APP_ORIGIN: "page_origin", INITIATIVE_API_URL: "app_api_internal" },
      settings: [{ env: "TRACKER_MODE", required: true }],
      signingKey: { env: "TRACKER_PRIVATE_KEY_PEM" },
      database: {
        dsnScheme: "postgresql+asyncpg",
        roles: [{ id: "owner", login: "tracker_owner", env: "OWNER_DATABASE_URL" }],
        provisionSql: "/app/provision.sql",
      },
      secrets: [{ id: "session-key", kind: "ed25519_private_key_pem", env: "SESSION_PRIVATE_KEY_PEM" }],
      metrics: { path: "/metrics", tokenEnv: "METRICS_TOKEN" },
      integrations: { billing: { hmacEnv: "BILLING_HMAC", publicKeyEnv: "BILLING_PUBLIC_KEY_PEM" } },
    },`;
    write({ "src/plugin.ts": plugin("", runtime) });
    expect(await run({ registry: "registry" })).toBe(0);
    const listing = JSON.parse(
      readFileSync(join(root, "registry", "acme", "K7M2QX8N4TVB9C", "listing.json"), "utf-8")
    );
    expect(listing.registration.runtime).toEqual({
      name: "tracker",
      port: 8200,
      health: { ready: "/readyz", live: "/healthz", startup_seconds: 120 },
      migrates_on_start: true,
      pages: true,
      facts: { APP_ORIGIN: "page_origin", INITIATIVE_API_URL: "app_api_internal" },
      settings: [{ env: "TRACKER_MODE", required: true }],
      signing_key: { env: "TRACKER_PRIVATE_KEY_PEM" },
      database: {
        dsn_scheme: "postgresql+asyncpg",
        roles: [{ id: "owner", login: "tracker_owner", env: "OWNER_DATABASE_URL" }],
        provision_sql: "/app/provision.sql",
      },
      secrets: [{ id: "session-key", kind: "ed25519_private_key_pem", env: "SESSION_PRIVATE_KEY_PEM" }],
      metrics: { path: "/metrics", token_env: "METRICS_TOKEN" },
      integrations: { billing: { hmac_env: "BILLING_HMAC", public_key_env: "BILLING_PUBLIC_KEY_PEM" } },
    });
  });

  it("refuses a runtime the registry would refuse", async () => {
    const runtime = `runtime: {
      name: "Tracker",
      port: 80,
      health: { ready: "readyz", live: "/healthz" },
      facts: { APP_ORIGIN: "page_origin", lower: "app_url" },
      settings: [{ env: "APP_ORIGIN" }],
      database: { roles: [], provisionSql: "provision.sh" },
    },`;
    write({ "src/plugin.ts": plugin("", runtime) });
    expect(await run()).toBe(1);
    const text = errors.join("");
    expect(text).toContain("listing runtime: name is a DNS label");
    expect(text).toContain("listing runtime: port is 1024 to 65535");
    expect(text).toContain("listing runtime: readyz is not an absolute path");
    expect(text).toContain("listing runtime: lower is not an environment variable name");
    expect(text).toContain("listing runtime: APP_ORIGIN is filled twice");
    expect(text).toContain("listing runtime: page_origin is a plug-in's own origin");
    expect(text).toContain("listing runtime: database provisionSql is an absolute path");
  });

  it("carries the listing's screenshots, each signed by its digest with its alt text", async () => {
    const board = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
    const detail = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
    write({
      "screens/board.png": board,
      "screens/detail.svg": detail,
      "src/plugin.ts": plugin(
        "",
        `images: [
          { path: "screens/board.png", alt: "A board of open tickets" },
          { path: "screens/detail.svg", alt: "One ticket, open" },
        ],`
      ),
    });
    expect(await run({ registry: "registry" })).toBe(0);
    const source = join(root, "registry", "acme", "K7M2QX8N4TVB9C");
    const listing = JSON.parse(readFileSync(join(source, "listing.json"), "utf-8"));
    expect(listing.images).toEqual([
      { path: "assets/board.png", sha256: digest(board), alt: "A board of open tickets" },
      { path: "assets/detail.svg", sha256: digest(detail), alt: "One ticket, open" },
    ]);
    expect(readFileSync(join(source, "assets", "board.png"))).toEqual(board);
    expect(readFileSync(join(source, "assets", "detail.svg"))).toEqual(detail);
    expect(await run({ registry: "registry", check: true })).toBe(0);
  });

  it("names no images when the listing has none", async () => {
    expect(await run({ registry: "registry" })).toBe(0);
    const listing = JSON.parse(
      readFileSync(join(root, "registry", "acme", "K7M2QX8N4TVB9C", "listing.json"), "utf-8")
    );
    expect(listing).not.toHaveProperty("images");
  });

  it("refuses screenshots the registry would refuse", async () => {
    const thirteen = Array.from({ length: 13 }, (_, n) => `{ path: "s/${n}.png", alt: "Shot ${n}" }`).join(", ");
    write({ "src/plugin.ts": plugin("", `images: [${thirteen}],`) });
    expect(await run()).toBe(1);
    expect(errors.join("")).toContain("listing images: at most 12, not 13");

    errors.length = 0;
    write({
      "src/plugin.ts": plugin(
        "",
        `images: [
          { path: "screens/notes.txt", alt: "Notes" },
          { path: "screens/board.png", alt: "" },
          { path: "screens/avatar.png", alt: "Clashes with the avatar" },
        ],`
      ),
    });
    expect(await run()).toBe(1);
    const text = errors.join("");
    expect(text).toContain("listing images: screens/notes.txt is not a PNG, JPEG, WebP, GIF, AVIF or SVG file");
    expect(text).toContain("listing images: screens/board.png needs alt text of 1 to 300 characters");
    expect(text).toContain("listing images: screens/avatar.png has the same file name as another picture");
  });

  it("is left as it was between releases", async () => {
    write({ "package.json": JSON.stringify({ name: "tracker", version: "1.3.0" }) });
    expect(await run({ registry: "registry" })).toBe(0);
    expect(existsSync(join(root, "registry"))).toBe(false);
    expect(existsSync(join(root, "manifest.json"))).toBe(true);
  });
});

describe("a declarative plug-in", () => {
  it("fails the build on an expression that does not parse, at its place", async () => {
    write({ "src/plugin.ts": declarative('{"total": response.body.count') });
    expect(await run()).toBe(1);
    expect(errors.join("")).toMatch(/manifest\/endpoints\/0\/map: does not parse: .* \(at character \d+\)/);
    expect(existsSync(join(root, "manifest.json"))).toBe(false);
  });

  it("is registered as declarative, with no image", async () => {
    write({ "src/plugin.ts": declarative('{"total": response.body.count}') });
    expect(await run({ registry: "registry" })).toBe(0);
    expect(manifest()).not.toHaveProperty("service");
    const listing = JSON.parse(readFileSync(join(root, "registry", "acme", "K7M2QX8N4TVB9C", "listing.json"), "utf-8"));
    expect(listing.registration).toEqual({ kind: "declarative", scope_ceiling: [] });
  });

  it("refuses an image, and a container plug-in's listing without one", async () => {
    write({ "src/plugin.ts": declarative("{}", `image: "ghcr.io/acme/tracker@sha256:${"a".repeat(64)}"`) });
    expect(await run()).toBe(1);
    expect(errors.join("")).toContain("listing: a declarative plug-in has no image, compose service or runtime");
    write({ "src/plugin.ts": plugin().replace(/image: .*\n/, "") });
    expect(await run()).toBe(1);
    expect(errors.join("")).toContain("listing: a container plug-in names its image");
  });
});

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const picture = `/api/v1/marketplace/media/${digest(avatar)}`;

describe("a plug-in built outside TypeScript", () => {
  /** The definition's manifest, as a plug-in written in another language writes it with its listing. */
  async function built(listing: Record<string, unknown> = {}) {
    expect(await run()).toBe(0);
    const written = manifest();
    rmSync(join(root, "manifest.json"));
    rmSync(join(root, "package.json"));
    write({
      "plugin.json": JSON.stringify({
        publicId: "acme.tracker",
        uid: "K7M2QX8N4TVB9C",
        name: "Tracker",
        manifest: written,
        listing: {
          publisher: "acme",
          summary: "Tickets.",
          avatar: "assets/avatar.png",
          version: "2.0.0",
          image: `ghcr.io/acme/tracker@sha256:${"b".repeat(64)}`,
          ...listing,
        },
      }),
    });
    return written;
  }

  it("refuses a listing that still names reference sectors", async () => {
    await built({ referenceSectors: ["billing"] });
    expect(await build({ root, plugin: "src/plugin.ts", manifest: "plugin.json", registry: "registry", check: false })).toBe(1);
    expect(errors.join("\n")).toContain("listing.referenceSectors was removed in 7.0");
  });

  it("writes its registry source from its manifest and the version its listing states", async () => {
    const written = await built();
    expect(await build({ root, plugin: "src/plugin.ts", manifest: "plugin.json", registry: "registry", check: false })).toBe(0);
    const source = join(root, "registry", "acme", "K7M2QX8N4TVB9C");
    const listing = JSON.parse(readFileSync(join(source, "listing.json"), "utf-8"));
    expect(listing.versions).toEqual([{ version: "2.0.0", definition: "2.0.0/manifest.json" }]);
    expect(listing.registration).toEqual({
      kind: "container",
      image: `ghcr.io/acme/tracker@sha256:${"b".repeat(64)}`,
      scope_ceiling: [],
    });
    expect(JSON.parse(readFileSync(join(source, "2.0.0", "manifest.json"), "utf-8"))).toEqual(written);
    expect(existsSync(join(root, "manifest.json"))).toBe(false);
  });

  it("packs its listing file", async () => {
    const written = await built();
    expect(await pack({ root, plugin: "src/plugin.ts", manifest: "plugin.json", out: "tracker.json" })).toBe(0);
    const listing = JSON.parse(readFileSync(join(root, "tracker.json"), "utf-8"));
    expect(listing.definition).toEqual(written);
    expect(listing.version).toBe("2.0.0");
  });

  it("is checked as a definition's manifest is", async () => {
    await built({ image: undefined });
    expect(await build({ root, plugin: "src/plugin.ts", manifest: "plugin.json", registry: "registry", check: false })).toBe(1);
    expect(errors.join("")).toContain("listing: a container plug-in names its image");
    write({ "plugin.json": JSON.stringify({ publicId: "acme.tracker" }) });
    expect(await build({ root, plugin: "src/plugin.ts", manifest: "plugin.json", check: false })).toBe(1);
    expect(errors.join("")).toContain("a built plug-in names its uid, name, manifest");
    expect(existsSync(join(root, "registry"))).toBe(false);
  });
});

describe("pack", () => {
  it("writes the listing file a deployment publishes, its picture named by its digest", async () => {
    write({ "src/plugin.ts": declarative('{"total": response.body.count}') });
    expect(await run()).toBe(0);
    expect(await pack({ root, plugin: "src/plugin.ts" })).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "acme.tracker-1.2.0.json"), "utf-8"))).toEqual({
      uid: "K7M2QX8N4TVB9C",
      public_id: "acme.tracker",
      kind: "plugin",
      name: "Tracker",
      publisher: "acme",
      description: "Tickets.",
      avatar_url: picture,
      version: "1.2.0",
      definition: manifest(),
      registration: { kind: "declarative", scope_ceiling: [] },
    });
  });

  it("packs a container plug-in with its image, and leaves out a picture a deployment does not keep", async () => {
    write({ "src/plugin.ts": plugin().replace("assets/avatar.png", "assets/avatar.svg"), "assets/avatar.svg": "<svg/>" });
    expect(await pack({ root, plugin: "src/plugin.ts", out: "tracker.json" })).toBe(0);
    const listing = JSON.parse(readFileSync(join(root, "tracker.json"), "utf-8"));
    expect(listing).not.toHaveProperty("avatar_url");
    expect(listing.release_notes).toBe("First.");
    expect(listing.registration).toEqual({ kind: "container", image: `ghcr.io/acme/tracker@sha256:${"a".repeat(64)}`, scope_ceiling: [] });
    expect(output.join("")).toContain("assets/avatar.svg is not PNG, JPEG, GIF or WebP");
  });
});

/**
 * A deployment's listing upload and listing pictures, as an owner's API key
 * reaches them: a version is published once, and again only with the same
 * content.
 */
async function fakeInitiative() {
  const uploads: Array<Record<string, any>> = [];
  const pictures: Buffer[] = [];
  const published = new Map<string, string>();
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const answer = (status: number, json: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(json));
    };
    if (request.headers.authorization !== "Bearer ppk_owner") return answer(401, { detail: "COULD_NOT_VALIDATE_CREDENTIALS" });
    if (request.url === "/api/v1/marketplace/local/media") {
      const form = await new Request("http://initiative", { method: "POST", headers: { "content-type": String(request.headers["content-type"]) }, body }).formData();
      const file = Buffer.from(await (form.get("file") as Blob).arrayBuffer());
      pictures.push(file);
      return answer(201, { path: `/api/v1/marketplace/media/${digest(file)}` });
    }
    const { manifest: listing } = JSON.parse(body.toString("utf-8"));
    const key = `${listing.uid} ${listing.version}`;
    if (published.has(key) && published.get(key) !== JSON.stringify(listing)) {
      return answer(422, { detail: "LISTING_UPLOAD_INVALID", problem: `version ${listing.version} is already published with different content` });
    }
    published.set(key, JSON.stringify(listing));
    uploads.push(listing);
    answer(201, { uid: listing.uid, public_id: listing.public_id, version: listing.version });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, uploads, pictures, close: () => server.close() };
}

async function until(holds: () => boolean): Promise<void> {
  for (let waited = 0; !holds(); waited += 20) {
    if (waited > 10_000) throw new Error("timed out");
    await new Promise((tick) => setTimeout(tick, 20));
  }
}

describe("dev", () => {
  it("uploads the listing with its picture, and again under a new version when the source changes", async () => {
    const initiative = await fakeInitiative();
    write({ "src/plugin.ts": declarative('{"total": response.body.count}') });
    const stop = new AbortController();
    const running = dev({ root, plugin: "src/plugin.ts", initiative: initiative.url, apiKey: "ppk_owner", signal: stop.signal });
    try {
      await until(() => initiative.uploads.length === 1);
      const [first] = initiative.uploads;
      expect(first.version).toMatch(/^1\.2\.0-dev\.[0-9a-f]{8}$/);
      expect(first).toMatchObject({ uid: "K7M2QX8N4TVB9C", avatar_url: picture, registration: { kind: "declarative" } });
      expect(initiative.pictures[0]).toEqual(avatar);
      await until(() => output.join("").includes("watching"));
      expect(output.join("")).toContain(
        `uploaded acme.tracker ${first.version} (uid K7M2QX8N4TVB9C): 201 {"uid":"K7M2QX8N4TVB9C","public_id":"acme.tracker","version":"${first.version}"}`
      );

      write({ "src/plugin.ts": declarative('{"total": response.body.total}') });
      await until(() => initiative.uploads.length === 2);
      expect(initiative.uploads[1].version).not.toBe(first.version);
      expect(initiative.uploads[1].definition.endpoints[0].map).toBe('{"total": response.body.total}');
    } finally {
      stop.abort();
      initiative.close();
    }
    expect(await running).toBe(0);
  });

  it("stops when the deployment refuses the key, and refuses a container plug-in", async () => {
    const initiative = await fakeInitiative();
    try {
      write({ "src/plugin.ts": declarative('{"total": response.body.count}') });
      expect(await dev({ root, plugin: "src/plugin.ts", initiative: initiative.url, apiKey: "ppk_nobody" })).toBe(1);
      expect(errors.join("")).toContain('refused the picture: 401 {"detail":"COULD_NOT_VALIDATE_CREDENTIALS"}');
      write({ "src/plugin.ts": plugin() });
      expect(await dev({ root, plugin: "src/plugin.ts", initiative: initiative.url, apiKey: "ppk_owner" })).toBe(1);
      expect(errors.join("")).toContain("dev uploads a declarative plug-in");
      expect(initiative.uploads).toEqual([]);
    } finally {
      initiative.close();
    }
  });
});
