"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

/**
 * A form's submit button that says it is working while the form is sent, and
 * cannot be pressed again until the answer comes back.
 *
 * For actions that take a moment — Publish asks the website, which asks
 * GitHub — where a button that does not react looks broken and gets pressed
 * again: every extra Publish queued another full rebuild of the site. The form
 * itself stays a server form with its CSRF field; only the button is client.
 */
export function SubmitButton({
  children,
  pendingLabel,
  disabled = false,
  className,
}: {
  children: ReactNode;
  pendingLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={disabled || pending} aria-busy={pending} className={className}>
      {pending ? pendingLabel : children}
    </button>
  );
}
