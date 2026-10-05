import type { FastifyInstance } from "fastify";

// The home page at GET /. A form queues a test email job and the page then watches it; a second
// form looks up any job. It is served the same way as the dead letter page: HTML and script as
// strings, a strict content security policy, no framework, no external script, font or CDN.
//
// It holds no secret and asks for none: no password field, no mail account field and no admin
// token (the admin token lives only on /admin/dead). It uses the demo-level x-user-id header
// (PRD FR1) and sends only what the form holds. Server text is written with textContent, never
// innerHTML. Nothing is stored in localStorage, sessionStorage or cookies.
//
// Real server behaviour this page mirrors (src/server.ts):
//   POST /api/jobs      header x-user-id (else 401 {"error":"x-user-id header required"})
//                       body {type:"send_email", payload:{...}, idempotencyKey: 1 to 200 characters}
//                       202 {id} new job, 200 {id} key already used by the same user with the same
//                       content, 409 {"error":"idempotency key already used with a different payload or owner"}
//   GET /api/jobs/:id   header x-user-id (else 401), 200 {id,status,attempts,maxAttempts,runAt,finishedAt,error},
//                       404 {"error":"not found"} for another user's job or an unknown id

// Same policy as the dead letter page: only its own script, and only requests to its own origin.
const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

export const HOME_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Background jobs</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 1.5rem; max-width: 42rem; color: #222; }
  h2 { margin: 1.8rem 0 .4rem; font-size: 1.15rem; }
  label { display: block; font-weight: 600; margin-top: .8rem; }
  input[type=text], input[type=email], textarea { font: inherit; width: 100%; box-sizing: border-box; padding: .35rem .5rem; }
  .row { display: flex; gap: .5rem; align-items: center; }
  .row input[type=text] { flex: 1; }
  .check { display: flex; gap: .4rem; align-items: center; font-weight: 400; margin-top: .4rem; }
  button { font: inherit; padding: .45rem 1rem; cursor: pointer; }
  .actions { margin-top: 1rem; }
  table { border-collapse: collapse; margin: .6rem 0; width: 100%; }
  th, td { border: 1px solid #ccc; padding: .35rem .7rem; text-align: left; vertical-align: top; }
  th { background: #f3f3f3; width: 8rem; }
  td { word-break: break-all; }
  .muted { color: #666; font-size: .92rem; margin: .3rem 0; }
  .bad { color: #a40000; font-weight: 600; }
  .reply { margin: .8rem 0 .2rem; min-height: 1.5rem; }
</style>
</head>
<body>
<h1>Background jobs</h1>
<p>Fill in the form to queue one email job. A separate worker picks it up and sends it, and this page shows what happens to it.</p>

<form id="sendForm">
  <label for="userName">Your user name (sent as the x-user-id header)</label>
  <input id="userName" type="text" value="demo-user" required autocomplete="off">

  <label for="to">To (recipient email address)</label>
  <input id="to" type="email" required autocomplete="off">

  <label for="subject">Subject</label>
  <input id="subject" type="text" value="test" required autocomplete="off">

  <label for="body">Body</label>
  <textarea id="body" rows="3">test</textarea>

  <label for="key">Idempotency key</label>
  <div class="row">
    <input id="key" type="text" required maxlength="200" autocomplete="off">
    <button id="newKey" type="button">New key</button>
  </div>
  <label class="check" for="keepKey"><input id="keepKey" type="checkbox"> Keep this key for the next send</label>
  <p class="muted">Same key twice means the same order. The server will not create a second job.</p>

  <div class="actions"><button id="send" type="submit">Send job</button></div>
</form>

<p id="reply" class="reply" role="status"></p>
<p id="serverSaid" class="muted"></p>

<h2>Check a job</h2>
<form id="checkForm">
  <label for="checkId">Job id</label>
  <input id="checkId" type="text" required autocomplete="off">
  <div class="actions"><button id="check" type="submit">Check status</button></div>
</form>
<p class="muted">This uses the user name from the form above.</p>

<table>
  <tr><th>Job id</th><td id="jobId">-</td></tr>
  <tr><th>Status</th><td id="status">-</td></tr>
  <tr><th>Attempts</th><td id="attempts">-</td></tr>
  <tr><th>Error</th><td id="error">-</td></tr>
  <tr><th>Last checked</th><td id="lastChecked">-</td></tr>
</table>
<p id="pollMessage" class="muted"></p>

<p class="muted">Succeeded means the mail server accepted the message. It does not confirm delivery.</p>
<p class="muted">If the status stays pending, the worker is not running.</p>
<p class="muted">While the worker window says transport=fake, no email really leaves this computer.</p>
<p class="muted">The sender account is set in the server settings, not on this page.</p>
<p><a href="/admin/dead">Dead jobs (admin)</a></p>
<script src="/app.js"></script>
</body>
</html>
`;

export const HOME_PAGE_JS = `
(function () {
  // The page checks a job once every POLL_MS, counted from one check to the next, and the text
  // below is built from this same number so the two cannot disagree.
  var POLL_MS = 2000;
  var KEEP_POLLING = ["pending", "processing", "failed"];

  function el(id) { return document.getElementById(id); }
  var sendForm = el("sendForm");
  var checkForm = el("checkForm");
  var sendButton = el("send");
  var userEl = el("userName");
  var toEl = el("to");
  var subjectEl = el("subject");
  var bodyEl = el("body");
  var keyEl = el("key");
  var keepEl = el("keepKey");
  var newKeyButton = el("newKey");
  var replyEl = el("reply");
  var serverSaidEl = el("serverSaid");
  var checkIdEl = el("checkId");
  var idEl = el("jobId");
  var statusEl = el("status");
  var attemptsEl = el("attempts");
  var errorEl = el("error");
  var lastEl = el("lastChecked");
  var pollMessageEl = el("pollMessage");

  var hasUuid = !!(window.crypto && typeof window.crypto.randomUUID === "function");
  var timer = null;
  var run = 0; // names the job being watched, so an old poll can never overwrite a newer one

  function say(text, bad) {
    replyEl.textContent = text;
    replyEl.className = bad ? "reply bad" : "reply";
  }
  function serverSaid(text) { serverSaidEl.textContent = text ? "Server said: " + text : ""; }
  function pollSay(text, bad) {
    pollMessageEl.textContent = text;
    pollMessageEl.className = bad ? "bad" : "muted";
  }
  function clearJob() {
    idEl.textContent = "-";
    statusEl.textContent = "-";
    attemptsEl.textContent = "-";
    errorEl.textContent = "-";
    lastEl.textContent = "-";
    pollSay("", false);
  }
  function stopPolling() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  }
  async function readText(res) {
    try { return (await res.text()).slice(0, 300); } catch (e) { return ""; }
  }

  function newKey() {
    if (!hasUuid) {
      keyEl.value = "";
      say("This browser cannot make a key on this address (crypto.randomUUID needs http://127.0.0.1 or https). Type a key by hand.", true);
      return;
    }
    keyEl.value = window.crypto.randomUUID();
  }

  // The meaning of each status for POST /api/jobs, in plain words.
  function explainSend(status) {
    if (status === 202) return "New job created.";
    if (status === 200) return "A job with this key already existed. The same job id was returned.";
    if (status === 409) return "This key was already used with different content or by a different user name.";
    if (status === 401) return "User name missing.";
    return null;
  }

  async function sendJob(event) {
    event.preventDefault();
    stopPolling();
    run += 1;
    var mine = run;
    clearJob();
    serverSaid("");
    var user = userEl.value;
    sendButton.disabled = true; // only while the request is in flight, so a double click cannot send twice
    try {
      say("Sending...", false);
      var res;
      try {
        res = await fetch("/api/jobs", {
          method: "POST",
          headers: { "content-type": "application/json", "x-user-id": user },
          body: JSON.stringify({
            type: "send_email",
            idempotencyKey: keyEl.value,
            payload: { to: toEl.value, subject: subjectEl.value, body: bodyEl.value }
          })
        });
      } catch (e) {
        say("Could not send: the server is not reachable, or the user name has characters an HTTP header cannot hold. The key was kept.", true);
        return;
      }

      var words = explainSend(res.status);
      var text = await readText(res);
      if (res.status === 202 || res.status === 200) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (!data || typeof data.id !== "string") {
          say("HTTP " + res.status + ": " + words + " But the reply had no job id.", true);
          serverSaid(text);
        } else {
          say("HTTP " + res.status + ": " + words, false);
          idEl.textContent = data.id;
          checkIdEl.value = data.id;
          poll(data.id, user, mine);
        }
      } else if (words !== null) {
        say("HTTP " + res.status + ": " + words, true);
        serverSaid(text);
      } else {
        say("HTTP " + res.status + ": " + (text || "(no text in the reply)"), true);
      }

      // A reply came back, so the order is settled either way. Make a fresh key unless asked to keep it.
      if (!keepEl.checked) newKey();
    } finally {
      sendButton.disabled = false;
    }
  }

  function checkJob(event) {
    event.preventDefault();
    stopPolling();
    run += 1;
    var mine = run;
    var id = checkIdEl.value.trim();
    clearJob();
    serverSaid("");
    say("Checking job " + id + "...", false);
    idEl.textContent = id;
    poll(id, userEl.value, mine);
  }

  // Looks at one job, shows it, and decides whether to look again.
  async function poll(id, user, mine) {
    if (mine !== run) return;
    var startedAt = Date.now();
    var res;
    try {
      res = await fetch("/api/jobs/" + encodeURIComponent(id), { headers: { "x-user-id": user } });
    } catch (e) {
      if (mine !== run) return;
      say("Could not check the job: the server is not reachable, or the user name has characters an HTTP header cannot hold.", true);
      pollSay("Trying again in about " + POLL_MS / 1000 + " seconds.", true);
      schedule(id, user, mine, startedAt);
      return;
    }
    var text = await readText(res);
    if (mine !== run) return;

    if (res.status === 404) {
      say("HTTP 404: Not found for this user name.", true);
      pollSay("", false);
      return;
    }
    if (res.status === 401) {
      say("HTTP 401: User name missing.", true);
      serverSaid(text);
      pollSay("", false);
      return;
    }
    if (res.status !== 200) {
      say("HTTP " + res.status + ": " + (text || "(no text in the reply)"), true);
      pollSay("", false);
      return;
    }
    var job = null;
    try { job = JSON.parse(text); } catch (e) { job = null; }
    if (!job || typeof job.status !== "string") {
      say("HTTP 200 but the reply was not a job.", true);
      serverSaid(text);
      return;
    }

    idEl.textContent = job.id;
    statusEl.textContent = job.status;
    attemptsEl.textContent = job.attempts + " of " + job.maxAttempts;
    errorEl.textContent = job.error ? job.error : "-";
    lastEl.textContent = new Date().toLocaleTimeString();

    if (KEEP_POLLING.indexOf(job.status) !== -1) {
      say("Status is " + job.status + ".", false);
      pollSay("Checking again in about " + POLL_MS / 1000 + " seconds.", false);
      schedule(id, user, mine, startedAt);
    } else if (job.status === "succeeded") {
      say("Done: the job succeeded.", false);
      pollSay("Stopped checking.", false);
    } else if (job.status === "dead") {
      say("The job is dead: it used up its retries or hit a permanent error. See the error above.", true);
      pollSay("Stopped checking.", false);
    } else {
      say("Unexpected status: " + job.status, true);
      pollSay("Stopped checking.", false);
    }
  }

  // Next check starts POLL_MS after the last one STARTED, so the time a reply takes does not stretch it.
  function schedule(id, user, mine, startedAt) {
    var wait = Math.max(0, POLL_MS - (Date.now() - startedAt));
    timer = setTimeout(function () { poll(id, user, mine); }, wait);
  }

  sendForm.addEventListener("submit", sendJob);
  checkForm.addEventListener("submit", checkJob);
  newKeyButton.addEventListener("click", newKey);
  newKey();
})();
`;

// Registered the same way as /admin/dead: two plain GET routes with the policy header.
export function registerHomePage(app: FastifyInstance): void {
  app.get("/", async (_request, reply) =>
    reply.header("content-security-policy", PAGE_CSP).type("text/html; charset=utf-8").send(HOME_PAGE_HTML),
  );
  app.get("/app.js", async (_request, reply) =>
    reply.header("content-security-policy", PAGE_CSP).type("text/javascript; charset=utf-8").send(HOME_PAGE_JS),
  );
}
