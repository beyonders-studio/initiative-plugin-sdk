/**
 * `initiative-plugin-sdk/term`: the deployment's term, read from its package
 * and verified here, and what it lets the plug-in honour.
 *
 * A deployment's package is a TUF repository the package gateway serves.
 * Under the role `package` it signs the deployment's registration keys,
 * `grants/<key_id>.json`, each one purchase:
 *
 *     {"key_id", "deployment", "issued_at", "months", "expires_at",
 *      "limits": {"users", "storage_bytes"},
 *      "apps": {"<listing_uid>": {"communities": 20, "values": {"<pool>": n}, "plan": "…"}}}
 *
 * For a plug-in, its own entry in `apps` is what counts, always that one shape:
 * `communities` is how many communities may hold it (its seats), and `values`
 * its pools, in its own statement keys. One left out, or null, is unlimited. A
 * deployment holds a key per purchase, so its term is what the live keys (not
 * yet expired) add up to.
 *
 * What kind of listing the plug-in is (`mandatory`, and its `access`) is the
 * package's to say, in the terms the same role signs,
 * `entitlements/<listing_uid>.json`. The SDK reads them from the verified
 * package and never works them out from anything else: not a statement's
 * shape, not a key's, not a default. A listing the package has no terms for is
 * not sold on this deployment, and nothing of it is honoured.
 *
 * Billing shares the term out and says so in each statement. This module is
 * the plug-in's own check of it, so that a statement signed by whoever holds
 * the statement key is still not honoured past the term without a key only
 * the package's signers hold:
 *
 * 1. {@link readTerm} (or {@link PackageTerm}, which keeps the last good read)
 *    verifies the package from a pinned root, the production root shipped in
 *    the SDK by default, with tuf-js, and reads the keys the `package` role
 *    signs. Nothing the gateway serves is used until the chain above it
 *    verifies; the gateway token only chooses which package is read.
 * 2. {@link checkTerm} takes the statements the plug-in holds and answers
 *    which it may honour: a community without a seat, or past a pool, is
 *    refused `term_exceeded`; one billing itself marked `term_full` stays
 *    refused; with no term at all (no root, no package, no live key), every
 *    statement is refused `no_term`.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseFetcher, type Fetcher, Updater } from "tuf-js";
import { DownloadHTTPError } from "tuf-js/dist/error.js";
import { PRODUCTION_ROOT } from "./package-root.js";

export { PRODUCTION_ROOT } from "./package-root.js";

/** The role a package signs its registration keys with. */
export const PACKAGE_ROLE = "package";
const GRANTS = "grants/";
const TERMS = "entitlements/";
const LISTING_FIELDS = ["listing_uid", "access", "mandatory", "meters"];
const APP_FIELDS = ["communities", "values", "plan"];
/** A path under the package role that names no key: asking for it loads the role. */
const PROBE = `${GRANTS}_.json`;
const MAX_FILE_BYTES = 16 * 1024;
const MAX_KEYS = 64;
const MAX_LISTINGS = 256;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;

/** One plug-in's agreement in a key: its seats, its pools, and the plan it's sold on. */
export interface KeyApp {
  communities?: number | null;
  values?: Record<string, number | null>;
  plan?: string | null;
}

/** One registration key, as the package signs it. */
export interface RegistrationKey {
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  months: number;
  /** Each plug-in's agreement, by listing uid. */
  apps: Record<string, KeyApp>;
}

/** What the package says one listing is, from `entitlements/<listing_uid>.json`. */
export interface ListingTerms {
  /** Who may install it: anyone (`open`), or a community billing entitles (`entitled`). */
  access: "open" | "entitled";
  /** Whether every community has it. */
  mandatory: boolean;
  /** The usage counters it may report. */
  meters: string[];
}

/** What a verified package holds of the term: its keys, and its listings' terms. */
export interface PackageContents {
  keys: RegistrationKey[];
  /** Each listing's terms, by uid. */
  listings: Record<string, ListingTerms>;
}

