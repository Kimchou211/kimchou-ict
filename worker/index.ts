import { analyzeImages, chatWithDeepSeek } from "./ai";
import { buildTradeRead } from "./trade-engine";
import { calculateLiveScan, chatWithLiveMarket, fetchLiveMarket, reviewLiveMarket } from "./live-market";
import type { AnalysisRecord, ChartImage, Env, JsonRecord } from "./types";

const TIMEFRAMES = new Set(["M1", "M2", "M3", "M5", "M10", "M15", "M30", "H1", "H2", "H4", "D1", "W1", "MN1"]);
const OUTCOMES = new Set(["TP1", "TP2", "SL", "SKIP", "CLEAR"]);
const RESULT_R: Record<string, number> = { TP1: 1, TP2: 1.8, SL: -1 };

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function equalSecret(candidate: string, expected: string): boolean {
  const candidateBytes = new TextEncoder().encode(candidate);
  const expectedBytes = new TextEncoder().encode(expected);
  let difference = candidateBytes.length ^ expectedBytes.length;
  const length = Math.max(candidateBytes.length, expectedBytes.length);
  for (let index = 0; index < length; index++) {
    difference |= (candidateBytes[index] || 0) ^ (expectedBytes[index] || 0);
  }
  return difference === 0;
}

function authorize(request: Request, env: Env): Response | null {
  if (!env.APP_PASSWORD) {
    return json({ detail: "Application is locked. Configure the APP_PASSWORD Worker secret before use." }, 503);
  }
  const value = request.headers.get("Authorization") || "";
  const match = value.match(/^Basic\s+([A-Za-z0-9+/]+=*)$/i);
  if (match) {
    try {
      const [username, password] = atob(match[1]).split(/:(.*)/s, 2);
      if (username === "jd-analysis" && password !== undefined && equalSecret(password, env.APP_PASSWORD)) return null;
    } catch {
      // Invalid base64 credentials are treated as an unauthorized request.
    }
  }
  return new Response("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="JD ANALYSIS", charset="UTF-8"',
      "Cache-Control": "no-store",
    },
  });
}

function badRequest(message: string): never {
  throw new ApiError(400, message);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "boolean" || value === null || value === undefined) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function safeJson(value: string): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : {};
  } catch {
    return {};
  }
}

function uploadUrl(name: string): string {
  return `/uploads/${encodeURIComponent(name)}`;
}

async function deleteUploadedImages(bucket: R2Bucket, images: ChartImage[]): Promise<void> {
  const outcomes = await Promise.allSettled(images.map((image) => bucket.delete(image.key)));
  const failed = outcomes.flatMap((outcome, index) => outcome.status === "rejected"
    ? [{ key: images[index].key, message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) }]
    : []);
  if (failed.length) console.error(JSON.stringify({ event: "upload_cleanup_failed", failed }));
}

function recordPayload(row: AnalysisRecord): JsonRecord {
  return {
    id: row.id,
    created_at: row.created_at || "",
    symbol: row.symbol,
    tf_primary: row.tf_primary,
    tf_secondary: row.tf_secondary,
    direction: row.direction,
    confidence: row.confidence,
    entry_low: row.entry_low,
    entry_high: row.entry_high,
    stop_loss: row.stop_loss,
    take_profit_1: row.take_profit_1,
    take_profit_2: row.take_profit_2,
    image_primary: row.image_primary,
    image_secondary: row.image_secondary,
    image_primary_url: uploadUrl(row.image_primary),
    image_secondary_url: uploadUrl(row.image_secondary),
    analysis: safeJson(row.payload_json),
  };
}

function imageType(bytes: Uint8Array): { mimeType: string; extension: string } | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (bytes.length >= 12
    && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF"
    && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return null;
}

function toBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

