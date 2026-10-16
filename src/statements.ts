/**
 * Entitlement statements: what billing says a community holds of the plug-in,
 * signed by billing and checked here.
 *
 * Billing signs each statement with its own Ed25519 key, a compact JWS with
 * header `{alg: "EdDSA", typ: "initiative-entitlement+jwt", kid}` and claims
 * `{iss: "initiative-billing", listing_uid, community_ref, version, values,
 * iat}`. Initiative stores it and hands it on verbatim, on the `entitlement`
 * hook and on `client.entitlement()`; it never signs one. The public half of
 * billing's key reaches the plug-in from the deployment, as the runtime fact
 * `entitlement_issuer_key` in {@link ENTITLEMENT_ISSUER_KEY_ENV}, so Initiative
 * can withhold a statement but never mint one.
 *
 * A statement is checked in this order, and refused at the first failure:
 *
 * 1. the issuer key is configured and is Ed25519 (otherwise every statement is
 *    refused, and why is logged once);
 * 2. the header's `alg` is `EdDSA` and its `typ` is
 *    `initiative-entitlement+jwt`, exactly: the header never picks the algorithm;
 * 3. the Ed25519 signature over the JWS signing input;
 * 4. `iss` is `initiative-billing`, `listing_uid` is the plug-in's own uid,
 *    `version` is a whole number of one or more and `values` an object.
 *
 * Only then are `version` and `values` handed on, taken from the verified
 * claims and nothing else.
 *
 * One gap stays, by design: `community_ref` is billing's pairwise reference,
 * which the plug-in cannot relate to the community it is told the statement is
 * for. Initiative vouches for that mapping, so a compromised Initiative could
 * at worst copy a real, signed statement onto another community.
 */

import { createPublicKey, verify, type KeyObject } from "node:crypto";

/** The environment variable the deployment fills with billing's statement key (SPKI PEM). */
export const ENTITLEMENT_ISSUER_KEY_ENV = "INITIATIVE_ENTITLEMENT_ISSUER_KEY_PEM";
/** The runtime fact that names billing's statement key. */
export const ENTITLEMENT_ISSUER_KEY_FACT = "entitlement_issuer_key";
/** Who signs every statement. */
export const ENTITLEMENT_ISSUER = "initiative-billing";
/** A statement's JOSE `typ`. */
export const ENTITLEMENT_STATEMENT_TYPE = "initiative-entitlement+jwt";

/** Why a statement was refused. Each is counted as `refused-<reason>`. */
export type EntitlementRefusal =
  /** No issuer key is configured: the deployment runs no billing. */
  | "no-key"
  /** The configured issuer key is not an Ed25519 public key. */
  | "bad-key"
  /** Not a compact JWS with a JSON header. */
  | "malformed"
  | "alg"
  | "typ"
  | "signature"
  | "iss"
  /** For another plug-in's listing. */
  | "listing"
  /** `version` or `values` missing or of the wrong type. */
  | "claims";

const REASONS: Record<EntitlementRefusal, string> = {
  "no-key": `no entitlement issuer key is configured (${ENTITLEMENT_ISSUER_KEY_ENV})`,
  "bad-key": `the entitlement issuer key (${ENTITLEMENT_ISSUER_KEY_ENV}) is not an Ed25519 public key`,
  malformed: "the statement is not a compact JWS",
  alg: "the statement is not signed EdDSA",
  typ: `the statement's typ is not ${ENTITLEMENT_STATEMENT_TYPE}`,
  signature: "the statement's signature does not verify under the issuer key",
  iss: `the statement is not issued by ${ENTITLEMENT_ISSUER}`,
  listing: "the statement is for another plug-in",
  claims: "the statement's version or values are not well formed",
};

/** A refused statement: `reason` is the counted outcome, `message` says it in words. */
export class EntitlementStatementError extends Error {
  constructor(readonly reason: EntitlementRefusal) {
    super(REASONS[reason]);
    this.name = "EntitlementStatementError";
  }
}

/** A statement that verified: what the plug-in is handed. */
export interface VerifiedEntitlement {
  version: number;
  values: Record<string, unknown>;
}

export interface EntitlementStatementsOptions {
  /** The plug-in's own listing uid; a statement for any other is refused. */
  listingUid: string;
  /**
   * Billing's statement key, SPKI PEM (a PEM with literal `\n` or base64 of the
   * PEM also do). Default: {@link ENTITLEMENT_ISSUER_KEY_ENV}. Absent, every
   * statement is refused.
   */
  issuerKeyPem?: string | null;
  /** Where the one warning about a missing or unusable key goes. Default: `console.warn`. */
  warn?: (message: string) => void;
}

/**
 * Checks billing's entitlement statements for one plug-in. The server makes one
 * for its hook and its client; give one to an `Initiative` made by hand to read
 * `client.entitlement()`.
 */
export class EntitlementStatements {
  private readonly key: KeyObject | EntitlementRefusal;
  private readonly listingUid: string;
  private readonly warn: (message: string) => void;
  private warned = false;

  constructor(options: EntitlementStatementsOptions) {
    if (!options.listingUid) throw new TypeError("listingUid is the plug-in's own listing uid");
    this.listingUid = options.listingUid;
    this.warn = options.warn ?? ((message) => console.warn(message));
    const pem = options.issuerKeyPem === undefined ? process.env[ENTITLEMENT_ISSUER_KEY_ENV] : options.issuerKeyPem;
    this.key = issuerKey(pem);
  }

