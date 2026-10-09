import tls from "node:tls";

const username = process.env.DDL_MAIL_USER;
const password = process.env.DDL_MAIL_PASSWORD;
const host = process.env.DDL_IMAP_HOST ?? "mails.tsinghua.edu.cn";

if (!username || !password) {
  throw new Error("DDL_MAIL_USER and DDL_MAIL_PASSWORD are required");
}

const socket = tls.connect({
  host,
  port: 993,
  servername: host,
  rejectUnauthorized: true,
});

let buffer = "";
let phase = "greeting";
let finished = false;

function quote(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function finish(result, code = 0) {
  if (finished) return;
  finished = true;
  console.log(JSON.stringify(result));
  socket.end();
  process.exitCode = code;
}

socket.setEncoding("utf8");
socket.setTimeout(12_000);
socket.on("secureConnect", () => {
  const cert = socket.getPeerCertificate();
  if (!socket.authorized) {
    finish({ connected: false, reason: socket.authorizationError }, 1);
    return;
  }
  if (!cert.subject) {
    finish({ connected: false, reason: "missing-certificate" }, 1);
  }
});

socket.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (phase === "greeting" && line.startsWith("* OK")) {
      phase = "login";
      socket.write(`A1 LOGIN ${quote(username)} ${quote(password)}\r\n`);
      continue;
    }
    if (phase === "login" && line.startsWith("A1 ")) {
      if (!line.startsWith("A1 OK")) {
        finish({ connected: true, authenticated: false, reason: "login-rejected", response: line }, 1);
        return;
      }
      phase = "examine";
      socket.write("A2 EXAMINE INBOX\r\n");
      continue;
    }
    if (phase === "examine" && line.startsWith("* ") && /EXISTS$/i.test(line)) {
      globalThis.messageCount = Number(line.match(/^\*\s+(\d+)\s+EXISTS/i)?.[1] ?? 0);
      continue;
    }
    if (phase === "examine" && /\[UIDNEXT\s+\d+\]/i.test(line)) {
      globalThis.uidNext = Number(line.match(/\[UIDNEXT\s+(\d+)\]/i)?.[1] ?? 0);
      continue;
    }
    if (phase === "examine" && line.startsWith("A2 ")) {
      if (!line.startsWith("A2 OK")) {
        finish({ connected: true, authenticated: true, examined: false }, 1);
        return;
      }
      phase = "search";
      socket.write("A3 UID SEARCH ALL\r\n");
      continue;
    }
    if (phase === "search" && line.startsWith("* SEARCH")) {
      const uids = line
        .slice("* SEARCH".length)
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter(Number.isFinite);
      globalThis.latestUid = uids.length ? Math.max(...uids) : 0;
      continue;
    }
    if (phase === "search" && line.startsWith("A3 ")) {
      if (!line.startsWith("A3 OK")) {
        finish({ connected: true, authenticated: true, examined: true, searched: false }, 1);
        return;
      }
      phase = "logout";
      socket.write("A4 LOGOUT\r\n");
      finish({
        connected: true,
        authenticated: true,
        examined: true,
        searched: true,
        latestUid: globalThis.latestUid ?? 0,
        messages: globalThis.messageCount ?? 0,
      });
      return;
    }
  }
});

socket.on("timeout", () => finish({ connected: false, reason: "timeout" }, 1));
socket.on("error", (error) => finish({ connected: false, reason: error.code ?? error.name }, 1));
