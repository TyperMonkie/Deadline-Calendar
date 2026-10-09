import { useEffect, useRef, useState } from "react";
import {
  Check,
  Download,
  Eye,
  File,
  FolderOpen,
  LoaderCircle,
  PartyPopper,
  RefreshCw,
} from "lucide-react";
import type { CSSProperties } from "react";
import type { DeadlineTask, TaskAttachment } from "../types";
import RopePull from "./RopePull";

type DownloadPhase = "idle" | "downloading" | "success" | "error";

interface AttachmentDownloaderProps {
  task: DeadlineTask;
  onUpdate: (task: DeadlineTask) => void;
  onToast: (message: string) => void;
  onAuthRequired: () => void;
}

const CONFETTI = Array.from({ length: 46 }, (_, index) => ({
  angle: Math.round((360 / 46) * index + ((index * 17) % 13)),
  distance: 82 + ((index * 29) % 92),
  delay: (index % 8) * 0.025,
  color: ["#8b7cf6", "#48dbc0", "#ff7195", "#ffc857", "#65a8ff", "#f4f0ff"][index % 6],
  rotate: (index * 71) % 360,
}));

function isLearnLink(value: string) {
  try {
    return new URL(value).hostname === "learn.tsinghua.edu.cn";
  } catch {
    return false;
  }
}

