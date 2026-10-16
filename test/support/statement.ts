/**
 * Billing's entitlement statements, as billing signs them, with test keys
 * standing in for billing's statement keypair.
 */

import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

const pair = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");

/** Billing's statement key, as the deployment hands it to the plug-in. */
export const BILLING_PUBLIC_PEM = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
/** Another Ed25519 key: not billing's. */
export const OTHER_PRIVATE_KEY: KeyObject = other.privateKey;
/** An RSA public key, which is never a statement key. */
export const RSA_PUBLIC_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .publicKey.export({ type: "spki", format: "pem" })
  .toString();

/** The listing uid of the tracker test plug-in. */
export const TRACKER_UID = "K7M2QX8N4TVB9C";

const part = (value: unknown) => Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");

/** A compact JWS of billing's shape: the claims and header given override the defaults. */
export function statement(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key: KeyObject | null = pair.privateKey
): string {
  const input = `${part({ alg: "EdDSA", typ: "initiative-entitlement+jwt", kid: "billing-1", ...header })}.${part({
    iss: "initiative-billing",
    listing_uid: TRACKER_UID,
    community_ref: "bref_1",
    version: 4,
    values: { monthly_allowance: 30000, packs_purchased: 0 },
    iat: 1_780_000_000,
    ...claims,
  })}`;
  return `${input}.${key ? sign(null, Buffer.from(input), key).toString("base64url") : ""}`;
}
