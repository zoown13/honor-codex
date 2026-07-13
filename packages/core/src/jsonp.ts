import type { MmaFacilityPayload, RawMmaFacility } from "./types.ts";

export interface JsonpOptions {
  expectedCallback?: string;
  allowPlainJson?: boolean;
  maxBytes?: number;
}

const CALLBACK_PATTERN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

export function parseJsonp<T>(input: string, options: JsonpOptions = {}): T {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  if (new TextEncoder().encode(input).byteLength > maxBytes) {
    throw new Error(`JSONP payload exceeds ${maxBytes} bytes`);
  }

  const text = input.replace(/^\uFEFF/, "").trim();
  if ((options.allowPlainJson ?? true) && (text.startsWith("{") || text.startsWith("["))) {
    return JSON.parse(text) as T;
  }

  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open <= 0 || close <= open || !/^\s*;?\s*$/.test(text.slice(close + 1))) {
    throw new Error("Invalid JSONP wrapper");
  }

  const callback = text.slice(0, open).trim();
  if (!CALLBACK_PATTERN.test(callback)) throw new Error("Invalid JSONP callback name");
  if (options.expectedCallback !== undefined && callback !== options.expectedCallback) {
    throw new Error(`Unexpected JSONP callback: ${callback}`);
  }

  return JSON.parse(text.slice(open + 1, close).trim()) as T;
}

export function parseMmaFacilityPayload(input: string, expectedCallback?: string): MmaFacilityPayload {
  const parsed = parseJsonp<unknown>(input, {
    ...(expectedCallback === undefined ? {} : { expectedCallback }),
  });
  if (!isRecord(parsed) || parsed.success !== true || !Array.isArray(parsed.list)) {
    throw new Error("MMA facility payload schema changed or request failed");
  }

  const list = parsed.list.map((item, index): RawMmaFacility => {
    if (!isRecord(item) || !nonEmptyString(item.mmgudgigwan_cd) || !nonEmptyString(item.udae_ggm)) {
      throw new Error(`Invalid MMA facility at index ${index}`);
    }
    return item as RawMmaFacility;
  });
  return { success: true, list };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
