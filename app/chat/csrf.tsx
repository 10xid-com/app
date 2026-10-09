"use client";

import { createContext, useContext } from "react";
import { CSRF_FIELD } from "@/lib/auth/csrf-names";

/**
 * The session's CSRF token for Chat Boss's browser-side forms and requests.
 *
 * Server components put it in a form with <CsrfField />; these forms are
 * client components, so the page hands the token down once (WorkspaceData
 * .csrf) and every form takes it from here. Server actions and the workspace
 * routes refuse anything without it (lib/auth/authorize.ts, step 3).
 */
const CsrfContext = createContext("");

export const CsrfProvider = CsrfContext.Provider;

export function CsrfInput() {
  return <input type="hidden" name={CSRF_FIELD} value={useContext(CsrfContext)} />;
}

/** The token itself, for a server action called from code rather than a form. */
export function useCsrf() {
  return useContext(CsrfContext);
}
