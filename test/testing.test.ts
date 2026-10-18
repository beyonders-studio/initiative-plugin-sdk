/**
 * A declarative plug-in's requests, mappings and writes, run against recorded
 * answers exactly as Initiative will run them: what is sent, what each answer
 * means, what is written, and the bounds every expression is evaluated within.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { CAPS } from "../src/contract.js";
import { evaluate, runAction, runAfterConnect, runEndpoint, runHealth, runSchedule, runWebhook } from "../src/testing.js";
import { issuesPlugin } from "./support/plugin.js";

const plugin = issuesPlugin();
const now = "2026-10-02T12:00:00.000Z";
const workspace = { workspace: { owner: "acme" } };

afterEach(() => vi.restoreAllMocks());

describe("runEndpoint", () => {
  it("renders each page's request, and maps every page's items", async () => {
    const run = await runEndpoint(plugin, "open-issues", {
      params: { state: "Open" },
      connections: workspace,
      now,
      responses: [{ body: [{ title: "A" }, { title: "B" }] }, { body: [{ title: "C" }] }],
    });
    expect(run).toEqual({
      requests: [1, 2].map((page) => ({
        method: "GET",
        url: `https://api.tracker.example/repos/acme/issues?state=open&page=${page}&per_page=2`,
        headers: { Accept: "application/json" },
        connection: "workspace",
      })),
      result: { titles: ["A", "B", "C"], total: 3 },
    });
  });

  it("refuses a range past max_pages when on_limit says so", async () => {
    const full = { body: [{ title: "A" }, { title: "B" }] };
    const run = await runEndpoint(plugin, "open-issues", { connections: workspace, now, responses: [full, full] });
    expect(run).toMatchObject({ unavailable: "range-too-large" });
  });

  it("runs steps in order, each reading the ones before it", async () => {
    const run = await runEndpoint(plugin, "label", {
      params: { number: 7, label: "bug" },
      connections: workspace,
      now,
      responses: [{ body: [{ name: "ui" }] }, { body: [{ name: "ui" }, { name: "bug" }] }],
    });
    expect(run.requests[1]).toEqual({
      method: "PUT",
      url: "https://api.tracker.example/issues/7/labels",
      headers: {},
      body: { labels: ["ui", "bug"] },
      connection: "workspace",
    });
    expect(run).toMatchObject({ result: { labels: ["ui", "bug"] } });
  });

  it.each([
    [{ status: 422, body: { message: "locked" } }, { unavailable: "locked" }],
    [{ status: 422, body: { message: "bad" } }, { unavailable: "invalid" }],
    [{ status: 404 }, { unavailable: "not-found" }],
    [{ status: 403 }, { unavailable: "not-authorized" }],
    [{ status: 429 }, { transient: true }],
    [{ status: 502 }, { transient: true }],
  ])("answers %j with its rule or the default", async (response, answered) => {
    const run = await runEndpoint(plugin, "label", { params: { number: 7 }, connections: workspace, now, responses: [response] });
    expect(run).toEqual({ requests: [expect.objectContaining({ method: "GET" })], ...answered });
  });

  it("sends a GraphQL cursor in its variable, from the second page", async () => {
    const page = (ids: string[], more: boolean) => ({
      body: { data: { issues: { nodes: ids.map((id) => ({ id })), pageInfo: { endCursor: ids.at(-1), hasNextPage: more } } } },
    });
    const run = await runEndpoint(plugin, "search", { now, responses: [page(["a"], true), page(["b"], false)] });
    expect(run.requests.map((request) => (request.body as { variables: unknown }).variables)).toEqual([
      { after: null },
      { after: "a" },
    ]);
    expect(run).toMatchObject({ result: { ids: ["a", "b"] } });
  });

  it("reads each connection the endpoint requires as connections.<id>, beside the request's own", async () => {
    const run = await runEndpoint(plugin, "assign", {
      params: { number: 7 },
      connections: { ...workspace, account: {}, elsewhere: { owner: "other" } },
      now,
      responses: [{ status: 201, body: { assignee: "alice" } }],
    });
    expect(run).toEqual({
      requests: [
        {
          method: "POST",
          url: "https://api.tracker.example/repos/acme/issues/7/assignees",
          headers: {},
          body: { assignee: "me", seen: ["workspace", "account"] },
          connection: "account",
        },
      ],
      result: { assignee: "alice" },
    });
  });

  it("fails on an answer that does not fit the returns, and on a response nothing asked for", async () => {
    await expect(
      runEndpoint(plugin, "open-issues", { connections: workspace, now, responses: [{ body: [{ title: 1 }] }] })
    ).rejects.toThrow("answered 'titles' as 1, which is not string");
    await expect(
      runEndpoint(plugin, "open-issues", { connections: workspace, now, responses: [{ body: [] }, { body: [] }] })
    ).rejects.toThrow("1 recorded response(s) were not asked for");
  });
});

describe("runAfterConnect", () => {
  const pages = [
    { headers: { Link: '<https://api.tracker.example/user/installations?page=2>; rel="next"' }, body: { installations: [{ id: "1", account: "other" }] } },
    { body: { installations: [{ id: "2", account: "acme" }] } },
  ];

  it("follows the Link header and maps the installation it came back with", async () => {
    const run = await runAfterConnect(plugin, "workspace", { params: { installation_id: "2" }, now, responses: pages });
    expect(run.requests.map((request) => request.url)).toEqual([
      "https://api.tracker.example/user/installations",
      "https://api.tracker.example/user/installations?page=2",
    ]);
    expect(run).toMatchObject({ result: { values: { owner: "acme" }, account_label: "acme" } });
  });

  it("answers mapping-failed, saying why, for a next page off the plug-in's hosts", async () => {
    const away = { headers: { Link: '<https://elsewhere.example/more>; rel="next"' }, body: { installations: [] } };
    const run = await runAfterConnect(plugin, "workspace", { now, responses: [away] });
    expect(run).toMatchObject({ unavailable: "mapping-failed", requests: [{ url: "https://api.tracker.example/user/installations" }] });
    expect("detail" in run && run.detail).toContain("https://elsewhere.example/more is not https on one of the plug-in's hosts");
  });

  it("refuses when refuse_when holds", async () => {
    const run = await runAfterConnect(plugin, "workspace", { params: { installation_id: "9" }, now, responses: pages });
    expect(run).toMatchObject({ refused: "not-installed" });
  });

  describe("with steps", () => {
    const stepped = issuesPlugin();
    stepped.connections!.workspace.flow!.after_connect = {
      steps: [
        { name: "installation", request: { method: "GET", url: '"https://api.tracker.example/installations/" & params.installation_id' } },
        { name: "member", request: { method: "GET", url: '"https://api.tracker.example/orgs/" & steps.installation.body.account & "/membership"' } },
      ],
      map: '{"values": {"owner": steps.installation.body.account}, "account_label": steps.installation.body.account}',
      refuse_when: 'response.body.role != "admin" or steps.member.body.role != "admin"',
      code: "not-admin",
    };
    const connect = (...responses: Array<{ status?: number; body?: unknown }>) =>
      runAfterConnect(stepped, "workspace", { params: { installation_id: "2" }, now, responses });

    it("makes each in order, reading the ones before, and maps them all", async () => {
      const run = await connect({ body: { account: "acme" } }, { body: { role: "admin" } });
      expect(run.requests.map((request) => request.url)).toEqual([
        "https://api.tracker.example/installations/2",
        "https://api.tracker.example/orgs/acme/membership",
      ]);
      expect(run).toMatchObject({ result: { values: { owner: "acme" }, account_label: "acme" } });
    });

    it("refuses when refuse_when holds over a step's answer", async () => {
      expect(await connect({ body: { account: "acme" } }, { body: { role: "member" } })).toMatchObject({ refused: "not-admin" });
    });

    it("answers a step's failure by the defaults", async () => {
      expect(await connect({ body: { account: "acme" } }, { status: 404 })).toMatchObject({ unavailable: "not-found" });
    });
  });
});

describe("runHealth", () => {
  it.each([
    [{ status: 200 }, "ok"],
    [{ status: 404 }, "removed"],
    [{ status: 403, body: { reason: "suspended" } }, "suspended"],
    [{ status: 500 }, "unavailable"],
  ])("reads %j as %s", async (response, state) => {
    const run = await runHealth(plugin, "workspace", { fields: { owner: "acme" }, now, responses: [response] });
    expect(run.requests[0].url).toBe("https://api.tracker.example/installations/acme");
    expect(run).toMatchObject({ result: state });
  });
});

describe("runWebhook", () => {
  const closed = { headers: { "X-Event": "issues" }, payload: { action: "closed", issue: { number: 7 } } };
  /** The delivery `closed` matches, written by `write`. */
  const writing = (write: string) => {
    const changed = issuesPlugin();
    changed.webhooks!.events![1].write = write;
    return runWebhook(changed, closed);
  };

  it("emits the first matching row's event and makes its writes, and sets a connection's state", async () => {
    expect(
      await runWebhook(plugin, {
        headers: { "X-Event": "issues" },
        payload: { action: "opened", issue: { number: 7, title: "Broken" } },
      })
    ).toEqual({
      event: { emit: "issue-opened", payload: { number: 7, title: "Broken" } },
      writes: [{ target: { install: true }, set: { "issues.last_opened": 7 } }],
    });
    expect(await runWebhook(plugin, closed)).toEqual({
      writes: [{ target: { holding: { key: "issue.number", value: "7" } }, set: { "issue.state": "closed" } }],
    });
    expect(await runWebhook(plugin, { headers: { "X-Event": "installation" }, payload: { action: "suspend" } })).toEqual({
      status: { connection: "workspace", state: "suspended" },
    });
    expect(await runWebhook(plugin, { headers: { "X-Event": "push" }, payload: {} })).toEqual({});
  });

  it("reads the install's settings and a unique setting's earlier values", async () => {
    const issue = { number: 12, title: "Fix ACME-7 and old-9, not other-3", html_url: "https://tracker.example/acme/issues/12" };
    const run = await runWebhook(plugin, {
      headers: { "X-Event": "issues" },
      payload: { action: "opened", issue },
      settings: { prefix: "acme" },
      aliases: { prefix: ["old"] },
    });
    const linked = [{ ref: "12", url: issue.html_url, text: "#12", state: { status: "open" } }];
    expect(run.writes).toEqual([
      { target: { install: true }, set: { "issues.last_opened": 12 } },
      { target: { kind: "task", id: 7 }, upsert: { "issues.linked": linked } },
      { target: { kind: "task", id: 9 }, upsert: { "issues.linked": linked } },
    ]);
  });

  it("fails on a write that is not a list of targeted changes within the caps", async () => {
    await expect(writing('{"target": {"install": true}, "set": {}}')).rejects.toThrow("wrap the answer in [ ] to keep a list");
    await expect(writing('[{"target": {"kind": "task"}, "set": {}}]')).rejects.toThrow(
      'write/0 answered {"target":{"kind":"task"},"set":{}}, which is not a targeted change: /target must have required property \'id\''
    );
    await expect(writing('[{"target": {"install": true}, "set": {"Issue": 1}}]')).rejects.toThrow("/set property name must be valid");
    await expect(writing(`[{"target": {"install": true}, "set": {"big": $pad("", ${CAPS.metadataValueBytes}, "x")}}]`)).rejects.toThrow(
      `write/0 gives 'big' a value of more than ${CAPS.metadataValueBytes} bytes as JSON`
    );
    await expect(writing(`[1..${CAPS.writeTargets + 1}].{"target": {"install": true}, "set": {}}`)).rejects.toThrow(
      `write answered ${CAPS.writeTargets + 1} changes, more than ${CAPS.writeTargets}`
    );
  });

  it("fails on a change that changes nothing or one key twice, or on a list's elements that are not elements within the caps", async () => {
    const changing = (...operations: string[]) => writing(`[{${['"target": {"install": true}', ...operations].join(", ")}}]`);
    await expect(changing()).rejects.toThrow("/ must match a schema in anyOf");
    await expect(changing('"upsert": {"issues.linked": [{"url": "u"}]}')).rejects.toThrow(
      "/upsert/issues.linked/0 must have required property 'ref'"
    );
    await expect(changing(`"remove": {"issues.linked": [$pad("", ${CAPS.metadataLookupLength + 1}, "x")]}`)).rejects.toThrow(
      `/remove/issues.linked/0 must NOT have more than ${CAPS.metadataLookupLength} characters`
    );
    await expect(changing('"set": {"issues.linked": null}', '"remove": {"issues.linked": ["12"]}')).rejects.toThrow(
      "write/0 changes 'issues.linked' twice"
    );
    await expect(changing('"upsert": {"issue.state": [{"ref": "12", "value": "open"}]}')).rejects.toThrow(
      "write/0 changes elements of 'issue.state', which is not a list field"
    );
    await expect(changing('"set": {"issues.linked": {"ref": "12"}}')).rejects.toThrow(
      `write/0 sets 'issues.linked', a list field, to {"ref":"12"}, which is not a list of elements`
    );
    await expect(changing(`"upsert": {"issues.linked": [{"ref": "12", "text": $pad("", ${CAPS.metadataValueBytes}, "x")}]}`)).rejects.toThrow(
      `write/0 gives 'issues.linked' a value of more than ${CAPS.metadataValueBytes} bytes as JSON`
    );
  });
});

