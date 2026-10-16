/**
 * Your plug-in's signing keys.
 *
 * A plug-in proves who it is to Initiative by signing a short JWT with its own
 * private key (`private_key_jwt`, RFC 7523). The deployment's operator
 * registers the matching public keys — a JWKS — against your plug-in's public id,
 * and the private key never leaves your plug-in.
 *
 * Three algorithms are supported, and the deployment picks the one to check by
 * the registered key's type: `EdDSA` for an Ed25519 key, `ES256` for a P-256
 * key, `RS256` for an RSA key. Ed25519 is the strongest of them: its
 * signatures are deterministic, so there is no per-signature nonce whose reuse
 * or bias would give the key away, as there is with ES256. It needs an
 * Initiative release that verifies EdDSA.
 *
 * Every key carries a `kid`. Each JWT names the `kid` it was signed with, so
 * rotating is: generate a new key, have the operator register a JWKS holding
 * both public keys, switch your plug-in to the new one, then drop the old entry.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";

/** The algorithms a plug-in key may use. */
export type PluginKeyAlgorithm = "RS256" | "ES256" | "EdDSA";

/** One public key, as a JWK. */
export interface PublicJwk {
  kty: "RSA" | "EC" | "OKP";
  kid: string;
  alg: PluginKeyAlgorithm;
  use: "sig";
  n?: string;
  e?: string;
  crv?: "P-256" | "Ed25519";
  x?: string;
  y?: string;
}

/** A JSON Web Key Set: what the operator registers for your plug-in. */
export interface Jwks {
  keys: PublicJwk[];
}

/** A private key ready to sign with. */
export interface PluginSigningKey {
  key: KeyObject;
  kid: string;
  alg: PluginKeyAlgorithm;
}

/** What {@link generatePluginKeys} returns. */
export interface GeneratedPluginKeys {
  /** PKCS#8 PEM. Keep it secret, and out of source control. */
  privateKeyPem: string;
  /** The public half, to register with the deployment. */
  jwks: Jwks;
  kid: string;
  alg: PluginKeyAlgorithm;
}

/**
 * Generate a new signing key.
 *
 * `kid` defaults to the key's RFC 7638 thumbprint, so the same key always gets
 * the same id and two keys never share one.
 */
export function generatePluginKeys(
  options: { alg?: PluginKeyAlgorithm; kid?: string } = {}
): GeneratedPluginKeys {
  const alg = options.alg ?? "RS256";
  const { privateKey } =
    alg === "RS256"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : alg === "ES256"
        ? generateKeyPairSync("ec", { namedCurve: "P-256" })
        : alg === "EdDSA"
          ? generateKeyPairSync("ed25519")
          : unsupported(alg);
  const kid = options.kid ?? thumbprint(privateKey);
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    jwks: publicJwks({ key: privateKey, kid, alg }),
    kid,
    alg,
  };
}

/**
 * Load a PEM private key for signing, under the `kid` it was registered with,
 * or its RFC 7638 thumbprint when none is given.
 *
 * The algorithm follows from the key: an Ed25519 key signs `EdDSA`, a P-256
 * key `ES256`, an RSA key `RS256`, and any other key is refused.
 */
export function loadPrivateKey(pem: string, kid?: string): PluginSigningKey {
  const key = createPrivateKey(pem);
  return { key, kid: kid || thumbprint(key), alg: algorithmOf(key) };
}

/** The JWKS for one signing key: its public half, with its `kid`. */
export function publicJwks(signing: PluginSigningKey): Jwks {
  const jwk = createPublicKey(signing.key).export({ format: "jwk" }) as Record<
    string,
    string
  >;
  const entry: PublicJwk =
    signing.alg === "RS256"
      ? { kty: "RSA", kid: signing.kid, alg: "RS256", use: "sig", n: jwk.n, e: jwk.e }
      : signing.alg === "EdDSA"
        ? { kty: "OKP", kid: signing.kid, alg: "EdDSA", use: "sig", crv: "Ed25519", x: jwk.x }
        : {
            kty: "EC",
            kid: signing.kid,
            alg: "ES256",
            use: "sig",
            crv: "P-256",
            x: jwk.x,
            y: jwk.y,
          };
  return { keys: [entry] };
}

/** The algorithm a key signs with, from its type. */
export function algorithmOf(key: KeyObject): PluginKeyAlgorithm {
  if (key.asymmetricKeyType === "ed25519") return "EdDSA";
  if (key.asymmetricKeyType === "rsa") return "RS256";
  if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") {
    return "ES256";
  }
  throw new TypeError(
    `unsupported key type ${key.asymmetricKeyType ?? "unknown"}: use an Ed25519, P-256 or RSA key`
  );
}

/**
 * Sign a compact JWT with a plug-in key. `typ` goes in the header; a plug-in's own
 * assertions are plain `JWT`.
 *
 * ES256 signatures are written in the JOSE form (`r || s`, 64 bytes), which is
 * what `ieee-p1363` produces. EdDSA signs the input itself, with no digest.
 */
export function signJwt(
  signing: PluginSigningKey,
  claims: Record<string, unknown>,
  typ = "JWT"
): string {
  const header = { alg: signing.alg, kid: signing.kid, typ };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature =
    signing.alg === "EdDSA"
      ? cryptoSign(null, Buffer.from(input), signing.key)
      : signing.alg === "ES256"
        ? cryptoSign("sha256", Buffer.from(input), { key: signing.key, dsaEncoding: "ieee-p1363" })
        : cryptoSign("sha256", Buffer.from(input), signing.key);
  return `${input}.${signature.toString("base64url")}`;
}

function base64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

/**
 * A public key's fingerprint: its RFC 7638 SHA-256 thumbprint, base64url
 * without padding. The plug-in logs it at start, and Initiative shows the same
 * value for the key it reads from the plug-in.
 */
export function jwkThumbprint(jwk: PublicJwk): string {
  const members =
    jwk.kty === "RSA"
      ? { e: jwk.e, kty: jwk.kty, n: jwk.n }
      : jwk.kty === "OKP"
        ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x }
        : { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  return createHash("sha256").update(JSON.stringify(members)).digest("base64url");
}

function thumbprint(privateKey: KeyObject): string {
  return jwkThumbprint(createPublicKey(privateKey).export({ format: "jwk" }) as PublicJwk);
}

function unsupported(alg: string): never {
  throw new TypeError(`unsupported algorithm ${alg}: use EdDSA, ES256 or RS256`);
}
