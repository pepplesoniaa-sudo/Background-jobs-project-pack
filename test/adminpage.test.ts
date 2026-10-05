import { describe, expect, it } from "vitest";
import { ADMIN_PAGE_HTML, ADMIN_PAGE_JS } from "../src/adminPage.js";

// DATABASE-FREE AND MAIL-FREE. The page script is run against a tiny fake document (no browser), so
// these tests cover what the script does, not only what its text contains.

class FakeEl {
  children: FakeEl[] = [];
  listeners: Record<string, Array<() => void>> = {};
  textContent = "";
  className = "";
  value = "";
  disabled = false;
  type = "";
  autocomplete = "";
  constructor(public tag: string) {}
  appendChild(child: FakeEl) {
    this.children.push(child);
    return child;
  }
  addEventListener(name: string, fn: () => void) {
    (this.listeners[name] ??= []).push(fn);
  }
  fire(name: string) {
    for (const fn of this.listeners[name] ?? []) fn();
  }
  all(): FakeEl[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}

const REF = "0123456789abcdef0123";
const dead = (id: string, sentState: string | null, status = "dead") => ({
  id, status, type: "send_email", createdAt: "t", attempts: 2, maxAttempts: 5, lastError: "uncertain send",
  payload: {}, sentState, checkProviderBeforeRetry: sentState === "sending", jobRef: REF, attempts_history: [],
});

async function openPage(jobs: unknown[]) {
  const byId: Record<string, FakeEl> = {};
  for (const id of ["token", "status", "out", "load"]) byId[id] = new FakeEl(id === "token" ? "input" : "div");
  const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string> } }> = [];
  const doc = {
    getElementById: (id: string) => byId[id],
    createElement: (tag: string) => new FakeEl(tag),
  };
  const fetchStub = async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push({ url, init });
    if (init?.method === "POST") return { status: 200, ok: true, json: async () => ({}) };
    return { status: 200, ok: true, json: async () => ({ jobs }) };
  };
  const win = { confirm: () => true };
  new Function("document", "fetch", "window", ADMIN_PAGE_JS)(doc, fetchStub, win);
  byId.token.value = "some-admin-token";
  const load = async () => {
    byId.load.fire("click");
    await new Promise((r) => setTimeout(r, 5));
  };
  await load();
  const row = (id: string) => byId.out.all().filter((e) => e.tag === "tr").find((tr) => tr.all().some((e) => e.textContent.includes(id)))!;
  return { byId, calls, load, row };
}

const confirmParts = (row: FakeEl) => ({
  box: row.all().find((e) => e.tag === "input")!,
  button: row.all().find((e) => e.tag === "button" && e.textContent === "Confirm mark as sent")!,
});

