/**
 * Verifying the tokens Initiative signs: the per-call context token and the
 * page handoff token. Each is signed here with a test key standing in for the
 * deployment's, and published through an injected JWKS fetch.
 */

import { describe, expect, it } from "vitest";

import {
  CONTEXT_TOKEN_TYPE,
  ContextTokenError,
  HANDOFF_TOKEN_TYPE,
  JWKS_PATH,
  JwksCache,
  audienceFor,
  verifyContextToken,
  verifyHandoffToken,
  verifyLifecycleToken,
} from "../src/tokens.js";
import { generatePluginKeys, loadPrivateKey, signJwt } from "../src/keys.js";
import { generatePlatformKey, loadPlatformKey, signPlatformJwt } from "./support/platform-key.js";

const BASE = "https://initiative.example.com";
const PUBLIC_ID = "acme.tracker";
const NOW = 1_780_000_000;

const platform = generatePlatformKey("platform-1");
const signing = loadPlatformKey(platform.privateKeyPem, "platform-1");

function jwksFetch(documents: Array<{ keys: unknown[] }> = [platform.jwks]) {
  const urls: string[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const body = documents[Math.min(index++, documents.length - 1)];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { urls, fetchImpl };
}

function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jti: "j-1",
    iss: "initiative",
    aud: audienceFor(PUBLIC_ID),
    iat: NOW,
    exp: NOW + 60,
    community_ref: "gapp_abc",
    community_status: "active",
    plugin_install_id: 7,
    ...extra,
  };
}

const contextClaims = (extra: Record<string, unknown> = {}) =>
  claims({ scope: "endpoint", endpoint_id: "plugin.acme.tracker.read", ...extra });

const lifecycleClaims = (extra: Record<string, unknown> = {}) =>
  claims({ scope: "lifecycle", hook: "after_connect", ...extra });

const handoffClaims = (extra: Record<string, unknown> = {}) =>
  claims({ sub: "uapp_alice", surface_id: "panel", initiative_id: 3, ...extra });

function options(fetchImpl: typeof fetch) {
  return {
    publicId: PUBLIC_ID,
    baseUrl: BASE,
    jwks: new JwksCache({ fetchImpl, now: () => NOW * 1000 }),
    now: () => NOW * 1000,
  };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const failure = await promise.then(
    () => null,
    (caught) => caught
  );
  expect(failure).toBeInstanceOf(ContextTokenError);
  return (failure as Error).message;
}

