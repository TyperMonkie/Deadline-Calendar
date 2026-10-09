const { app, BrowserWindow, ipcMain, net, safeStorage, session, shell } = require("electron");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { createDataStore } = require("./data-store.cjs");

const MAIL_HOST = "mails.tsinghua.edu.cn";
const MAIL_PORT = 993;
const LEARN_HOME = "https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/";
// The renderer is bundled locally and must never be restored from Chromium's
// disk cache. A stale renderer used the browser-only localStorage fallback,
// which made the calendar appear empty even while app-data.json was intact.
app.commandLine.appendSwitch("disable-http-cache");
app.setPath("userData", path.join(app.getPath("appData"), "ddl-calendar"));
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
let mainWindow;
let learnWindow;
let quittingAfterSessionSave = false;

// Windows redirects AppData for processes launched from packaged Microsoft Store
// apps. That previously gave Codex-launched and desktop-launched copies of this
// app two different files with the same apparent path. Keep authoritative user
// data outside redirected AppData and import the newest valid legacy copy once.
const persistentDataDirectory = path.join(app.getPath("home"), ".ddl-calendar");
const legacyDataDirectories = [app.getPath("userData")];
try {
  const packagesDirectory = path.join(app.getPath("home"), "AppData", "Local", "Packages");
  for (const entry of fsSync.readdirSync(packagesDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith("OpenAI.Codex_")) {
      legacyDataDirectories.push(path.join(
        packagesDirectory,
        entry.name,
        "LocalCache",
        "Roaming",
        "ddl-calendar",
      ));
    }
  }
} catch {
  // The normal desktop launch may not have a Codex package directory.
}
const uniqueLegacyDataDirectories = [...new Set(legacyDataDirectories.map((directory) => path.resolve(directory)))];
const dataStore = createDataStore(persistentDataDirectory, {
  legacyDirectories: uniqueLegacyDataDirectories,
});

function migratePersistentFile(fileName) {
  const destination = path.join(persistentDataDirectory, fileName);
  const candidates = [persistentDataDirectory, ...uniqueLegacyDataDirectories]
    .map((directory) => path.join(directory, fileName))
    .filter((candidate) => fsSync.existsSync(candidate));
  if (!candidates.length) return destination;
  const ranked = candidates.map((candidate) => {
    let timestamp = fsSync.statSync(candidate).mtimeMs;
    try {
      const stored = JSON.parse(fsSync.readFileSync(candidate, "utf8"));
      const embeddedTimestamp = Date.parse(stored.savedAt ?? stored.lastSyncedAt ?? "");
      if (Number.isFinite(embeddedTimestamp)) timestamp = embeddedTimestamp;
    } catch {
      // Keep the filesystem timestamp for encrypted or future-format files.
    }
    return { candidate, timestamp };
  }).sort((left, right) => right.timestamp - left.timestamp);
  if (path.resolve(ranked[0].candidate) !== path.resolve(destination)) {
    fsSync.mkdirSync(persistentDataDirectory, { recursive: true });
    fsSync.copyFileSync(ranked[0].candidate, destination);
  }
  return destination;
}

function appendStartupDiagnostic(event, details = {}) {
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      version: app.getVersion(),
      pid: process.pid,
      event,
      ...details,
    });
    fsSync.mkdirSync(persistentDataDirectory, { recursive: true });
    fsSync.appendFileSync(path.join(persistentDataDirectory, "startup-diagnostics.log"), `${line}\n`, "utf8");
  } catch {
    // Diagnostics must never prevent the calendar from starting.
  }
}

function configPath() {
  return migratePersistentFile("mail-config.json");
}

function learnSessionPath() {
  return migratePersistentFile("learn-session.json");
}