describe("S9b Mark as sent needs the typed reference (page only)", () => {
  it("the Confirm button starts disabled, stays disabled for wrong text, and enables only for exactly the 20-character reference", async () => {
    const { row } = await openPage([dead("job-1", "sending")]);
    const { box, button } = confirmParts(row("job-1"));
    expect(button.disabled).toBe(true);
    for (const text of ["wrong", REF.slice(0, 19), REF + "x", REF.toUpperCase(), ` ${REF}`, `${REF} `, ""]) {
      box.value = text;
      box.fire("input");
      expect(button.disabled, JSON.stringify(text)).toBe(true);
    }
    box.value = REF;
    box.fire("input");
    expect(button.disabled).toBe(false);
  });

  it("no request is sent unless the text is exact, even if a click gets through; with the exact text one POST is sent, token in a header only", async () => {
    const { row, calls } = await openPage([dead("job-1", "sending")]);
    const { box, button } = confirmParts(row("job-1"));
    box.value = "nope";
    box.fire("input");
    button.fire("click"); // a click that somehow reaches the handler
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.filter((c) => c.url.includes("mark-sent"))).toHaveLength(0);

    box.value = REF;
    box.fire("input");
    button.fire("click");
    await new Promise((r) => setTimeout(r, 5));
    const sent = calls.filter((c) => c.url.includes("mark-sent"));
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("/api/admin/dead-jobs/job-1/mark-sent");
    expect(sent[0].init?.method).toBe("POST");
    expect(sent[0].init?.headers).toEqual({ "x-admin-token": "some-admin-token" });
  });

  it("window.confirm is no longer used for mark-as-sent (the other two actions keep theirs)", () => {
    const fn = /async function markSent\(job\)[\s\S]*?\n  }\n/.exec(ADMIN_PAGE_JS)![0];
    expect(fn).not.toContain("window.confirm");
    expect(fn).toContain("typedRefs[job.id] !== job.jobRef");
    for (const name of ["retry", "markNotSent"]) {
      const other = new RegExp(`async function ${name}\\(job\\)[\\s\\S]*?\\n  }\\n`).exec(ADMIN_PAGE_JS)![0];
      expect(other, name).toContain("window.confirm");
    }
  });

  it("the typed text survives a reload of the list, and the button state is restored with it", async () => {
    const { row, load } = await openPage([dead("job-1", "sending"), dead("job-2", "sending")]);
    let one = confirmParts(row("job-1"));
    one.box.value = REF;
    one.box.fire("input");
    const two = confirmParts(row("job-2"));
    two.box.value = "half";
    two.box.fire("input");

    await load(); // the list is rebuilt
    one = confirmParts(row("job-1"));
    expect(one.box.value).toBe(REF);
    expect(one.button.disabled).toBe(false);
    const again = confirmParts(row("job-2"));
    expect(again.box.value).toBe("half"); // kept per job, never shared between rows
    expect(again.button.disabled).toBe(true);
  });

  it("the form appears only for a dead job whose email state is 'sending'", async () => {
    const { row } = await openPage([dead("job-a", "sending"), dead("job-b", "sent"), dead("job-c", null), dead("job-d", "sending", "succeeded")]);
    expect(row("job-a").all().some((e) => e.tag === "input")).toBe(true);
    for (const id of ["job-b", "job-c", "job-d"]) {
      expect(row(id).all().some((e) => e.tag === "input"), id).toBe(false);
      expect(row(id).all().some((e) => e.textContent === "Confirm mark as sent"), id).toBe(false);
    }
  });

  it("the form is built with createElement and textContent, never innerHTML", () => {
    expect(ADMIN_PAGE_JS).not.toContain("innerHTML");
    expect(ADMIN_PAGE_JS).toContain('el("input")');
    expect(ADMIN_PAGE_JS).toContain('"Confirm mark as sent"');
  });
});

// ---- dead view: what the page script shows (fake document, no browser) ----
const DEADVIEW_TOKEN = "T0KEN-must-never-be-shown-1234567890";

const rich = (id: string, over: Record<string, unknown> = {}) => ({
  ...dead(id, null),
  attempts: 3, maxAttempts: 3,
  createdAt: "2026-10-05T00:10:05.123Z", finishedAt: "2026-10-05T00:31:12.456Z",
  payload: { to: "n***@example.test", subject: "e2e dead 1", body: "hello body", bodyTruncated: false },
  ...over,
});

async function openView(opts: { jobs?: unknown[]; total?: number; status?: number; reject?: boolean } = {}) {
  const byId: Record<string, FakeEl> = {};
  for (const id of ["token", "status", "out", "load"]) byId[id] = new FakeEl(id === "token" ? "input" : "div");
  let calls = 0;
  const doc = { getElementById: (id: string) => byId[id], createElement: (tag: string) => new FakeEl(tag) };
  const fetchStub = async () => {
    calls += 1;
    if (opts.reject) throw new TypeError("network down");
    const status = opts.status ?? 200;
    return { status, ok: status >= 200 && status < 300, json: async () => ({ jobs: opts.jobs ?? [], total: opts.total }) };
  };
  new Function("document", "fetch", "window", ADMIN_PAGE_JS)(doc, fetchStub, { confirm: () => true });
  byId.token.value = DEADVIEW_TOKEN;
  byId.load.fire("click");
  await new Promise((r) => setTimeout(r, 10));
  const texts = () => byId.out.all().map((e) => e.textContent);
  const rowOf = (id: string) => byId.out.all().filter((e) => e.tag === "tr").find((tr) => tr.all().some((e) => e.textContent.includes(id)))!;
  return { byId, texts, rowOf, calls: () => calls };
}
const rowTexts = (row: FakeEl) => row.all().map((e) => e.textContent);