/** What the live keys add up to, for every plug-in they name. */
export interface DeploymentTerm {
  /** The live keys, by id, sorted. */
  keyIds: string[];
  /** Each listing's seats; a listing absent here may be held by any number of communities. */
  seats: Record<string, number>;
  /** Each listing's pools by statement key; a pool absent here is unlimited. */
  pools: Record<string, Record<string, number>>;
  /** The soonest a live key expires (`YYYY-MM-DD`). */
  expiresAt: string;
  /** Each listing's terms, as the package signs them; a listing absent here isn't sold here. */
  listings: Record<string, ListingTerms>;
}

/** The package could not be read, or did not verify. `code` says which. */
export class PackageUnavailableError extends Error {
  constructor(
    readonly code: string,
    detail = ""
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PackageUnavailableError";
  }
}

export interface ReadTermOptions {
  /** The package's base URL, where `metadata/` and `targets/` are served. */
  packageUrl: string;
  /** The package gateway's token, sent only to the package URL's own origin. */
  token?: string;
  /**
   * The root to trust, as JSON. Default: {@link PRODUCTION_ROOT}. A root file
   * holding a `placeholder` member is no root.
   */
  root?: string;
  /**
   * Where the verified metadata is kept between reads, so a package older than
   * one already verified is refused. Default: a scratch directory per read.
   */
  metadataDir?: string;
  /** How files are fetched. Default: `fetch`, no redirects, every body capped. */
  fetcher?: Fetcher;
  /** Today, for which keys are live. Default: now. */
  now?: Date;
}

/**
 * Verify the deployment's package and add up its live registration keys.
 * Null when there is no term: no root, no `package` role, or no live key.
 * Throws {@link PackageUnavailableError} when the package doesn't verify.
 */
export async function readTerm(options: ReadTermOptions): Promise<DeploymentTerm | null> {
  const contents = await readPackage(options);
  return contents === null ? null : combineKeys(contents.keys, options.now, contents.listings);
}

/**
 * The registration keys (live or not) and the listings' terms the package
 * signs, verified; null when there is no root. Throws
 * {@link PackageUnavailableError} when the package doesn't verify.
 */
export async function readPackage(options: ReadTermOptions): Promise<PackageContents | null> {
  const root = options.root ?? PRODUCTION_ROOT;
  let rootDocument: unknown;
  try {
    rootDocument = JSON.parse(root);
  } catch {
    throw new PackageUnavailableError("ROOT_INVALID", "the root is not JSON");
  }
  if (isRecord(rootDocument) && "placeholder" in rootDocument && !("signed" in rootDocument)) return null;
  const base = options.packageUrl.endsWith("/") ? options.packageUrl : `${options.packageUrl}/`;
  const scratch = options.metadataDir === undefined;
  const dir = options.metadataDir ?? mkdtempSync(join(tmpdir(), "initiative-term-"));
  try {
    mkdirSync(join(dir, "download"), { recursive: true });
    writeFileSync(join(dir, "root.json"), root);
    const updater = new Updater({
      metadataDir: dir,
      metadataBaseUrl: `${base}metadata/`,
      targetDir: join(dir, "download"),
      targetBaseUrl: `${base}targets/`,
      fetcher: options.fetcher ?? new GatewayFetcher(base, options.token ?? ""),
      config: {
        rootMaxLength: MAX_METADATA_BYTES,
        timestampMaxLength: 64 * 1024,
        snapshotMaxLength: MAX_METADATA_BYTES,
        targetsMaxLength: MAX_METADATA_BYTES,
        maxDelegations: 64,
        fetchRetries: 0,
      },
    });
    try {
      await updater.refresh();
    } catch (error) {
      throw new PackageUnavailableError("PACKAGE_INVALID", messageOf(error));
    }
    return await signed(updater, dir);
  } finally {
    if (scratch) rmSync(dir, { recursive: true, force: true });
  }
}