describe("runAction", () => {
  const task = { kind: "task" as const, id: 7, title: "Fix the build" };
  const created = { status: 201, body: { number: 12, html_url: "https://tracker.example/acme/issues/12" } };

  it("makes its endpoint's call with the item and the install's settings, and the change its write answers from the result", async () => {
    const run = await runAction(plugin, "create", { item: task, settings: { prefix: "acme" }, connections: workspace, now, responses: [created] });
    expect(run).toEqual({
      requests: [
        {
          method: "POST",
          url: "https://api.tracker.example/repos/acme/issues",
          headers: {},
          body: { title: "Fix the build", body: "From acme-7" },
          connection: "workspace",
        },
      ],
      result: { number: 12, url: "https://tracker.example/acme/issues/12" },
      change: {
        set: { "issue.number": 12, "issue.link": { url: "https://tracker.example/acme/issues/12", text: "#12" }, "issue.state": "open" },
      },
    });
    expect(await runAction(plugin, "create", { item: task, connections: workspace, now, responses: [{ status: 404 }] })).toEqual({
      requests: [expect.objectContaining({ method: "POST" })],
      unavailable: "not-found",
    });
  });

  it("writes from the values it holds alone, and nothing when its write answers nothing", async () => {
    expect(await runAction(plugin, "unlink", { item: task, held: { "issue.number": 12 }, now, responses: [] })).toEqual({
      requests: [],
      change: { set: { "issue.number": null, "issue.link": null, "issue.state": null } },
    });
    expect(await runAction(plugin, "unlink", { item: task, now, responses: [] })).toEqual({ requests: [] });
  });

  it("sends its endpoint the params the reader answered, and writes from them or from the element it was run from", async () => {
    const issue = { number: 12, title: "Broken", html_url: "https://tracker.example/acme/issues/12", state: "open" };
    expect(await runAction(plugin, "link", { item: task, params: { number: 12 }, connections: workspace, now, responses: [{ body: issue }] })).toEqual({
      requests: [{ method: "GET", url: "https://api.tracker.example/repos/acme/issues/12", headers: {}, connection: "workspace" }],
      result: { number: 12, title: "Broken", url: issue.html_url, state: "open" },
      change: { upsert: { "issues.linked": [{ ref: "12", url: issue.html_url, text: "#12 Broken", state: { status: "open" } }] } },
    });
    expect(await runAction(plugin, "unlink-one", { item: task, element: "12", now, responses: [] })).toEqual({
      requests: [],
      change: { remove: { "issues.linked": ["12"] } },
    });
  });

  it("fails on a write that is not a change, and on an item, params or an element the action does not take", async () => {
    const changed = issuesPlugin();
    changed.actions!.unlink.write = '{"issue.number": null}';
    await expect(runAction(changed, "unlink", { item: task, now, responses: [] })).rejects.toThrow(
      "write answered {\"issue.number\":null}, which is not a change: / must have required property 'set'"
    );
    await expect(runAction(plugin, "unlink", { item: { ...task, kind: "post" }, now, responses: [] })).rejects.toThrow(
      "'unlink' is not offered on post"
    );
    await expect(runAction(plugin, "link", { item: task, params: { number: 12, state: "open" }, now, responses: [] })).rejects.toThrow(
      "'link' does not ask for 'state'"
    );
    await expect(runAction(plugin, "unlink", { item: task, element: "12", now, responses: [] })).rejects.toThrow(
      "'unlink' is offered on no list's elements"
    );
  });
});

