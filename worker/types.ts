export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  UPLOADS: R2Bucket;
  APP_NAME?: string;
  APP_PASSWORD?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_VISION_MODEL?: string;
  DEEPSEEK_CHAT_MODEL?: string;
  MAX_UPLOAD_MB?: string;
  CONFIDENCE_MINIMUM?: string;
  PRICE_AGREEMENT_ABSOLUTE?: string;
  ATR_AGREEMENT_PERCENT?: string;
  FORCE_SIGNAL?: string;
}

export type JsonRecord = Record<string, unknown>;

export interface AnalysisRecord {
  id: number;
  created_at: string;
  symbol: string;
  tf_primary: string;
  tf_secondary: string;
  direction: string;
  confidence: number;
  entry_low: number | null;
  entry_high: number | null;
  stop_loss: number | null;
  take_profit_1: number | null;
  take_profit_2: number | null;
  image_primary: string;
  image_secondary: string;
  payload_json: string;
}

export interface ChartImage {
  mimeType: string;
  base64: string;
  key: string;
}
