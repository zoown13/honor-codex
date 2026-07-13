import type { MetadataRoute } from "next";
import { PILOT_PATH } from "../lib/config";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "병역명문가 혜택찾기",
    short_name: "명문가 혜택",
    description: "내 주변과 전국의 병역명문가 혜택을 쉽게 찾는 비공개 파일럿",
    start_url: PILOT_PATH,
    scope: "/",
    display: "standalone",
    background_color: "#f5f7f2",
    theme_color: "#173f35",
    orientation: "portrait-primary",
    lang: "ko-KR",
    categories: ["government", "lifestyle", "travel"],
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable"
      }
    ],
  };
}