async function saveLearnSession() {
  if (!safeStorage.isEncryptionAvailable()) return { saved: false, cookies: 0 };
  const learnSession = session.fromPartition("persist:ddl-learn");
  const cookies = (await learnSession.cookies.get({})).filter((cookie) =>
    cookie.domain.replace(/^\./, "").endsWith("tsinghua.edu.cn"),
  );
  const encryptedCookies = safeStorage.encryptString(JSON.stringify(cookies)).toString("base64");
  await fs.mkdir(path.dirname(learnSessionPath()), { recursive: true });
  await fs.writeFile(
    learnSessionPath(),
    JSON.stringify({ encryptedCookies, savedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
  await learnSession.flushStorageData();
  return { saved: true, cookies: cookies.length };
}

async function restoreLearnSession() {
  if (!safeStorage.isEncryptionAvailable()) return { restored: false, cookies: 0 };
  try {
    const stored = JSON.parse(await fs.readFile(learnSessionPath(), "utf8"));
    const cookies = JSON.parse(
      safeStorage.decryptString(Buffer.from(stored.encryptedCookies, "base64")),
    );
    const learnSession = session.fromPartition("persist:ddl-learn");
    let restored = 0;
    for (const cookie of cookies) {
      const host = String(cookie.domain ?? "").replace(/^\./, "");
      if (!host.endsWith("tsinghua.edu.cn") || !cookie.name) continue;
      const details = {
        url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path || "/",
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
      };
      if (!cookie.hostOnly && cookie.domain) details.domain = cookie.domain;
      if (cookie.sameSite && cookie.sameSite !== "unspecified") details.sameSite = cookie.sameSite;
      if (cookie.expirationDate && cookie.expirationDate > Date.now() / 1000) {
        details.expirationDate = cookie.expirationDate;
      }
      await learnSession.cookies.set(details).catch(() => undefined);
      restored += 1;
    }
    return { restored: restored > 0, cookies: restored };
  } catch {
    return { restored: false, cookies: 0 };
  }
}

async function readMailConfig() {
  try {
    return JSON.parse(await fs.readFile(configPath(), "utf8"));
  } catch {
    return null;
  }
}

function readMailConfigSync() {
  try {
    return JSON.parse(fsSync.readFileSync(configPath(), "utf8"));
  } catch {
    return null;
  }
}

function mailStatusFromConfig(config) {
  return {
    available: safeStorage.isEncryptionAvailable(),
    configured: Boolean(config?.encryptedPassword && config?.username),
    username: config?.username ?? "",
    initialized: Boolean(config?.initialized),
    lastUid: config?.lastUid ?? null,
    lastSyncedAt: config?.lastSyncedAt ?? null,
  };
}

async function writeMailConfig(config) {
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2), "utf8");
}

function decryptPassword(config) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Windows 凭据加密当前不可用");
  }
  return safeStorage.decryptString(Buffer.from(config.encryptedPassword, "base64"));
}

function createImapClient(username, password) {
  return new ImapFlow({
    host: MAIL_HOST,
    port: MAIL_PORT,
    secure: true,
    logger: false,
    auth: { user: username, pass: password },
  });
}

async function withMailbox(username, password, callback) {
  const client = createImapClient(username, password);
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      return await callback(client);
    } finally {
      lock.release();
    }
  } finally {
    if (client.usable) await client.logout().catch(() => undefined);
  }
}

function latestUid(uids) {
  return uids.length ? Math.max(...uids) : 0;
}

