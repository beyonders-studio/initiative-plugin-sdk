/**
 * A deployment's package, built in memory, to test a plug-in's term check
 * against: a TUF repository laid out as initiative-packages lays one out
 * (consistent snapshots, targets under their sha256), whose top-level
 * `targets` delegates the `package` role over `entitlements/*` and `grants/*`.
 *
 * The keys come from `seed` and the dates from `now`, and Ed25519 signs
 * deterministically, so one seed builds the same bytes every time. Mirrors
 * billing's `billing/devtools/tuf_package.py`.
 */

import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { Metadata, Signature } from "@tufjs/models";
import { BaseFetcher, type Fetcher } from "tuf-js";
import { DownloadHTTPError } from "tuf-js/dist/error.js";
import { sha256 } from "./term.js";

/** A registration key's document, as `grants/<key_id>.json` holds it. */
export interface TestKeyDocument {
  key_id: string;
  deployment?: string;
  issued_at?: string;
  months?: number;
  expires_at?: string;
  limits?: Record<string, number>;
  apps?: Record<string, { communities?: number | null; values?: Record<string, number | null>; plan?: string | null }>;
}

export interface TestPackageOptions {
  /** The keys' seed. Default: a fixed one. */
  seed?: string;
  /** The package's keys. Default: one unlimited key, `test-unlimited`. */
  keys?: TestKeyDocument[];
  /**
   * Each listing's terms, by uid, signed as `entitlements/<uid>.json`. A
   * listing with none isn't sold on the package's deployment. Default: none.
   */
  listings?: Record<string, { access: "open" | "entitled"; mandatory: boolean; meters?: string[] }>;
  /** The day everything is dated from. Default: 2026-10-01. */
  now?: Date;
  /** How long every role and the default key are valid, in days. Default: ten years. */
  lifetimeDays?: number;
  /** Where it is served. Default: `https://packages.test/packages/test/`. */
  packageUrl?: string;
}

export interface TestPackage {
  /** The root to trust, as JSON: pass it as `root` to `readTerm`. */
  root: string;
  packageUrl: string;
  /** Every file it serves, by path under `packageUrl`. */
  files: Map<string, Buffer>;
  /** Serves `files` to tuf-js; pass it as `fetcher` to `readTerm`. */
  fetcher: Fetcher;
}

const DAY = 86_400_000;
const TOP = ["root", "targets", "snapshot", "timestamp"] as const;

