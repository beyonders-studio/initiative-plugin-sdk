import { describe, expect, it } from "vitest";
import {
  checkTerm,
  combineKeys,
  type DeploymentTerm,
  type HeldStatement,
  PackageTerm,
  parseKey,
  parseListingTerms,
  readTerm,
} from "../src/term.js";
import { buildTestPackage } from "../src/testing.js";

const AUTOMATIONS = "5M8B51VRKB3XSY";
const TIMESHEETS = "TIMESHEETS01";
const NOW = new Date("2026-11-01T00:00:00Z");

const LISTINGS = {
  [AUTOMATIONS]: { access: "open" as const, mandatory: true, meters: ["runs"] },
  [TIMESHEETS]: { access: "entitled" as const, mandatory: false, meters: [] as string[] },
};

function held(installation: string, over: Partial<HeldStatement> = {}): HeldStatement {
  return { installation, active: true, values: {}, ...over };
}

describe("reading the term from the package", () => {
  it("verifies the package and adds up the live keys and the listings' terms", async () => {
    const pkg = buildTestPackage({
      listings: LISTINGS,
      keys: [
        {
          key_id: "2026-acme",
          expires_at: "2027-11-01",
          apps: { [AUTOMATIONS]: { communities: 20, values: { monthly_allowance: 200000 } } },
        },
        {
          key_id: "2026-acme-more",
          expires_at: "2027-06-01",
          apps: { [AUTOMATIONS]: { communities: 5, values: { monthly_allowance: 50000 } }, [TIMESHEETS]: { communities: 3, plan: "team" } },
        },
        { key_id: "2024-old", issued_at: "2024-01-01", expires_at: "2025-01-01", apps: { [TIMESHEETS]: { communities: 99 } } },
      ],
    });
    const term = await readTerm({ packageUrl: pkg.packageUrl, root: pkg.root, fetcher: pkg.fetcher, now: NOW });
    expect(term).toEqual({
      keyIds: ["2026-acme", "2026-acme-more"],
      seats: { [AUTOMATIONS]: 25, [TIMESHEETS]: 3 },
      pools: { [AUTOMATIONS]: { monthly_allowance: 250000 } },
      expiresAt: "2027-06-01",
      listings: {
        [AUTOMATIONS]: { access: "open", mandatory: true, meters: ["runs"] },
        [TIMESHEETS]: { access: "entitled", mandatory: false, meters: [] },
      },
    });
  });

  it("builds the same bytes from the same seed", () => {
    const a = buildTestPackage({ listings: LISTINGS });
    const b = buildTestPackage({ listings: LISTINGS });
    expect([...a.files]).toEqual([...b.files]);
    expect(a.root).toEqual(b.root);
  });

  it("refuses a package another root signed", async () => {
    const pkg = buildTestPackage();
    const other = buildTestPackage({ seed: "someone else" });
    await expect(
      readTerm({ packageUrl: pkg.packageUrl, root: other.root, fetcher: pkg.fetcher, now: NOW })
    ).rejects.toMatchObject({ code: "PACKAGE_INVALID" });
  });

  it("reads no root, and no live key, as no term", async () => {
    const pkg = buildTestPackage();
    const placeholder = JSON.stringify({ placeholder: "no root shipped yet" });
    expect(await readTerm({ packageUrl: pkg.packageUrl, root: placeholder, fetcher: pkg.fetcher })).toBeNull();
    const expired = buildTestPackage({ keys: [{ key_id: "old", issued_at: "2024-01-01", expires_at: "2025-01-01" }] });
    expect(await readTerm({ packageUrl: expired.packageUrl, root: expired.root, fetcher: expired.fetcher, now: NOW })).toBeNull();
  });

  it("keeps the last verified term when a read fails", async () => {
    const pkg = buildTestPackage({ listings: LISTINGS });
    let down = false;
    const fetcher = {
      downloadBytes: (url: string, max: number) => (down ? Promise.reject(new Error("gateway down")) : pkg.fetcher.downloadBytes(url, max)),
      downloadFile: <T>(url: string, max: number, handler: (file: string) => Promise<T>) =>
        down ? Promise.reject(new Error("gateway down")) : pkg.fetcher.downloadFile(url, max, handler),
    };
    const source = new PackageTerm({ packageUrl: pkg.packageUrl, root: pkg.root, fetcher });
    expect((await source.refresh(NOW))?.keyIds).toEqual(["test-unlimited"]);
    down = true;
    expect((await source.refresh(NOW))?.keyIds).toEqual(["test-unlimited"]);
    expect(source.error?.code).toBe("PACKAGE_INVALID");
  });
});

