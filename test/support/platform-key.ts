/**
 * A stand-in for the deployment's platform key: the RS256 key Initiative signs
 * its context, handoff and lifecycle tokens with, which a plug-in verifies.
 * It is Initiative's key, not a plug-in key, so it is made here rather than
 * with the SDK's plug-in keygen (Ed25519 only).
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

export interface PlatformKey {
  key: KeyObject;
  kid: string;
}

/** A fresh RSA key and the JWKS Initiative would publish for it. */
export function generatePlatformKey(kid: string): { privateKeyPem: string; jwks: { keys: unknown[] } } {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as Record<string, string>;
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    jwks: { keys: [{ kty: "RSA", kid, alg: "RS256", use: "sig", n: jwk.n, e: jwk.e }] },
  };
}

export function loadPlatformKey(pem: string, kid: string): PlatformKey {
  return { key: createPrivateKey(pem), kid };
}

/** An RS256 compact JWT, as Initiative signs one. */
export function signPlatformJwt(signing: PlatformKey, claims: Record<string, unknown>, typ = "JWT"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", kid: signing.kid, typ })}.${encode(claims)}`;
  return `${input}.${sign("sha256", Buffer.from(input), signing.key).toString("base64url")}`;
}
