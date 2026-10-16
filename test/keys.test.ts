/**
 * Plug-in keys: Ed25519 only. What is generated, that a signature made with the
 * private half verifies with the JWKS the operator registers, and that any
 * other kind of key is refused.
 */

import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";

import { generatePluginKeys, jwkThumbprint, loadPrivateKey, publicJwks, signJwt } from "../src/keys.js";

function decode(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf-8"));
}

/** Verify a compact JWT against a JWKS entry, as a deployment would. */
function verifiesWith(token: string, jwk: Record<string, unknown>): boolean {
  const [header, payload, signature] = token.split(".");
  const key = createPublicKey({ key: jwk as never, format: "jwk" });
  return verify(null, Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, "base64url"));
}

describe("a plug-in key", () => {
  const keys = generatePluginKeys();

  it("is Ed25519: a PKCS#8 private key and a one-entry OKP JWKS", () => {
    expect(keys.privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(keys.jwks.keys).toHaveLength(1);
    const [entry] = keys.jwks.keys;
    expect(entry).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", kid: keys.kid });
    expect(jwkThumbprint(entry)).toBe(keys.kid);
  });

  it("publishes no private material", () => {
    expect(keys.jwks.keys[0]).not.toHaveProperty("d");
  });

  it("round-trips: signed EdDSA with the private key, verified with the JWKS", () => {
    const signing = loadPrivateKey(keys.privateKeyPem, keys.kid);
    const token = signJwt(signing, { iss: "acme.tracker", n: 1 });
    const [header, payload] = token.split(".");
    expect(decode(header)).toEqual({ alg: "EdDSA", kid: keys.kid, typ: "JWT" });
    expect(decode(payload)).toEqual({ iss: "acme.tracker", n: 1 });
    expect(verifiesWith(token, keys.jwks.keys[0] as never)).toBe(true);
  });

  it("does not verify with another key", () => {
    const other = generatePluginKeys();
    const token = signJwt(loadPrivateKey(keys.privateKeyPem, keys.kid), { n: 1 });
    expect(verifiesWith(token, other.jwks.keys[0] as never)).toBe(false);
  });

  it("derives the same JWKS from the loaded key", () => {
    expect(publicJwks(loadPrivateKey(keys.privateKeyPem, keys.kid))).toEqual(keys.jwks);
  });

  it.each([
    ["RSA", () => generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey],
    ["P-256", () => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey],
  ])("refuses a %s key", (_, make) => {
    const pem = make().export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => loadPrivateKey(pem)).toThrow(/Ed25519/);
  });
});

describe("kid", () => {
  it("defaults to a thumbprint, distinct per key", () => {
    const a = generatePluginKeys();
    const b = generatePluginKeys();
    expect(a.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.kid).not.toBe(b.kid);
  });

  it("takes one you choose", () => {
    const keys = generatePluginKeys({ kid: "2026-09" });
    expect(keys.kid).toBe("2026-09");
    expect(keys.jwks.keys[0].kid).toBe("2026-09");
  });

  it("is the key's thumbprint when a loaded key names none", () => {
    const keys = generatePluginKeys();
    expect(loadPrivateKey(keys.privateKeyPem).kid).toBe(keys.kid);
  });
});

describe("fingerprint", () => {
  it("is the RFC 7638 SHA-256 thumbprint of crv, kty and x (RFC 8037 §A.3)", () => {
    const rfc8037 = { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" } as const;
    expect(jwkThumbprint(rfc8037)).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
    const members = JSON.stringify({ crv: "Ed25519", kty: "OKP", x: rfc8037.x });
    expect(jwkThumbprint(rfc8037)).toBe(createHash("sha256").update(members).digest("base64url"));
  });
});
