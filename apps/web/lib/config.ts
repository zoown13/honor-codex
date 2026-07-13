export const PILOT_SLUG =
  process.env.NEXT_PUBLIC_PILOT_SLUG?.trim() || "honor-family-pilot-demo";

export const PILOT_PATH = `/pilot/${PILOT_SLUG}/`;
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "";
export const KAKAO_MAP_APP_KEY = process.env.NEXT_PUBLIC_KAKAO_MAP_APP_KEY?.trim() ?? "";
export const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() ?? "";

export const IS_MOCK_API = API_BASE_URL.length === 0;
