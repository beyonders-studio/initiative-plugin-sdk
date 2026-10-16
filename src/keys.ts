/**
 * Your plug-in's signing key.
 *
 * A plug-in proves who it is to Initiative by signing a short JWT with its own
 * private key (`private_key_jwt`, RFC 7523). The deployment's operator
 * registers the matching public key — a JWKS — against your plug-in's public
 * id, and the private key never leaves your plug-in.
 *
 * Every plug-in key is Ed25519, signing EdDSA (RFC 8037). Its signatures are
 * deterministic, so there is no per-signature nonce whose reuse or bias would
 * give the key away, and the key is small and fast. There is no other kind.
 *
 * Every key carries a `kid`, by default its RFC 7638 thumbprint. Each JWT names
 * the `kid` it was signed with, so rotating is: generate a new key, have the
 * operator register a JWKS holding both public keys, switch your plug-in to the
 * new one, then drop the old entry.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";

/** One public key, as a JWK. */
export interface PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg: "EdDSA";
  use: "sig";
}

/** A JSON Web Key Set: what the operator registers for your plug-in. */
export interface Jwks {
  keys: PublicJwk[];
}

/** A private key ready to sign with. */
export interface PluginSigningKey {
  key: KeyObject;
  kid: string;
}

/** What {@link generatePluginKeys} returns. */
export interface GeneratedPluginKeys {
  /** PKCS#8 PEM. Keep it secret, and out of source control. */
  privateKeyPem: string;
  /** The public half, to register with the deployment. */
  jwks: Jwks;
  kid: string;
}

/**
 * Generate a new Ed25519 signing key.
 *
 * `kid` defaults to the key's RFC 7638 thumbprint, so the same key always gets
 * the same id and two keys never share one.
 */
export function generatePluginKeys(options: { kid?: string } = {}): GeneratedPluginKeys {
  const { privateKey } = generateKeyPairSync("ed25519");
  const kid = options.kid ?? thumbprint(privateKey);
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    jwks: publicJwks({ key: privateKey, kid }),
    kid,
  };
}

/**
 * Load a PEM private key for signing, under the `kid` it was registered with,
 * or its RFC 7638 thumbprint when none is given. Anything but an Ed25519 key
 * is refused.
 */
export function loadPrivateKey(pem: string, kid?: string): PluginSigningKey {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new TypeError(
      `a plug-in key is Ed25519, not ${key.asymmetricKeyType ?? "unknown"}: make one with \`initiative-plugin keygen\``
    );
  }
  return { key, kid: kid || thumbprint(key) };
}

/** The JWKS for one signing key: its public half, with its `kid`. */
export function publicJwks(signing: PluginSigningKey): Jwks {
  const jwk = createPublicKey(signing.key).export({ format: "jwk" }) as Record<string, string>;
  return { keys: [{ kty: "OKP", crv: "Ed25519", x: jwk.x, kid: signing.kid, alg: "EdDSA", use: "sig" }] };
}

/**
 * Sign a compact JWT with a plug-in key. `typ` goes in the header; a plug-in's own
 * assertions are plain `JWT`. EdDSA signs the input itself, with no digest.
 */
export function signJwt(
  signing: PluginSigningKey,
  claims: Record<string, unknown>,
  typ = "JWT"
): string {
  const header = { alg: "EdDSA", kid: signing.kid, typ };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  return `${input}.${cryptoSign(null, Buffer.from(input), signing.key).toString("base64url")}`;
}

function base64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

/**
 * A public key's fingerprint: its RFC 7638 SHA-256 thumbprint (members `crv`,
 * `kty`, `x`), base64url without padding. The plug-in logs it at start, and
 * Initiative shows the same value for the key it reads from the plug-in.
 */
export function jwkThumbprint(jwk: Pick<PublicJwk, "crv" | "kty" | "x">): string {
  const members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  return createHash("sha256").update(JSON.stringify(members)).digest("base64url");
}

function thumbprint(privateKey: KeyObject): string {
  return jwkThumbprint(createPublicKey(privateKey).export({ format: "jwk" }) as PublicJwk);
}
