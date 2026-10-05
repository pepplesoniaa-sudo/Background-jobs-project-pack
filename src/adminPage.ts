// The dead letter page. The HTML carries no job data and no token: the operator types the token,
// and the script sends it in a request header, never in a URL (PRD FR12). Everything that comes
// from the database is written with textContent, never innerHTML.

export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dead jobs</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 1.5rem; color: #222; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { border: 1px solid #ccc; padding: .4rem .5rem; vertical-align: top; text-align: left; }
  th { background: #f3f3f3; }
  pre { margin: 0; white-space: pre-wrap; }
  .warn { color: #a40000; font-weight: 600; }
  .muted { color: #666; }
  #status { margin-left: .5rem; }
</style>
</head>
<body>
<h1>Dead jobs</h1>
<p class="muted">These jobs used up their retries or hit a permanent error. A person must decide what to do.</p>
<label>Admin token <input id="token" type="password" autocomplete="off"></label>
<button id="load" type="button">Load</button>
<span id="status" role="status"></span>
<div id="out"></div>
<script src="/admin/dead.js"></script>
</body>
</html>
`;

export const ADMIN_PAGE_JS = `
(function () {
  var tokenInput = document.getElementById("token");
  var statusEl = document.getElementById("status");
  var out = document.getElementById("out");

  function el(tag, text, cls) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  }
  function headers() { return { "x-admin-token": tokenInput.value }; }
  function say(message) { statusEl.textContent = message; }
  var NO_SERVER = "Could not reach the server.";
  // fetch that never throws: a network failure gives null, and the caller says NO_SERVER.
  async function call(url, init) {
    try { return await fetch(url, init); } catch (e) { return null; }
  }
  // Times arrive as ISO strings in UTC. They are shown as "2026-10-05 00:31:12 UTC".
  function fmt(value) {
    if (value === undefined || value === null || value === "") return "(none)";
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toISOString().slice(0, 19).replace("T", " ") + " UTC";
  }
  function orNone(value) {
    return value === undefined || value === null || value === "" ? "(none)" : String(value);
  }

  // A manual re-fetch of the list, the same as pressing Load. There is no timer: nothing refreshes by itself.
  function addRefresh() {
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "Refresh";
    button.addEventListener("click", function () { load(); });
    out.appendChild(button);
  }

  async function load() {
    say("Loading...");
    var res = await call("/api/admin/dead-jobs", { headers: headers() });
    if (!res) { say(NO_SERVER); return; }
    if (res.status === 401) { say("Wrong or missing admin token."); out.textContent = ""; addRefresh(); return; }
    if (!res.ok) { say("Could not load (" + res.status + ")."); return; }
    var body = await res.json();
    render(body.jobs, typeof body.total === "number" ? body.total : body.jobs.length);
    say(body.jobs.length === 0 ? "No dead jobs." : "");
  }

  async function retry(job) {
    var question = "Retry job " + job.id + "?";
    if (job.sentState === "sending") {
      question =
        "WARNING: the outcome of the last try is UNKNOWN. If the email was in fact delivered, retrying sends a DUPLICATE. Search the Sent folder of the sending account for the reference " +
        job.jobRef + " first.\\n\\n" + question;
    }
    if (!window.confirm(question)) return;
    var res = await call("/api/admin/dead-jobs/" + encodeURIComponent(job.id) + "/retry", {
      method: "POST",
      headers: headers(),
    });
    if (!res) { say(NO_SERVER); return; }
    if (res.status === 409) say("That job is not dead any more.");
    else if (!res.ok) say("Retry failed (" + res.status + ").");
    else say("Job " + job.id + " is pending again.");
    await load();
  }

  async function markNotSent(job) {
    var question =
      "Only do this if you have checked the provider and the email for job " + job.id +
      " was NOT delivered.\\n\\nWARNING: marking it as not sent lets a retry send it again. If it was in fact delivered, this can send a DUPLICATE and the recipient gets it twice.\\n\\nMark as not sent?";
    if (!window.confirm(question)) return;
    var res = await call("/api/admin/dead-jobs/" + encodeURIComponent(job.id) + "/mark-not-sent", {
      method: "POST",
      headers: headers(),
    });
    if (!res) { say(NO_SERVER); return; }
    if (res.status === 409) say("Nothing to clear for that job any more.");
    else if (!res.ok) say("Could not mark as not sent (" + res.status + ").");
    else say("Job " + job.id + " marked as not sent. You can retry it now.");
    await load();
  }

  // What the operator has typed into each row's confirm box, so a reload of the list keeps it.
  var typedRefs = {};

  async function markSent(job) {
    // The confirm is typing the reference: no request goes out unless the text is exactly the reference.
    if (typedRefs[job.id] !== job.jobRef) return;
    var res = await call("/api/admin/dead-jobs/" + encodeURIComponent(job.id) + "/mark-sent", {
      method: "POST",
      headers: headers(),
    });
    if (!res) { say(NO_SERVER); return; }
    if (res.status === 409) say("Nothing to mark as sent for that job any more.");
    else if (!res.ok) say("Could not mark as sent (" + res.status + ").");
    else say("Job " + job.id + " marked as sent.");
    delete typedRefs[job.id];
    await load();
  }

  function render(jobs, total) {
    out.textContent = "";
    addRefresh();
    if (jobs.length === 0) { out.appendChild(el("p", "No dead jobs.")); return; }
    out.appendChild(el("p", "Showing " + jobs.length + " of " + total + " dead jobs", "muted"));
    var table = el("table");
    var head = el("tr");
    ["Job", "Created / Died", "Attempts", "Last error", "Email state", "Payload", "History", ""].forEach(function (h) {
      head.appendChild(el("th", h));
    });
    table.appendChild(head);
    jobs.forEach(function (job) {
      var row = el("tr");
      row.appendChild(el("td", job.id + " (" + job.type + ")"));
      var timeCell = el("td", "Created: " + fmt(job.createdAt));
      timeCell.appendChild(el("div", "Died: " + fmt(job.finishedAt)));
      row.appendChild(timeCell);
      row.appendChild(el("td", "attempts " + job.attempts + " of " + job.maxAttempts));
      row.appendChild(el("td", job.lastError));

      var stateCell = el("td", job.sentState === null ? "none" : job.sentState);
      stateCell.appendChild(el("div", "X-Job-Ref: " + job.jobRef, "muted"));
      if (job.sentState === "sending") {
        stateCell.appendChild(el("div", "Outcome UNKNOWN: check the provider before retrying.", "warn"));
        stateCell.appendChild(el("div", "Search the Sent folder of the sending account for this reference: " + job.jobRef, "muted"));
        stateCell.appendChild(el("div", "Retry and Mark as not sent can each send a duplicate if the email was in fact delivered.", "warn"));
      }
      row.appendChild(stateCell);

      var payloadCell = el("td");
      var p = job.payload && typeof job.payload === "object" ? job.payload : {};
      payloadCell.appendChild(el("div", "To: " + orNone(p.to)));
      payloadCell.appendChild(el("div", "Recipient hidden for privacy.", "muted"));
      payloadCell.appendChild(el("div", "Subject: " + orNone(p.subject)));
      payloadCell.appendChild(el("div", "Body (first 200 characters)" + (p.bodyTruncated ? ", cut short" : "") + ":", "muted"));
      payloadCell.appendChild(el("pre", orNone(p.body)));
      row.appendChild(payloadCell);

      var historyCell = el("td");
      job.attempts_history.forEach(function (a) {
        var line =
          "#" + a.attemptNo + " worker " + (a.workerId || "unknown") +
          " | started " + fmt(a.startedAt) + " | finished " + (a.finishedAt ? fmt(a.finishedAt) : "not finished") +
          " | " + (a.error || "ok");
        if (a.delayMs !== null) line += " (delay " + a.delayMs + " ms of bound " + a.backoffBoundMs + ")";
        historyCell.appendChild(el("div", line));
      });
      row.appendChild(historyCell);

      // Actions exist only while the job is dead. The server refuses them otherwise (409) as well.
      var actionCell = el("td");
      if (job.status === "dead") {
        var button = el("button", "Retry");
        button.type = "button";
        button.addEventListener("click", function () { retry(job); });
        actionCell.appendChild(button);
        actionCell.appendChild(el("div", "Retry: Puts the job back in the queue with a fresh allowance of attempts.", "muted"));
        if (job.sentState === "sending") {
          var clearButton = el("button", "Mark as not sent");
          clearButton.type = "button";
          clearButton.addEventListener("click", function () { markNotSent(job); });
          actionCell.appendChild(clearButton);
          actionCell.appendChild(el("div", "Mark not sent: Use only if you checked that the email was NOT sent. Retrying can send a duplicate.", "muted"));
          actionCell.appendChild(el("div", "Mark as sent: Use only if you checked the Sent folder and the email WAS sent. Type the reference to confirm.", "muted"));
          var refBox = el("input");
          refBox.type = "text";
          refBox.autocomplete = "off";
          refBox.value = typedRefs[job.id] || "";
          var sentButton = el("button", "Confirm mark as sent");
          sentButton.type = "button";
          var syncSent = function () { sentButton.disabled = refBox.value !== job.jobRef; };
          refBox.addEventListener("input", function () { typedRefs[job.id] = refBox.value; syncSent(); });
          sentButton.addEventListener("click", function () { markSent(job); });
          syncSent();
          actionCell.appendChild(refBox);
          actionCell.appendChild(sentButton);
        }
      }
      row.appendChild(actionCell);

      table.appendChild(row);
    });
    out.appendChild(table);
  }

  document.getElementById("load").addEventListener("click", load);
})();
`;