async function signed(updater: Updater, dir: string): Promise<PackageContents> {
  const none: PackageContents = { keys: [], listings: {} };
  const top = signedOf(readFileSync(join(dir, "targets.json"), "utf-8"));
  const role = (top.delegations?.roles ?? []).find((r: { name?: string }) => r.name === PACKAGE_ROLE);
  if (!role || !delegates(role, PROBE)) return none;
  const snapshot = signedOf(readFileSync(join(dir, "snapshot.json"), "utf-8"));
  // Delegated with no role file published (the public index): nothing here.
  if (!snapshot.meta?.[`${PACKAGE_ROLE}.json`]) return none;
  try {
    await updater.getTargetInfo(PROBE);
  } catch (error) {
    throw new PackageUnavailableError("PACKAGE_ROLE_INVALID", messageOf(error));
  }
  // Written by the client only once it verified the role.
  const files = signedOf(readFileSync(join(dir, `${PACKAGE_ROLE}.json`), "utf-8")).targets ?? {};
  const under = (prefix: string) =>
    Object.keys(files)
      .filter((path) => path.startsWith(prefix) && path.endsWith(".json") && delegates(role, path))
      .sort();
  const grants = under(GRANTS);
  const terms = under(TERMS);
  if (grants.length > MAX_KEYS || terms.length > MAX_LISTINGS) {
    throw new PackageUnavailableError("TOO_MANY_FILES", `${grants.length} keys, ${terms.length} terms`);
  }
  const contents: PackageContents = { keys: [], listings: {} };
  for (const path of grants) {
    const key = parseKey(path, await download(updater, dir, path));
    if (key) contents.keys.push(key);
  }
  for (const path of terms) {
    const uid = path.slice(TERMS.length, -".json".length);
    const listing = parseListingTerms(uid, await download(updater, dir, path));
    if (listing) contents.listings[uid] = listing;
  }
  return contents;
}

/** One target the package role signs, checked against its target metadata. */
async function download(updater: Updater, dir: string, path: string): Promise<Buffer> {
  try {
    const info = await updater.getTargetInfo(path);
    if (!info || info.length > MAX_FILE_BYTES) throw new Error("not a small signed target");
    return readFileSync(await updater.downloadTarget(info, join(dir, "download", "file.json")));
  } catch (error) {
    throw new PackageUnavailableError("TARGET_REJECTED", `${path}: ${messageOf(error)}`);
  }
}

/**
 * A listing's terms held to the shape the package build signs, or null for
 * terms that don't hold (they are skipped, and the listing is not sold here).
 * Only two shapes are valid: `entitled`, not mandatory, no meters; or `open`
 * and mandatory, which may meter.
 */
export function parseListingTerms(uid: string, data: Buffer | string): ListingTerms | null {
  let doc: unknown;
  try {
    doc = JSON.parse(data.toString());
  } catch {
    return null;
  }
  if (!isRecord(doc) || Object.keys(doc).some((k) => !LISTING_FIELDS.includes(k))) return null;
  if (doc.listing_uid !== uid) return null;
  const { access, mandatory } = doc;
  const meters = doc.meters ?? [];
  if ((access !== "open" && access !== "entitled") || typeof mandatory !== "boolean") return null;
  if (!Array.isArray(meters) || !meters.every((m) => typeof m === "string" && m.length > 0)) return null;
  if (new Set(meters).size !== meters.length) return null;
  if (access === "entitled" && (mandatory || meters.length > 0)) return null;
  if (access === "open" && !mandatory) return null;
  return { access, mandatory, meters: meters as string[] };
}

/**
 * A registration key held to the shape the package build signs, or null for
 * one that doesn't hold (it is skipped).
 */
