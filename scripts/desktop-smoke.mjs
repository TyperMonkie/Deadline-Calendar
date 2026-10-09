import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const executable = "D:/文档/ChatGPT/New project 3/release-final/win-unpacked/DDL Calendar.exe";
const port = 9333;
const processHandle = spawn(executable, [`--remote-debugging-port=${port}`], {
  stdio: "ignore",
  windowsHide: true,
});

async function waitForDebugger() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // The packaged app is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Packaged desktop app did not expose its renderer in time");
}

try {
  await waitForDebugger();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes("index.html"));
  if (!page) throw new Error("DDL Calendar renderer was not found");
  await page.waitForLoadState("domcontentloaded");

  const platform = await page.evaluate(() => window.ddlCalendar?.platform ?? null);
  if (platform !== "desktop") throw new Error("Desktop preload bridge is unavailable");
  const mailStatus = await page.evaluate(() => window.ddlCalendar.mail.getStatus());
  if (!mailStatus.available) throw new Error("Windows DPAPI encryption is unavailable");

  const debugState = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    body: document.body?.innerText?.slice(0, 300) ?? "",
    rootChildren: document.querySelector("#root")?.childElementCount ?? -1,
  }));
  if (debugState.rootChildren < 1) {
    throw new Error(`Packaged renderer is blank: ${JSON.stringify(debugState)}`);
  }

  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("heading", { name: "同步设置" }).waitFor();
  await page.screenshot({ path: "ddl-calendar-desktop-preview.png" });
  console.log("Desktop smoke test passed: packaged renderer, preload bridge, DPAPI, and settings UI.");
  await browser.close();
} finally {
  processHandle.kill();
}