describe("verifyContextToken", () => {
  it("returns the claims of a token Initiative signed for this plug-in", async () => {
    const { urls, fetchImpl } = jwksFetch();
    const token = signPlatformJwt(signing, contextClaims({ connection_refs: { account: "ref-1" } }), CONTEXT_TOKEN_TYPE);
    const verified = await verifyContextToken(token, options(fetchImpl));
    expect(verified).toMatchObject({
      community_ref: "gapp_abc",
      community_status: "active",
      plugin_install_id: 7,
      scope: "endpoint",
      endpoint_id: "plugin.acme.tracker.read",
      connection_refs: { account: "ref-1" },
    });
    expect(urls).toEqual([`${BASE}${JWKS_PATH}`]);
  });

  it("names the calling plug-in, the actor and the member on a call from another plug-in", async () => {
    const { fetchImpl } = jwksFetch();
    const token = signPlatformJwt(
      signing,
      contextClaims({
        act: { sub: "acme.automations" },
        actor: "member",
        member: "uapp_target_ref",
        initiative_id: 4,
        connection_refs: { account: "ref-m" },
      }),
      CONTEXT_TOKEN_TYPE
    );
    const verified = await verifyContextToken(token, options(fetchImpl));
    expect(verified.act).toEqual({ sub: "acme.automations" });
    expect(verified.actor).toBe("member");
    expect(verified.member).toBe("uapp_target_ref");
    expect(verified.initiative_id).toBe(4);
  });

  it("leaves the caller claims absent on Initiative's own call", async () => {
    const { fetchImpl } = jwksFetch();
    const verified = await verifyContextToken(signPlatformJwt(signing, contextClaims(), CONTEXT_TOKEN_TYPE), options(fetchImpl));
    expect(verified.act).toBeUndefined();
    expect(verified.actor).toBeUndefined();
    expect(verified.member).toBeUndefined();
  });

  it("refuses caller claims of the wrong shape", async () => {
    const { fetchImpl } = jwksFetch();
    for (const [extra, message] of [
      [{ act: "acme.automations" }, "act names no calling plug-in"],
      [{ act: { sub: "" } }, "act names no calling plug-in"],
      [{ actor: "robot" }, "unknown actor robot"],
      [{ actor: "member" }, "a member call names no member"],
      [{ initiative_id: 0 }, "initiative_id is not an initiative"],
    ] as const) {
      const token = signPlatformJwt(signing, contextClaims(extra), CONTEXT_TOKEN_TYPE);
      expect(await refusal(verifyContextToken(token, options(fetchImpl)))).toBe(message);
    }
  });

  it("finds the JWKS from the API base too", async () => {
    const { urls, fetchImpl } = jwksFetch();
    await verifyContextToken(signPlatformJwt(signing, contextClaims(), CONTEXT_TOKEN_TYPE), {
      ...options(fetchImpl),
      baseUrl: `${BASE}/api/v1`,
    });
    expect(urls).toEqual([`${BASE}${JWKS_PATH}`]);
  });

  it("refuses a token for another plug-in", async () => {
    const { fetchImpl } = jwksFetch();
    const token = signPlatformJwt(signing, contextClaims({ aud: audienceFor("other.plugin") }), CONTEXT_TOKEN_TYPE);
    expect(await refusal(verifyContextToken(token, options(fetchImpl)))).toContain(
      "initiative-plugin:other.plugin"
    );
  });

  it("refuses another issuer", async () => {
    const { fetchImpl } = jwksFetch();
    const token = signPlatformJwt(signing, contextClaims({ iss: "someone-else" }), CONTEXT_TOKEN_TYPE);
    expect(await refusal(verifyContextToken(token, options(fetchImpl)))).toContain(
      "someone-else"
    );
  });

  it("refuses an expired token, and one not valid yet, beyond the leeway", async () => {
    const { fetchImpl } = jwksFetch();
    const expired = signPlatformJwt(signing, contextClaims({ iat: NOW - 120, exp: NOW - 31 }), CONTEXT_TOKEN_TYPE);
    expect(await refusal(verifyContextToken(expired, options(fetchImpl)))).toContain("expired");
    const early = signPlatformJwt(signing, contextClaims({ iat: NOW + 31, exp: NOW + 90 }), CONTEXT_TOKEN_TYPE);
    expect(await refusal(verifyContextToken(early, options(fetchImpl)))).toContain("not valid yet");
    const withinLeeway = signPlatformJwt(signing, contextClaims({ iat: NOW - 90, exp: NOW - 29 }), CONTEXT_TOKEN_TYPE);
    await expect(verifyContextToken(withinLeeway, options(fetchImpl))).resolves.toBeTruthy();
  });

  it("refuses a signature by a key the deployment did not publish", async () => {
    const { fetchImpl } = jwksFetch();
    const stranger = generatePlatformKey("platform-1");
    const token = signPlatformJwt(loadPlatformKey(stranger.privateKeyPem, "platform-1"), contextClaims(), CONTEXT_TOKEN_TYPE);
    expect(await refusal(verifyContextToken(token, options(fetchImpl)))).toContain(
      "did not verify"
    );
  });

  it("refuses any algorithm but RS256", async () => {
    const { fetchImpl } = jwksFetch();
    const plugin = generatePluginKeys({ kid: "platform-1" });
    const token = signJwt(loadPrivateKey(plugin.privateKeyPem, "platform-1"), contextClaims(), CONTEXT_TOKEN_TYPE);
    expect(await refusal(verifyContextToken(token, options(fetchImpl)))).toContain("EdDSA");
  });

  it("refuses a handoff token presented as a context token", async () => {
    const { fetchImpl } = jwksFetch();
    const token = signPlatformJwt(signing, handoffClaims(), HANDOFF_TOKEN_TYPE);
    expect(await refusal(verifyContextToken(token, options(fetchImpl)))).toBe(
      `token is typed ${HANDOFF_TOKEN_TYPE}, not ${CONTEXT_TOKEN_TYPE}`
    );
  });

  it("refuses a token that is not typed as one of Initiative's", async () => {
    const { fetchImpl } = jwksFetch();
    const token = signPlatformJwt(signing, contextClaims());
    expect(await refusal(verifyContextToken(token, options(fetchImpl)))).toBe(
      `token is typed JWT, not ${CONTEXT_TOKEN_TYPE}`
    );
  });

  it("refuses a context token that names no scope", async () => {
    const { fetchImpl } = jwksFetch();
    const token = signPlatformJwt(signing, handoffClaims(), CONTEXT_TOKEN_TYPE);
    expect(await refusal(verifyContextToken(token, options(fetchImpl)))).toContain(
      "not a context token"
    );
  });

  it("refuses a token naming no community status, or one it does not know", async () => {
    const { fetchImpl } = jwksFetch();
    for (const community_status of [undefined, "archived"]) {
      const token = signPlatformJwt(signing, contextClaims({ community_status }), CONTEXT_TOKEN_TYPE);
      expect(await refusal(verifyContextToken(token, options(fetchImpl)))).toContain("unknown community status");
    }
  });

  it("refuses something that is not a JWT", async () => {
    const { fetchImpl } = jwksFetch();
    expect(await refusal(verifyContextToken("abc", options(fetchImpl)))).toBe("not a JWT");
    expect(await refusal(verifyContextToken("a.b.c", options(fetchImpl)))).toBe("not a JWT");
  });

  it("refetches once for an unknown kid, so a rotation resolves", async () => {
    const next = generatePlatformKey("platform-2");
    const both = { keys: [...platform.jwks.keys, ...next.jwks.keys] };
    const { urls, fetchImpl } = jwksFetch([platform.jwks, both]);
    const opts = options(fetchImpl);

    await verifyContextToken(signPlatformJwt(signing, contextClaims(), CONTEXT_TOKEN_TYPE), opts);
    const rotated = signPlatformJwt(loadPlatformKey(next.privateKeyPem, "platform-2"), contextClaims(), CONTEXT_TOKEN_TYPE);
    await verifyContextToken(rotated, opts);
    expect(urls).toHaveLength(2);

    // A kid nobody published, against a set that was itself refetched in this
    // window: refused without another fetch.
    const unknown = signPlatformJwt(loadPlatformKey(next.privateKeyPem, "platform-9"), contextClaims(), CONTEXT_TOKEN_TYPE);
    expect(await refusal(verifyContextToken(unknown, opts))).toContain("platform-9");
    expect(await refusal(verifyContextToken(unknown, opts))).toContain("platform-9");
    expect(urls).toHaveLength(2);
  });
});

