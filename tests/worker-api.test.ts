import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index.ts";

type TestRecord = Record<string, unknown>;
type QueryRequest = { query: string; params: unknown[] };

function authHeaders() {
  return { Authorization: `Basic ${btoa("jd-analysis:test-password")}` };
}

function makeRecord(overrides: TestRecord = {}): TestRecord {
  return {
    id: 57,
    created_at: new Date().toISOString(),
    symbol: "XAUUSD",
    tf_primary: "M5",
    tf_secondary: "ICT",
    direction: "BUY",
    confidence: 82,
    entry_low: 2000,
    entry_high: 2001,
    stop_loss: 1995,
    take_profit_1: 2005,
    take_profit_2: 2010,
    image_primary: "primary.png",
    image_secondary: "secondary.png",
    payload_json: JSON.stringify({ signal_grade: "A", outcome: { result: "TP1", r: 1.4 } }),
    ...overrides,
  };
}

function pgResponse(rows: TestRecord[], columns: string[]): Response {
  return Response.json({
    fields: columns.map((name) => ({
      name,
      dataTypeID: name === "id" ? 23
        : ["confidence", "entry_low", "entry_high", "stop_loss", "take_profit_1", "take_profit_2"].includes(name) ? 701
          : 25,
    })),
    rows: rows.map((row) => columns.map((column) => row[column] === null || row[column] === undefined ? null : String(row[column]))),
  });
}

function makeNeonFetch(records: TestRecord[] = []) {
  const queries: QueryRequest[] = [];
  let nextId = Math.max(56, ...records.map((record) => Number(record.id) || 0)) + 1;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.neon.tech") {
      const request = JSON.parse(String(init?.body)) as QueryRequest;
      queries.push(request);
      const query = request.query.trim();
      const normalized = query.toLowerCase();
      if (normalized.startsWith("select 1")) {
        return pgResponse([{ "?column?": 1 }], ["?column?"]);
      }
      if (normalized.startsWith("insert into analysis_records")) {
        const id = nextId++;
        return pgResponse([{ id }], ["id"]);
      }
      if (normalized.startsWith("update analysis_records")) {
        const id = Number(request.params[1]);
        const record = records.find((item) => Number(item.id) === id);
        if (record) record.payload_json = request.params[0];
        return pgResponse(record ? [{ id }] : [], ["id"]);
      }
      if (normalized.startsWith("select") && normalized.includes("from analysis_records")) {
        const select = query.match(/^select\s+([\s\S]+?)\s+from\s+analysis_records/i)?.[1];
        assert.ok(select, "Expected a SELECT projection for analysis_records.");
        const columns = select.split(",").map((part) => {
          const item = part.trim();
          const alias = item.match(/\s+as\s+([a-z_]+)/i)?.[1];
          return alias || item.split("::")[0].split(/\s+/).at(-1)?.replaceAll('"', "") || item;
        });
        const idMatch = normalized.match(/\bwhere\s+id\s*=\s*\$\d+/);
        const selected = idMatch
          ? records.filter((record) => Number(record.id) === Number(request.params.at(-1)))
          : records;
        return pgResponse(selected, columns);
      }
      return pgResponse([], []);
    }
    if (url.hostname === "api.twelvedata.com") {
      return Response.json(timeSeries(url.searchParams.get("interval") || "5min"));
    }
    throw new Error(`Unexpected test fetch host: ${url.hostname}`);
  };
  return { fetcher, queries, records };
}

function timeSeries(interval: string) {
  const step = interval === "1h" ? 60 : interval === "15min" ? 15 : interval === "5min" ? 5 : 1;
  const stepMs = step * 60_000;
  const last = Math.floor(Date.now() / stepMs) * stepMs;
  return {
    values: Array.from({ length: 120 }, (_, index) => {
      const timestamp = new Date(last - (119 - index) * stepMs).toISOString().slice(0, 19).replace("T", " ");
      const close = 4000 + Math.sin(index / 4) * 4 + index * 0.02;
      return {
        datetime: timestamp,
        open: String(close - 0.1),
        high: String(close + 0.4),
        low: String(close - 0.4),
        close: String(close),
        volume: "10",
      };
    }),
  };
}

function env(databaseUrl = "postgresql://test:test@ep-test.neon.tech/test?sslmode=require") {
  return { APP_PASSWORD: "test-password", DATABASE_URL: databaseUrl };
}

