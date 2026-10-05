// Evidence helper: queues jobs through the real POST /api/jobs endpoint as user e2e-user.
// It holds no secret and does not load any test setup. It never prints a recipient address.
//
//   node scripts/e2e/enqueue.js one  <key>  <name>      one job, recipient <name>@example.test
//   node scripts/e2e/enqueue.js many <prefix> <count>   <count> jobs AT ONCE, keys <prefix>01..NN,
//                                                       recipients <prefix>NN@example.test
//
// The web server address is http://127.0.0.1:3200 unless E2E_BASE is set.
const BASE = process.env.E2E_BASE || "http://127.0.0.1:3200";
const [cmd, a, b] = process.argv.slice(2);

async function post(key, name) {
  const res = await fetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": "e2e-user" },
    body: JSON.stringify({
      type: "send_email",
      idempotencyKey: key,
      payload: { to: `${name}@example.test`, subject: `evidence ${key}`, body: `Evidence job ${key}.` },
    }),
  });
  const body = await res.json().catch(() => null);
  return { key, status: res.status, id: body && body.id };
}

async function main() {
  if (cmd === "one") {
    const r = await post(a, b);
    console.log(JSON.stringify(r));
    process.exitCode = r.status === 202 ? 0 : 1; // not process.exit(): it can trip a libuv assertion on Windows
    return;
  }
  if (cmd === "many") {
    const n = Number(b);
    const started = Date.now();
    const keys = Array.from({ length: n }, (_, i) => `${a}${String(i + 1).padStart(2, "0")}`);
    const results = await Promise.all(keys.map((k) => post(k, k))); // all requests in flight together
    const byStatus = {};
    for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    console.log(JSON.stringify({ requested: n, byStatus, millis: Date.now() - started }));
    process.exitCode = byStatus[202] === n ? 0 : 1;
    return;
  }
  console.log("usage: one <key> <name> | many <prefix> <count>");
  process.exitCode = 2;
}
main().catch((e) => {
  console.log("request failed: " + (e && e.code ? e.code : "error"));
  process.exitCode = 1;
});
