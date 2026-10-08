"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-reads the page every few seconds while a publish is running, so the
 * deploy card goes from "building" to "live" without anyone pressing reload.
 * Stops on its own once the page no longer renders it.
 */
export function RefreshWhileRunning({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);
  return null;
}
