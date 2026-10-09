export type TaskSource = "manual" | "email";

export interface TaskAttachment {
  id: string;
  name: string;
  size: string;
  url: string;
  localPath?: string;
  downloadedAt?: string;
}

export interface DeadlineTask {
  id: string;
  title: string;
  course: string;
  dueAt: string;
  description: string;
  link: string;
  completed: boolean;
  source: TaskSource;
  color: string;
  createdAt: string;
  attachments?: TaskAttachment[];
}

export interface SyncState {
  initialized: boolean;
  lastSyncedAt: string | null;
  lastMessageId: string | null;
  status: "idle" | "syncing" | "success" | "error";
}

export type TaskDraft = Pick<
  DeadlineTask,
  "title" | "course" | "dueAt" | "description" | "link"
>;