describe("verifyHandoffToken", () => {
  it("refuses a context token presented as a handoff", async () => {
    const { fetchImpl } = jwksFetch();
    const token = signPlatformJwt(signing, handoffClaims(), CONTEXT_TOKEN_TYPE);
    expect(await refusal(verifyHandoffToken(token, options(fetchImpl)))).toBe(
      `token is typed ${CONTEXT_TOKEN_TYPE}, not ${HANDOFF_TOKEN_TYPE}`
    );
  });

  it("returns the member, the page and the initiative", async () => {
    const { fetchImpl } = jwksFetch();
    const verified = await verifyHandoffToken(signPlatformJwt(signing, handoffClaims(), HANDOFF_TOKEN_TYPE), options(fetchImpl));
    expect(verified).toMatchObject({
      sub: "uapp_alice",
      surface_id: "panel",
      initiative_id: 3,
      community_ref: "gapp_abc",
      community_status: "active",
      plugin_install_id: 7,
      jti: "j-1",
    });
  });

  it("takes a community-level opening with no initiative", async () => {
    const { fetchImpl } = jwksFetch();
    const token = signPlatformJwt(signing, handoffClaims({ initiative_id: undefined }), HANDOFF_TOKEN_TYPE);
    const verified = await verifyHandoffToken(token, options(fetchImpl));
    expect(verified.initiative_id).toBeUndefined();
  });

  it("refuses a token naming no member or no page", async () => {
    const { fetchImpl } = jwksFetch();
    expect(
      await refusal(
        verifyHandoffToken(signPlatformJwt(signing, handoffClaims({ sub: undefined }), HANDOFF_TOKEN_TYPE), options(fetchImpl))
      )
    ).toContain("no member");
    expect(
      await refusal(
        verifyHandoffToken(
          signPlatformJwt(signing, handoffClaims({ surface_id: undefined }), HANDOFF_TOKEN_TYPE),
          options(fetchImpl)
        )
      )
    ).toContain("no page");
  });

  it("checks the audience like a context token", async () => {
    const { fetchImpl } = jwksFetch();
    const token = signPlatformJwt(signing, handoffClaims({ aud: audienceFor("other.plugin") }), HANDOFF_TOKEN_TYPE);
    await expect(verifyHandoffToken(token, options(fetchImpl))).rejects.toThrow(
      ContextTokenError
    );
  });
});