describe("the shapes the package signs", () => {
  it("holds a key's app entry to one shape", () => {
    const key = (apps: unknown) => Buffer.from(JSON.stringify({ key_id: "k", issued_at: "2026-01-01", months: 12, expires_at: "2027-01-01", apps }));
    expect(parseKey("grants/k.json", key({ [AUTOMATIONS]: { communities: 2, values: { runs: 5 }, plan: "p" } }))).not.toBeNull();
    expect(parseKey("grants/k.json", key({ [AUTOMATIONS]: { mandatory: true } }))).toBeNull();
    expect(parseKey("grants/k.json", key({ [AUTOMATIONS]: { communities: 0 } }))).toBeNull();
    const old = Buffer.from(JSON.stringify({ key_id: "k", issued_at: "2026-01-01", months: 12, expires_at: "2027-01-01", limits: { communities: 20 } }));
    expect(parseKey("grants/k.json", old)).toBeNull();
  });

  it("holds a listing's terms to the two shapes the build allows", () => {
    const terms = (doc: object) => Buffer.from(JSON.stringify({ listing_uid: "L", ...doc }));
    expect(parseListingTerms("L", terms({ access: "open", mandatory: true, meters: ["runs"] }))).toEqual({ access: "open", mandatory: true, meters: ["runs"] });
    expect(parseListingTerms("L", terms({ access: "entitled", mandatory: false }))).toEqual({ access: "entitled", mandatory: false, meters: [] });
    expect(parseListingTerms("L", terms({ access: "entitled", mandatory: true }))).toBeNull();
    expect(parseListingTerms("L", terms({ access: "open", mandatory: false }))).toBeNull();
    expect(parseListingTerms("M", terms({ access: "open", mandatory: true }))).toBeNull();
  });
});

describe("checking statements against the term", () => {
  const term = (over: Partial<DeploymentTerm> = {}): DeploymentTerm => ({
    keyIds: ["k"],
    seats: {},
    pools: {},
    expiresAt: "2030-01-01",
    listings: LISTINGS,
    ...over,
  });

  it("honours the first holders and refuses past the seats", () => {
    const verdicts = checkTerm(term({ seats: { [TIMESHEETS]: 2 } }), TIMESHEETS, [held("a"), held("b"), held("c")]);
    expect(verdicts.map((v) => v.refusal)).toEqual([null, null, "term_exceeded"]);
  });

  it("gives a freed seat to the next in line", () => {
    const seats = term({ seats: { [TIMESHEETS]: 2 } });
    expect(checkTerm(seats, TIMESHEETS, [held("b"), held("c")]).every((v) => v.honoured)).toBe(true);
  });

  it("keeps billing's term_full and takes no seat for it", () => {
    const verdicts = checkTerm(term({ seats: { [TIMESHEETS]: 1 } }), TIMESHEETS, [
      held("a", { active: false, reason: "term_full", values: { active: false, reason: "term_full" } }),
      held("b"),
    ]);
    expect(verdicts.map((v) => v.refusal)).toEqual(["term_full", null]);
  });

  it("refuses a share that would take a pool past the term", () => {
    const pools = term({ pools: { [AUTOMATIONS]: { monthly_allowance: 1000 } } });
    const verdicts = checkTerm(pools, AUTOMATIONS, [
      held("a", { share: { monthly_allowance: 600 } }),
      held("b", { share: { monthly_allowance: 600 } }),
      held("c", { share: { monthly_allowance: 400 } }),
    ]);
    expect(verdicts.map((v) => v.refusal)).toEqual([null, "term_exceeded", null]);
  });

  it("never fits an unlimited allowance into a finite pool", () => {
    const pools = term({ pools: { [AUTOMATIONS]: { monthly_allowance: 1000 } } });
    const [verdict] = checkTerm(pools, AUTOMATIONS, [held("a", { values: { monthly_allowance: null } })]);
    expect(verdict.refusal).toBe("term_exceeded");
  });

  it("refuses everything with no term, and a listing the package doesn't sell", () => {
    expect(checkTerm(null, TIMESHEETS, [held("a")])[0].refusal).toBe("no_term");
    expect(checkTerm(term(), "UNKNOWN", [held("a")])[0].refusal).toBe("not_listed");
  });

  it("adds up only the keys still live", () => {
    const keys = [
      { keyId: "a", issuedAt: "2026-01-01", expiresAt: "2027-01-01", months: 12, apps: { [TIMESHEETS]: { communities: 2 } } },
      { keyId: "b", issuedAt: "2025-01-01", expiresAt: "2026-01-01", months: 12, apps: { [TIMESHEETS]: { communities: 5 } } },
    ];
    expect(combineKeys(keys, NOW)?.seats).toEqual({ [TIMESHEETS]: 2 });
  });
});

describe("the shipped root", () => {
  it("is a root, and verifies nothing it didn't sign", async () => {
    const pkg = buildTestPackage();
    await expect(readTerm({ packageUrl: pkg.packageUrl, fetcher: pkg.fetcher, now: NOW })).rejects.toMatchObject({
      code: "PACKAGE_INVALID",
    });
  });
});
