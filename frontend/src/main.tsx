import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  NavLink,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Activity,
  BookOpen,
  FlaskConical,
  Gauge,
  GitBranch,
  Layers3,
  Menu,
  Moon,
  Search,
  Sun,
  X,
} from "lucide-react";
import { api, Metrics, Stats } from "./api";
import {
  Overview,
  Pipeline,
  Explorer,
  Lab,
  Services,
  Insights,
  Documentation,
} from "./pages";
import "./styles.css";

document.documentElement.dataset.theme =
  localStorage.getItem("logweave-theme") === "dark" ? "dark" : "light";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 2000 } },
});
let sessionBootstrap: Promise<unknown> | undefined;
function bootstrapSession() {
  return (sessionBootstrap ??= api("/session"));
}
const nav = [
  { path: "/", label: "Overview", icon: Gauge },
  { path: "/pipeline", label: "Pipeline explorer", icon: GitBranch },
  { path: "/logs", label: "Log explorer", icon: Search },
  { path: "/lab", label: "System lab", icon: FlaskConical },
  { path: "/services", label: "Services", icon: Layers3 },
  { path: "/insights", label: "Insights", icon: Activity },
  { path: "/architecture", label: "Architecture", icon: BookOpen },
];
function LiveMetrics() {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let es: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout>;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      es = new EventSource("/api/metrics/stream");
      es.onopen = () => setConnected(true);
      es.onmessage = (e) => {
        try {
          qc.setQueryData(["metrics"], JSON.parse(e.data) as Metrics);
        } catch {}
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      es?.close();
    };
  }, [qc]);
  return connected;
}
function Shell() {
  const loc = useLocation();
  const connected = LiveMetrics();
  const [menu, setMenu] = useState(false);
  const [dark, setDark] = useState(
    () => localStorage.getItem("logweave-theme") === "dark",
  );
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeMenu = () => {
    setMenu(false);
    menuButton.current?.focus();
  };
  const { data: metrics } = useQuery({
    queryKey: ["metrics"],
    queryFn: () => api<Metrics>("/metrics"),
    refetchInterval: connected ? false : 3000,
  });
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: () => api<Stats>("/stats"),
    refetchInterval: 5000,
  });
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("logweave-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => setMenu(false), [loc.pathname]);
  useEffect(() => {
    if (!menu) return;
    closeButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [menu]);
  const title = nav.find((x) => x.path === loc.pathname)?.label || "Overview";
  return (
    <div className="app-shell">
      {menu && (
        <button
          className="menu-scrim"
          aria-label="Close navigation menu"
          onClick={closeMenu}
        />
      )}
      <aside className={"sidebar " + (menu ? "open" : "")}>
        <div className="brand">
          <div className="brand-symbol">
            <span />
            <span />
            <span />
          </div>
          <div>
            <strong>Distributed Log Aggregator &amp; Indexer</strong>
            <small>OBSERVABILITY WORKSTATION</small>
          </div>
          <button
            ref={closeButton}
            className="mobile-close icon-button"
            onClick={closeMenu}
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>
        <div className="workspace-tag">
          <span className="status-dot" /> Your simulation
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Primary navigation">
          {nav.map(({ path, label, icon: Icon }) => (
            <NavLink
              key={path}
              to={path}
              end={path === "/"}
              onClick={() => {
                if (menu) closeMenu();
              }}
              className={({ isActive }) =>
                "nav-item " + (isActive ? "active" : "")
              }
            >
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-system">
            <div className="sidebar-system-title">
              <span className={"status-dot " + (!connected ? "muted" : "")} />{" "}
              {connected ? "System connected" : "Reconnecting"}
            </div>
            <p>
              {metrics?.active_workers ?? 0} active workers ·{" "}
              {metrics?.queue_depth ?? 0} queued
            </p>
          </div>
          <button className="theme-toggle" onClick={() => setDark(!dark)}>
            {dark ? <Sun size={17} /> : <Moon size={17} />}{" "}
            {dark ? "Light appearance" : "Dark monitoring mode"}
          </button>
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <button
            ref={menuButton}
            className="mobile-menu icon-button"
            onClick={() => setMenu(true)}
            aria-label="Open menu"
            aria-expanded={menu}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            Workspace <span>/</span> <strong>{title}</strong>
          </div>
          <div className="topbar-right">
            <span className="live-pill">
              <span className={"status-dot " + (!connected ? "muted" : "")} />
              {connected ? "LIVE" : "OFFLINE"}
            </span>
            <span className="header-divider" />
            <span className="header-time">
              {new Date().toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </div>
        </header>
        <main>
          <Routes>
            <Route
              path="/"
              element={<Overview metrics={metrics} stats={stats} />}
            />
            <Route path="/pipeline" element={<Pipeline metrics={metrics} />} />
            <Route path="/logs" element={<Explorer />} />
            <Route path="/lab" element={<Lab metrics={metrics} />} />
            <Route path="/services" element={<Services />} />
            <Route
              path="/insights"
              element={<Insights metrics={metrics} stats={stats} />}
            />
            <Route path="/architecture" element={<Documentation />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
function SessionGate() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    bootstrapSession().then(
      () => mounted && setReady(true),
      (reason) =>
        mounted && setError(reason.message || "Could not start a simulation."),
    );
    return () => {
      mounted = false;
    };
  }, []);
  if (ready) return <Shell />;
  return (
    <div className="session-gate" role="status">
      <strong>
        {error ? "Simulation unavailable" : "Preparing your simulation…"}
      </strong>
      {error && <p>{error}</p>}
      {error && (
        <button
          className="button"
          onClick={() => {
            sessionBootstrap = undefined;
            setError("");
            bootstrapSession().then(
              () => setReady(true),
              (reason) => setError(reason.message),
            );
          }}
        >
          Try again
        </button>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionGate />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
