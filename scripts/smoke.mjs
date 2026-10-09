import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});

const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto("http://localhost:1420", { waitUntil: "networkidle" });
await page.getByRole("button", { name: "设置" }).click();
if (!(await page.getByRole("heading", { name: "同步设置" }).isVisible())) {
  throw new Error("Connection settings dialog did not open");
}
await page.screenshot({ path: "ddl-calendar-settings-preview.png", fullPage: true });
await page.getByRole("button", { name: "关闭" }).click();
await page.getByRole("button", { name: "添加 DDL" }).click();
await page.getByLabel(/标题/).fill("第三周课后作业");
await page.getByLabel(/截止日期与时间/).fill("2026-10-12T23:59");
await page.getByLabel(/课程/).fill("交叉项目训练");
await page.getByLabel(/详细说明/).fill("完成卫星数据分析，并在网络学堂中提交作业文件。");
await page.screenshot({ path: "ddl-calendar-editor-preview.png", fullPage: true });
await page.getByRole("button", { name: "保存到日历" }).click();
await page.locator(".task-chip", { hasText: "第三周课后作业" }).click();
await page.screenshot({ path: "ddl-calendar-detail-preview.png", fullPage: true });

const detailVisible = await page.getByRole("heading", { name: "第三周课后作业" }).isVisible();
const deadlineVisible = await page.getByText("2026年10月12日").isVisible();
if (!detailVisible || !deadlineVisible) {
  throw new Error("Task detail smoke check failed");
}

await page.getByRole("button", { name: "关闭" }).click().catch(() => page.keyboard.press("Escape"));
await page.evaluate(() => {
  const key = "ddl-calendar.tasks.v1";
  const tasks = JSON.parse(localStorage.getItem(key) ?? "[]");
  const first = tasks[0];
  for (let index = 2; index <= 4; index += 1) {
    tasks.push({ ...first, id: `smoke-${index}`, title: `同日任务 ${index}` });
  }
  localStorage.setItem(key, JSON.stringify(tasks));
});
await page.reload({ waitUntil: "networkidle" });
if ((await page.locator(".task-chip").count()) !== 3) {
  throw new Error("Calendar should show at most three task chips per day");
}
if (!(await page.getByRole("button", { name: "还有 1 项" }).isVisible())) {
  throw new Error("Collapsed task counter is missing");
}

await browser.close();
console.log("Smoke test passed: settings, create, detail, and 3 + remaining task layout.");
