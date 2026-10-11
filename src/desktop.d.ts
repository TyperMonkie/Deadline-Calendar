export {};

import type { DeadlineTask, SyncState, TaskAttachment } from "./types";

declare global {
interface DesktopMailStatus {
  available: boolean;
  configured: boolean;
  needsReconnect: boolean;
  username: string;
  initialized: boolean;
  lastUid: number | null;
  lastSyncedAt: string | null;
}

interface MailConfigureResult {
  configured: boolean;
  initialized: boolean;
  latestUid: number;
  messages: number;
  lastSyncedAt: string;
  resumedFromExisting: boolean;
}

interface SyncedAssignment {
  uid: number;
  messageId: string;
  subject: string;
  course: string;
  title: string;
  link: string;
  receivedAt: string | null;
  attachments: TaskAttachment[];
}

interface AssignmentReadResult {
  ok: boolean;
  authRequired?: boolean;
  reason?: string;
  task?: SyncedAssignment & { dueAt: string; description: string; pageTitle: string };
}

interface AttachmentProgress {
  batchId: string;
  attachmentId: string;
  fileName: string;
  progress: number;
  overallProgress: number;
}

interface MailSyncResult {
  configured: boolean;
  initialized: boolean;
  checked?: number;
  latestUid?: number;
  lastSyncedAt?: string;
  tasks: Array<SyncedAssignment & { dueAt: string; description: string; pageTitle: string }>;
  pending: number;
  networkAuthRequired: boolean;
}

type DesktopDataSnapshot = { tasks: DeadlineTask[]; syncState: SyncState };
type DesktopDataLoadResult =
  | { ok: true; data: DesktopDataSnapshot }
  | { ok: false; error: string };

  interface Window {
    ddlCalendar?: {
      platform: "desktop";
      data: {
        loadSync: () => DesktopDataLoadResult;
        load: () => Promise<DesktopDataLoadResult>;
        save: (input: DesktopDataSnapshot & { allowEmpty?: boolean }) => Promise<{ saved: boolean }>;
      };
      mail: {
        getStatusSync: () => DesktopMailStatus;
        getStatus: () => Promise<DesktopMailStatus>;
        configure: (input: { username: string; password: string }) => Promise<MailConfigureResult>;
        sync: () => Promise<MailSyncResult>;
      };
      learn: {
        openLogin: () => Promise<{ opened: boolean }>;
        getStatus: () => Promise<{ authenticated: boolean }>;
        saveSession: () => Promise<{ saved: boolean; cookies: number }>;
        refreshAssignment: (input: Pick<DeadlineTask, "title" | "course" | "link"> & Partial<SyncedAssignment>) => Promise<AssignmentReadResult>;
        onAuthenticated: (callback: () => void) => () => void;
      };
      attachments: {
        download: (input: {
          batchId: string;
          title: string;
          course: string;
          link: string;
          attachments: TaskAttachment[];
        }) => Promise<{ downloaded: TaskAttachment[]; directory: string | null }>;
        exists: (filePath: string) => Promise<boolean>;
        open: (filePath: string) => Promise<{ opened: boolean }>;
        show: (filePath: string) => Promise<{ shown: boolean }>;
        onProgress: (callback: (progress: AttachmentProgress) => void) => () => void;
      };
    };
  }
}