async function imageFromForm(
  value: File | string | null,
  maxBytes: number,
  bucket: R2Bucket,
): Promise<ChartImage> {
  if (!(value instanceof File) || !value.size) badRequest("Upload both timeframe screenshots before analyzing.");
  if (value.size > maxBytes) throw new ApiError(413, `Each image must be under ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
  const bytes = new Uint8Array(await value.arrayBuffer());
  const type = imageType(bytes);
  if (!type) throw new ApiError(415, "Use a readable PNG, JPG/JPEG or WEBP chart screenshot.");
  const key = `${crypto.randomUUID().replaceAll("-", "")}.${type.extension}`;
  await bucket.put(key, bytes, { httpMetadata: { contentType: type.mimeType } });
  return { mimeType: type.mimeType, base64: toBase64(bytes), key };
}

async function getHealth(env: Env): Promise<Response> {
  let database = "connected";
  try {
    await env.DB.prepare("SELECT 1").first();
  } catch {
    database = "offline";
  }
  return json({
    app: env.APP_NAME || "JD ANALYSIS",
    database,
    providers: {
      gemini_configured: Boolean(env.GEMINI_API_KEY),
      deepseek_configured: Boolean(env.DEEPSEEK_API_KEY),
    },
    mode: "live-market-and-image-analysis",
    symbol: "XAUUSD",
    live_terminal: true,
    live_market_provider: "Yahoo Finance XAUUSD=X",
    force_signal: env.FORCE_SIGNAL?.trim().toLowerCase() !== "false",
  });
}

async function analyze(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    badRequest("Upload must use multipart/form-data.");
  }
  const tfPrimary = (form.get("tf_primary")?.toString() || "M1").toUpperCase();
  const tfSecondary = (form.get("tf_secondary")?.toString() || "M5").toUpperCase();
  if (!TIMEFRAMES.has(tfPrimary) || !TIMEFRAMES.has(tfSecondary) || tfPrimary === tfSecondary) {
    badRequest("Choose two different supported timeframes.");
  }
  const maxUploadMb = Math.max(1, Math.min(25, finiteNumber(env.MAX_UPLOAD_MB) || 12));
  const maxBytes = maxUploadMb * 1024 * 1024;
  const savedImages: ChartImage[] = [];
  try {
    savedImages.push(await imageFromForm(form.get("primary_image"), maxBytes, env.UPLOADS));
    savedImages.push(await imageFromForm(form.get("secondary_image"), maxBytes, env.UPLOADS));
    let aiResults: Awaited<ReturnType<typeof analyzeImages>>;
    try {
      aiResults = await analyzeImages(env, savedImages, tfPrimary, tfSecondary);
    } catch (error) {
      await deleteUploadedImages(env.UPLOADS, savedImages);
      if (error instanceof Error && error.message.startsWith("Configure at least one")) {
        throw new ApiError(503, error.message);
      }
      throw error;
    }
    if (!aiResults.providerResults.length) {
      await deleteUploadedImages(env.UPLOADS, savedImages);
      const errors = Object.entries(aiResults.providerErrors).map(([provider, message]) => `${provider}: ${message}`).join(" | ");
      throw new ApiError(502, `All configured AI providers failed. ${errors || "Check API keys/model names."}`);
    }

    const analysis = buildTradeRead(aiResults.providerResults, aiResults.providerErrors, tfPrimary, tfSecondary, env);
    analysis.provider_errors = aiResults.providerErrors;
    const createdAt = new Date().toISOString();
    const values = [
      createdAt, "XAUUSD", tfPrimary, tfSecondary, String(analysis.direction || "WAIT"),
      finiteNumber(analysis.confidence) || 0, finiteNumber(analysis.entry_low), finiteNumber(analysis.entry_high),
      finiteNumber(analysis.stop_loss), finiteNumber(analysis.take_profit_1), finiteNumber(analysis.take_profit_2),
      savedImages[0].key, savedImages[1].key, JSON.stringify(analysis),
    ];
    try {
      const inserted = await env.DB.prepare(
        `INSERT INTO analysis_records
          (created_at, symbol, tf_primary, tf_secondary, direction, confidence, entry_low, entry_high,
           stop_loss, take_profit_1, take_profit_2, image_primary, image_secondary, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(...values).run();
      const id = typeof inserted.meta.last_row_id === "number" ? inserted.meta.last_row_id : null;
      return json({
        id,
        created_at: createdAt,
        tf_primary: tfPrimary,
        tf_secondary: tfSecondary,
        image_primary: savedImages[0].key,
        image_secondary: savedImages[1].key,
        image_primary_url: uploadUrl(savedImages[0].key),
        image_secondary_url: uploadUrl(savedImages[1].key),
        history_saved: id !== null,
        ...(id === null ? { history_error: "Database did not return the inserted record ID." } : {}),
        analysis,
      });
    } catch (error) {
      console.error(JSON.stringify({ event: "analysis_history_save_failed", message: error instanceof Error ? error.message : String(error) }));
      return json({
        id: null,
        created_at: createdAt,
        tf_primary: tfPrimary,
        tf_secondary: tfSecondary,
        image_primary: savedImages[0].key,
        image_secondary: savedImages[1].key,
        image_primary_url: uploadUrl(savedImages[0].key),
        image_secondary_url: uploadUrl(savedImages[1].key),
        history_saved: false,
        history_error: "Analysis completed, but saving it to D1 failed.",
        analysis,
      });
    }
  } catch (error) {
    await deleteUploadedImages(env.UPLOADS, savedImages);
    if (!(error instanceof ApiError) && error instanceof Error && !error.message.startsWith("Gemini API") && !error.message.startsWith("DeepSeek")) {
      console.error(JSON.stringify({ event: "analysis_failed", message: error.message }));
    }
    throw error;
  }
}

