import { createServer, type Server, type Socket } from "node:net";

// A tiny scripted SMTP server for tests. It never leaves the machine.
// Each reply can be changed to simulate a refusal at that stage, a hang or a dropped connection.
export interface SmtpBehavior {
  greeting?: string | "silent"; // default "220 fake ESMTP". "silent": accept the connection, say nothing
  auth?: string; // default "235 2.7.0 ok"
  mail?: string; // default "250 ok"
  rcpt?: string | "hang"; // default "250 ok". "hang": never answer RCPT TO
  final?: string | "hang" | "drop"; // reply to the end of the message. default "250 2.0.0 queued"
}

export interface FakeSmtp {
  port: number;
  messages: string[]; // raw message data of every message the server received
  recipients: string[];
  close(): Promise<void>;
}

export async function startFakeSmtp(behavior: SmtpBehavior = {}): Promise<FakeSmtp> {
  const messages: string[] = [];
  const recipients: string[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const reply = (line: string) => socket.write(line + "\r\n");

    let inData = false;
    let data = "";
    let buffer = "";

    if (behavior.greeting === "silent") return; // connected, but the server never greets
    reply(behavior.greeting ?? "220 fake ESMTP");
    if (behavior.greeting?.startsWith("4") || behavior.greeting?.startsWith("5")) {
      setTimeout(() => socket.end(), 10);
      return;
    }

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push(data);
          const final = behavior.final ?? "250 2.0.0 queued";
          if (final === "hang") return; // the body arrived and the server says nothing
          if (final === "drop") {
            socket.destroy();
            return;
          }
          reply(final);
          continue;
        }
        const eol = buffer.indexOf("\r\n");
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          socket.write("250-fake\r\n250 AUTH PLAIN\r\n");
        } else if (upper.startsWith("AUTH")) {
          reply(behavior.auth ?? "235 2.7.0 ok");
        } else if (upper.startsWith("MAIL FROM")) {
          reply(behavior.mail ?? "250 ok");
        } else if (upper.startsWith("RCPT TO")) {
          const rcpt = behavior.rcpt ?? "250 ok";
          if (rcpt === "hang") continue;
          if (rcpt.startsWith("250")) recipients.push(line.slice(line.indexOf("<") + 1, line.indexOf(">")));
          reply(rcpt);
        } else if (upper === "DATA") {
          inData = true;
          reply("354 go ahead");
        } else if (upper === "QUIT") {
          reply("221 bye");
          socket.end();
        } else {
          reply("250 ok");
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    messages,
    recipients,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