/** Build a signed package holding `keys`; by default one unlimited key. */
export function buildTestPackage(options: TestPackageOptions = {}): TestPackage {
  const seed = options.seed ?? "initiative-plugin-sdk test package";
  const now = options.now ?? new Date("2026-10-01T00:00:00Z");
  const lifetime = (options.lifetimeDays ?? 3650) * DAY;
  const expires = iso(new Date(now.getTime() + lifetime));
  const packageUrl = options.packageUrl ?? "https://packages.test/packages/test/";
  const day = now.toISOString().slice(0, 10);
  const keys = options.keys ?? [
    {
      key_id: "test-unlimited",
      expires_at: new Date(now.getTime() + lifetime).toISOString().slice(0, 10),
      months: 120,
    },
  ];

  const signers = Object.fromEntries([...TOP, "package"].map((role) => [role, signer(seed, role)]));
  const files = new Map<string, Buffer>();
  const write = (path: string, metadata: Metadata<never>) => files.set(path, Buffer.from(JSON.stringify(metadata.toJSON())));

  const root = Metadata.fromJSON("root" as never, {
    signed: {
      _type: "root",
      spec_version: "1.0.31",
      version: 1,
      expires,
      consistent_snapshot: true,
      keys: Object.fromEntries(TOP.map((role) => [signers[role].keyId, signers[role].key])),
      roles: Object.fromEntries(TOP.map((role) => [role, { keyids: [signers[role].keyId], threshold: 1 }])),
    },
    signatures: [],
  } as never) as Metadata<never>;
  sealWith(root, signers.root);
  const rootBytes = Buffer.from(JSON.stringify(root.toJSON()));
  files.set("metadata/1.root.json", rootBytes);

  const targets: Record<string, { length: number; hashes: { sha256: string } }> = {};
  for (const key of keys) {
    const document = {
      deployment: "test",
      issued_at: day,
      months: 12,
      expires_at: day,
      limits: {},
      apps: {},
      ...key,
    };
    const path = `grants/${key.key_id}.json`;
    const data = Buffer.from(JSON.stringify(document));
    const digest = sha256(data);
    targets[path] = { length: data.length, hashes: { sha256: digest } };
    files.set(`targets/grants/${digest}.${key.key_id}.json`, data);
  }
  for (const [uid, terms] of Object.entries(options.listings ?? {})) {
    const path = `entitlements/${uid}.json`;
    const data = Buffer.from(JSON.stringify({ listing_uid: uid, meters: [], ...terms }));
    const digest = sha256(data);
    targets[path] = { length: data.length, hashes: { sha256: digest } };
    files.set(`targets/entitlements/${digest}.${uid}.json`, data);
  }
  const packageRole = Metadata.fromJSON("targets" as never, {
    signed: { _type: "targets", spec_version: "1.0.31", version: 1, expires, targets },
    signatures: [],
  } as never) as Metadata<never>;
  sealWith(packageRole, signers.package);
  write("metadata/1.package.json", packageRole);

  const top = Metadata.fromJSON("targets" as never, {
    signed: {
      _type: "targets",
      spec_version: "1.0.31",
      version: 1,
      expires,
      targets: {},
      delegations: {
        keys: { [signers.package.keyId]: signers.package.key },
        roles: [
          {
            name: "package",
            keyids: [signers.package.keyId],
            threshold: 1,
            terminating: true,
            paths: ["entitlements/*", "grants/*"],
          },
        ],
      },
    },
    signatures: [],
  } as never) as Metadata<never>;
  sealWith(top, signers.targets);
  write("metadata/1.targets.json", top);

  const snapshot = Metadata.fromJSON("snapshot" as never, {
    signed: {
      _type: "snapshot",
      spec_version: "1.0.31",
      version: 1,
      expires,
      meta: { "targets.json": { version: 1 }, "package.json": { version: 1 } },
    },
    signatures: [],
  } as never) as Metadata<never>;
  sealWith(snapshot, signers.snapshot);
  write("metadata/1.snapshot.json", snapshot);

  const timestamp = Metadata.fromJSON("timestamp" as never, {
    signed: {
      _type: "timestamp",
      spec_version: "1.0.31",
      version: 1,
      expires,
      meta: { "snapshot.json": { version: 1 } },
    },
    signatures: [],
  } as never) as Metadata<never>;
  sealWith(timestamp, signers.timestamp);
  write("metadata/timestamp.json", timestamp);

  return { root: rootBytes.toString("utf-8"), packageUrl, files, fetcher: new MapFetcher(packageUrl, files) };
}

interface Signer {
  keyId: string;
  key: { keytype: string; scheme: string; keyval: { public: string } };
  privateKey: KeyObject;
}

function signer(seed: string, role: string): Signer {
  const raw = Buffer.from(sha256(`${seed}\u0000${role}`), "hex");
  // PKCS#8 for an Ed25519 key is a fixed prefix and the 32-byte seed.
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), raw]),
    format: "der",
    type: "pkcs8",
  });
  const publicRaw = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  const key = { keytype: "ed25519", scheme: "ed25519", keyval: { public: publicRaw.toString("hex") } };
  return { keyId: sha256(canonical(key)), key, privateKey };
}

function sealWith(metadata: Metadata<never>, by: Signer): void {
  metadata.sign((data: Buffer) => new Signature({ keyID: by.keyId, sig: sign(null, data, by.privateKey).toString("hex") }));
}

/** Canonical JSON, as TUF signs it: sorted keys, no whitespace. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function iso(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

class MapFetcher extends BaseFetcher {
  constructor(
    private readonly base: string,
    private readonly files: Map<string, Buffer>
  ) {
    super();
  }

  async fetch(url: string): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
    const data = url.startsWith(this.base) ? this.files.get(url.slice(this.base.length)) : undefined;
    if (!data) throw new DownloadHTTPError(`${url} not found`, 404);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(data));
        controller.close();
      },
    });
  }
}