function parseAssignmentMail(parsed, uid) {
  const body = `${parsed.text ?? ""}\n${parsed.html ?? ""}`
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&ldquo;|&rdquo;/g, "“")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

  if (!body.includes("有新布置的课程作业")) return null;
  const course = body.match(/你所学的[“\"](.+?)[”\"]课程/)?.[1]?.trim() ?? "";
  const title = body.match(/作业标题[：:]\s*[“\"](.+?)[”\"]/)?.[1]?.trim() ?? "";
  const link = body.match(/https?:\/\/learn\.tsinghua\.edu\.cn\/[^\s<>\")]+/)?.[0] ?? "";
  if (!title || !link) return null;

  return {
    uid,
    messageId: parsed.messageId ?? `uid:${uid}`,
    subject: parsed.subject ?? "",
    course,
    title,
    link,
    receivedAt: parsed.date?.toISOString() ?? null,
  };
}

function parseDeadlineFromText(text) {
  const normalized = text.replace(/\u00a0/g, " ");
  const patterns = [
    /(?:截止时间|截止日期|截止|结束时间)[^\d]{0,30}(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})[日\sT]*(\d{1,2})[:：](\d{2})/i,
    /(?:截止时间|截止日期|截止|结束时间)[^\d]{0,30}(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const [, year, month, day, hour = "23", minute = "59"] = match;
    const pad = (value) => String(value).padStart(2, "0");
    return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
  }
  return null;
}

function parseLastDateTimeFromText(text) {
  const matches = [...text.matchAll(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s+|T)(\d{1,2})[:：](\d{2})/g)];
  const match = matches.at(-1);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const pad = (value) => String(value).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

function parseDescriptionFromText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const start = lines.findIndex((line) => /^(?:作业说明|作业内容|作业要求|内容|说明)[：:]?$/i.test(line));
  if (start < 0) return "";
  const collected = [];
  for (const line of lines.slice(start + 1)) {
    if (/^(?:作业附件|答案说明|答案附件|发布对象|完成方式|截止时间|截止日期|补交截止时间|提交作业|已提交|附件|返回|评分)[：:]?/i.test(line)) break;
    collected.push(line);
    if (collected.join("\n").length > 2000) break;
  }
  return collected.join("\n").slice(0, 2000);
}

async function readLearnPage(reader, settleMs = 1200) {
  if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
  return reader.webContents.executeJavaScript(`({
    url: location.href,
    title: document.title,
    text: document.body ? document.body.innerText : ""
  })`);
}

function learnPageNeedsAuth(page) {
  return (
    page.url.includes("id.tsinghua.edu.cn") ||
    page.url.includes("/f/login") ||
    /未登录|登录失效|登录超时/.test(`${page.title}\n${page.text}`)
  );
}

async function loadLearnAssignment(assignment) {
  const partition = "persist:ddl-learn";
  const reader = new BrowserWindow({
    show: false,
    webPreferences: {
      partition,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try {
    await reader.loadURL(assignment.link);
    let page = await readLearnPage(reader);

    // The learning platform may keep its SSO cookie but discard the per-process
    // course session. Visiting /f/login silently rebuilds that session when the
    // SSO cookie is still valid, which makes restart-time synchronization reliable.
    if (learnPageNeedsAuth(page)) {
      await reader.loadURL("https://learn.tsinghua.edu.cn/f/login");
      let recovered = false;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const loginPage = await readLearnPage(reader, 500);
        if (!learnPageNeedsAuth(loginPage)) {
          recovered = true;
          break;
        }
      }
      if (!recovered) return { ok: false, authRequired: true };
      await reader.loadURL(assignment.link);
      page = await readLearnPage(reader);
    }
    if (learnPageNeedsAuth(page)) return { ok: false, authRequired: true };

    const row = await reader.webContents.executeJavaScript(`(() => {
      const wantedTitle = ${JSON.stringify(assignment.title)};
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const match = [...document.querySelectorAll("tr")].find((candidate) =>
        [...candidate.querySelectorAll("th,td")].some((cell) => normalize(cell.innerText) === wantedTitle)
      );
      if (!match) return null;
      const titleLink = [...match.querySelectorAll("a")].find((anchor) => normalize(anchor.innerText) === wantedTitle);
      return {
        text: match.innerText || "",
        detailUrl: titleLink ? titleLink.href : ""
      };
    })()`);

    let dueAt = parseDeadlineFromText(page.text) || parseLastDateTimeFromText(row?.text ?? "");
    let description = "";
    let pageTitle = page.title;
    let attachments = [];

    if (row?.detailUrl) {
      await reader.loadURL(row.detailUrl);
      const detailPage = await readLearnPage(reader);
      if (!learnPageNeedsAuth(detailPage)) {
        dueAt = parseDeadlineFromText(detailPage.text) || dueAt;
        description = parseDescriptionFromText(detailPage.text);
        pageTitle = detailPage.title;
        attachments = await reader.webContents.executeJavaScript(`(() => {
          const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
          const section = [...document.querySelectorAll(".list.fujian")].find((candidate) =>
            normalize(candidate.querySelector(".left")?.textContent) === "作业附件"
          );
          if (!section) return [];
          return [...section.querySelectorAll(".wdhere")].map((item, index) => {
            const nameLink = item.querySelector(".ftitle a");
            const downloadLink = [...item.querySelectorAll("a")].find((anchor) => normalize(anchor.textContent) === "下载");
            const name = normalize(nameLink?.textContent) || ("附件-" + (index + 1));
            const url = downloadLink?.href || nameLink?.href || "";
            let fileId = "";
            try { fileId = new URL(nameLink?.href || url).searchParams.get("fileId") || ""; } catch {}
            return {
              id: fileId || (name + "-" + index),
              name,
              size: normalize(item.querySelector(".color_999")?.textContent),
              url
            };
          }).filter((attachment) => attachment.url);
        })()`);
      }
    }

    if (!dueAt) return { ok: false, authRequired: false, reason: "deadline-not-found" };
    await saveLearnSession().catch(() => undefined);
    return {
      ok: true,
      task: {
        ...assignment,
        dueAt,
        description,
        pageTitle,
        attachments,
      },
    };
  } catch {
    return { ok: false, authRequired: false, reason: "page-load-failed" };
  } finally {
    if (!reader.isDestroyed()) reader.destroy();
  }
}

function sanitizePathSegment(value, fallback) {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 90);
  return cleaned || fallback;
}

function parseDisplaySize(value) {
  const match = String(value || "").trim().match(/^([\d.]+)\s*(B|K|KB|M|MB|G|GB)$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2].toUpperCase();
  const power = unit.startsWith("G") ? 3 : unit.startsWith("M") ? 2 : unit.startsWith("K") ? 1 : 0;
  return Math.round(amount * (1024 ** power));
}

function validateLearnDownloadUrl(value) {
  const parsed = new URL(String(value || ""));
  if (parsed.protocol !== "https:" || parsed.hostname !== "learn.tsinghua.edu.cn") {
    throw new Error("附件地址不是受信任的网络学堂链接");
  }
  return parsed.toString();
}

function downloadRoot() {
  return path.join(app.getPath("downloads"), "DDL Calendar");
}

function validateDownloadedPath(value) {
  const root = path.resolve(downloadRoot());
  const resolved = path.resolve(String(value || ""));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("文件不在 DDL Calendar 下载目录中");
  }
  return resolved;
}

async function uniqueDownloadPath(directory, requestedName) {
  const safeName = sanitizePathSegment(requestedName, "附件");
  const extension = path.extname(safeName);
  const stem = path.basename(safeName, extension);
  let candidate = path.join(directory, safeName);
  for (let suffix = 1; fsSync.existsSync(candidate); suffix += 1) {
    candidate = path.join(directory, `${stem} (${suffix})${extension}`);
  }
  return candidate;
}

async function streamLearnDownload({ event, batchId, attachment, index, count, url, referer, finalPath, learnSession }) {
  const temporaryPath = `${finalPath}.part`;
  await fs.unlink(temporaryPath).catch(() => undefined);
  return new Promise((resolve, reject) => {
    let settled = false;
    let loaded = 0;
    let total = parseDisplaySize(attachment.size);
    const writer = fsSync.createWriteStream(temporaryPath, { flags: "wx" });
    const request = net.request({
      method: "GET",
      url,
      session: learnSession,
      useSessionCookies: true,
      redirect: "follow",
    });
    if (referer) request.setHeader("Referer", referer);

    const finishWithError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.abort();
      writer.destroy();
      void fs.unlink(temporaryPath).catch(() => undefined);
      reject(error);
    };

    const timeout = setTimeout(() => finishWithError(new Error(`下载超时：${attachment.name}`)), 45000);
    request.on("error", (error) => finishWithError(error));
    writer.on("error", (error) => finishWithError(error));
    writer.on("finish", async () => {
      if (settled) return;
      try {
        await fs.rename(temporaryPath, finalPath);
        settled = true;
        clearTimeout(timeout);
        resolve({ loaded, total });
      } catch (error) {
        finishWithError(error);
      }
    });

    request.on("response", (response) => {
      const contentType = String(response.headers["content-type"] || "").toLowerCase();
      if (response.statusCode < 200 || response.statusCode >= 300 || contentType.includes("text/html")) {
        response.resume();
        finishWithError(new Error(`下载失败：${attachment.name}`));
        return;
      }
      total = Number(response.headers["content-length"]) || total;
      response.on("data", (chunk) => {
        loaded += chunk.length;
        const fileRatio = total > 0 ? Math.min(1, loaded / total) : 0.5;
        event.sender.send("attachments:progress", {
          batchId,
          attachmentId: attachment.id,
          fileName: attachment.name,
          progress: Math.round(fileRatio * 100),
          overallProgress: Math.round(((index + fileRatio) / count) * 100),
        });
        if (!writer.write(chunk)) response.pause();
      });
      writer.on("drain", () => response.resume());
      response.on("error", (error) => finishWithError(error));
      response.on("end", () => writer.end());
    });
    request.end();
  });
}

async function downloadTaskAttachments(event, input) {
  const requested = Array.isArray(input?.attachments) ? input.attachments : [];
  if (!requested.length) return { downloaded: [], directory: null };
  const batchId = String(input?.batchId || "");
  let available = requested;

  if (input?.link && input?.title) {
    const refreshed = await loadLearnAssignment({
      uid: 0,
      messageId: `download:${batchId}`,
      subject: "",
      course: String(input.course || ""),
      title: String(input.title),
      link: String(input.link),
      receivedAt: null,
    });
    if (refreshed.ok) {
      const freshById = new Map(refreshed.task.attachments.map((attachment) => [attachment.id, attachment]));
      const freshByName = new Map(refreshed.task.attachments.map((attachment) => [attachment.name, attachment]));
      available = requested.map((attachment) => freshById.get(attachment.id) || freshByName.get(attachment.name) || attachment);
    } else if (refreshed.authRequired) {
      throw new Error("网络学堂登录已失效，请重新登录后再下载");
    }
  }

  const directory = path.join(
    downloadRoot(),
    sanitizePathSegment(input?.course, "未分类"),
    sanitizePathSegment(input?.title, "未命名作业"),
  );
  await fs.mkdir(directory, { recursive: true });
  const learnSession = session.fromPartition("persist:ddl-learn");
  const downloaded = [];

  for (let index = 0; index < available.length; index += 1) {
    const attachment = available[index];
    const url = validateLearnDownloadUrl(attachment.url);
    const finalPath = await uniqueDownloadPath(directory, attachment.name);
    await streamLearnDownload({
      event,
      batchId,
      attachment,
      index,
      count: available.length,
      url,
      referer: input?.link ? String(input.link) : "",
      finalPath,
      learnSession,
    });
    downloaded.push({
      ...attachment,
      localPath: finalPath,
      downloadedAt: new Date().toISOString(),
    });
    event.sender.send("attachments:progress", {
      batchId,
      attachmentId: attachment.id,
      fileName: attachment.name,
      progress: 100,
      overallProgress: Math.round(((index + 1) / available.length) * 100),
    });
  }

  return { downloaded, directory };
}

ipcMain.handle("mail:get-status", async () => {
  const config = await readMailConfig();
  return mailStatusFromConfig(config);
});

ipcMain.handle("data:load", async () => {
  try { return { ok: true, data: await dataStore.load() }; }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle("data:save", async (_event, input) => dataStore.save(input));
ipcMain.on("data:load-sync", (event) => {
  try {
    const data = dataStore.loadSync();
    appendStartupDiagnostic("data-load-sync", { tasks: data.tasks.length });
    event.returnValue = { ok: true, data };
  }
  catch (error) {
    appendStartupDiagnostic("data-load-sync-error", { error: error.message });
    event.returnValue = { ok: false, error: error.message };
  }
});
ipcMain.on("mail:get-status-sync", (event) => { event.returnValue = mailStatusFromConfig(readMailConfigSync()); });

ipcMain.handle("mail:configure", async (_event, input) => {
  const username = String(input?.username ?? "").trim();
  const password = String(input?.password ?? "");
  if (!username || !password) throw new Error("请填写邮箱账号和客户端专用密码");
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 凭据加密当前不可用");

  const baseline = await withMailbox(username, password, async (client) => {
    const uids = await client.search({ all: true }, { uid: true });
    return {
      latestUid: latestUid(uids),
      messages: client.mailbox?.exists ?? uids.length,
    };
  });

  const config = {
    username,
    encryptedPassword: safeStorage.encryptString(password).toString("base64"),
    initialized: true,
    lastUid: baseline.latestUid,
    lastSyncedAt: new Date().toISOString(),
    pendingAssignments: [],
  };
  await writeMailConfig(config);
  return { configured: true, initialized: true, ...baseline, lastSyncedAt: config.lastSyncedAt };
});

ipcMain.handle("mail:sync", async () => {
  const config = await readMailConfig();
  if (!config?.initialized || !config?.encryptedPassword) {
    return { configured: false, initialized: false, tasks: [], pending: 0, networkAuthRequired: false };
  }

  const password = decryptPassword(config);
  const result = await withMailbox(config.username, password, async (client) => {
    const startUid = Number(config.lastUid ?? 0) + 1;
    const uids = await client.search({ uid: `${startUid}:*` }, { uid: true });
    const newUids = uids.filter((uid) => uid >= startUid);
    const assignments = [];

    if (newUids.length) {
      for await (const message of client.fetch(newUids, { uid: true, source: true }, { uid: true })) {
        if (!message.source) continue;
        const parsed = await simpleParser(message.source);
        const assignment = parseAssignmentMail(parsed, message.uid);
        if (assignment) assignments.push(assignment);
      }
    }

    return {
      checked: newUids.length,
      latestUid: newUids.length ? latestUid(newUids) : Number(config.lastUid ?? 0),
      assignments,
    };
  });

  const pendingById = new Map(
    [...(config.pendingAssignments ?? []), ...result.assignments].map((assignment) => [assignment.messageId, assignment]),
  );
  const completedTasks = [];
  const remainingAssignments = [];
  let networkAuthRequired = false;

  for (const assignment of pendingById.values()) {
    const extracted = await loadLearnAssignment(assignment);
    if (extracted.ok) completedTasks.push(extracted.task);
    else {
      remainingAssignments.push(assignment);
      networkAuthRequired ||= Boolean(extracted.authRequired);
    }
  }

  const nextConfig = {
    ...config,
    lastUid: result.latestUid,
    lastSyncedAt: new Date().toISOString(),
    pendingAssignments: remainingAssignments,
  };
  await writeMailConfig(nextConfig);
  return {
    configured: true,
    initialized: true,
    checked: result.checked,
    latestUid: result.latestUid,
    tasks: completedTasks,
    pending: remainingAssignments.length,
    networkAuthRequired,
    lastSyncedAt: nextConfig.lastSyncedAt,
  };
});

ipcMain.handle("learn:get-status", async () => {
  const learnSession = session.fromPartition("persist:ddl-learn");
  const [learnCookies, identityCookies] = await Promise.all([
    learnSession.cookies.get({ domain: "learn.tsinghua.edu.cn" }),
    learnSession.cookies.get({ domain: "id.tsinghua.edu.cn" }),
  ]);
  return { authenticated: learnCookies.length > 0 || identityCookies.length > 0 };
});

ipcMain.handle("learn:save-session", async () => saveLearnSession());

ipcMain.handle("learn:refresh-assignment", async (_event, input) => loadLearnAssignment({
  uid: Number(input?.uid || 0),
  messageId: String(input?.messageId || `refresh:${Date.now()}`),
  subject: String(input?.subject || ""),
  course: String(input?.course || ""),
  title: String(input?.title || ""),
  link: String(input?.link || ""),
  receivedAt: input?.receivedAt ?? null,
}));

ipcMain.handle("attachments:download", async (event, input) => downloadTaskAttachments(event, input));

ipcMain.handle("attachments:exists", async (_event, filePath) => {
  try {
    return fsSync.existsSync(validateDownloadedPath(filePath));
  } catch {
    return false;
  }
});

ipcMain.handle("attachments:open", async (_event, filePath) => {
  const resolved = validateDownloadedPath(filePath);
  if (!fsSync.existsSync(resolved)) throw new Error("文件已被移动或删除");
  const error = await shell.openPath(resolved);
  if (error) throw new Error(error);
  return { opened: true };
});

ipcMain.handle("attachments:show", async (_event, filePath) => {
  const resolved = validateDownloadedPath(filePath);
  if (!fsSync.existsSync(resolved)) throw new Error("文件已被移动或删除");
  shell.showItemInFolder(resolved);
  return { shown: true };
});

ipcMain.handle("learn:open-login", async () => {
  if (learnWindow && !learnWindow.isDestroyed()) {
    learnWindow.focus();
    return { opened: true };
  }
  learnWindow = new BrowserWindow({
    width: 980,
    height: 760,
    title: "登录清华网络学堂",
    parent: mainWindow,
    modal: false,
    webPreferences: {
      partition: "persist:ddl-learn",
      contextIsolation: true,
      sandbox: true,
    },
  });
  learnWindow.on("closed", () => {
    learnWindow = null;
    // A user may close the login window immediately after signing in, before
    // navigating away from the login URL. Persist the cookies in that case too.
    saveLearnSession().catch(() => undefined);
  });
  learnWindow.webContents.on("did-finish-load", async () => {
    const url = learnWindow?.webContents.getURL() ?? "";
    if (!url.startsWith("https://learn.tsinghua.edu.cn/") || url.includes("/f/login")) return;
    const pageState = await learnWindow.webContents.executeJavaScript(`({
      title: document.title,
      text: document.body ? document.body.innerText : ""
    })`).catch(() => ({ title: "", text: "" }));
    if (/未登录|登录失效|登录超时/.test(`${pageState.title}\n${pageState.text}`)) return;
    await saveLearnSession().catch(() => undefined);
    mainWindow?.webContents.send("learn:authenticated");
  });
  await learnWindow.loadURL(LEARN_HOME);
  return { opened: true };
});

function createWindow() {
  let verificationAttempts = 0;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: "#080a10",
    title: "DDL Calendar",
    icon: path.join(__dirname, "../src-tauri/icons/icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.on("did-finish-load", async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    verificationAttempts += 1;
    try {
      const diskData = dataStore.loadSync();
      const rendered = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
        const finishAt = Date.now() + 2500;
        const inspect = () => {
          const grid = document.querySelector('.calendar-grid');
          if (grid || Date.now() >= finishAt) {
            resolve({
              chips: document.querySelectorAll('.task-chip').length,
              pending: document.querySelector('.meta-item strong')?.textContent || '',
              url: location.href
            });
            return;
          }
          setTimeout(inspect, 50);
        };
        inspect();
      })`);
      appendStartupDiagnostic("renderer-verified", {
        attempt: verificationAttempts,
        diskTasks: diskData.tasks.length,
        renderedTasks: rendered.chips,
        pending: rendered.pending,
        url: rendered.url,
      });

      if (diskData.tasks.length > 0 && rendered.chips === 0 && verificationAttempts < 3) {
        const tasksJson = JSON.stringify(JSON.stringify(diskData.tasks));
        const syncJson = JSON.stringify(JSON.stringify(diskData.syncState));
        await mainWindow.webContents.executeJavaScript(`(() => {
          localStorage.setItem('ddl-calendar.tasks.v1', ${tasksJson});
          localStorage.setItem('ddl-calendar.sync.v1', ${syncJson});
        })()`);
        appendStartupDiagnostic("renderer-recovery-reload", {
          attempt: verificationAttempts,
          restoredTasks: diskData.tasks.length,
        });
        mainWindow.webContents.reloadIgnoringCache();
        return;
      }

      if (diskData.tasks.length > 0 && rendered.chips === 0) {
        throw new Error(`磁盘有 ${diskData.tasks.length} 项任务，但界面仍显示 0 项`);
      }
      mainWindow.show();
    } catch (error) {
      appendStartupDiagnostic("renderer-verification-error", {
        attempt: verificationAttempts,
        error: error.message,
      });
      mainWindow.show();
    }
  });
  if (process.argv.includes("--dev")) {
    mainWindow.loadURL("http://localhost:1420");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"), {
      query: { version: app.getVersion(), boot: String(Date.now()) },
    });
  }
}

app.whenReady().then(async () => {
  await session.defaultSession.clearCache().catch(() => undefined);
  await restoreLearnSession();
  const startupData = dataStore.loadSync();
  appendStartupDiagnostic("app-ready", {
    dataDirectory: persistentDataDirectory,
    chromiumDataDirectory: app.getPath("userData"),
    tasks: startupData.tasks.length,
    cacheDisabled: app.commandLine.hasSwitch("disable-http-cache"),
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on("window-all-closed", () => app.quit());

// Flush the authenticated learning-platform cookies before the process exits.
// This covers normal window closing, Windows shutdown, and desktop restarts.
app.on("before-quit", (event) => {
  if (quittingAfterSessionSave) return;
  event.preventDefault();
  quittingAfterSessionSave = true;
  saveLearnSession()
    .catch(() => undefined)
    .finally(() => app.quit());
});