export function parseKey(path: string, data: Buffer | string): RegistrationKey | null {
  const stem = path.slice(GRANTS.length, -".json".length);
  let doc: unknown;
  try {
    doc = JSON.parse(data.toString());
  } catch {
    return null;
  }
  if (!isRecord(doc) || doc.key_id !== stem) return null;
  const { months, issued_at: issuedAt, expires_at: expiresAt } = doc;
  if (!isPositive(months) || !isDay(issuedAt) || !isDay(expiresAt)) return null;
  const limits = doc.limits ?? {};
  // A plug-in's seats are its own (`apps.<uid>.communities`), never a limit.
  if (!isRecord(limits) || "communities" in limits) return null;
  const apps = doc.apps ?? {};
  if (!isRecord(apps)) return null;
  const out: RegistrationKey["apps"] = {};
  for (const [uid, app] of Object.entries(apps)) {
    // One shape, whatever the listing: seats, pools, and the plan it's sold on.
    if (!isRecord(app) || Object.keys(app).some((k) => !APP_FIELDS.includes(k))) return null;
    const plan = app.plan ?? null;
    if (plan !== null && (typeof plan !== "string" || plan.length === 0)) return null;
    const seats = app.communities ?? null;
    if (seats !== null && !isPositive(seats)) return null;
    const values = app.values ?? {};
    if (!isRecord(values)) return null;
    for (const value of Object.values(values)) {
      if (value !== null && !isCount(value)) return null;
    }
    out[uid] = {
      communities: seats as number | null,
      values: values as Record<string, number | null>,
      plan: plan as string | null,
    };
  }
  return { keyId: stem, issuedAt, expiresAt, months: months as number, apps: out };
}

/** What the keys live on `now` add up to; null when none is. */
export function combineKeys(
  keys: RegistrationKey[],
  now: Date = new Date(),
  listings: Record<string, ListingTerms> = {}
): DeploymentTerm | null {
  const today = now.toISOString().slice(0, 10);
  const live = keys.filter((k) => k.expiresAt > today);
  if (live.length === 0) return null;
  const seats: Record<string, number> = {};
  const pools: Record<string, Record<string, number>> = {};
  for (const key of live) {
    for (const [uid, app] of Object.entries(key.apps)) {
      if (isPositive(app.communities)) seats[uid] = (seats[uid] ?? 0) + app.communities;
      for (const [name, value] of Object.entries(app.values ?? {})) {
        if (isCount(value)) {
          pools[uid] ??= {};
          pools[uid][name] = (pools[uid][name] ?? 0) + value;
        }
      }
    }
  }
  return {
    keyIds: live.map((k) => k.keyId).sort(),
    seats,
    pools,
    expiresAt: live.map((k) => k.expiresAt).sort()[0],
    listings: { ...listings },
  };
}

/**
 * The term, read again on each {@link refresh}, keeping the last verified keys
 * when a read fails: until they expire, a package that is down for a while
 * does not take the term away.
 */
export class PackageTerm {
  private contents: PackageContents | null = null;
  private lastError: PackageUnavailableError | null = null;

  constructor(private readonly options: Omit<ReadTermOptions, "now">) {}

  /** Read the package again; the term in force afterwards. */
  async refresh(now: Date = new Date()): Promise<DeploymentTerm | null> {
    try {
      this.contents = await readPackage(this.options);
      this.lastError = null;
    } catch (error) {
      if (!(error instanceof PackageUnavailableError)) throw error;
      this.lastError = error;
    }
    return this.current(now);
  }

  /** The term in force now, from the last verified read. */
  current(now: Date = new Date()): DeploymentTerm | null {
    return this.contents === null ? null : combineKeys(this.contents.keys, now, this.contents.listings);
  }

  /** Why the last read failed, or null when it verified. */
  get error(): PackageUnavailableError | null {
    return this.lastError;
  }
}

/** A statement the plug-in holds, for {@link checkTerm}. */
export interface HeldStatement {
  /** The community's install, as Initiative names it. */
  installation: string;
  /** What the verified statement says (see `VerifiedEntitlement`). */
  active: boolean;
  reason?: string | null;
  values: Record<string, unknown>;
  share?: Record<string, number> | null;
}

/** Why a statement isn't honoured. */
export type TermRefusal =
  /** No term in force: no root, no package, or no live key. */
  | "no_term"
  /** The package has no terms for this listing: it isn't sold on this deployment. */
  | "not_listed"
  /** Billing gave the community no seat. */
  | "term_full"
  /** Past the plug-in's seats, or a pool, under the term this plug-in read. */
  | "term_exceeded"
  /** Billing says the community holds nothing now, for its own reason. */
  | "inactive";

export interface TermVerdict {
  installation: string;
  honoured: boolean;
  /** Why not, when it isn't. */
  refusal: TermRefusal | null;
}

