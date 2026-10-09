import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const username = process.env.DDL_MAIL_USER;
const password = process.env.DDL_MAIL_PASSWORD;
if (!username || !password) throw new Error("Mail credentials are required through environment variables");

const executable = "D:/文档/ChatGPT/New project 3/release-final/win-unpacked/DDL Calendar.exe";
const port = 9334;
const processHandle = spawn(executable, [`--remote-debugging-port=${port}`], {
  stdio: "ignore",
  windowsHide: true,
});

async function waitForDebugger() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
    } catch {
      // The desktop app is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Desktop app did not start in time");
}

try {
  await waitForDebugger();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes("index.html"));
  if (!page) throw new Error("DDL Calendar renderer was not found");
  const configured = await page.evaluate(
    ({ username, password }) => window.ddlCalendar.mail.configure({ username, password }),
    { username, password },
  );
  const sync = await page.evaluate(() => window.ddlCalendar.mail.sync());
  console.log(JSON.stringify({
    configured: configured.configured,
    baselineEstablished: configured.initialized,
    messages: configured.messages,
    latestUid: configured.latestUid,
    immediateSyncChecked: sync.checked,
    immediateSyncTasks: sync.tasks.length,
  }));
  await browser.close();
} finally {
  processHandle.kill();
}