test("Worker exposes ICT candle and scan routes and saves scan history through Neon", async () => {
  const originalFetch = globalThis.fetch;
  const db = makeNeonFetch();
  globalThis.fetch = db.fetcher;
  try {
    const candles = await worker.fetch(new Request("https://example.test/api/ict/candles?tf=M5&symbol=XAUUSD", { headers: authHeaders() }), {
      ...env(),
      TWELVEDATA_API_KEY: "test-key",
    } as never);
    assert.equal(candles.status, 200);
    const candleBody = await candles.json() as { feed: { tf: string }; bars: unknown[] };
    assert.equal(candleBody.feed.tf, "M5");
    assert.equal(candleBody.bars.length, 120);

    const scan = await worker.fetch(new Request("https://example.test/api/ict/scan?tf=M5&symbol=XAUUSD&ai=false", {
      method: "POST",
      headers: authHeaders(),
    }), {
      ...env(),
      TWELVEDATA_API_KEY: "test-key",
    } as never);
    assert.equal(scan.status, 200);
    const scanBody = await scan.json() as {
      id: number;
      history_saved: boolean;
      analysis: { ict_scan: boolean; feed: { tf: string }; final_direction: string };
    };
    assert.equal(scanBody.id, 57);
    assert.equal(scanBody.history_saved, true);
    assert.equal(scanBody.analysis.ict_scan, true);
    assert.equal(scanBody.analysis.feed.tf, "M5");
    assert.ok(["BUY", "SELL", "WAIT"].includes(scanBody.analysis.final_direction));
    const insert = db.queries.find(({ query }) => query.trimStart().startsWith("INSERT INTO analysis_records"));
    assert.ok(insert);
    assert.ok(insert.params.length > 0);
    assert.equal(insert.query.includes("XAUUSD"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("history reads and outcome changes preserve the API response shape", async () => {
  const originalFetch = globalThis.fetch;
  const db = makeNeonFetch([makeRecord()]);
  globalThis.fetch = db.fetcher;
  try {
    const listResponse = await worker.fetch(new Request("https://example.test/api/history", { headers: authHeaders() }), env() as never);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json() as { database: string; items: Array<Record<string, unknown>> };
    assert.equal(list.database, "connected");
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].id, 57);
    assert.equal((list.items[0].analysis as Record<string, unknown>).signal_grade, "A");

    const detailResponse = await worker.fetch(new Request("https://example.test/api/history/57", { headers: authHeaders() }), env() as never);
    assert.equal(detailResponse.status, 200);
    assert.equal((await detailResponse.json() as Record<string, unknown>).image_primary_url, "/uploads/primary.png");

    const updateResponse = await worker.fetch(new Request("https://example.test/api/history/57/outcome", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ result: "TP2" }),
    }), env() as never);
    assert.equal(updateResponse.status, 200);
    const updated = await updateResponse.json() as { analysis: { outcome: { result: string } } };
    assert.equal(updated.analysis.outcome.result, "TP2");

    const clearResponse = await worker.fetch(new Request("https://example.test/api/history/57/outcome", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ result: "CLEAR" }),
    }), env() as never);
    assert.equal(clearResponse.status, 200);
    assert.equal("outcome" in (await clearResponse.json() as { analysis: Record<string, unknown> }).analysis, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("overall statistics use recorded R and include grade and direction groups", async () => {
  const originalFetch = globalThis.fetch;
  const db = makeNeonFetch([makeRecord()]);
  globalThis.fetch = db.fetcher;
  try {
    const response = await worker.fetch(new Request("https://example.test/api/stats", { headers: authHeaders() }), env() as never);
    assert.equal(response.status, 200);
    const stats = await response.json() as {
      resolved: number;
      total_r: number;
      by_grade: Record<string, { total_r: number }>;
      by_direction: Record<string, { total_r: number }>;
    };
    assert.equal(stats.resolved, 1);
    assert.equal(stats.total_r, 1.4);
    assert.equal(stats.by_grade.A.total_r, 1.4);
    assert.equal(stats.by_direction.BUY.total_r, 1.4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("daily statistics route returns local-time totals", async () => {
  const originalFetch = globalThis.fetch;
  const db = makeNeonFetch([makeRecord()]);
  globalThis.fetch = db.fetcher;
  try {
    const response = await worker.fetch(new Request("https://example.test/api/stats/daily?days=14&tz_offset_min=420", {
      headers: authHeaders(),
    }), env() as never);
    assert.equal(response.status, 200);
    const result = await response.json() as { days: Array<Record<string, unknown>>; today: Record<string, unknown> };
    assert.equal(result.days.length, 1);
    assert.equal(result.days[0].signals, 1);
    assert.equal(result.days[0].win_rate, 100);
    assert.equal(result.days[0].total_r, 1.4);
    assert.equal(result.today.signals, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("health route reports Neon connectivity", async () => {
  const originalFetch = globalThis.fetch;
  const db = makeNeonFetch();
  globalThis.fetch = db.fetcher;
  try {
    const response = await worker.fetch(new Request("https://example.test/api/health", { headers: authHeaders() }), env() as never);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { database: string }).database, "connected");
    assert.equal(db.queries[0].query, "SELECT 1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ICT routes reject unsupported timeframes instead of returning 404", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/ict/scan?tf=H1&ai=false", {
    method: "POST",
    headers: authHeaders(),
  }), env("") as never);
  assert.equal(response.status, 400);
});
