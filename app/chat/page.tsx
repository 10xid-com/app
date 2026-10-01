import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/require";
import { AUTO, CHAT_MODELS, modelLabel } from "@/lib/ai/models";
import { chatIsConfigured } from "@/lib/ai/openrouter";
import { PortalShell } from "../portal-shell";
import { ChatBox } from "./chat-box";

export const metadata: Metadata = { title: "Chat" };

/**
 * An AI chat box for staff, and where staff land after signing in.
 *
 * Staff only: clients are sent to their dashboard. The route behind the box
 * makes the same check, so this redirect is courtesy, not the lock.
 */
export default async function ChatPage() {
  const ctx = await requireSession("/chat");
  if (!ctx.scope.isStaff) redirect("/dashboard");

  return (
    <PortalShell email={ctx.email} isStaff>
      {chatIsConfigured() ? (
        <ChatBox
          models={[
            // Auto first, so it is the default: whichever free model is
            // answering. Picking one by hand is still there for comparing.
            { id: AUTO, label: modelLabel(AUTO) },
            ...CHAT_MODELS.map((m) => ({ id: m.id, label: m.label })),
          ]}
        />
      ) : (
        <div className="rounded-xl border border-warn/30 bg-warn/10 p-4 text-sm text-ink">
          <h1 className="text-base font-semibold">The chat is not set up yet</h1>
          <p className="mt-1 text-ink-soft">
            It needs an OpenRouter API key in the <code>OPENROUTER_API_KEY</code>{" "}
            setting on the server. Until then nothing is sent anywhere.
          </p>
        </div>
      )}
    </PortalShell>
  );
}
