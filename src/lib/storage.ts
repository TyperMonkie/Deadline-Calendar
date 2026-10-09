import type { DeadlineTask, SyncState } from "../types";

const TASKS_KEY = "ddl-calendar.tasks.v1";
const SYNC_KEY = "ddl-calendar.sync.v1";

const defaultSyncState: SyncState = {
  initialized: false,
  lastSyncedAt: null,
  lastMessageId: null,
  status: "idle",
};

export function loadTasks(): DeadlineTask[] {
  try {
    const value = localStorage.getItem(TASKS_KEY);
    return value ? (JSON.parse(value) as DeadlineTask[]) : [];
  } catch {
    return [];
  }
}

export function saveTasks(tasks: DeadlineTask[]): void {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
}

export function loadSyncState(): SyncState {
  try {
    const value = localStorage.getItem(SYNC_KEY);
    return value ? { ...defaultSyncState, ...JSON.parse(value) } : defaultSyncState;
  } catch {
    return defaultSyncState;
  }
}

export function saveSyncState(state: SyncState): void {
  localStorage.setItem(SYNC_KEY, JSON.stringify(state));
}
