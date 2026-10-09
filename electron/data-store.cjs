const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const EMPTY_APP_DATA = Object.freeze({
  schemaVersion: 1,
  tasks: [],
  syncState: { initialized: false, lastSyncedAt: null, lastMessageId: null, status: "idle" },
});

function parseAppData(raw) {
  const stored = JSON.parse(raw);
  const validTasks = Array.isArray(stored?.tasks) && stored.tasks.every((task) =>
    task && typeof task.id === "string" && typeof task.title === "string" && typeof task.dueAt === "string",
  );
  if (!validTasks || !stored?.syncState || typeof stored.syncState !== "object") {
    throw new Error("任务数据格式不完整");
  }
  return stored;
}

function createDataStore(directory, options = {}) {
  const currentPath = path.join(directory, "app-data.json");
  const backupPath = path.join(directory, "app-data.backup.json");
  const markerPath = path.join(directory, "app-data.initialized");
  const legacyDirectories = [...new Set((options.legacyDirectories ?? [])
    .filter((candidate) => candidate && path.resolve(candidate) !== path.resolve(directory))
    .map((candidate) => path.resolve(candidate)))];
  let saveQueue = Promise.resolve();

  function writeSnapshotSync(snapshot) {
    fsSync.mkdirSync(directory, { recursive: true });
    fsSync.writeFileSync(markerPath, "initialized\n", { flag: "a" });
    const temporaryPath = `${currentPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    fsSync.writeFileSync(temporaryPath, JSON.stringify(snapshot, null, 2), "utf8");
    try {
      if (fsSync.existsSync(currentPath)) {
        parseAppData(fsSync.readFileSync(currentPath, "utf8"));
        fsSync.copyFileSync(currentPath, backupPath);
      }
    } catch {
      // Keep the previous valid backup if the canonical file cannot be read.
    }
    try {
      fsSync.renameSync(temporaryPath, currentPath);
    } catch {
      fsSync.copyFileSync(temporaryPath, currentPath);
      fsSync.unlinkSync(temporaryPath);
    }
  }

  function loadSync() {
    const failures = [];
    let foundFile = false;
    const candidates = [directory, ...legacyDirectories].flatMap((candidateDirectory, directoryIndex) => [
      { path: path.join(candidateDirectory, "app-data.json"), directoryIndex, fileIndex: 0 },
      { path: path.join(candidateDirectory, "app-data.backup.json"), directoryIndex, fileIndex: 1 },
    ]);
    const validSnapshots = [];
    for (const candidate of candidates) {
      if (!fsSync.existsSync(candidate.path)) continue;
      foundFile = true;
      try {
        const stored = parseAppData(fsSync.readFileSync(candidate.path, "utf8"));
        const savedAt = Date.parse(stored.savedAt ?? "");
        const modifiedAt = fsSync.statSync(candidate.path).mtimeMs;
        validSnapshots.push({
          ...candidate,
          stored,
          timestamp: Number.isFinite(savedAt) ? savedAt : modifiedAt,
        });
      } catch (error) {
        failures.push(`${candidate.path}: ${error.message}`);
      }
    }
    if (validSnapshots.length) {
      validSnapshots.sort((left, right) =>
        right.timestamp - left.timestamp
        || right.stored.tasks.length - left.stored.tasks.length
        || left.directoryIndex - right.directoryIndex
        || left.fileIndex - right.fileIndex,
      );
      const selected = validSnapshots[0];
      if (path.resolve(selected.path) !== path.resolve(currentPath)) {
        writeSnapshotSync(selected.stored);
      } else if (!fsSync.existsSync(markerPath)) {
        fsSync.mkdirSync(directory, { recursive: true });
        fsSync.writeFileSync(markerPath, "initialized\n", { flag: "a" });
      }
      return selected.stored;
    }
    const foundMarker = [directory, ...legacyDirectories]
      .some((candidateDirectory) => fsSync.existsSync(path.join(candidateDirectory, "app-data.initialized")));
    if (foundFile || foundMarker) {
      throw new Error(`本地任务数据无法读取；已停止加载，避免覆盖原文件。${failures.join(" | ")}`);
    }
    return EMPTY_APP_DATA;
  }

  async function saveOne(input) {
    const tasks = input?.tasks;
    const syncState = input?.syncState;
    if (!Array.isArray(tasks) || !syncState || typeof syncState !== "object") {
      throw new Error("无效的应用数据；未执行保存");
    }
    const existing = loadSync();
    if (existing.tasks.length && tasks.length === 0 && input.allowEmpty !== true) {
      throw new Error("拒绝用空日历覆盖已有任务；请重试或重新打开应用");
    }
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(markerPath, "initialized\n", { flag: "a" });
    const payload = JSON.stringify({ schemaVersion: 1, tasks, syncState, savedAt: new Date().toISOString() }, null, 2);
    const temporaryPath = `${currentPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(temporaryPath, payload, "utf8");
    try {
      parseAppData(await fs.readFile(currentPath, "utf8"));
      await fs.copyFile(currentPath, backupPath);
    } catch {
      // Keep the previous valid backup if the primary file cannot be read.
    }
    try {
      await fs.rename(temporaryPath, currentPath);
    } catch {
      await fs.copyFile(temporaryPath, currentPath);
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
    return { saved: true };
  }

  function save(input) {
    const pending = saveQueue.catch(() => undefined).then(() => saveOne(input));
    saveQueue = pending;
    return pending;
  }

  return { loadSync, load: async () => loadSync(), save };
}

module.exports = { createDataStore };