async function history(env: Env, url: URL): Promise<Response> {
  const requested = Number(url.searchParams.get("limit") || 40);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(150, Math.trunc(requested))) : 40;
  try {
    const result = await env.DB.prepare(
      "SELECT * FROM analysis_records ORDER BY id DESC LIMIT ?",
    ).bind(limit).all<AnalysisRecord>();
    return json({ items: (result.results || []).map(recordPayload), database: "connected" });
  } catch (error) {
    console.error(JSON.stringify({ event: "history_read_failed", message: error instanceof Error ? error.message : String(error) }));
    return json({ items: [], database: "offline", error: "D1 database is unavailable." });
  }
}

async function historyDetail(env: Env, id: number): Promise<Response> {
  try {
    const row = await env.DB.prepare("SELECT * FROM analysis_records WHERE id = ?").bind(id).first<AnalysisRecord>();
    if (!row) throw new ApiError(404, "Signal history item was not found.");
    return json(recordPayload(row));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "Database unavailable.");
  }
}

async function setOutcome(request: Request, env: Env, id: number): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    badRequest("Request body must be valid JSON.");
  }
  const result = (body as { result?: unknown } | null)?.result;
  if (typeof result !== "string" || !OUTCOMES.has(result)) {
    badRequest("Result must be TP1, TP2, SL, SKIP or CLEAR.");
  }
  try {
    const row = await env.DB.prepare("SELECT * FROM analysis_records WHERE id = ?").bind(id).first<AnalysisRecord>();
    if (!row) throw new ApiError(404, "Signal history item was not found.");
    const payload = safeJson(row.payload_json);
    if (result === "CLEAR") delete payload.outcome;
    else payload.outcome = { result, at: new Date().toISOString() };
    const updated = await env.DB.prepare("UPDATE analysis_records SET payload_json = ? WHERE id = ?")
      .bind(JSON.stringify(payload), id).run();
    if (!updated.success) throw new ApiError(503, "Database unavailable.");
    return json(recordPayload({ ...row, payload_json: JSON.stringify(payload) }));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error(JSON.stringify({ event: "outcome_save_failed", message: error instanceof Error ? error.message : String(error) }));
    throw new ApiError(503, "Database unavailable.");
  }
}

