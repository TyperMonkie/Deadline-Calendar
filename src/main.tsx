import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

type BootstrapState =
  | { status: "loading" }
  | { status: "preview" }
  | { status: "error"; message: string }
  | { status: "ready"; data: DesktopDataSnapshot | null };

function initialBootstrap(): BootstrapState {
  if (!window.ddlCalendar) {
    return location.protocol === "file:"
      ? { status: "error", message: "桌面数据接口未启动。请关闭程序后重新打开。" }
      : { status: "preview" };
  }
  try {
    const result = window.ddlCalendar.data.loadSync();
    return result?.ok ? { status: "ready", data: result.data } : { status: "loading" };
  } catch {
    return { status: "loading" };
  }
}

function DesktopBootstrap() {
  const [state, setState] = useState<BootstrapState>(initialBootstrap);

  useEffect(() => {
    if (state.status !== "loading") return;
    let cancelled = false;
    window.ddlCalendar?.data.load().then((result) => {
      if (cancelled) return;
      setState(result.ok
        ? { status: "ready", data: result.data }
        : { status: "error", message: result.error });
    }).catch((error) => {
      if (!cancelled) setState({
        status: "error",
        message: error instanceof Error ? error.message : "读取本地任务失败",
      });
    });
    return () => { cancelled = true; };
  }, [state.status]);

  if (state.status === "ready") return <App initialData={state.data} />;
  if (state.status === "preview") {
    return (
      <div className="bootstrap-screen">
        <div className="bootstrap-card preview-card" role="alert">
          <span className="bootstrap-mark">DDL</span>
          <h1>这里是临时预览页</h1>
          <p>网页预览不会读取或保存桌面日历。请从桌面或开始菜单打开“DDL Calendar”，你的任务保存在那里。</p>
          <strong>正式桌面版不会再与这个页面混用数据。</strong>
        </div>
      </div>
    );
  }
  return (
    <div className="bootstrap-screen">
      <div className="bootstrap-card" role={state.status === "error" ? "alert" : "status"}>
        <span className="bootstrap-mark">DDL</span>
        <h1>{state.status === "loading" ? "正在读取本地日历" : "本地日历暂时无法读取"}</h1>
        <p>{state.status === "loading"
          ? "正在确认已保存的任务，请稍候…"
          : `${state.message} 原始数据不会被空日历覆盖。`}</p>
        {state.status === "error" && <button onClick={() => setState({ status: "loading" })}>重新读取</button>}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DesktopBootstrap />
  </StrictMode>,
);
