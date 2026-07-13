import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PilotApp } from "../../../components/pilot-app";
import { PILOT_SLUG } from "../../../lib/config";

export const dynamicParams = false;

export const metadata: Metadata = {
  title: "내 주변 혜택",
  robots: { index: false, follow: false, nocache: true }
};

export function generateStaticParams() {
  return [{ slug: PILOT_SLUG }];
}

export default async function PilotPage({
  params
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  if (slug !== PILOT_SLUG) notFound();

  return <PilotApp slug={slug} />;
}