/**
 * Which statements the plug-in may honour under `term`, for its own listing.
 *
 * The listing must have terms in the package (`term.listings`): one without is
 * not sold on this deployment, and every statement is refused `not_listed`.
 * Its kind (mandatory, open or entitled) is the package's word, read there and
 * never worked out from a statement.
 *
 * `held` is every statement the plug-in holds, **in the order it first saw
 * each community**: the earliest are honoured first, so an existing holder
 * keeps its seat when a new community arrives past the limit. Keep that order
 * stable across calls (for example by the time each install's first
 * statement arrived).
 *
 * - A community billing marked inactive is refused and takes no seat.
 * - Seats: no more than `term.seats[listingUid]` active statements are
 *   honoured; the rest are refused `term_exceeded`.
 * - Pools: each honoured statement's share (its `share`, or else its value for
 *   that key, where an unlimited one never fits a finite pool) counts against
 *   the pool; one that would take the total past it is refused
 *   `term_exceeded` and counts nothing.
 */
export function checkTerm(
  term: DeploymentTerm | null,
  listingUid: string,
  held: HeldStatement[]
): TermVerdict[] {
  if (term === null) return held.map((s) => refuse(s, "no_term"));
  if (!term.listings[listingUid]) return held.map((s) => refuse(s, "not_listed"));
  const seats = term.seats[listingUid];
  const pools = term.pools[listingUid] ?? {};
  const used: Record<string, number> = {};
  let seated = 0;
  return held.map((statement) => {
    if (!statement.active) return refuse(statement, statement.reason === "term_full" ? "term_full" : "inactive");
    if (seats !== undefined && seated >= seats) return refuse(statement, "term_exceeded");
    const take: Record<string, number> = {};
    for (const [pool, allowed] of Object.entries(pools)) {
      const amount = shareOf(statement, pool);
      if (amount === null || (used[pool] ?? 0) + amount > allowed) return refuse(statement, "term_exceeded");
      take[pool] = amount;
    }
    for (const [pool, amount] of Object.entries(take)) used[pool] = (used[pool] ?? 0) + amount;
    seated += 1;
    return { installation: statement.installation, honoured: true, refusal: null };
  });
}

/** What a statement draws on one pool; null when unlimited. */
function shareOf(statement: HeldStatement, pool: string): number | null {
  const fromShare = statement.share?.[pool];
  if (isCount(fromShare)) return fromShare;
  const value = statement.values[pool];
  if (value === undefined) return 0;
  return isCount(value) ? value : null;
}

function refuse(statement: HeldStatement, refusal: TermRefusal): TermVerdict {
  return { installation: statement.installation, honoured: false, refusal };
}

/**
 * Fetches the package over `fetch`: no redirects, every body capped, and the
 * gateway token only to the package's own origin.
 */
export class GatewayFetcher extends BaseFetcher {
  private readonly origin: string;

  constructor(
    base: string,
    private readonly token: string
  ) {
    super();
    this.origin = new URL(base).origin;
  }

  async fetch(url: string): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
    const headers: Record<string, string> = { accept: "application/json, */*" };
    if (this.token && new URL(url).origin === this.origin) headers.authorization = `Bearer ${this.token}`;
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok || !response.body) {
      // The client reads a 403 or 404 on a newer root as "no newer root".
      throw new DownloadHTTPError(`${url} answered ${response.status}`, response.status);
    }
    return response.body as ReadableStream<Uint8Array<ArrayBuffer>>;
  }
}

function delegates(role: { paths?: string[] }, path: string): boolean {
  return (role.paths ?? []).some((pattern) => matches(pattern, path));
}

/** TUF's path pattern: `*` matches within one path segment. */
function matches(pattern: string, path: string): boolean {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, i) =>
    new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`).test(
      pathParts[i]
    )
  );
}

/** A metadata file's `signed`, read after the client verified it. */
function signedOf(text: string): any {
  return JSON.parse(text).signed;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositive(value: unknown): value is number {
  return isCount(value) && value > 0;
}

function isDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** The SHA-256 of `data`, hex. */
export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