  /**
   * The statement's `version` and `values`, once it verifies, for the community
   * Initiative names (`installation`, used only to count new unlimited grants).
   * Throws {@link EntitlementStatementError} when it is refused.
   */
  verify(statement: unknown, installation: string): VerifiedEntitlement {
    let verified: VerifiedEntitlement;
    try {
      verified = this.check(statement);
    } catch (error) {
      if (error instanceof EntitlementStatementError) count(`refused-${error.reason}`);
      throw error;
    }
    count("applied");
    noteAllowance(this.listingUid, installation, verified.values);
    return verified;
  }

  private check(statement: unknown): VerifiedEntitlement {
    if (typeof this.key === "string") {
      if (!this.warned) {
        this.warned = true;
        this.warn(`entitlement statements are all refused: ${REASONS[this.key]}`);
      }
      throw new EntitlementStatementError(this.key);
    }
    const parts = typeof statement === "string" ? statement.split(".") : [];
    // The signature may be empty here, as an unsigned (`alg: none`) token's is: the alg check refuses it by name.
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]*$/.test(parts[2])) {
      throw new EntitlementStatementError("malformed");
    }
    const header = jsonOf(parts[0]);
    if (!isRecord(header)) throw new EntitlementStatementError("malformed");
    if (header.alg !== "EdDSA") throw new EntitlementStatementError("alg");
    if (header.typ !== ENTITLEMENT_STATEMENT_TYPE) throw new EntitlementStatementError("typ");
    const signature = Buffer.from(parts[2], "base64url");
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), this.key, signature)) {
      throw new EntitlementStatementError("signature");
    }
    const claims = jsonOf(parts[1]);
    if (!isRecord(claims)) throw new EntitlementStatementError("claims");
    if (claims.iss !== ENTITLEMENT_ISSUER) throw new EntitlementStatementError("iss");
    if (claims.listing_uid !== this.listingUid) throw new EntitlementStatementError("listing");
    const { version, values } = claims;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1 || !isRecord(values)) {
      throw new EntitlementStatementError("claims");
    }
    return { version, values };
  }
}

function issuerKey(pem: string | null | undefined): KeyObject | EntitlementRefusal {
  if (!pem) return "no-key";
  try {
    const text = pem.includes("-----BEGIN") ? pem.replaceAll("\\n", "\n") : Buffer.from(pem, "base64").toString("utf-8");
    const key = createPublicKey(text);
    return key.asymmetricKeyType === "ed25519" ? key : "bad-key";
  } catch {
    return "bad-key";
  }
}

function jsonOf(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Metrics, for alerts only: nothing here refuses a statement.

const outcomes = new Map<string, number>();
let unlimitedGrants = 0;
/** Whether each community's last verified statement granted an unlimited allowance, by listing and community. */
const unlimited = new Map<string, boolean>();

function count(outcome: string): void {
  outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
}

/**
 * Count a grant of an unlimited allowance (`monthly_allowance` null) for a
 * community whose last statement this process saw did not grant one. The
 * memory is the process's own, so the first statement after a start counts
 * when it grants one.
 */
function noteAllowance(listingUid: string, installation: string, values: Record<string, unknown>): void {
  const key = `${listingUid}\u0000${installation}`;
  const isUnlimited = "monthly_allowance" in values && values.monthly_allowance === null;
  if (isUnlimited && unlimited.get(key) !== true) unlimitedGrants += 1;
  unlimited.set(key, isUnlimited);
}

/** What the process has counted of entitlement statements since it started. */
export interface EntitlementMetrics {
  /** Statements by outcome: `applied`, or `refused-<reason>`. */
  statements: Record<string, number>;
  /** Grants of an unlimited allowance to a community that did not have one. */
  unlimitedGrants: number;
}

/** A snapshot of the entitlement statement counters, for the plug-in's metrics endpoint. */
export function entitlementMetrics(): EntitlementMetrics {
  return { statements: Object.fromEntries([...outcomes].sort(([a], [b]) => a.localeCompare(b))), unlimitedGrants };
}

/**
 * The same counters in the Prometheus text format, to append to what the
 * plug-in's metrics endpoint serves:
 *
 * - `initiative_plugin_entitlement_statements_total{outcome="…"}`
 * - `initiative_plugin_entitlement_unlimited_grants_total`
 *
 * Alert on any `refused-*` and on any rise in unlimited grants.
 */
export function entitlementMetricsText(): string {
  const { statements, unlimitedGrants: grants } = entitlementMetrics();
  const lines = [
    "# HELP initiative_plugin_entitlement_statements_total Entitlement statements, by outcome.",
    "# TYPE initiative_plugin_entitlement_statements_total counter",
    ...Object.entries(statements).map(
      ([outcome, value]) => `initiative_plugin_entitlement_statements_total{outcome="${outcome}"} ${value}`
    ),
    "# HELP initiative_plugin_entitlement_unlimited_grants_total Grants of an unlimited allowance to a community that did not have one.",
    "# TYPE initiative_plugin_entitlement_unlimited_grants_total counter",
    `initiative_plugin_entitlement_unlimited_grants_total ${grants}`,
  ];
  return `${lines.join("\n")}\n`;
}
