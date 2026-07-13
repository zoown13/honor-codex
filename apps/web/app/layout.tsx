import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ServiceWorkerRegistration } from "../components/service-worker-registration";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "병역명문가 혜택찾기",
    template: "%s · 병역명문가 혜택찾기"
  },
  description: "내 주변 병역명문가 예우시설과 전국·지자체 혜택을 한눈에 확인하세요.",
  applicationName: "병역명문가 혜택찾기",
  manifest: "/manifest.webmanifest",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true }
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "명문가 혜택"
  },
  formatDetection: { telephone: true, address: false, email: false }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f7f2" },
    { media: "(prefers-color-scheme: dark)", color: "#15231f" }
  ],
  colorScheme: "light"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ko">
      <body>
        <a className="skip-link" href="#main-content">
          본문으로 바로가기
        </a>
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
