"use client";

/**
 * Public embed route for AI Phil.
 *
 * Loaded inside an iframe by /public/ai-phil-embed.js.
 * No auth required — the widget's backend proxies handle rate-limiting.
 *
 * Params:
 *   ?context=member|discovery   (default: member)
 */

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AIPhilWidget } from "@/components/ai-phil-widget";

function WidgetLoader() {
  const params = useSearchParams();
  const raw = params.get("context");
  const context = (
    raw === "discovery" || raw === "implementation" || raw === "new-member"
      ? raw
      : "member"
  ) as "member" | "discovery" | "implementation" | "new-member";
  return <AIPhilWidget context={context} />;
}

export default function EmbedPage() {
  return (
    <Suspense fallback={null}>
      <WidgetLoader />
    </Suspense>
  );
}