function bucket(): { resolved: number; wins: number; losses: number; total_r: number } {
  return { resolved: 0, wins: 0, losses: 0, total_r: 0 };
}

function finish(value: ReturnType<typeof bucket>): JsonRecord {
  return {
    ...value,
    total_r: Math.round(value.total_r * 100) / 100,
    win_rate: value.resolved ? Math.round(1000 * value.wins / value.resolved) / 10 : 0,
    avg_r: value.resolved ? Math.round(100 * value.total_r / value.resolved) / 100 : 0,
  };
}

async function stats(env: Env): Promise<Response> {
  try {
    const response = await env.DB.prepare(
      "SELECT direction, stop_loss, payload_json FROM analysis_records ORDER BY id DESC LIMIT 2000",
    ).all<Pick<AnalysisRecord, "direction" | "stop_loss" | "payload_json">>();
    const total = bucket();
    const byGrade: Record<string, ReturnType<typeof bucket>> = {};
    const byDirection: Record<string, ReturnType<typeof bucket>> = {};
    let unresolved = 0;
    for (const row of response.results || []) {
      if (!["BUY", "SELL"].includes(row.direction) || row.stop_loss === null) continue;
      const result = safeJson(row.payload_json);
      const outcome = (result.outcome as { result?: unknown } | undefined)?.result;
      if (typeof outcome !== "string" || !(outcome in RESULT_R)) {
        if (outcome !== "SKIP") unresolved++;
        continue;
      }
      const value = RESULT_R[outcome];
      const gradeName = typeof result.signal_grade === "string" && result.signal_grade ? result.signal_grade : "-";
      for (const group of [total, byGrade[gradeName] ||= bucket(), byDirection[row.direction] ||= bucket()]) {
        group.resolved++;
        if (value > 0) group.wins++;
        if (value < 0) group.losses++;
        group.total_r += value;
      }
    }
    return json({
      ...finish(total),
      unresolved,
      by_grade: Object.fromEntries(Object.keys(byGrade).sort().map((key) => [key, finish(byGrade[key])])),
      by_direction: Object.fromEntries(Object.entries(byDirection).map(([key, value]) => [key, finish(value)])),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "stats_read_failed", message: error instanceof Error ? error.message : String(error) }));
    return json({ resolved: 0, unresolved: 0, error: "D1 database is unavailable.", by_grade: {}, by_direction: {} });
  }
}

async function chat(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    badRequest("Request body must be valid JSON.");
  }
  const payload = body as { message?: unknown; analysis_id?: unknown } | null;
  const message = payload?.message;
  if (typeof message !== "string" || !message.trim() || message.length > 4000) {
    badRequest("Message must contain between 1 and 4000 characters.");
  }
  const analysisId = payload?.analysis_id;
  if (analysisId !== undefined && analysisId !== null && (!Number.isSafeInteger(analysisId) || Number(analysisId) <= 0)) {
    badRequest("analysis_id must be a positive integer.");
  }
  let context: JsonRecord | null = null;
  let contextId: number | null = null;
  try {
    const row = analysisId
      ? await env.DB.prepare("SELECT id, payload_json FROM analysis_records WHERE id = ?").bind(Number(analysisId)).first<Pick<AnalysisRecord, "id" | "payload_json">>()
      : await env.DB.prepare("SELECT id, payload_json FROM analysis_records ORDER BY id DESC LIMIT 1").first<Pick<AnalysisRecord, "id" | "payload_json">>();
    if (row) {
      context = safeJson(row.payload_json);
      contextId = row.id;
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "chat_context_read_failed", message: error instanceof Error ? error.message : String(error) }));
  }
  try {
    const answer = await chatWithDeepSeek(env, message, context);
    return json({ answer, provider: "DeepSeek", context_analysis_id: analysisId || contextId });
  } catch (error) {
    throw new ApiError(503, error instanceof Error ? error.message : "DeepSeek chat is unavailable.");
  }
}

