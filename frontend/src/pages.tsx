import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type NodeProps,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Database,
  FileJson,
  Pause,
  Play,
  RotateCcw,
  Search,
  Server,
  Settings2,
  ShieldAlert,
  Square,
  Upload,
  Workflow,
  Zap,
} from "lucide-react";
import {
  api,
  post,
  qs,
  type Log,
  type Metrics,
  type Service,
  type Stats,
} from "./api";

const fmt = (n: number | undefined) =>
  n === undefined ? "—" : new Intl.NumberFormat().format(n);
const time = (s: string | undefined) =>
  s ? new Date(s).toLocaleString() : "—";
function Header({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action && <div className="heading-action">{action}</div>}
    </div>
  );
}
function State({
  error,
  loading,
  empty,
}: {
  error?: unknown;
  loading?: boolean;
  empty?: string;
}) {
  return (
    <div className="state">
      {error ? (
        <>
          <CircleAlert size={20} />
          <span>
            {error instanceof Error
              ? error.message
              : "Unable to load data. Check the backend connection."}
          </span>
        </>
      ) : loading ? (
        "Loading data…"
      ) : (
        empty
      )}
    </div>
  );
}
function Metric({
  label,
  value,
  unit,
  detail,
  emphasis,
}: {
  label: string;
  value: string | number;
  unit?: string;
  detail?: string;
  emphasis?: boolean;
}) {
  return (
    <div className={"metric " + (emphasis ? "metric-emphasis" : "")}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">
        {value}
        <span>{unit}</span>
      </div>
      {detail && <div className="metric-detail">{detail}</div>}
    </div>
  );
}
function useHistory(metrics?: Metrics) {
  const [history, setHistory] = useState<
    {
      time: string;
      received: number;
      indexed: number;
      queue: number;
      errors: number;
    }[]
  >([]);
  useEffect(() => {
    if (metrics)
      setHistory((prev) => [
        ...prev.slice(-59),
        {
          time: new Date(metrics.timestamp * 1000).toLocaleTimeString(),
          received: metrics.received_rate,
          indexed: metrics.indexed_rate,
          queue: metrics.queue_depth,
          errors: metrics.errors,
        },
      ]);
  }, [
    metrics?.timestamp,
    metrics?.received_rate,
    metrics?.indexed_rate,
    metrics?.queue_depth,
    metrics?.errors,
  ]);
  return history;
}
function Throughput({
  history,
}: {
  history: {
    time: string;
    received: number;
    indexed: number;
    queue: number;
    errors: number;
  }[];
}) {
  return history.length ? (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart
        data={history}
        margin={{ top: 12, right: 8, bottom: 0, left: -25 }}
      >
        <defs>
          <linearGradient id="ingestFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#147f76" stopOpacity=".24" />
            <stop offset="100%" stopColor="#147f76" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="indexFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e3803e" stopOpacity=".17" />
            <stop offset="100%" stopColor="#e3803e" stopOpacity="0" />
          </linearGradient>
        </defs>
        <CartesianGrid
          vertical={false}
          stroke="var(--line)"
          strokeDasharray="3 5"
        />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          minTickGap={30}
        />
        <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
        <Tooltip
          contentStyle={{
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: 8,
          }}
        />
        <Area
          type="monotone"
          dataKey="received"
          stroke="#147f76"
          strokeWidth={2}
          fill="url(#ingestFill)"
          name="Ingested /s"
        />
        <Area
          type="monotone"
          dataKey="indexed"
          stroke="#e3803e"
          strokeWidth={2}
          fill="url(#indexFill)"
          name="Indexed /s"
        />
      </AreaChart>
    </ResponsiveContainer>
  ) : (
    <div className="chart-empty">Waiting for live telemetry</div>
  );
}
export function Overview({
  metrics,
  stats,
}: {
  metrics?: Metrics;
  stats?: Stats;
}) {
  const history = useHistory(metrics);
  const isReceiving = (metrics?.received_rate ?? 0) > 0;
  const {
    data: logs,
    isLoading: logsLoading,
    error: logsError,
  } = useQuery({
    queryKey: ["recent"],
    queryFn: () => api<{ items: Log[] }>("/logs?limit=5"),
    refetchInterval: 3000,
  });
  return (
    <>
      <Header
        title="System overview"
        description="Follow every event from ingestion to search, as it happens."
        action={
          <Link className="button primary" to="/lab">
            <Zap size={16} /> Open system lab <ArrowUpRight size={15} />
          </Link>
        }
      />
      <div className="overview-intro">
        <div className="intro-copy">
          <h2>
            Logs in motion.
            <br />
            <em>Every step visible.</em>
          </h2>
          <p>
            {isReceiving
              ? "Traffic is flowing through the pipeline. Watch the queue and indexers respond in real time."
              : "Your pipeline is ready. Start a traffic run to see ingestion, indexing, and search come to life."}
          </p>
          <Link to="/pipeline" className="inline-link">
            Explore the pipeline <ArrowRight size={16} />
          </Link>
        </div>
        <div className="intro-visual">
          <div className="visual-head">
            <strong>Event path</strong>
            <span
              className={isReceiving ? "visual-state live" : "visual-state"}
            >
              <span
                className={isReceiving ? "status-dot" : "status-dot muted"}
              />
              {isReceiving ? "Flowing" : "Ready"}
            </span>
          </div>
          <ol className="flow-list">
            <li className="flow-step">
              <span className="step-icon">
                <Server size={18} />
              </span>
              <span className="step-copy">
                <strong>Sources + tailer</strong>
                <small>Files and generated traffic</small>
              </span>
              <span className="step-measure">
                <strong>
                  {fmt(metrics?.received_rate)}
                  <small>/sec</small>
                </strong>
              </span>
            </li>
            <li className="flow-step">
              <span className="step-icon stream">
                <Workflow size={18} />
              </span>
              <span className="step-copy">
                <strong>Redis Stream</strong>
                <small>Waiting to be indexed</small>
              </span>
              <span className="step-measure">
                <strong>{fmt(metrics?.queue_depth)}</strong>
                <small>queued</small>
              </span>
            </li>
            <li className="flow-step">
              <span className="step-icon">
                <Settings2 size={18} />
              </span>
              <span className="step-copy">
                <strong>Indexers</strong>
                <small>Consumer group</small>
              </span>
              <span className="step-measure">
                <strong>{fmt(metrics?.active_workers)}</strong>
                <small>active</small>
              </span>
            </li>
            <li className="flow-step">
              <span className="step-icon">
                <Database size={18} />
              </span>
              <span className="step-copy">
                <strong>PostgreSQL shards</strong>
                <small>Distributed search index</small>
              </span>
              <span className="step-measure">
                <strong>{fmt(metrics?.indexed)}</strong>
                <small>indexed</small>
              </span>
            </li>
          </ol>
          <div className="visual-footer">
            <span className={isReceiving ? "status-dot" : "status-dot muted"} />
            {isReceiving
              ? "Processing live traffic"
              : "Standing by for traffic"}
          </div>
        </div>
      </div>
      <div className="metrics-strip">
        <Metric
          label="Logs received"
          value={fmt(metrics?.received)}
          detail="Accepted by ingestion"
        />
        <Metric
          label="Logs indexed"
          value={fmt(metrics?.indexed)}
          detail="Searchable across index shards"
        />
        <Metric
          label="Queue backlog"
          value={fmt(metrics?.queue_depth)}
          detail="Waiting in Redis Stream"
          emphasis={!!metrics?.queue_depth}
        />
        <Metric
          label="Active workers"
          value={fmt(metrics?.active_workers)}
          detail={
            metrics?.workers_paused
              ? "Processing paused"
              : "Consumer group online"
          }
        />
      </div>
      <div className="overview-health">
        <span>
          <span className="status-dot" /> System health{" "}
          <strong>
            {!metrics
              ? "Checking"
              : metrics.active_workers > 0 && !metrics.workers_paused
                ? "Operational"
                : "Attention needed"}
          </strong>
        </span>
        <span>
          Active services <strong>{stats?.active_services ?? "—"}</strong>
        </span>
        <span>
          Error logs{" "}
          <strong>
            {!stats
              ? "—"
              : stats.stored
                ? `${((stats.error_logs / stats.stored) * 100).toFixed(1)}%`
                : "0.0%"}
          </strong>
        </span>
      </div>
      <div className="dashboard-grid">
        <section className="panel throughput-panel">
          <div className="panel-head">
            <div>
              <h3>Pipeline throughput</h3>
              <p>Ingestion and indexing, events per second</p>
            </div>
            <span className="small-live">
              <span className="status-dot" /> Live
            </span>
          </div>
          <div className="chart-wrap">
            <Throughput history={history} />
          </div>
          <div className="chart-legend">
            <span>
              <i className="legend-dot teal" /> Ingested
            </span>
            <span>
              <i className="legend-dot orange" /> Indexed
            </span>
          </div>
        </section>
        <section className="panel pulse-panel">
          <div className="panel-head">
            <div>
              <h3>System pulse</h3>
              <p>Current operating conditions</p>
            </div>
          </div>
          <div className="pulse-row">
            <div>
              <span className="pulse-icon teal-bg">
                <ArrowDown size={17} />
              </span>
              <span>Ingestion rate</span>
            </div>
            <strong>
              {metrics?.received_rate ?? "—"}
              <small> / sec</small>
            </strong>
          </div>
          <div className="pulse-row">
            <div>
              <span className="pulse-icon orange-bg">
                <ArrowDown size={17} />
              </span>
              <span>Indexing rate</span>
            </div>
            <strong>
              {metrics?.indexed_rate ?? "—"}
              <small> / sec</small>
            </strong>
          </div>
          <div className="pulse-row">
            <div>
              <span className="pulse-icon neutral-bg">
                <Clock3 size={17} />
              </span>
              <span>Avg. processing</span>
            </div>
            <strong>
              {metrics?.avg_processing_ms ?? "—"}
              <small> ms</small>
            </strong>
          </div>
          <div className="pulse-row">
            <div>
              <span className="pulse-icon red-bg">
                <ShieldAlert size={17} />
              </span>
              <span>Processing errors</span>
            </div>
            <strong>{fmt(metrics?.errors)}</strong>
          </div>
          <div className="pulse-foot">
            {!metrics
              ? "Awaiting live metrics."
              : metrics.queue_depth
                ? metrics.queue_depth > metrics.indexed_rate * 5
                  ? "Backlog is elevated. Check worker capacity."
                  : "Events are waiting to be indexed."
                : "Queue is clear. All accepted events are processed."}
          </div>
        </section>
      </div>
      <section className="panel recent-panel">
        <div className="panel-head">
          <div>
            <h3>Recent indexed events</h3>
            <p>The latest searchable logs across services</p>
          </div>
          <Link to="/logs" className="inline-link">
            View all logs <ArrowRight size={15} />
          </Link>
        </div>
        {logsLoading || logsError ? (
          <State loading={logsLoading} error={logsError} />
        ) : logs?.items.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>TIME</th>
                  <th>SEVERITY</th>
                  <th>SERVICE</th>
                  <th>MESSAGE</th>
                </tr>
              </thead>
              <tbody>
                {logs.items.map((log) => (
                  <tr key={log.event_id}>
                    <td className="mono">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </td>
                    <td>
                      <SeverityBadge level={log.severity} />
                    </td>
                    <td>{log.service}</td>
                    <td className="message-cell">{log.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <State empty="No indexed logs yet. Start traffic in the System lab." />
        )}
      </section>
    </>
  );
}
function SeverityBadge({ level }: { level: string }) {
  return (
    <span className={"severity severity-" + level.toLowerCase()}>{level}</span>
  );
}
const componentInfo: Record<
  string,
  { name: string; purpose: string; detail: string }
> = {
  sources: {
    name: "Log sources",
    purpose: "Real file tailer and five demo services",
    detail:
      "A checkpointed daemon tails real JSON or plaintext files. Authentication, payments, gateway, database, and notifications also produce structured demo traffic.",
  },
  collector: {
    name: "Ingestion API",
    purpose: "Validation and acceptance",
    detail:
      "FastAPI validates each event with Pydantic, stamps a received time, and publishes accepted JSON to Redis Streams. Invalid input receives an explicit error.",
  },
  redis: {
    name: "Redis Stream",
    purpose: "Durable handoff and buffering",
    detail:
      "The stream buffers accepted events and assigns them to the indexers consumer group. Entries remain until indexing succeeds and the worker acknowledges them.",
  },
  workers: {
    name: "Indexer workers",
    purpose: "Distributed normalization and indexing",
    detail:
      "Independent worker replicas consume batches. A worker reclaims abandoned pending entries; unique event IDs keep retries idempotent.",
  },
  database: {
    name: "PostgreSQL shards",
    purpose: "Distributed indexed event storage",
    detail:
      "Workers hash each event onto one physical shard. Every log_events table has B-tree filters and a generated tsvector with GIN full-text search.",
  },
  search: {
    name: "Search API",
    purpose: "Queryable logs and statistics",
    detail:
      "FastAPI queries every shard concurrently, merges globally ordered pages, and serves filters, summaries, and event detail.",
  },
};
type FlowData = {
  label: string;
  subtitle: string;
  value: string;
  status: string;
  kind: string;
};
function ComponentNode({ data, selected }: NodeProps<Node<FlowData>>) {
  return (
    <div className={"flow-node " + (selected ? "selected" : "")}>
      <Handle
        type="target"
        position={
          data.kind === "workers"
            ? Position.Top
            : data.kind === "database" || data.kind === "search"
              ? Position.Right
              : Position.Left
        }
      />
      <div className="node-top">
        <span className={"node-icon " + data.kind}>
          <Workflow size={18} />
        </span>
        <span
          className={
            "node-status " +
            (data.status === "paused" ||
            data.status === "stopped" ||
            data.status === "offline"
              ? "paused"
              : "")
          }
        />
      </div>
      <strong>{data.label}</strong>
      <small>{data.subtitle}</small>
      <div className="node-metric">
        <b>{data.value}</b>
        <span>{data.status}</span>
      </div>
      <Handle
        type="source"
        position={
          data.kind === "redis"
            ? Position.Bottom
            : data.kind === "workers" || data.kind === "database"
              ? Position.Left
              : Position.Right
        }
      />
    </div>
  );
}
const nodeTypes = { component: ComponentNode };
export function Pipeline({ metrics }: { metrics?: Metrics }) {
  const [selected, setSelected] = useState("redis");
  const { data: health } = useQuery({
    queryKey: ["component-health"],
    queryFn: () =>
      api<{ api: boolean; redis: boolean; postgres: boolean }>(
        "/system/health",
      ),
    refetchInterval: 5000,
  });
  const { data: shardState } = useQuery({
    queryKey: ["shard-health"],
    queryFn: () =>
      api<{ count: number; shards: { healthy: boolean; events: number | null }[] }>(
        "/system/shards",
      ),
    refetchInterval: 5000,
  });
  const nodes: Node<FlowData>[] = [
    [
      "sources",
      "Sources + tailer",
      "Files and demo services",
      `${metrics?.generator.status === "running" ? metrics.generator.rate : 0} /s`,
      metrics?.generator.status ?? "stopped",
      0,
      20,
    ],
    [
      "collector",
      "Collectors",
      "FastAPI ingestion",
      `${metrics?.received_rate ?? "—"} /s`,
      health?.api ? "healthy" : "offline",
      300,
      20,
    ],
    [
      "redis",
      "Redis Stream",
      "Consumer group",
      `${metrics?.queue_depth ?? 0} queued`,
      health?.redis
        ? metrics?.queue_depth
          ? "buffering"
          : "healthy"
        : "offline",
      600,
      20,
    ],
    [
      "workers",
      "Indexer workers",
      "Distributed replicas",
      `${metrics?.active_workers ?? 0} active`,
      metrics?.active_workers ? "healthy" : "paused",
      600,
      250,
    ],
    [
      "database",
      "PostgreSQL shards",
      `${shardState?.count ?? "—"} index shards`,
      `${metrics?.indexed ?? 0} logs`,
      health?.postgres && shardState?.shards.every((shard) => shard.healthy)
        ? "healthy"
        : "offline",
      300,
      250,
    ],
    [
      "search",
      "Search API",
      "Query layer",
      "Ready",
      health?.api && health?.postgres ? "healthy" : "offline",
      0,
      250,
    ],
  ].map(([id, label, subtitle, value, status, x, y]) => ({
    id: String(id),
    type: "component",
    position: { x: Number(x), y: Number(y) },
    data: {
      label: String(label),
      subtitle: String(subtitle),
      value: String(value),
      status: String(status),
      kind: String(id),
    },
    selected: selected === id,
    draggable: false,
  }));
  const edges: Edge[] = [
    ["sources", "collector"],
    ["collector", "redis"],
    ["redis", "workers"],
    ["workers", "database"],
    ["database", "search"],
  ].map(([source, target], i) => ({
    id: `e${i}`,
    source,
    target,
    type: "smoothstep",
    animated: !!metrics?.received_rate && (i < 3 || !!metrics?.indexed_rate),
    style: { stroke: "#9eb6ad", strokeWidth: 2 },
  }));
  const item = componentInfo[selected];
  return (
    <>
      <Header
        title="Pipeline explorer"
        description="Inspect the real path of an event through the Distributed Log Aggregator & Indexer."
        action={
          <span className="page-chip">
            <span className="status-dot" /> {metrics?.active_workers ?? 0}{" "}
            indexers connected
          </span>
        }
      />
      <div className="pipeline-layout">
        <section className="panel canvas-panel">
          <div className="canvas-toolbar">
            <div>
              <strong>Processing architecture</strong>
              <span>Drag to pan · scroll to zoom · select a node</span>
            </div>
            <span>LIVE TOPOLOGY</span>
          </div>
          <div className="flow-canvas">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={(_, node) => setSelected(node.id)}
              fitView
              fitViewOptions={{ padding: 0.12 }}
              minZoom={0.45}
              maxZoom={1.2}
              nodesConnectable={false}
              elementsSelectable
            >
              <Background color="var(--grid)" gap={20} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          <div className="canvas-foot">
            <span className="legend-dot teal" /> Animated links indicate
            measured activity. <span className="legend-dot orange" /> Queue:{" "}
            {metrics?.queue_depth ?? 0} pending
          </div>
          <div className="component-picker" aria-label="Pipeline stages">
            {Object.entries(componentInfo).map(([id, component], index) => (
              <button
                key={id}
                className={selected === id ? "active" : ""}
                aria-pressed={selected === id}
                onClick={() => setSelected(id)}
              >
                <span>{index + 1}</span> {component.name}
              </button>
            ))}
          </div>
        </section>
        <aside className="panel inspector">
          <div className="inspector-label">COMPONENT INSPECTOR</div>
          <h2>{item.name}</h2>
          <p>{item.purpose}</p>
          <div className="inspector-status">
            <span className="status-dot" />{" "}
            {selected === "workers" && !metrics?.active_workers
              ? "Paused"
              : selected === "sources" &&
                  metrics?.generator.status !== "running"
                ? "Idle"
                : (selected === "redis" && !health?.redis) ||
                    (selected === "database" && !health?.postgres)
                  ? "Unavailable"
                  : "Operational"}
          </div>
          <div className="inspector-block">
            <span>LIVE METRIC</span>
            <strong>
              {selected === "redis"
                ? `${fmt(metrics?.queue_depth)} queued`
                : selected === "sources" || selected === "collector"
                  ? `${metrics?.received_rate ?? "—"} events / sec`
                  : selected === "workers"
                    ? `${metrics?.active_workers ?? 0} workers`
                    : selected === "database"
                      ? `${fmt(metrics?.indexed)} indexed`
                      : "Search ready"}
            </strong>
          </div>
          <div className="inspector-block">
            <span>ROLE IN THE PIPELINE</span>
            <p>{item.detail}</p>
          </div>
          <Link
            to={
              selected === "workers" || selected === "sources"
                ? "/lab"
                : "/architecture"
            }
            className="inline-link"
          >
            {selected === "workers" || selected === "sources"
              ? "Open controls"
              : "Read architecture"}{" "}
            <ArrowRight size={15} />
          </Link>
        </aside>
      </div>
    </>
  );
}
function FilterDropdown({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const labelId = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  useEffect(() => {
    if (!open) return;
    root.current
      ?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
      [selectedIndex]?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !root.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open, selectedIndex]);

  return (
    <div
      className="filter-field"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span className="filter-label" id={labelId}>
        {label}
      </span>
      <button
        ref={trigger}
        className="filter-trigger"
        type="button"
        aria-labelledby={labelId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{options[selectedIndex]?.label}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={menuId}
          className="filter-menu"
          role="menu"
          aria-labelledby={labelId}
          onKeyDown={(event) => {
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitemradio"]',
              ),
            );
            const index = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              trigger.current?.focus();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              items[
                (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
                  items.length
              ]?.focus();
            } else if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              items[event.key === "Home" ? 0 : items.length - 1]?.focus();
            }
          }}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={15} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Explorer() {
  const qc = useQueryClient();
  const initialService =
    new URLSearchParams(window.location.search).get("service") || "";
  const [q, setQ] = useState(""),
    [search, setSearch] = useState(""),
    [service, setService] = useState(initialService),
    [severity, setSeverity] = useState(""),
    [trace, setTrace] = useState(""),
    [range, setRange] = useState("all"),
    [page, setPage] = useState(1),
    [expanded, setExpanded] = useState(""),
    [live, setLive] = useState(false),
    [copy, setCopy] = useState(""),
    [importResult, setImportResult] = useState("");
  const { data: services } = useQuery({
    queryKey: ["services"],
    queryFn: () => api<Service[]>("/services"),
    refetchInterval: 5000,
  });
  const start =
    range === "1h"
      ? new Date(Date.now() - 3600000).toISOString()
      : range === "24h"
        ? new Date(Date.now() - 86400000).toISOString()
        : undefined;
  const query = qs({
    q: search,
    service,
    severity,
    trace_id: trace,
    start,
    page,
    limit: 25,
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ["logs", query],
    queryFn: () =>
      api<{ items: Log[]; total: number; page: number; limit: number }>(
        `/logs?${query}`,
      ),
    refetchInterval: live ? 2000 : false,
  });
  const importFile = async (file: File) => {
    const data = new FormData();
    data.append("file", file);
    try {
      const result = await api<{ accepted: number; rejected: number }>(
        "/logs/import",
        { method: "POST", body: data },
      );
      setImportResult(
        `Imported ${result.accepted} events; ${result.rejected} rejected.`,
      );
      qc.invalidateQueries({ queryKey: ["logs"] });
    } catch (e) {
      setImportResult(e instanceof Error ? e.message : "Import failed");
    }
  };
  const copyJson = async (log: Log) => {
    await navigator.clipboard.writeText(JSON.stringify(log, null, 2));
    setCopy(log.event_id);
    setTimeout(() => setCopy(""), 1800);
  };
  return (
    <>
      <Header
        title="Log explorer"
        description="Search indexed events across services, time, and severity."
        action={
          <div className="explorer-actions">
            <label
              className="import-button"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.currentTarget.querySelector("input")?.click();
                }
              }}
            >
              <Upload size={15} /> Import JSONL
              <input
                type="file"
                accept=".jsonl"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) importFile(file);
                }}
              />
            </label>
            <label className="live-toggle">
              <input
                type="checkbox"
                checked={live}
                onChange={(e) => setLive(e.target.checked)}
              />
              <span className="status-dot" /> Live tail
            </label>
          </div>
        }
      />
      {importResult && (
        <div className="import-result" role="status">
          {importResult}
        </div>
      )}
      <section className="panel explorer-panel">
        <form
          className="search-row"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setSearch(q);
          }}
        >
          <div className="search-input">
            <Search size={19} />
            <input
              aria-label="Search log messages"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search log messages…"
            />
          </div>
          <button className="button primary" type="submit">
            Search
          </button>
        </form>
        <div className="filters">
          <FilterDropdown
            label="Service"
            value={service}
            options={[
              { value: "", label: "All services" },
              ...(services?.map((s) => ({
                value: s.service,
                label: s.service,
              })) ?? []),
            ]}
            onChange={(next) => {
              setService(next);
              setPage(1);
            }}
          />
          <FilterDropdown
            label="Severity"
            value={severity}
            options={[
              { value: "", label: "All levels" },
              ...["DEBUG", "INFO", "WARN", "ERROR", "FATAL"].map((level) => ({
                value: level,
                label: level,
              })),
            ]}
            onChange={(next) => {
              setSeverity(next);
              setPage(1);
            }}
          />
          <FilterDropdown
            label="Time range"
            value={range}
            options={[
              { value: "all", label: "All time" },
              { value: "1h", label: "Last hour" },
              { value: "24h", label: "Last 24 hours" },
            ]}
            onChange={(next) => {
              setRange(next);
              setPage(1);
            }}
          />
          <button
            className="clear-button"
            onClick={() => {
              setQ("");
              setSearch("");
              setService("");
              setSeverity("");
              setTrace("");
              setRange("all");
              setPage(1);
            }}
          >
            <RotateCcw size={14} /> Reset filters
          </button>
        </div>
        <div className="results-heading">
          <strong>{fmt(data?.total)} events</strong>
          <span>Sorted newest first · indexed events only</span>
        </div>
        {isLoading || error ? (
          <State loading={isLoading} error={error} />
        ) : data?.items.length ? (
          <div className="table-wrap">
            <table className="logs-table">
              <thead>
                <tr>
                  <th>TIME</th>
                  <th>LEVEL</th>
                  <th>SERVICE</th>
                  <th>MESSAGE</th>
                  <th>TRACE ID</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((log) => (
                  <FragmentRow
                    key={log.event_id}
                    term={search}
                    log={log}
                    expanded={expanded === log.event_id}
                    onExpand={() =>
                      setExpanded(expanded === log.event_id ? "" : log.event_id)
                    }
                    onCopy={() => copyJson(log)}
                    copied={copy === log.event_id}
                    onTrace={() => {
                      setQ("");
                      setSearch("");
                      setService("");
                      setSeverity("");
                      setRange("all");
                      setPage(1);
                      setTrace(log.trace_id || "");
                      setPage(1);
                      setExpanded(log.event_id);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <State empty="No events match these filters. Try a broader search or start traffic in the System lab." />
        )}
        <div className="pagination">
          <span>
            Page {page} of {Math.max(1, Math.ceil((data?.total ?? 0) / 25))}
          </span>
          <div>
            <button disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <button
              disabled={page * 25 >= (data?.total ?? 0)}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
function Highlighted({ text, term }: { text: string; term: string }) {
  const query = term.trim();
  if (!query) return text;
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}
function FragmentRow({
  log,
  expanded,
  onExpand,
  onCopy,
  copied,
  onTrace,
  term,
}: {
  log: Log;
  expanded: boolean;
  onExpand: () => void;
  onCopy: () => void;
  copied: boolean;
  onTrace: () => void;
  term: string;
}) {
  return (
    <>
      <tr className="clickable-row" onClick={onExpand}>
        <td className="mono">{new Date(log.timestamp).toLocaleTimeString()}</td>
        <td>
          <SeverityBadge level={log.severity} />
        </td>
        <td>{log.service}</td>
        <td className="message-cell">
          <Highlighted text={log.message} term={term} />
        </td>
        <td className="mono trace-cell">{log.trace_id || "—"}</td>
        <td>
          <button
            className="row-expand"
            aria-label={`${expanded ? "Hide" : "Show"} details for ${log.service} event at ${new Date(log.timestamp).toLocaleTimeString()}`}
            aria-expanded={expanded}
            onClick={(event) => {
              event.stopPropagation();
              onExpand();
            }}
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="detail-row">
          <td colSpan={6}>
            <div className="detail-content">
              <div>
                <strong>Event details</strong>
                <div className="detail-grid">
                  <span>EVENT ID</span>
                  <code>{log.event_id}</code>
                  <span>HOST</span>
                  <code>{log.host}</code>
                  <span>RECEIVED</span>
                  <code>{time(log.received_at)}</code>
                  <span>INDEXED</span>
                  <code>{time(log.indexed_at)}</code>
                  <span>TRACE ID</span>
                  <code>{log.trace_id || "—"}</code>
                </div>
              </div>
              <div>
                <div className="detail-actions">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCopy();
                    }}
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
                    {copied ? "Copied" : "Copy JSON"}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onTrace();
                    }}
                  >
                    Inspect trace
                  </button>
                </div>
                <pre>{JSON.stringify(log.metadata, null, 2)}</pre>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
export function Lab({ metrics }: { metrics?: Metrics }) {
  const qc = useQueryClient();
  const [rate, setRate] = useState(50),
    [delay, setDelay] = useState(0),
    [notice, setNotice] = useState("");
  const history = useHistory(metrics);
  const mutation = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      post(path, body),
    onSuccess: (_, variables) => {
      if (variables.path === "/demo/reset") {
        window.location.reload();
        return;
      }
      qc.invalidateQueries();
      setNotice("Control applied to the running system.");
      setTimeout(() => setNotice(""), 3000);
    },
    onError: (e) => setNotice(e.message),
  });
  const run = (path: string, body?: unknown) => mutation.mutate({ path, body });
  return (
    <>
      <Header
        title="System lab"
        description="Apply real load and failure controls. Observe the system respond."
      
      />
      <div className="lab-grid">
        <section className="panel lab-controls">
          <div className="section-title">
            <span className="section-icon">
              <Zap size={19} />
            </span>
            <div>
              <h3>Traffic generation</h3>
              <p>Events enter through the ingestion HTTP API.</p>
            </div>
          </div>
          <div className="control-label">
            <span>Target rate</span>
            <strong>
              {rate} <small>logs / sec</small>
            </strong>
          </div>
          <input
            type="range"
            min="1"
            max="500"
            step="1"
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            aria-label="Target log rate"
          />
          <div className="range-labels">
            <span>1 / sec</span>
            <span>500 / sec</span>
          </div>
          <div className="presets">
            {[10, 50, 100, 500].map((n) => (
              <button
                key={n}
                className={rate === n ? "selected" : ""}
                onClick={() => setRate(n)}
              >
                {n}/s
              </button>
            ))}
          </div>
          <div className="button-row">
            <button
              className="button primary"
              disabled={mutation.isPending}
              onClick={() => run("/generator/start", { rate })}
            >
              <Play size={16} /> Start traffic
            </button>
            <button
              className="button secondary"
              disabled={mutation.isPending}
              onClick={() => run("/generator/pause")}
            >
              <Pause size={16} /> Pause
            </button>
            <button
              className="button secondary"
              disabled={mutation.isPending}
              onClick={() => run("/generator/stop")}
            >
              <Square size={15} /> Stop
            </button>
          </div>
          <div className="control-footer">
            <span>Status</span>
            <strong className="capitalize">
              {metrics?.generator.status ?? "unknown"}
            </strong>
          </div>
          <button
            className="text-action"
            disabled={mutation.isPending}
            onClick={() => run("/generator/burst", { rate })}
          >
            <Zap size={15} /> Send one traffic burst
          </button>
        </section>
        <section className="panel lab-controls">
          <div className="section-title">
            <span className="section-icon orange-icon">
              <Settings2 size={19} />
            </span>
            <div>
              <h3>Indexer behavior</h3>
              <p>Pause or slow real consumer processes.</p>
            </div>
          </div>
          <div className="switch-row">
            <div>
              <strong>Pause all workers</strong>
              <span>Incoming events will accumulate in Redis.</span>
            </div>
            <button
              className={"switch " + (metrics?.workers_paused ? "on" : "")}
              role="switch"
              aria-checked={!!metrics?.workers_paused}
              aria-label="Pause all workers"
              disabled={mutation.isPending}
              onClick={() =>
                run("/workers/control", { paused: !metrics?.workers_paused })
              }
            >
              <span />
            </button>
          </div>
          <div className="control-label">
            <span>Processing delay</span>
            <strong>
              {delay} <small>ms / event</small>
            </strong>
          </div>
          <input
            type="range"
            min="0"
            max="1000"
            step="25"
            value={delay}
            onChange={(e) => setDelay(Number(e.target.value))}
            aria-label="Worker processing delay"
          />
          <div className="range-labels">
            <span>No delay</span>
            <span>1,000 ms</span>
          </div>
          <button
            className="button secondary full-button"
            disabled={mutation.isPending}
            onClick={() => run("/workers/control", { delay_ms: delay })}
          >
            Apply processing delay
          </button>
          <div className="control-footer">
            <span>Current delay</span>
            <strong>{metrics?.worker_delay_ms ?? 0} ms</strong>
          </div>
          <div className="worker-list">
            <strong>Individual workers</strong>
            {metrics?.workers
              .slice()
              .sort()
              .map((name, index) => (
                <div key={name}>
                  <span className="worker-identity">
                    <strong>Indexer {index + 1}</strong>
                    <code title={name}>ID {name}</code>
                  </span>
                  <button
                    disabled={mutation.isPending}
                    aria-label={`${metrics.worker_paused?.[name] ? "Resume" : "Pause"} Indexer ${index + 1}`}
                    onClick={() =>
                      run(`/workers/${encodeURIComponent(name)}/control`, {
                        paused: !metrics.worker_paused?.[name],
                      })
                    }
                  >
                    {metrics.worker_paused?.[name] ? "Resume" : "Pause"}
                  </button>
                </div>
              ))}
          </div>
          <button
            className="text-action"
            disabled={mutation.isPending}
            onClick={() => {
              setDelay(0);
              run("/workers/control", { paused: false, delay_ms: 0 });
            }}
          >
            <RotateCcw size={15} /> Restore normal operation
          </button>
        </section>
      </div>
      <div className="lab-readout">
        <Metric
          label="Incoming"
          value={metrics?.received_rate ?? "—"}
          unit="/s"
        />
        <Metric
          label="Indexed"
          value={metrics?.indexed_rate ?? "—"}
          unit="/s"
        />
        <Metric label="Backlog" value={fmt(metrics?.queue_depth)} />
        <Metric
          label="Avg. processing"
          value={metrics?.avg_processing_ms ?? "—"}
          unit="ms"
        />
        <Metric label="Errors" value={fmt(metrics?.errors)} />
      </div>
      <div className="dashboard-grid">
        <section className="panel throughput-panel">
          <div className="panel-head">
            <div>
              <h3>Experiment telemetry</h3>
              <p>These measurements come from live Redis counters.</p>
            </div>
          </div>
          <div className="chart-wrap">
            <Throughput history={history} />
          </div>
          <div className="chart-legend">
            <span>
              <i className="legend-dot teal" /> Ingested
            </span>
            <span>
              <i className="legend-dot orange" /> Indexed
            </span>
          </div>
        </section>
        <section className="panel experiment-guide">
          <h3>What to try</h3>
          <ol>
            <li>
              <strong>Start traffic</strong>
              <span>
                Events flow through the API, stream, workers, and database.
              </span>
            </li>
            <li>
              <strong>Pause workers</strong>
              <span>
                Watch the queue backlog rise while ingestion continues.
              </span>
            </li>
            <li>
              <strong>Resume workers</strong>
              <span>The backlog drains and logs become searchable.</span>
            </li>
            <li>
              <strong>Scale replicas</strong>
              <span>
                Run <code>docker compose up -d --scale worker=4 worker</code>.
              </span>
            </li>
          </ol>
          <button
            className="text-action danger"
            disabled={mutation.isPending}
            onClick={() => {
              if (
                window.confirm(
                  "Start a fresh simulation? Your current logs and queue will be cleared.",
                )
              )
                run("/demo/reset");
            }}
          >
            <RotateCcw size={15} /> Start fresh simulation
          </button>
        </section>
      </div>
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
    </>
  );
}
export function Services() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["services"],
    queryFn: () => api<Service[]>("/services"),
    refetchInterval: 5000,
  });
  return (
    <>
      <Header
        title="Service monitoring"
        description="See which applications are emitting logs and where errors appear."
      />
      <div className="service-summary">
        <strong>{data?.length ?? 0}</strong>
        <span>services with indexed activity</span>
      </div>
      {isLoading || error ? (
        <State loading={isLoading} error={error} />
      ) : data?.length ? (
        <div className="services-list">
          {data.map((s) => (
            <Link
              to={"/logs?service=" + encodeURIComponent(s.service)}
              className="service-row"
              key={s.service}
            >
              <span className="service-icon">
                <Server size={20} />
              </span>
              <div className="service-main">
                <strong>{s.service}</strong>
                <span>Last event {time(s.last_seen)}</span>
              </div>
              <span className="service-health">
                <span
                  className={
                    "status-dot " +
                    (Date.now() - new Date(s.last_seen).getTime() > 300000
                      ? "muted"
                      : "")
                  }
                />{" "}
                {Date.now() - new Date(s.last_seen).getTime() > 300000
                  ? "Quiet"
                  : "Active"}
              </span>
              <div className="service-stat">
                <strong>{fmt(s.volume)}</strong>
                <span>LOGS</span>
              </div>
              <div className="service-stat">
                <strong>
                  {s.volume ? ((s.errors / s.volume) * 100).toFixed(1) : "0.0"}%
                </strong>
                <span>ERROR RATE</span>
              </div>
              <ArrowUpRight size={18} />
            </Link>
          ))}
        </div>
      ) : (
        <State empty="No services have indexed logs yet. Start traffic to populate service health." />
      )}
    </>
  );
}
export function Insights({
  metrics,
  stats,
}: {
  metrics?: Metrics;
  stats?: Stats;
}) {
  const history = useHistory(metrics);
  const backlog = !!metrics?.queue_depth;
  const fallingBehind =
    !!metrics &&
    metrics.queue_depth > 5 &&
    metrics.received_rate > metrics.indexed_rate;
  return (
    <>
      <Header
        title="System insights"
        description="Read the performance story told by actual pipeline measurements."
      />
      <div className="insight-callout">
        <span className={"insight-symbol " + (fallingBehind ? "warning" : "")}>
          <Activity size={23} />
        </span>
        <div>
          <strong>
            {fallingBehind
              ? "Indexers are falling behind"
              : backlog
                ? "The queue is buffering events"
                : metrics?.generator.status === "running"
                  ? "Pipeline is processing traffic"
                  : "Waiting for a traffic run"}
          </strong>
          <p>
            {fallingBehind
              ? "Ingestion is outpacing indexing and the queue is growing. Resume workers, reduce delay, or add replicas."
              : backlog
                ? "Some accepted events are waiting to be indexed. Watch whether the backlog drains over time."
                : metrics?.generator.status === "running"
                  ? "Events are arriving and the queue is currently clear."
                  : "Start traffic in the System lab to collect performance data."}
          </p>
        </div>
      </div>
      <div className="insights-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Throughput trend</h3>
              <p>Measured events per second in this browser session</p>
            </div>
          </div>
          <div className="chart-wrap">
            <Throughput history={history} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>Indexing health</h3>
              <p>Current worker and queue measurements</p>
            </div>
          </div>
          <div className="insight-rows">
            <div>
              <span>Queue backlog</span>
              <strong>{fmt(metrics?.queue_depth)}</strong>
            </div>
            <div>
              <span>Processing time</span>
              <strong>{metrics?.avg_processing_ms ?? "—"} ms</strong>
            </div>
            <div>
              <span>Active workers</span>
              <strong>{metrics?.active_workers ?? 0}</strong>
            </div>
            <div>
              <span>Processing errors</span>
              <strong>{fmt(metrics?.errors)}</strong>
            </div>
            <div>
              <span>Rejected events</span>
              <strong>{fmt(metrics?.rejected)}</strong>
            </div>
          </div>
        </section>
      </div>
      <section className="panel hourly-panel">
        <div className="panel-head">
          <div>
            <h3>Backlog and errors</h3>
            <p>
              Queue depth and cumulative processing errors in this browser
              session
            </p>
          </div>
        </div>
        {history.length ? (
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={history}>
              <CartesianGrid vertical={false} stroke="var(--line)" />
              <XAxis
                dataKey="time"
                tickLine={false}
                axisLine={false}
                minTickGap={30}
              />
              <YAxis tickLine={false} axisLine={false} />
              <Tooltip />
              <Area
                dataKey="queue"
                name="Queue depth"
                type="monotone"
                stroke="#e3803e"
                fill="#fbe9d9"
                strokeWidth={2}
              />
              <Area
                dataKey="errors"
                name="Errors"
                type="monotone"
                stroke="#b74642"
                fill="none"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <State empty="Start traffic to collect a trend." />
        )}
      </section>
      <section className="panel hourly-panel">
        <div className="panel-head">
          <div>
            <h3>Indexed volume</h3>
            <p>PostgreSQL records over the last 60 minutes</p>
          </div>
        </div>
        {stats?.series.length ? (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={stats.series}>
              <CartesianGrid vertical={false} stroke="var(--line)" />
              <XAxis
                dataKey="minute"
                tickFormatter={(v) =>
                  new Date(v).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                }
                tickLine={false}
                axisLine={false}
              />
              <YAxis tickLine={false} axisLine={false} />
              <Tooltip labelFormatter={(v) => time(String(v))} />
              <Area
                dataKey="indexed"
                type="monotone"
                stroke="#147f76"
                fill="#d4e8e2"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <State empty="Indexed volume will appear after traffic reaches the PostgreSQL shards." />
        )}
      </section>
    </>
  );
}
export function Documentation() {
  return (
    <>
      <Header
        title="Architecture & documentation"
        description="A clear map of how the Distributed Log Aggregator & Indexer accepts, buffers, indexes, and searches events."
      />
      <div className="doc-layout">
        <article className="doc-article">
          <section>
            <h2>How the pipeline works</h2>
            <p>
              The Distributed Log Aggregator &amp; Indexer is a locally runnable distributed logging system. A durable
              daemon tails real log files while five demo services generate structured traffic through FastAPI. Accepted
              events go into a Redis Stream, where independent indexer processes
              consume from one group. They hash and commit events to PostgreSQL shards before
              acknowledging the stream entry. The search API only returns
              committed rows.
            </p>
            <div className="doc-flow">
              <span>Files + services</span>
              <ArrowRight size={16} />
              <span>FastAPI</span>
              <ArrowRight size={16} />
              <span>Redis</span>
              <ArrowRight size={16} />
              <span>Workers</span>
              <ArrowRight size={16} />
              <span>PostgreSQL shards</span>
            </div>
          </section>
          <section>
            <h2>Why Redis Streams?</h2>
            <p>
              Streams retain entries while workers are busy or unavailable. A
              consumer group distributes new entries across replicas. Pending
              entries can be reclaimed when a worker disappears. The visible
              queue depth makes load and recovery behavior easy to demonstrate.
            </p>
          </section>
          <section>
            <h2>Delivery and recovery</h2>
            <p>
              Processing is at least once. A worker inserts an event, then
              acknowledges and deletes its stream entry. If the worker stops
              between those steps, another worker can reclaim it. The unique
              event ID and PostgreSQL conflict handling prevent duplicate rows.
            </p>
            <p>
              Malformed queued events go to a dead-letter stream with a reason.
              Ingestion validation errors are returned to the caller; JSONL
              import reports rejected line numbers.
            </p>
          </section>
          <section>
            <h2>Search and retention</h2>
            <p>
              Each PostgreSQL shard uses B-tree indexes for time, service, severity, and
              trace filters. A generated <code>tsvector</code> column and GIN
              index support full-text message search. FastAPI fans queries out
              concurrently and merges the ordered results. The retention endpoint
              deletes rows older than the configured number of days when
              invoked.
            </p>
          </section>
          <section>
            <h2>Scaling limits</h2>
            <p>
              Run more worker replicas with Docker Compose. This improves
              throughput until Redis, a PostgreSQL shard, or host resources become the
              bottleneck. The repository includes a repeatable benchmark runner;
              results remain specific to the measured machine and workload.
            </p>
          </section>
        </article>
        <aside className="doc-aside">
          <div className="doc-aside-title">QUICK REFERENCE</div>
          <a href="http://localhost:8000/docs" target="_blank" rel="noreferrer">
            <FileJson size={17} /> Interactive API <ArrowUpRight size={14} />
          </a>
          <Link to="/pipeline">
            <Workflow size={17} /> Pipeline explorer <ArrowRight size={14} />
          </Link>
          <Link to="/lab">
            <Zap size={17} /> Experiment controls <ArrowRight size={14} />
          </Link>
          <div className="doc-note">
            <strong>Run locally</strong>
            <code>docker compose up --build</code>
            <span>
              Frontend: localhost:5173
              <br />
              API: localhost:8000
            </span>
          </div>
        </aside>
      </div>
    </>
  );
}
