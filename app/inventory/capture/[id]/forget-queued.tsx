"use client";

import { useEffect } from "react";
import { forgetCapture } from "./photo-queue";

/**
 * On an item that is saved or discarded, nothing more can be added: whatever
 * this phone still kept for it is dropped, so it is not kept forever.
 */
export function ForgetQueuedPhotos({ captureId }: { captureId: string }) {
  useEffect(() => {
    void forgetCapture(captureId);
  }, [captureId]);
  return null;
}
