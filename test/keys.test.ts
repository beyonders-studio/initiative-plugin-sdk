/**
 * Plug-in keys: what is generated, and that a signature made with the private half
 * verifies with the JWKS the operator registers.
 */

import { createHash, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  algorithmOf,
  generatePluginKeys,
  jwkThumbprint,
  loadPrivateKey,
  publicJwks,
  signJwt,
  type PluginKeyAlgorithm,
} from "../src/keys.js";

function decode(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf-8"));
}

/** Verify a compact JWT against a JWKS entry, as a deployment would. */
function verifiesWith(token: string, jwk: Record<string, unknown>): boolean {
  const [header, payload, signature] = token.split(".");
  const key = createPublicKey({ key: jwk as never, format: "jwk" });
  const input = Buffer.from(`${header}.${payload}`);
  const raw = Buffer.from(signature, "base64url");
  if (jwk.kty === "OKP") return verify(null, input, key, raw);
  return jwk.kty === "EC"
    ? verify("sha256", input, { key, dsaEncoding: "ieee-p1363" }, raw)
    : verify("sha256", input, key, raw);
}

describe.each<PluginKeyAlgorithm>(["RS256", "ES256", "EdDSA"])("%s keys", (alg) => {
  const keys = generatePluginKeys({ alg });

  it("writes a PKCS#8 private key and a one-entry JWKS", () => {
    expect(keys.privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(keys.alg).toBe(alg);
    expect(keys.jwks.keys).toHaveLength(1);
    const [entry] = keys.jwks.keys;
    expect(entry).toMatchObject({ kid: keys.kid, alg, use: "sig" });
    expect(entry.kty).toBe({ RS256: "RSA", ES256: "EC", EdDSA: "OKP" }[alg]);
    expect(jwkThumbprint(entry)).toBe(keys.kid);
  });

  it("publishes no private material", () => {
    const [entry] = keys.jwks.keys as unknown as Array<Record<string, unknown>>;
    for (const member of ["d", "p", "q", "dp", "dq", "qi"]) {
      expect(entry).not.toHaveProperty(member);
    }
  });

  it("round-trips: signed with the private key, verified with the JWKS", () => {
    const signing = loadPrivateKey(keys.privateKeyPem, keys.kid);
    expect(signing.alg).toBe(alg);
    const token = signJwt(signing, { iss: "acme.tracker", n: 1 });
    const [header, payload] = token.split(".");
    expect(decode(header)).toEqual({ alg, kid: keys.kid, typ: "JWT" });
    expect(decode(payload)).toEqual({ iss: "acme.tracker", n: 1 });
    expect(verifiesWith(token, keys.jwks.keys[0] as never)).toBe(true);
  });

  it("does not verify with another key", () => {
    const other = generatePluginKeys({ alg });
    const token = signJwt(loadPrivateKey(keys.privateKeyPem, keys.kid), { n: 1 });
    expect(verifiesWith(token, other.jwks.keys[0] as never)).toBe(false);
  });

  it("derives the same JWKS from the loaded key", () => {
    expect(publicJwks(loadPrivateKey(keys.privateKeyPem, keys.kid))).toEqual(keys.jwks);
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
    const keys = generatePluginKeys({ alg: "ES256", kid: "2026-09" });
    expect(keys.kid).toBe("2026-09");
    expect(keys.jwks.keys[0].kid).toBe("2026-09");
  });

  it("is the key's thumbprint when a loaded key names none", () => {
    const keys = generatePluginKeys();
    expect(loadPrivateKey(keys.privateKeyPem).kid).toBe(keys.kid);
  });
});

describe("fingerprint", () => {
  it("is the RFC 7638 SHA-256 thumbprint, base64url", () => {
    const rfc7638 = {
      kty: "RSA",
      kid: "2011-04-29",
      alg: "RS256",
      use: "sig",
      e: "AQAB",
      n:
        "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W" +
        "-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt" +
        "-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
    } as const;
    expect(jwkThumbprint(rfc7638)).toBe("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
  });
});

describe("an Ed25519 thumbprint", () => {
  it("takes crv, kty and x, in that order (RFC 7638 §3.2)", () => {
    const keys = generatePluginKeys({ alg: "EdDSA" });
    const [entry] = keys.jwks.keys;
    const members = JSON.stringify({ crv: "Ed25519", kty: "OKP", x: entry.x });
    expect(keys.kid).toBe(createHash("sha256").update(members).digest("base64url"));
  });
});

describe("algorithm", () => {
  it("defaults to RS256", () => {
    expect(generatePluginKeys().alg).toBe("RS256");
  });

  it("follows the key's type", () => {
    const rsa = loadPrivateKey(generatePluginKeys({ alg: "RS256" }).privateKeyPem, "a");
    const ec = loadPrivateKey(generatePluginKeys({ alg: "ES256" }).privateKeyPem, "b");
    const ed = loadPrivateKey(generatePluginKeys({ alg: "EdDSA" }).privateKeyPem, "c");
    expect(algorithmOf(rsa.key)).toBe("RS256");
    expect(algorithmOf(ec.key)).toBe("ES256");
    expect(algorithmOf(ed.key)).toBe("EdDSA");
  });

  it("refuses an unsupported algorithm", () => {
    expect(() => generatePluginKeys({ alg: "HS256" as never })).toThrow(/unsupported/);
  });
});