async function liveMarket(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const interval = url.searchParams.get("interval") || "1m";
  try {
    const market = await fetchLiveMarket(interval);
    return json(calculateLiveScan(market));
  } catch (error) {
    throw new ApiError(503, `Live market data unavailable: ${error instanceof Error ? error.message.slice(0, 320) : String(error).slice(0, 320)}`);
  }
}

async function liveAnalyze(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const interval = url.searchParams.get("interval") || "1m";
  let scan: JsonRecord;
  try {
    scan = calculateLiveScan(await fetchLiveMarket(interval));
  } catch (error) {
    throw new ApiError(503, `Live market data unavailable: ${error instanceof Error ? error.message.slice(0, 320) : String(error).slice(0, 320)}`);
  }
  scan.technical_direction = scan.direction || "WAIT";
  const review = await reviewLiveMarket(env, scan);
  scan.ai_review = review;
  if (review.ok) {
    const aiDirection = String(review.direction || "WAIT");
    if (aiDirection === scan.technical_direction) {
      scan.confluence_status = "AI_AND_TECHNICAL_ALIGNED";
      scan.scan_source = "deepseek_plus_technical_scan";
    } else {
      scan.confluence_status = "AI_TECHNICAL_CONFLICT";
      scan.direction = "WAIT";
      scan.action = "WAIT_FOR_CONFIRMATION";
      scan.setup_rationale = `${String(scan.setup_rationale || "").trim().replace(/;$/, "")}; AI review (${aiDirection}) conflicts with the technical scan (${String(scan.technical_direction)}); waiting for confirmation.`.replace(/^; /, "");
    }
  } else {
    scan.confluence_status = "TECHNICAL_ONLY";
    scan.scan_source = "rule_based_technical_scan";
  }
  const createdAt = new Date().toISOString();
  let id: number | null = null;
  let historySaved = true;
  let historyError: string | null = null;
  try {
    const inserted = await env.DB.prepare(
      `INSERT INTO analysis_records
        (created_at, symbol, tf_primary, tf_secondary, direction, confidence, entry_low, entry_high,
         stop_loss, take_profit_1, take_profit_2, image_primary, image_secondary, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      createdAt, "XAUUSD", String((scan.feed as JsonRecord | undefined)?.timeframe || "M1"), "LIVE",
      String(scan.direction || "WAIT"), finiteNumber(scan.confidence) || 0,
      finiteNumber(scan.entry_low), finiteNumber(scan.entry_high), finiteNumber(scan.stop_loss),
      finiteNumber(scan.take_profit_1), finiteNumber(scan.take_profit_2), "", "", JSON.stringify(scan),
    ).run();
    id = typeof inserted.meta.last_row_id === "number" ? inserted.meta.last_row_id : null;
    if (id === null) { historySaved = false; historyError = "Database did not return the inserted record ID."; }
  } catch (error) {
    historySaved = false;
    historyError = error instanceof Error ? error.message.slice(0, 250) : String(error).slice(0, 250);
    console.error(JSON.stringify({ event: "live_scan_history_save_failed", message: historyError }));
  }
  return json({ id, created_at: createdAt, tf_primary: String((scan.feed as JsonRecord | undefined)?.timeframe || "M1"),
    tf_secondary: "LIVE", history_saved: historySaved, history_error: historyError, analysis: scan });
}

async function liveChat(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { badRequest("Request body must be valid JSON."); }
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message !== "string" || !message.trim() || message.length > 4000) badRequest("Message must contain between 1 and 4000 characters.");

  let currentScan: JsonRecord;
  try {
    currentScan = calculateLiveScan(await fetchLiveMarket("1m"));
  } catch (error) {
    throw new ApiError(503, `Live market data unavailable: ${error instanceof Error ? error.message.slice(0, 260) : String(error).slice(0, 260)}`);
  }
  let savedScan: JsonRecord | null = null;
  try {
    const row = await env.DB.prepare("SELECT payload_json FROM analysis_records WHERE tf_secondary = 'LIVE' ORDER BY id DESC LIMIT 1").first<{ payload_json: string }>();
    if (row?.payload_json) savedScan = safeJson(row.payload_json);
  } catch (error) {
    console.error(JSON.stringify({ event: "live_chat_context_read_failed", message: error instanceof Error ? error.message : String(error) }));
  }
  if (savedScan) {
    currentScan.latest_analyzer_scan = {
      created_at: savedScan.feed && typeof savedScan.feed === "object" ? (savedScan.feed as JsonRecord).fetched_at : null,
      direction: savedScan.direction, technical_direction: savedScan.technical_direction,
      action: savedScan.action, entry_low: savedScan.entry_low, entry_high: savedScan.entry_high,
      stop_loss: savedScan.stop_loss, take_profit_1: savedScan.take_profit_1, take_profit_2: savedScan.take_profit_2,
      confluence_status: savedScan.confluence_status, ai_review: savedScan.ai_review,
    };
  }
  try {
    const answer = await chatWithLiveMarket(env, message, currentScan);
    return json({ answer, provider: "DeepSeek", context: "live-market-terminal", feed_time: (currentScan.feed as JsonRecord | undefined)?.last_bar_time });
  } catch (error) {
    throw new ApiError(503, error instanceof Error ? error.message : "DeepSeek live chat is unavailable.");
  }
}

async function uploadedImage(env: Env, pathname: string): Promise<Response> {
  const name = pathname.slice("/uploads/".length);
  if (!/^[a-f0-9]{32}\.(?:jpg|png|webp)$/.test(name)) throw new ApiError(404, "Image not found.");
  const object = await env.UPLOADS.get(name);
  if (!object) throw new ApiError(404, "Image not found.");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "private, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
}

async function dispatch(request: Request, env: Env): Promise<Response> {
  const requestUrl = new URL(request.url);
  const { pathname } = requestUrl;
  const origin = request.headers.get("Origin");
  if (request.method === "POST" && origin && origin !== requestUrl.origin) {
    throw new ApiError(403, "Cross-origin requests are not allowed.");
  }
  if (pathname === "/favicon.ico") return new Response(null, { status: 204 });
  if (pathname.startsWith("/uploads/")) {
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    return uploadedImage(env, pathname);
  }
  if (pathname === "/api/health" && request.method === "GET") return getHealth(env);
  if (pathname === "/api/live-market" && request.method === "GET") return liveMarket(request);
  if (pathname === "/api/live-analyze" && request.method === "POST") return liveAnalyze(request, env);
  if (pathname === "/api/live-chat" && request.method === "POST") return liveChat(request, env);
  if (pathname === "/api/analyze" && request.method === "POST") return analyze(request, env);
  if (pathname === "/api/history" && request.method === "GET") return history(env, new URL(request.url));
  if (pathname === "/api/stats" && request.method === "GET") return stats(env);
  const outcomeMatch = pathname.match(/^\/api\/history\/(\d+)\/outcome$/);
  if (outcomeMatch && request.method === "POST") return setOutcome(request, env, Number(outcomeMatch[1]));
  const detailMatch = pathname.match(/^\/api\/history\/(\d+)$/);
  if (detailMatch && request.method === "GET") return historyDetail(env, Number(detailMatch[1]));
  if (pathname === "/api/chat" && request.method === "POST") return chat(request, env);
  if (pathname.startsWith("/api/")) return json({ detail: "API endpoint not found." }, 404);
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/api/") || pathname.startsWith("/uploads/")) {
        const denied = authorize(request, env);
        if (denied) return denied;
      }
      return await dispatch(request, env);
    } catch (error) {
      if (error instanceof ApiError) return json({ detail: error.message }, error.status);
      const { pathname } = new URL(request.url);
      console.error(JSON.stringify({
        event: "request_failed",
        path: pathname,
        message: error instanceof Error ? error.message : String(error),
      }));
      return json({ detail: "Request failed. Check the Worker logs for details." }, 500);
    }
  },
};