describe("verifyLifecycleToken", () => {
  it("returns the claims of a hook call, naming the hook", async () => {
    const { fetchImpl } = jwksFetch();
    const verified = await verifyLifecycleToken(signPlatformJwt(signing, lifecycleClaims(), CONTEXT_TOKEN_TYPE), {
      ...options(fetchImpl),
      hook: "after_connect",
    });
    expect(verified).toMatchObject({
      scope: "lifecycle",
      hook: "after_connect",
      community_ref: "gapp_abc",
      community_status: "active",
      plugin_install_id: 7,
    });
  });

  it("refuses an endpoint token", async () => {
    const { fetchImpl } = jwksFetch();
    expect(
      await refusal(verifyLifecycleToken(signPlatformJwt(signing, contextClaims(), CONTEXT_TOKEN_TYPE), options(fetchImpl)))
    ).toMatch(/not a lifecycle token/);
  });

  it("refuses a token minted for another hook", async () => {
    const { fetchImpl } = jwksFetch();
    const token = signPlatformJwt(signing, lifecycleClaims({ hook: "revoke" }), CONTEXT_TOKEN_TYPE);
    expect(
      await refusal(verifyLifecycleToken(token, { ...options(fetchImpl), hook: "after_connect" }))
    ).toMatch(/for hook revoke, not after_connect/);
  });

  it("checks the audience and the clock like a context token", async () => {
    const { fetchImpl } = jwksFetch();
    const elsewhere = signPlatformJwt(signing, lifecycleClaims({ aud: audienceFor("acme.other") }), CONTEXT_TOKEN_TYPE);
    expect(await refusal(verifyLifecycleToken(elsewhere, options(fetchImpl)))).toMatch(
      /is for initiative-plugin:acme.other/
    );
    const stale = signPlatformJwt(signing, lifecycleClaims({ iat: NOW - 900, exp: NOW - 600 }), CONTEXT_TOKEN_TYPE);
    expect(await refusal(verifyLifecycleToken(stale, options(fetchImpl)))).toMatch(/expired/);
  });
});