describe("runSchedule", () => {
  it("asks what changed since its last success, and writes each answer to the items holding it", async () => {
    const run = await runSchedule(plugin, "sync", {
      since: "2026-10-01T12:00:00.000Z",
      connections: workspace,
      now,
      responses: [{ body: [{ number: 7, state: "closed" }, { number: 9, state: "open" }] }],
    });
    expect(run).toEqual({
      requests: [
        {
          method: "GET",
          url: "https://api.tracker.example/repos/acme/issues?since=2026-10-01T12%3A00%3A00.000Z&state=all",
          headers: {},
          connection: "workspace",
        },
      ],
      result: { numbers: [7, 9], states: ["closed", "open"] },
      writes: [
        { target: { holding: { key: "issue.number", value: "7" } }, set: { "issue.state": "closed" } },
        { target: { holding: { key: "issue.number", value: "9" } }, set: { "issue.state": "open" } },
      ],
    });
  });

  it("asks for everything the first time, writes nothing when nothing changed, and nothing on a failure", async () => {
    expect(await runSchedule(plugin, "sync", { connections: workspace, now, responses: [{ body: [] }] })).toEqual({
      requests: [expect.objectContaining({ url: "https://api.tracker.example/repos/acme/issues?state=all" })],
      result: {},
      writes: [],
    });
    expect(await runSchedule(plugin, "sync", { connections: workspace, now, responses: [{ status: 502 }] })).toEqual({
      requests: [expect.objectContaining({ method: "GET" })],
      transient: true,
    });
  });
});

describe("evaluate", () => {
  it("answers $now() and $millis() at the call's time", async () => {
    expect(await evaluate("[$now(), $millis()]", {}, { now })).toEqual([now, Date.parse(now)]);
  });

  it("is bounded in depth, time and the size of its answer", async () => {
    await expect(evaluate("($f := function($n) { $f($n + 1) + 1 }; $f(0))", {})).rejects.toThrow("Stack overflow");
    await expect(evaluate(`$pad("", ${CAPS.expressionOutputBytes}, "x")`, {})).rejects.toThrow(
      `over ${CAPS.expressionOutputBytes} bytes`
    );
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(CAPS.expressionTimeMs + 1);
    await expect(evaluate("[1, 2].($ * 2)", {})).rejects.toThrow(`timeout after ${CAPS.expressionTimeMs} milliseconds`);
  });
});