describe("dead view page: what the operator sees", () => {
  it("B2 attempts read 'attempts 3 of 3'", async () => {
    const { rowOf } = await openView({ jobs: [rich("job-1")], total: 1 });
    expect(rowTexts(rowOf("job-1"))).toContain("attempts 3 of 3");
  });

  it("B3 the header says 'Showing K of N dead jobs'", async () => {
    const { texts } = await openView({ jobs: [rich("job-1"), rich("job-2")], total: 7 });
    expect(texts()).toContain("Showing 2 of 7 dead jobs");
  });

  it("B4 created and died times carry a visible UTC label and are readable", async () => {
    const { rowOf } = await openView({ jobs: [rich("job-1")], total: 1 });
    const t = rowTexts(rowOf("job-1"));
    expect(t).toContain("Created: 2026-10-05 00:10:05 UTC");
    expect(t).toContain("Died: 2026-10-05 00:31:12 UTC");
  });

  it("B4 a job with no died time says '(none)' instead of failing", async () => {
    const { rowOf } = await openView({ jobs: [rich("job-1", { finishedAt: null })], total: 1 });
    expect(rowTexts(rowOf("job-1"))).toContain("Died: (none)");
  });

  it("B4 attempt history times are labelled UTC too", async () => {
    const history = [{ attemptNo: 1, workerId: "w1", startedAt: "2026-10-05T00:11:00.000Z", finishedAt: "2026-10-05T00:11:01.000Z", error: "boom", backoffBoundMs: 500, delayMs: 300 }];
    const { rowOf } = await openView({ jobs: [rich("job-1", { attempts_history: history })], total: 1 });
    const line = rowTexts(rowOf("job-1")).find((s) => s.startsWith("#1 worker w1"))!;
    expect(line).toContain("started 2026-10-05 00:11:00 UTC");
    expect(line).toContain("finished 2026-10-05 00:11:01 UTC");
    expect(line).toContain("boom");
  });

  it("B1 the payload shows the masked recipient, 'Recipient hidden for privacy.', the subject and the body prefix, as plain text", async () => {
    const hostile = "<img src=x onerror=alert(1)> prefix";
    const { rowOf } = await openView({ jobs: [rich("job-1", { payload: { to: "n***@example.test", subject: "<b>subj</b>", body: hostile, bodyTruncated: true } })], total: 1 });
    const row = rowOf("job-1");
    const t = rowTexts(row);
    expect(t).toContain("To: n***@example.test");
    expect(t).toContain("Recipient hidden for privacy.");
    expect(t).toContain("Subject: <b>subj</b>"); // literal text, never markup
    expect(t).toContain("Body (first 200 characters), cut short:");
    const pre = row.all().find((e) => e.tag === "pre")!;
    expect(pre.textContent).toBe(hostile);
  });

  it("B1 a missing subject or body shows '(none)'", async () => {
    const { rowOf } = await openView({ jobs: [rich("job-1", { payload: { to: "n***@example.test" } })], total: 1 });
    const row = rowOf("job-1");
    expect(rowTexts(row)).toContain("Subject: (none)");
    expect(row.all().find((e) => e.tag === "pre")!.textContent).toBe("(none)");
    const bare = await openView({ jobs: [rich("job-2", { payload: undefined })], total: 1 });
    expect(rowTexts(bare.rowOf("job-2"))).toContain("To: (none)");
  });

  it("B5 each button has its plain explanation, and the extra ones appear only where the button does", async () => {
    const { rowOf } = await openView({ jobs: [rich("job-a", { sentState: "sending", checkProviderBeforeRetry: true }), rich("job-b")], total: 2 });
    const a = rowTexts(rowOf("job-a"));
    expect(a).toContain("Retry: Puts the job back in the queue with a fresh allowance of attempts.");
    expect(a).toContain("Mark not sent: Use only if you checked that the email was NOT sent. Retrying can send a duplicate.");
    expect(a).toContain("Mark as sent: Use only if you checked the Sent folder and the email WAS sent. Type the reference to confirm.");
    const b = rowTexts(rowOf("job-b"));
    expect(b).toContain("Retry: Puts the job back in the queue with a fresh allowance of attempts.");
    expect(b.some((s) => s.startsWith("Mark not sent:") || s.startsWith("Mark as sent:"))).toBe(false);
  });

  it("B5 a row that is not dead gets no buttons and no explanations", async () => {
    const { rowOf } = await openView({ jobs: [rich("job-1", { status: "succeeded", sentState: "sending" })], total: 1 });
    const row = rowOf("job-1");
    expect(row.all().some((e) => e.tag === "button")).toBe(false);
    expect(rowTexts(row).some((s) => s.startsWith("Retry:"))).toBe(false);
  });

  it("B6 an empty list says 'No dead jobs.'", async () => {
    const { byId, texts } = await openView({ jobs: [], total: 0 });
    expect(byId.status.textContent).toBe("No dead jobs.");
    expect(texts()).toContain("No dead jobs.");
  });

  it("B6 a wrong or missing token says 'Wrong or missing admin token.' and never repeats the token", async () => {
    const { byId, texts } = await openView({ status: 401 });
    expect(byId.status.textContent).toBe("Wrong or missing admin token.");
    for (const s of [...texts(), byId.status.textContent]) expect(s).not.toContain(DEADVIEW_TOKEN);
  });

  it("B6 a network failure says 'Could not reach the server.' and never repeats the token", async () => {
    const { byId, texts } = await openView({ reject: true });
    expect(byId.status.textContent).toBe("Could not reach the server.");
    for (const s of [...texts(), byId.status.textContent]) expect(s).not.toContain(DEADVIEW_TOKEN);
  });

  it("B6 another failure status is reported by number, without the token", async () => {
    const { byId } = await openView({ status: 500 });
    expect(byId.status.textContent).toBe("Could not load (500).");
    expect(byId.status.textContent).not.toContain(DEADVIEW_TOKEN);
  });

  it("B6 the token field is type=password with autocomplete=off, and the page never stores the token", () => {
    expect(ADMIN_PAGE_HTML).toMatch(/<input id="token" type="password" autocomplete="off">/);
    expect(ADMIN_PAGE_JS).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML/);
    expect(ADMIN_PAGE_JS).not.toContain(DEADVIEW_TOKEN);
  });

  it("B7 there is no auto-refresh: no timer in the script, and no request is made after the load, even with a text box focused", async () => {
    expect(ADMIN_PAGE_JS).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
    const view = await openView({ jobs: [rich("job-1", { sentState: "sending" })], total: 1 });
    const box = view.rowOf("job-1").all().find((e) => e.tag === "input")!;
    (box as any).focused = true; // an operator typing in the confirm box
    box.value = "half-typed";
    box.fire("input");
    const before = view.calls();
    await new Promise((r) => setTimeout(r, 150));
    expect(view.calls()).toBe(before);
    expect(box.value).toBe("half-typed"); // nothing rebuilt the row under the operator's hands
  });

  it("an action that cannot reach the server says so and does not reload", async () => {
    // a fetch that works for the first load and fails for the POST
    const byId: Record<string, FakeEl> = {};
    for (const id of ["token", "status", "out", "load"]) byId[id] = new FakeEl(id === "token" ? "input" : "div");
    const doc = { getElementById: (id: string) => byId[id], createElement: (tag: string) => new FakeEl(tag) };
    let gets = 0;
    const fetchStub = async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") throw new TypeError("down");
      gets += 1;
      return { status: 200, ok: true, json: async () => ({ jobs: [rich("job-1")], total: 1 }) };
    };
    new Function("document", "fetch", "window", ADMIN_PAGE_JS)(doc, fetchStub, { confirm: () => true });
    byId.token.value = DEADVIEW_TOKEN;
    byId.load.fire("click");
    await new Promise((r) => setTimeout(r, 10));
    const retryBtn = byId.out.all().find((e) => e.tag === "button" && e.textContent === "Retry")!;
    retryBtn.fire("click");
    await new Promise((r) => setTimeout(r, 10));
    expect(byId.status.textContent).toBe("Could not reach the server.");
    expect(gets).toBe(1);
  });
});