export default function AttachmentDownloader({ task, onUpdate, onToast, onAuthRequired }: AttachmentDownloaderProps) {
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<DownloadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [currentFile, setCurrentFile] = useState("");
  const [pullRatio, setPullRatio] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const activeBatch = useRef("");
  const attachments = task.attachments ?? [];

  useEffect(() => {
    setPhase("idle");
    setProgress(0);
    setPullRatio(0);
    setCurrentFile("");
    setError(null);
  }, [task.id]);

  useEffect(() => {
    if (!window.ddlCalendar?.attachments) return;
    const withLocalFiles = attachments.filter((attachment) => attachment.localPath);
    if (!withLocalFiles.length) return;
    let cancelled = false;
    void Promise.all(withLocalFiles.map(async (attachment) => ({
      id: attachment.id,
      exists: await window.ddlCalendar!.attachments.exists(attachment.localPath!),
    }))).then((checks) => {
      if (cancelled) return;
      const missing = new Set(checks.filter((check) => !check.exists).map((check) => check.id));
      if (!missing.size) return;
      onUpdate({
        ...task,
        attachments: attachments.map((attachment) => (
          missing.has(attachment.id) ? { ...attachment, localPath: undefined } : attachment
        )),
      });
    });
    return () => { cancelled = true; };
    // The audit intentionally runs once each time a task detail is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  useEffect(() => {
    if (!window.ddlCalendar?.attachments) return;
    return window.ddlCalendar.attachments.onProgress((event) => {
      if (event.batchId !== activeBatch.current) return;
      setProgress(event.overallProgress);
      setCurrentFile(event.fileName);
    });
  }, []);

  async function refreshAttachments(silent = false) {
    if (!window.ddlCalendar || !task.link || !isLearnLink(task.link)) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.ddlCalendar.learn.refreshAssignment({
        title: task.title,
        course: task.course,
        link: task.link,
      });
      if (result.ok && result.task) {
        const previousById = new Map((task.attachments ?? []).map((attachment) => [attachment.id, attachment]));
        const nextAttachments = result.task.attachments.map((attachment) => {
          const previous = previousById.get(attachment.id);
          return previous
            ? { ...attachment, localPath: previous.localPath, downloadedAt: previous.downloadedAt }
            : attachment;
        });
        onUpdate({
          ...task,
          dueAt: result.task.dueAt || task.dueAt,
          description: result.task.description || task.description,
          attachments: nextAttachments,
        });
        if (!silent) onToast(nextAttachments.length ? `已读取 ${nextAttachments.length} 个作业附件` : "这个作业没有附件");
      } else if (result.authRequired) {
        onAuthRequired();
        if (!silent) onToast("网络学堂登录已失效，请重新登录");
      } else if (!silent) {
        onToast("暂时无法读取附件，请稍后重试");
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "附件读取失败";
      setError(message);
      if (!silent) onToast(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (task.attachments !== undefined || !isLearnLink(task.link)) return;
    void refreshAttachments(true);
    // Only auto-refresh once for each newly opened task. Further refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  async function startDownload(selection: TaskAttachment[]) {
    if (!window.ddlCalendar?.attachments || phase === "downloading" || selection.length === 0) return;
    const batchId = crypto.randomUUID?.() ?? `download-${Date.now()}`;
    activeBatch.current = batchId;
    setPhase("downloading");
    setProgress(1);
    setPullRatio(1);
    setError(null);
    setCurrentFile(selection[0]?.name ?? "");
    try {
      const result = await window.ddlCalendar.attachments.download({
        batchId,
        title: task.title,
        course: task.course,
        link: task.link,
        attachments: selection,
      });
      const downloadedById = new Map(result.downloaded.map((attachment) => [attachment.id, attachment]));
      const downloadedByName = new Map(result.downloaded.map((attachment) => [attachment.name, attachment]));
      const merged = attachments.map((attachment) =>
        downloadedById.get(attachment.id) || downloadedByName.get(attachment.name) || attachment,
      );
      onUpdate({ ...task, attachments: merged });
      setProgress(100);
      setPhase("success");
      setCurrentFile("");
      window.setTimeout(() => setPullRatio(0), 520);
      onToast(result.downloaded.length === 1 ? "附件下载成功！" : `${result.downloaded.length} 个附件下载成功！`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "下载失败，请稍后重试";
      setPhase("error");
      setProgress(0);
      setPullRatio(0);
      setError(message);
      onToast(message);
      if (/登录/.test(message)) onAuthRequired();
    }
  }

  async function openFile(attachment: TaskAttachment) {
    if (!attachment.localPath || !window.ddlCalendar?.attachments) return;
    try {
      await window.ddlCalendar.attachments.open(attachment.localPath);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "无法打开文件";
      if (/移动或删除/.test(message)) {
        onUpdate({
          ...task,
          attachments: attachments.map((item) => item.id === attachment.id ? { ...item, localPath: undefined } : item),
        });
      }
      onToast(message);
    }
  }

  async function showFile(attachment: TaskAttachment) {
    if (!attachment.localPath || !window.ddlCalendar?.attachments) return;
    try {
      await window.ddlCalendar.attachments.show(attachment.localPath);
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : "无法定位文件");
    }
  }

  const fill = phase === "downloading" || phase === "success" ? progress : pullRatio * 13;
  const cardStyle = {
    "--fill": `${fill}%`,
    "--progress-ratio": String(progress / 100),
    "--shake": `${Math.max(0.25, (progress / 100) * 2.6)}px`,
    "--shake-speed": `${Math.max(0.075, 0.25 - (progress / 100) * 0.16)}s`,
  } as CSSProperties;

  return (
    <section className="attachment-zone">
      <div className="attachment-zone-heading">
        <div><span>ASSIGNMENT FILES</span><strong>作业附件</strong></div>
        {isLearnLink(task.link) && (
          <button className="attachment-refresh" disabled={loading || phase === "downloading"} onClick={() => void refreshAttachments()}>
            {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}刷新
          </button>
        )}
      </div>

      <div className={`attachment-card ${pullRatio > 0 ? "is-pulling" : ""} ${phase === "downloading" ? "is-downloading" : ""} ${phase === "success" ? "is-success" : ""}`} style={cardStyle}>
        <div className="download-water"><span /><span /></div>
        {phase === "success" && (
          <div className="confetti-burst" aria-hidden="true">
            {CONFETTI.map((piece, index) => (
              <i key={index} style={{
                "--angle": `${piece.angle}deg`,
                "--distance": `${piece.distance}px`,
                "--delay": `${piece.delay}s`,
                "--confetti": piece.color,
                "--rotate": `${piece.rotate}deg`,
              } as CSSProperties} />
            ))}
          </div>
        )}

        <div className="attachment-card-content">
          <div className="attachment-card-top">
            <div className="boring-badge">NORMAL MODE</div>
            <span>{attachments.length ? `${attachments.length} 个文件` : "没有文件"}</span>
          </div>

          {loading && attachments.length === 0 ? (
            <div className="attachment-loading"><LoaderCircle className="spin" size={18} />正在从网络学堂读取附件…</div>
          ) : attachments.length > 0 ? (
            <div className="attachment-list">
              {attachments.map((attachment) => (
                <div className="attachment-row" key={attachment.id}>
                  <span className={`attachment-file-icon ${attachment.localPath ? "ready" : ""}`}>
                    {attachment.localPath ? <Check size={15} /> : <File size={15} />}
                  </span>
                  <span className="attachment-copy">
                    <strong title={attachment.name}>{attachment.name}</strong>
                    <small>
                      {attachment.size || "未知大小"} · {attachment.localPath
                        ? "已下载 · 仍可再下一份"
                        : attachment.downloadedAt ? "下载过 · 本地文件已删除" : "等待下载"}
                    </small>
                  </span>
                  <span className="attachment-actions">
                    {attachment.localPath ? (
                      <>
                        <button onClick={() => void openFile(attachment)} title="使用默认应用打开"><Eye size={13} />预览</button>
                        <button className="icon-only" onClick={() => void showFile(attachment)} title="在文件夹中显示"><FolderOpen size={13} /></button>
                        <button disabled={phase === "downloading"} onClick={() => void startDownload([attachment])}><Download size={13} />再下一份</button>
                      </>
                    ) : (
                      <button disabled={phase === "downloading"} onClick={() => void startDownload([attachment])}><Download size={13} />下载</button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="attachment-empty"><File size={19} /><span>这个作业没有附带文件</span></div>
          )}

          {phase === "downloading" && (
            <div className="download-overlay-copy">
              <strong>{progress}%</strong><span>{currentFile ? `正在装载 ${currentFile}` : "正在装载附件"}</span>
            </div>
          )}
          {phase === "success" && (
            <div className="download-success-copy"><PartyPopper size={24} /><strong>下载成功！</strong><span>文件已稳稳落袋</span></div>
          )}
          {error && phase === "error" && <div className="attachment-error">{error}</div>}
        </div>
      </div>

      {attachments.length > 0 && (
        <div className="rope-console">
          <RopePull
            running={phase === "downloading"}
            progress={progress}
            onStretchChange={setPullRatio}
            onPull={() => void startDownload(attachments)}
          />
          <div className="rope-console-copy">
            <span>DOWNLOAD ROPE</span>
            <strong>下载绳</strong>
            <p>每次拉到底都会重新下载全部附件<br />已有文件会自动保留，不会被覆盖</p>
          </div>
        </div>
      )}
    </section>
  );
}
