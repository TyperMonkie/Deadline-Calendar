import { useEffect, useMemo, useRef, useState } from "react";
import {
  addMonths,
  format,
  isSameDay,
  isToday,
  parseISO,
  startOfMonth,
} from "date-fns";
import { zhCN } from "date-fns/locale";
import {
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock3,
  Cloud,
  Inbox,
  KeyRound,
  Link2,
  LoaderCircle,
  MailCheck,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Settings2,
  Sparkles,
  Trash2,
  Wifi,
  X,
} from "lucide-react";
import {
  courseColor,
  dayLabel,
  isOutsideMonth,
  monthDays,
  monthLabel,
  tasksForDay,
  urgency,
} from "./lib/calendar";
import { loadSyncState, loadTasks, saveSyncState, saveTasks } from "./lib/storage";
import type { DeadlineTask, SyncState, TaskDraft } from "./types";
import AttachmentDownloader from "./components/AttachmentDownloader";

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

const emptyDraft = (date = new Date()): TaskDraft => ({
  title: "",
  course: "",
  dueAt: format(date, "yyyy-MM-dd'T'23:59"),
  description: "",
  link: "",
});

const initialMailStatus = window.ddlCalendar?.mail.getStatusSync?.() ?? null;

function newId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function App({ initialData }: { initialData: DesktopDataSnapshot | null }) {
  const [tasks, setTasks] = useState<DeadlineTask[]>(() => initialData?.tasks ?? loadTasks());
  const [currentMonth, setCurrentMonth] = useState(() => startOfMonth(new Date()));
  const [hideCompleted, setHideCompleted] = useState(false);
  const [activeTask, setActiveTask] = useState<DeadlineTask | null>(null);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<DeadlineTask | null>(null);
  const [draft, setDraft] = useState<TaskDraft>(() => emptyDraft());
  const [query, setQuery] = useState("");
  const [syncState, setSyncState] = useState<SyncState>(() => initialData?.syncState ?? loadSyncState());
  const [toast, setToast] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mailStatus, setMailStatus] = useState<DesktopMailStatus | null>(initialMailStatus);
  const [learnAuthenticated, setLearnAuthenticated] = useState(false);
  const [mailForm, setMailForm] = useState({ username: initialMailStatus?.username ?? "", password: "" });
  const [mailSaving, setMailSaving] = useState(false);
  const [mailError, setMailError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const skipInitialSave = useRef(true);
  const allowEmptySave = useRef(false);
  const lastSaveAllowedEmpty = useRef(false);
  const tasksRef = useRef(tasks);
  const intentionallyEmptied = useRef(false);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    if (!window.ddlCalendar) return;
    let cancelled = false;

    const recoverFromDisk = async () => {
      if (cancelled || intentionallyEmptied.current || tasksRef.current.length > 0) return;
      try {
        const result = await window.ddlCalendar!.data.load();
        if (cancelled || !result.ok || result.data.tasks.length === 0 || tasksRef.current.length > 0) return;
        tasksRef.current = result.data.tasks;
        setTasks(result.data.tasks);
        setSyncState(result.data.syncState);
        setStorageError(null);
        setToast(`已从本地文件恢复 ${result.data.tasks.length} 项任务`);
      } catch {
        // Keep the existing error state; the disk copy is never overwritten here.
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void recoverFromDisk();
    };
    void recoverFromDisk();
    window.addEventListener("focus", recoverFromDisk);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", recoverFromDisk);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (skipInitialSave.current) {
      skipInitialSave.current = false;
      return;
    }
    if (window.ddlCalendar) {
      const allowEmpty = allowEmptySave.current;
      allowEmptySave.current = false;
      lastSaveAllowedEmpty.current = allowEmpty;
      void window.ddlCalendar.data.save({ tasks, syncState, allowEmpty })
        .then(() => setStorageError(null))
        .catch((error) => setStorageError(error instanceof Error ? error.message : "保存失败，请重试"));
    } else {
      try {
        saveTasks(tasks);
        saveSyncState(syncState);
        setStorageError(null);
      } catch (error) {
        setStorageError(error instanceof Error ? error.message : "保存失败，请重试");
      }
    }
  }, [syncState, tasks]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3400);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    if (!window.ddlCalendar) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    let attempts = 0;
    const loadStatus = async () => {
      try {
        const [mail, learn] = await Promise.all([
          window.ddlCalendar!.mail.getStatus(),
          window.ddlCalendar!.learn.getStatus(),
        ]);
        if (cancelled) return;
        setMailStatus(mail);
        setMailForm((value) => ({ ...value, username: mail.username }));
        setLearnAuthenticated(learn.authenticated);
      } catch {
        attempts += 1;
        if (!cancelled && attempts < 4) retryTimer = window.setTimeout(loadStatus, 800);
      }
    };
    void loadStatus();
    const removeAuthenticatedListener = window.ddlCalendar.learn.onAuthenticated(() => {
      setLearnAuthenticated(true);
      setToast("网络学堂登录成功，可以继续同步");
    });
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      removeAuthenticatedListener();
    };
  }, []);
  useEffect(() => {
    if (!window.ddlCalendar || !mailStatus?.configured) return;
    const lastSync = mailStatus.lastSyncedAt ? new Date(mailStatus.lastSyncedAt) : null;
    const now = new Date();
    const missedToday = !lastSync || lastSync.toDateString() !== now.toDateString();
    if (missedToday) void runSync();

    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0);
    let interval: number | undefined;
    const timeout = window.setTimeout(() => {
      void runSync();
      interval = window.setInterval(() => void runSync(), 24 * 60 * 60 * 1000);
    }, nextMidnight.getTime() - now.getTime());
    return () => {
      window.clearTimeout(timeout);
      if (interval) window.clearInterval(interval);
    };
  }, [mailStatus?.configured, mailStatus?.lastSyncedAt]);

  const visibleTasks = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return tasks.filter((task) => {
      if (hideCompleted && task.completed) return false;
      if (!needle) return true;
      return `${task.title} ${task.course} ${task.description}`.toLocaleLowerCase().includes(needle);
    });
  }, [hideCompleted, query, tasks]);

  const days = useMemo(() => monthDays(currentMonth), [currentMonth]);
  const monthTasks = visibleTasks.filter(
    (task) => format(parseISO(task.dueAt), "yyyy-MM") === format(currentMonth, "yyyy-MM"),
  );
  const pendingCount = monthTasks.filter((task) => !task.completed).length;
  const completedCount = monthTasks.filter((task) => task.completed).length;

  function openCreate(date = new Date()) {
    setEditingTask(null);
    setDraft(emptyDraft(date));
    setEditorOpen(true);
  }

  function openEdit(task: DeadlineTask) {
    setEditingTask(task);
    setDraft({
      title: task.title,
      course: task.course,
      dueAt: task.dueAt.slice(0, 16),
      description: task.description,
      link: task.link,
    });
    setActiveTask(null);
    setEditorOpen(true);
  }

  function saveDraft() {
    if (!draft.title.trim() || !draft.dueAt) return;
    if (editingTask) {
      setTasks((items) =>
        items.map((task) =>
          task.id === editingTask.id
            ? {
                ...task,
                ...draft,
                title: draft.title.trim(),
                course: draft.course.trim(),
                color: courseColor(draft.course.trim()),
              }
            : task,
        ),
      );
      setToast("任务已更新");
    } else {
      intentionallyEmptied.current = false;
      const task: DeadlineTask = {
        id: newId(),
        ...draft,
        title: draft.title.trim(),
        course: draft.course.trim(),
        completed: false,
        source: "manual",
        color: courseColor(draft.course.trim()),
        createdAt: new Date().toISOString(),
      };
      setTasks((items) => [...items, task]);
      setCurrentMonth(startOfMonth(parseISO(task.dueAt)));
      setToast("DDL 已加入日历");
    }
    setEditorOpen(false);
  }

  function toggleCompleted(task: DeadlineTask) {
    const completed = !task.completed;
    setTasks((items) => items.map((item) => (item.id === task.id ? { ...item, completed } : item)));
    setActiveTask((item) => (item?.id === task.id ? { ...item, completed } : item));
    setToast(completed ? "已标记为完成" : "已恢复为待完成");
  }

  function updateTask(task: DeadlineTask) {
    setTasks((items) => items.map((item) => (item.id === task.id ? task : item)));
    setActiveTask((item) => (item?.id === task.id ? task : item));
  }

  function deleteTask(task: DeadlineTask) {
    setTasks((items) => {
      const next = items.filter((item) => item.id !== task.id);
      if (items.length > 0 && next.length === 0) {
        allowEmptySave.current = true;
        intentionallyEmptied.current = true;
      }
      return next;
    });
    setActiveTask(null);
    setToast("任务已删除");
  }

  async function runSync() {
    if (syncState.status === "syncing") return;
    if (!window.ddlCalendar) {
      setToast("邮箱同步仅在 Windows 桌面版中启用");
      return;
    }
    const status = await window.ddlCalendar.mail.getStatus();
    setMailStatus(status);
    if (!status.configured) {
      setSettingsOpen(true);
      setToast(status.needsReconnect ? "请重新输入一次邮箱客户端专用密码，原同步进度会保留" : "请先连接清华邮箱");
      return;
    }
    setSyncState((state) => ({ ...state, status: "syncing" }));
    try {
      const result = await window.ddlCalendar.mail.sync();
      const lastSyncedAt = result.lastSyncedAt ?? new Date().toISOString();
      setSyncState((state) => ({ ...state, initialized: true, lastSyncedAt, status: "success" }));
      setMailStatus(await window.ddlCalendar.mail.getStatus());
      if (result.tasks.length) {
        intentionallyEmptied.current = false;
        const imported: DeadlineTask[] = result.tasks.map((task) => ({
          id: `email-${task.uid}`,
          title: task.title,
          course: task.course,
          dueAt: task.dueAt,
          description: task.description,
          link: task.link,
          completed: false,
          source: "email",
          color: courseColor(task.course),
          createdAt: task.receivedAt ?? new Date().toISOString(),
          attachments: task.attachments,
        }));
        setTasks((current) => {
          const existingIds = new Set(current.map((task) => task.id));
          return [...current, ...imported.filter((task) => !existingIds.has(task.id))];
        });
        setToast(`已自动加入 ${result.tasks.length} 项新作业`);
      } else if (result.networkAuthRequired) {
        setSettingsOpen(true);
        setToast(`有 ${result.pending} 项作业等待网络学堂登录后补全`);
      } else if (result.pending) {
        setToast(`有 ${result.pending} 项作业暂未识别出截止时间，下次同步会重试`);
      } else if (result.checked) {
        setToast(`检查了 ${result.checked} 封新邮件，没有发现作业通知`);
      } else {
        setToast("已经是最新状态，没有新邮件");
      }
    } catch (error) {
      setSyncState((state) => ({ ...state, status: "error" }));
      setToast(error instanceof Error ? error.message : "同步失败，请检查邮箱连接");
    }
  }

  async function configureMail() {
    if (!window.ddlCalendar || !mailForm.username.trim() || !mailForm.password) return;
    setMailSaving(true);
    setMailError(null);
    try {
      const result = await window.ddlCalendar.mail.configure(mailForm);
      const status = await window.ddlCalendar.mail.getStatus();
      setMailStatus(status);
      setMailForm((value) => ({ ...value, password: "" }));
      setSyncState((state) => ({ ...state, initialized: true, lastSyncedAt: result.lastSyncedAt, status: "success" }));
      setToast(result.resumedFromExisting
        ? "邮箱连接已恢复，将从上次同步进度继续检查"
        : `邮箱连接成功，已从第 ${result.latestUid} 封邮件之后开始监听`);
    } catch (error) {
      setMailError(error instanceof Error ? error.message : "连接失败，请检查账号和客户端专用密码");
    } finally {
      setMailSaving(false);
    }
  }

  async function openLearnLogin() {
    if (!window.ddlCalendar) {
      setToast("网络学堂登录仅在 Windows 桌面版中启用");
      return;
    }
    await window.ddlCalendar.learn.openLogin();
    setToast("请在弹出的窗口中完成网络学堂二次认证");
  }

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><CalendarDays size={19} /></div>
          <div>
            <div className="brand-name">DDL Calendar</div>
            <div className="brand-subtitle">让每个截止日期都有迹可循</div>
          </div>
        </div>

        <div className="topbar-actions">
          <label className="search-box">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索任务或课程"
            />
            {query && <button onClick={() => setQuery("")} aria-label="清除搜索"><X size={14} /></button>}
          </label>
          <button className="icon-button" title="设置" aria-label="设置" onClick={() => setSettingsOpen(true)}><Settings2 size={18} /></button>
          <button className="sync-button" onClick={runSync}>
            {syncState.status === "syncing" ? <LoaderCircle className="spin" size={17} /> : <Cloud size={17} />}
            {syncState.status === "syncing" ? "同步中" : "立即同步"}
          </button>
          <button className="primary-button" onClick={() => openCreate()}><Plus size={18} />添加 DDL</button>
        </div>
      </header>

      {storageError && (
        <div className="storage-alert" role="alert">
          <span>本地数据尚未保存：{storageError}</span>
          <button onClick={() => {
            if (!window.ddlCalendar) return;
            void window.ddlCalendar.data.save({ tasks, syncState, allowEmpty: lastSaveAllowedEmpty.current })
              .then(() => setStorageError(null))
              .catch((error) => setStorageError(error instanceof Error ? error.message : "保存失败，请重试"));
          }}>重试保存</button>
        </div>
      )}

      <main className="workspace">
        <section className="calendar-panel">
          <div className="calendar-toolbar">
            <div className="month-navigation">
              <button className="nav-button" onClick={() => setCurrentMonth((month) => addMonths(month, -1))} aria-label="上个月"><ChevronLeft /></button>
              <h1>{monthLabel(currentMonth)}</h1>
              <button className="nav-button" onClick={() => setCurrentMonth((month) => addMonths(month, 1))} aria-label="下个月"><ChevronRight /></button>
              <button className="today-button" onClick={() => setCurrentMonth(startOfMonth(new Date()))}>今天</button>
            </div>

            <div className="calendar-meta">
              <div className="meta-item"><span className="meta-dot pending" />待完成 <strong>{pendingCount}</strong></div>
              <div className="meta-item"><span className="meta-dot done" />已完成 <strong>{completedCount}</strong></div>
              <label className="switch-label">
                <input type="checkbox" checked={hideCompleted} onChange={(event) => setHideCompleted(event.target.checked)} />
                <span className="switch" />隐藏已完成
              </label>
            </div>
          </div>

          <div className="calendar-card">
            <div className="weekday-row">
              {WEEKDAYS.map((weekday, index) => <div className={index > 4 ? "weekend" : ""} key={weekday}>{weekday}</div>)}
            </div>
            <div className="calendar-grid">
              {days.map((day) => {
                const dayTasks = tasksForDay(visibleTasks, day);
                const outside = isOutsideMonth(day, currentMonth);
                return (
                  <div
                    className={`day-cell ${outside ? "outside" : ""} ${isToday(day) ? "is-today" : ""}`}
                    key={day.toISOString()}
                    onDoubleClick={() => openCreate(day)}
                  >
                    <div className="day-head">
                      <button className="day-number" onClick={() => setSelectedDay(day)}>{format(day, "d")}</button>
                      {dayTasks.length > 0 && <span className="day-count">{dayTasks.length}</span>}
                      <button className="quick-add" onClick={() => openCreate(day)} aria-label={`在${format(day, "M月d日")}添加任务`}><Plus size={14} /></button>
                    </div>
                    <div className="task-stack">
                      {dayTasks.slice(0, 3).map((task) => (
                        <button
                          key={task.id}
                          className={`task-chip ${task.completed ? "completed" : ""} urgency-${urgency(task)}`}
                          style={{ "--task-color": task.color } as React.CSSProperties}
                          onClick={() => setActiveTask(task)}
                        >
                          <span className="task-color" />
                          <span className="task-chip-title">{task.title}</span>
                          <span className="task-time">{format(parseISO(task.dueAt), "HH:mm")}</span>
                        </button>
                      ))}
                      {dayTasks.length > 3 && (
                        <button className="more-tasks" onClick={() => setSelectedDay(day)}>
                          <MoreHorizontal size={14} />还有 {dayTasks.length - 3} 项
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="calendar-tip"><Sparkles size={14} />双击日期可快速创建 DDL</div>
        </section>

        <aside className="side-panel">
          <div className="side-card next-card">
            <div className="side-card-title"><span>同步中心</span><span className={`status-badge ${mailStatus?.configured ? "connected" : "testing"}`}>{mailStatus?.configured ? "已连接" : mailStatus?.needsReconnect ? "需重连" : "待连接"}</span></div>
            <div className="sync-illustration"><MailCheck size={26} /><span className="sync-ring" /></div>
            <h3>{mailStatus?.configured ? "清华邮箱已连接" : mailStatus?.needsReconnect ? "邮箱凭据需要重新连接" : "连接邮箱以开始同步"}</h3>
            <p>{mailStatus?.configured
              ? "只读取上次同步之后的新邮件，不回溯历史内容。"
              : mailStatus?.needsReconnect
                ? "重新输入客户端专用密码后，会从原来的同步位置继续检查。"
                : "邮箱首次连接只建立同步起点，之后仅识别新邮件。"}</p>
            <div className="sync-foot"><Inbox size={14} />{mailStatus?.needsReconnect ? "同步起点已安全保留" : "不会扫描历史邮件"}</div>
          </div>

          <div className="side-card">
            <div className="side-card-title"><span>近期 DDL</span><button onClick={() => setCurrentMonth(startOfMonth(new Date()))}>回到本月</button></div>
            <div className="upcoming-list">
              {visibleTasks.filter((task) => !task.completed && new Date(task.dueAt) >= new Date()).sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, 4).map((task) => (
                <button key={task.id} className="upcoming-item" onClick={() => setActiveTask(task)}>
                  <span className="upcoming-date"><strong>{format(parseISO(task.dueAt), "dd")}</strong>{format(parseISO(task.dueAt), "M月")}</span>
                  <span className="upcoming-copy"><strong>{task.title}</strong><small>{task.course || "未分类"}</small></span>
                  <ChevronRight size={15} />
                </button>
              ))}
              {visibleTasks.filter((task) => !task.completed && new Date(task.dueAt) >= new Date()).length === 0 && (
                <div className="empty-upcoming"><CheckCircle2 size={25} /><span>近期没有待完成任务</span></div>
              )}
            </div>
          </div>
        </aside>
      </main>

      {editorOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setEditorOpen(false)}>
          <section className="modal editor-modal">
            <div className="modal-header">
              <div><span className="eyebrow">{editingTask ? "EDIT DEADLINE" : "NEW DEADLINE"}</span><h2>{editingTask ? "编辑 DDL" : "添加一个 DDL"}</h2></div>
              <button className="close-button" onClick={() => setEditorOpen(false)}><X /></button>
            </div>
            <div className="form-grid">
              <label className="field full"><span>标题 <b>*</b></span><input autoFocus value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="例如：第三周课后作业" /></label>
              <label className="field"><span>截止日期与时间 <b>*</b></span><input type="datetime-local" value={draft.dueAt} onChange={(event) => setDraft({ ...draft, dueAt: event.target.value })} /></label>
              <label className="field"><span>课程 / 分类</span><input value={draft.course} onChange={(event) => setDraft({ ...draft, course: event.target.value })} placeholder="例如：交叉项目训练" /></label>
              <label className="field full"><span>详细说明</span><textarea rows={5} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="任务要求、提交方式或备忘……" /></label>
              <label className="field full"><span>相关链接</span><div className="input-with-icon"><Link2 size={16} /><input type="url" value={draft.link} onChange={(event) => setDraft({ ...draft, link: event.target.value })} placeholder="https://" /></div></label>
            </div>
            <div className="modal-footer"><button className="ghost-button" onClick={() => setEditorOpen(false)}>取消</button><button className="primary-button" disabled={!draft.title.trim() || !draft.dueAt} onClick={saveDraft}><Check size={17} />保存到日历</button></div>
          </section>
        </div>
      )}

      {activeTask && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setActiveTask(null)}>
          <section className="modal detail-modal" style={{ "--task-color": activeTask.color } as React.CSSProperties}>
            <div className="detail-accent" />
            <div className="modal-header detail-header">
              <div><span className="source-pill">{activeTask.source === "email" ? "邮件识别" : "手动添加"}</span><h2>{activeTask.title}</h2><p>{activeTask.course || "未分类"}</p></div>
              <button className="close-button" onClick={() => setActiveTask(null)}><X /></button>
            </div>
            <div className="detail-time"><CalendarDays size={18} /><div><small>截止时间</small><strong>{format(parseISO(activeTask.dueAt), "yyyy年M月d日 EEEE HH:mm", { locale: zhCN })}</strong></div></div>
            <div className="detail-description"><small>任务内容</small><p>{activeTask.description || "没有填写详细说明。"}</p></div>
            {activeTask.link && <a className="detail-link" href={activeTask.link} target="_blank" rel="noreferrer"><Link2 size={16} />打开相关页面<ArrowUpRight size={15} /></a>}
            <AttachmentDownloader
              task={activeTask}
              onUpdate={updateTask}
              onToast={setToast}
              onAuthRequired={() => {
                setSettingsOpen(true);
                setToast("请重新登录网络学堂后再读取或下载附件");
              }}
            />
            <div className="modal-footer detail-actions"><button className="delete-button" onClick={() => deleteTask(activeTask)}><Trash2 size={16} />删除</button><span /><button className="ghost-button" onClick={() => openEdit(activeTask)}><Pencil size={16} />编辑</button><button className={activeTask.completed ? "ghost-button" : "primary-button"} onClick={() => toggleCompleted(activeTask)}>{activeTask.completed ? <RotateCcw size={16} /> : <CheckCircle2 size={16} />}{activeTask.completed ? "恢复任务" : "标记完成"}</button></div>
          </section>
        </div>
      )}

      {selectedDay && (
        <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSelectedDay(null)}>
          <aside className="day-drawer">
            <div className="drawer-header"><div><span className="eyebrow">DAILY OVERVIEW</span><h2>{dayLabel(selectedDay)}</h2></div><button className="close-button" onClick={() => setSelectedDay(null)}><X /></button></div>
            <div className="drawer-task-list">
              {tasksForDay(visibleTasks, selectedDay).map((task) => (
                <button key={task.id} className={`drawer-task ${task.completed ? "completed" : ""}`} onClick={() => { setSelectedDay(null); setActiveTask(task); }}>
                  <span className="drawer-check">{task.completed ? <Check size={15} /> : <Circle size={15} />}</span>
                  <span><strong>{task.title}</strong><small>{task.course || "未分类"} · {format(parseISO(task.dueAt), "HH:mm")}</small></span>
                  <ChevronRight size={16} />
                </button>
              ))}
              {tasksForDay(visibleTasks, selectedDay).length === 0 && <div className="drawer-empty"><CalendarDays size={28} /><p>这一天还没有 DDL</p></div>}
            </div>
            <button className="drawer-add" onClick={() => { const day = selectedDay; setSelectedDay(null); openCreate(day); }}><Plus size={17} />添加这一天的 DDL</button>
          </aside>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSettingsOpen(false)}>
          <section className="modal settings-modal">
            <div className="modal-header">
              <div><span className="eyebrow">CONNECTIONS</span><h2>同步设置</h2></div>
              <button className="close-button" onClick={() => setSettingsOpen(false)} aria-label="关闭"><X /></button>
            </div>

            <div className="settings-content">
              <section className="connection-card">
                <div className="connection-head">
                  <span className="connection-icon mail"><Mail size={19} /></span>
                  <div><h3>清华邮箱</h3><p>通过只读 IMAP 检查新作业通知</p></div>
                  <span className={`connection-state ${mailStatus?.configured ? "ok" : ""}`}><span />{mailStatus?.configured ? "已连接" : mailStatus?.needsReconnect ? "需重新连接" : "未连接"}</span>
                </div>
                <div className="connection-form">
                  <label className="field"><span>邮箱账号</span><input value={mailForm.username} onChange={(event) => setMailForm({ ...mailForm, username: event.target.value })} placeholder="name@mails.tsinghua.edu.cn" /></label>
                  <label className="field"><span>客户端专用密码</span><div className="input-with-icon"><KeyRound size={16} /><input type="password" value={mailForm.password} onChange={(event) => setMailForm({ ...mailForm, password: event.target.value })} placeholder={mailStatus?.configured || mailStatus?.needsReconnect ? "输入专用密码以重新连接" : "在邮箱安全设置中生成"} /></div></label>
                  {mailStatus?.needsReconnect && <div className="form-error">旧凭据来自另一运行环境，当前 Windows 无法解密。同步起点和待处理邮件均已保留。</div>}
                  {mailError && <div className="form-error">{mailError}</div>}
                  <div className="security-note"><ShieldCheck size={15} /><span>专用密码使用 Windows DPAPI 加密，只保存在这台电脑中。</span></div>
                  <button className="connect-button" disabled={mailSaving || !mailForm.username.trim() || !mailForm.password} onClick={configureMail}>{mailSaving ? <LoaderCircle className="spin" size={16} /> : <Wifi size={16} />}{mailSaving ? "正在验证" : mailStatus?.needsReconnect ? "重新连接并保留进度" : mailStatus?.configured ? "重新连接" : "连接并建立同步起点"}</button>
                </div>
              </section>

              <section className="connection-card">
                <div className="connection-head">
                  <span className="connection-icon learn"><CalendarDays size={19} /></span>
                  <div><h3>网络学堂</h3><p>读取作业说明和准确截止时间</p></div>
                  <span className={`connection-state ${learnAuthenticated ? "ok" : ""}`}><span />{learnAuthenticated ? "已登录" : "需要认证"}</span>
                </div>
                <div className="learn-login-copy">
                  <p>首次使用需要完成学校的二次认证。应用会保留登录会话，后续自动打开作业链接。</p>
                  <button className="ghost-button" onClick={openLearnLogin}><ArrowUpRight size={16} />打开登录窗口</button>
                </div>
              </section>
            </div>
          </section>
        </div>
      )}

      {toast && <div className="toast"><CheckCircle2 size={17} />{toast}</div>}
    </div>
  );
}

export default App;