describe("dead view page: the manual Refresh button (no timer)", () => {
  // A fetch that answers with a different list each time it is called, and records every call.
  async function openSequence(lists: unknown[][], status = 200) {
    const byId: Record<string, FakeEl> = {};
    for (const id of ["token", "status", "out", "load"]) byId[id] = new FakeEl(id === "token" ? "input" : "div");
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const created: string[] = [];
    const doc = {
      getElementById: (id: string) => byId[id],
      createElement: (tag: string) => (created.push(tag), new FakeEl(tag)),
    };
    const fetchStub = async (url: string, init?: { headers?: Record<string, string> }) => {
      const n = calls.length;
      calls.push({ url, headers: init?.headers });
      return { status, ok: status === 200, json: async () => ({ jobs: lists[Math.min(n, lists.length - 1)], total: 9 }) };
    };
    new Function("document", "fetch", "window", ADMIN_PAGE_JS)(doc, fetchStub, { confirm: () => true });
    byId.token.value = DEADVIEW_TOKEN;
    byId.load.fire("click");
    await new Promise((r) => setTimeout(r, 10));
    const refresh = () => byId.out.all().find((e) => e.tag === "button" && e.textContent === "Refresh");
    const idsShown = () => byId.out.all().filter((e) => e.tag === "tr").map((tr) => tr.all()[1]?.textContent ?? "");
    return { byId, calls, created, refresh, idsShown };
  }

  it("a Refresh button appears with the list, is a plain type=button, and was built with createElement and textContent", async () => {
    const v = await openSequence([[rich("job-1")]]);
    const button = v.refresh()!;
    expect(button).toBeTruthy();
    expect(button.type).toBe("button");
    expect(v.created).toContain("button");
    expect(ADMIN_PAGE_JS).toContain('document.createElement("button")');
    expect(ADMIN_PAGE_JS).toContain('button.textContent = "Refresh"');
    expect(ADMIN_PAGE_JS).not.toContain("innerHTML");
  });

  it("clicking it fetches the list again with the token in a header only, and shows what the second answer holds", async () => {
    const v = await openSequence([[rich("job-1")], [rich("job-1"), rich("job-2")]]);
    expect(v.calls).toHaveLength(1);
    v.refresh()!.fire("click");
    await new Promise((r) => setTimeout(r, 10));
    expect(v.calls).toHaveLength(2);
    expect(v.calls[1].url).toBe("/api/admin/dead-jobs"); // no token or query in the URL
    expect(v.calls[1].headers).toEqual({ "x-admin-token": DEADVIEW_TOKEN });
    const text = v.byId.out.all().map((e) => e.textContent).join("\n");
    expect(text).toContain("job-2");
    expect(v.refresh()).toBeTruthy(); // the rebuilt page has its Refresh button again
  });

  it("there is no timer: without a click no second request is ever made", async () => {
    const v = await openSequence([[rich("job-1")]]);
    await new Promise((r) => setTimeout(r, 150));
    expect(v.calls).toHaveLength(1);
    expect(ADMIN_PAGE_JS).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
  });

  it("the Refresh button is there for an empty list and for a wrong token too", async () => {
    const empty = await openSequence([[]]);
    expect(empty.refresh()).toBeTruthy();
    expect(empty.byId.out.all().map((e) => e.textContent)).toContain("No dead jobs.");
    const denied = await openSequence([[]], 401);
    expect(denied.byId.status.textContent).toBe("Wrong or missing admin token.");
    expect(denied.refresh()).toBeTruthy();
    for (const e of denied.byId.out.all()) expect(e.textContent).not.toContain(DEADVIEW_TOKEN);
  });

  it("text typed in a mark-as-sent box survives a refresh", async () => {
    const sending = rich("job-1", { sentState: "sending" });
    const v = await openSequence([[sending], [sending]]);
    const box = () => v.byId.out.all().find((e) => e.tag === "input")!;
    box().value = "half-typed";
    box().fire("input");
    v.refresh()!.fire("click");
    await new Promise((r) => setTimeout(r, 10));
    expect(box().value).toBe("half-typed");
  });

  it("the Refresh button is not an action button: the three action buttons are still the only ones made with el()", () => {
    expect(ADMIN_PAGE_JS.split('el("button"').length - 1).toBe(3);
  });
});
