/**
 * The address photo uploads had before they moved to /api/social/photos (for
 * Instagram and Facebook alike). Kept so a page loaded before that deploy,
 * still open in someone's browser, keeps working: it is the same handler,
 * with the same guard, not a second one.
 */
export { POST, dynamic } from "@/app/api/social/photos/route";
