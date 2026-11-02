import assert from "node:assert/strict";
import test from "node:test";
import { buildTradeRead } from "../worker/trade-engine.ts";

const env = {
  APP_NAME: "JD ANALYSIS",
  MAX_UPLOAD_MB: "12",
  CONFIDENCE_MINIMUM: "65",
  PRICE_AGREEMENT_ABSOLUTE: "0.50",
  ATR_AGREEMENT_PERCENT: "0.20",
  FORCE_SIGNAL: "false",
} as const;

function provider(direction: string, overrides: Record<string, unknown> = {}) {
  return {
    provider: "Gemini",
    model: "test-model",
    direction,
    confidence: 72,
    setup_rationale: "Visible structure test.",
    timeframe_alignment: "aligned",
    chart_reads: [
      {
        symbol_detected: "XAUUSD",
        current_price: 2350,
        current_price_readable: true,
        atr_value: 2,
        atr_visible: true,
        atr_period: 14,
        price_scale_top: 2360,
        price_scale_bottom: 2340,
        price_scale_readable: true,
        trend: "bullish",
        structure: "Higher highs and higher lows.",
        annotations: [],
      },
      {
        symbol_detected: "XAUUSD",
        current_price: 2350.1,
        current_price_readable: true,
        atr_value: 4,
        atr_visible: true,
        atr_period: 14,
        price_scale_top: 2370,
        price_scale_bottom: 2330,
        price_scale_readable: true,
        trend: "bullish",
        structure: "Higher timeframe bullish structure.",
        annotations: [],
      },
    ],
    pullback_zones: {
      BUY: { low: 2344.5, high: 2346, quality: "estimated", basis: "Support retest." },
      SELL: { low: 2353, high: 2354.5, quality: "estimated", basis: "Resistance retest." },
    },
    entry_trigger_buy: "Break the recent swing high and retest.",
    entry_trigger_sell: "Break below the recent swing low and fail the retest.",
    ...overrides,
  };
}

test("strict mode calculates screenshot levels only after all verification checks pass", () => {
  const result = buildTradeRead([provider("BUY")], {}, "M1", "M5", env);
  assert.equal(result.direction, "BUY");
  assert.equal(result.levels_available, true);
  assert.equal(result.trade_ready, false);
  assert.equal(result.entry_price, 2350);
  assert.equal(result.validation && (result.validation as Record<string, unknown>).levels_calculated, true);
});

test("strict mode keeps conditional scenarios and withholds levels for unreadable prices", () => {
  const item = provider("WAIT");
  const chartReads = item.chart_reads.map((read) => ({
    ...read,
    current_price: null,
    current_price_readable: false,
    atr_value: null,
    atr_visible: false,
  }));
  const result = buildTradeRead([provider("WAIT", { chart_reads: chartReads })], {}, "M1", "M5", env);
  const setups = result.conditional_setups as Array<Record<string, unknown>>;
  assert.equal(result.direction, "WAIT");
  assert.equal(result.levels_available, false);
  assert.deepEqual(setups.map((setup) => setup.direction), ["BUY", "SELL"]);
  assert.equal(setups[0].pullback_low, 2344.5);
});

test("forced mode produces best-effort levels from axis estimates and marks the signal provisional", () => {
  const forcedEnv = { ...env, FORCE_SIGNAL: "true" };
  const item = provider("BUY", {
    chart_reads: [
      { trend: "bullish", confidence: 60, price_estimate: 2350, atr_estimate: 2, price_scale_top: 2360, price_scale_bottom: 2340, price_scale_readable: true },
      { trend: "bullish", confidence: 60, price_estimate: 2350.1, atr_estimate: 4, price_scale_top: 2370, price_scale_bottom: 2330, price_scale_readable: true },
    ],
  });
  const result = buildTradeRead([item], {}, "M1", "M5", forcedEnv);
  assert.equal(result.direction, "BUY");
  assert.equal(result.forced_signal, true);
  assert.equal(result.trade_ready, false);
  assert.equal(result.levels_available, true);
  assert.equal(result.entry_price, 2350);
  assert.ok(["C", "D"].includes(String(result.signal_grade)));
});
