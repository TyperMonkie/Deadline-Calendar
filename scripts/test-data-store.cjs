const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createDataStore } = require("../electron/data-store.cjs");

const syncState = { initialized: true, lastSyncedAt: null, lastMessageId: null, status: "idle" };
const task = (id) => ({ id, title: id, dueAt: "2026-10-10T23:59" });
const snapshot = (...ids) => ({ tasks: ids.map(task), syncState });

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ddl-calendar-store-test-"));
  return { directory, store: createDataStore(directory) };
}

test("新安装从空数据开始，首次保存后可读回", async () => {
  const { directory, store } = await fixture();
  assert.equal(store.loadSync().tasks.length, 0);
  await store.save(snapshot("one"));
  assert.equal(store.loadSync().tasks[0].id, "one");
  await fs.access(path.join(directory, "app-data.initialized"));
});

test("主文件损坏时读备份，两份都损坏时停止加载和保存", async () => {
  const { directory, store } = await fixture();
  await fs.writeFile(path.join(directory, "app-data.json"), "broken");
  await fs.writeFile(path.join(directory, "app-data.backup.json"), JSON.stringify(snapshot("backup")));
  assert.equal(store.loadSync().tasks[0].id, "backup");
  await fs.writeFile(path.join(directory, "app-data.json"), "broken again");
  await fs.writeFile(path.join(directory, "app-data.backup.json"), "also broken");
  assert.throws(() => store.loadSync(), /本地任务数据无法读取/);
  await assert.rejects(store.save(snapshot("new")), /本地任务数据无法读取/);
  assert.equal(await fs.readFile(path.join(directory, "app-data.json"), "utf8"), "broken again");
});

test("已有任务不会被意外空状态覆盖，明确删除最后一项可以保存", async () => {
  const { store } = await fixture();
  await store.save(snapshot("one"));
  await assert.rejects(store.save(snapshot()), /拒绝用空日历覆盖/);
  assert.equal(store.loadSync().tasks.length, 1);
  await store.save({ ...snapshot(), allowEmpty: true });
  assert.equal(store.loadSync().tasks.length, 0);
});

test("并发保存按请求顺序提交，备份保留前一份", async () => {
  const { directory, store } = await fixture();
  await Promise.all([
    store.save(snapshot("one")),
    store.save(snapshot("one", "two")),
    store.save(snapshot("one", "two", "three")),
  ]);
  assert.equal(store.loadSync().tasks.length, 3);
  const backup = JSON.parse(await fs.readFile(path.join(directory, "app-data.backup.json"), "utf8"));
  assert.equal(backup.tasks.length, 2);
});

test("曾经保存过的任务文件消失时不伪装成新安装", async () => {
  const { directory, store } = await fixture();
  await store.save(snapshot("one"));
  await fs.unlink(path.join(directory, "app-data.json"));
  assert.throws(() => store.loadSync(), /本地任务数据无法读取/);
});

test("从被 Windows 重定向的旧目录迁移最新数据，之后以固定目录为准", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ddl-calendar-migration-test-"));
  const canonical = path.join(root, "canonical");
  const redirected = path.join(root, "redirected-appdata");
  await fs.mkdir(canonical, { recursive: true });
  await fs.mkdir(redirected, { recursive: true });
  await fs.writeFile(path.join(canonical, "app-data.json"), JSON.stringify({
    ...snapshot(),
    savedAt: "2026-10-09T08:08:34.490Z",
  }));
  await fs.writeFile(path.join(redirected, "app-data.json"), JSON.stringify({
    ...snapshot("restored"),
    savedAt: "2026-10-09T10:08:40.184Z",
  }));

  const store = createDataStore(canonical, { legacyDirectories: [redirected] });
  assert.equal(store.loadSync().tasks[0].id, "restored");
  const migrated = JSON.parse(await fs.readFile(path.join(canonical, "app-data.json"), "utf8"));
  assert.equal(migrated.tasks[0].id, "restored");

  await store.save({ ...snapshot(), allowEmpty: true });
  assert.equal(store.loadSync().tasks.length, 0);
});
