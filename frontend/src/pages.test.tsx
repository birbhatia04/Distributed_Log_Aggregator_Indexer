// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Documentation, Explorer, Lab, Overview, Pipeline } from "./pages";
import type { Metrics } from "./api";

const metrics: Metrics = {
  received: 40,
  indexed: 36,
  rejected: 1,
  errors: 0,
  received_rate: 10,
  indexed_rate: 9,
  queue_depth: 4,
  indexing_lag: 4,
  active_workers: 2,
  workers: ["worker-a", "worker-b"],
  worker_paused: { "worker-a": false, "worker-b": false },
  avg_processing_ms: 3,
  generator: { status: "stopped", rate: 10 },
  workers_paused: false,
  worker_delay_ms: 0,
  timestamp: 1,
};
const calls: string[] = [];
function wrapper(node: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      calls.push(`${init?.method || "GET"} ${input}`);
      let body: unknown = {};
      if (input.includes("/services"))
        body = [
          {
            service: "auth-service",
            volume: 1,
            errors: 0,
            last_seen: new Date().toISOString(),
          },
        ];
      else if (input.includes("/logs?"))
        body = { items: [], total: 0, page: 1, limit: 25 };
      return { ok: true, json: async () => body } as Response;
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("frontend views", () => {
  it("renders measured dashboard values and navigation", () => {
    wrapper(
      <Overview
        metrics={metrics}
        stats={{ stored: 36, active_services: 2, error_logs: 1, series: [] }}
      />,
    );
    expect(screen.getByText("Logs received")).toBeTruthy();
    expect(screen.getByText("Active services")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Open system lab/ })
        .getAttribute("href"),
    ).toBe("/lab");
  });
  it("sends selected log filters to the API", async () => {
    wrapper(<Explorer />);
    await userEvent.click(screen.getByRole("button", { name: "Severity" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "ERROR" }));
    await waitFor(() =>
      expect(calls.some((c) => c.includes("severity=ERROR"))).toBe(true),
    );
    expect(
      screen.getByRole("button", { name: "Severity" }).textContent,
    ).toContain("ERROR");
  });
  it("wires the traffic button to the generator endpoint", async () => {
    wrapper(<Lab metrics={metrics} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Start traffic" }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.includes("POST /api/generator/start"))).toBe(
        true,
      ),
    );
  });
  it("shows friendly worker names while controlling the correct worker ID", async () => {
    wrapper(<Lab metrics={metrics} />);
    expect(screen.getByText("Indexer 1")).toBeTruthy();
    expect(screen.getByText("ID worker-a")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Pause Indexer 1" }),
    );
    await waitFor(() =>
      expect(
        calls.some((call) =>
          call.includes("POST /api/workers/worker-a/control"),
        ),
      ).toBe(true),
    );
  });
  it("renders architecture teaching content", () => {
    wrapper(<Documentation />);
    expect(
      screen.getByRole("heading", { name: "Delivery and recovery" }),
    ).toBeTruthy();
  });
  it("shows component detail when a pipeline node is selected", async () => {
    wrapper(<Pipeline metrics={metrics} />);
    fireEvent.click(screen.getByRole("button", { name: "4 Indexer workers" }));
    expect(
      screen.getByRole("heading", { name: "Indexer workers" }),
    ).toBeTruthy();
  });
});
