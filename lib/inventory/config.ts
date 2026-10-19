import "server-only";
import { ollamaConfig, ollamaUnavailability } from "@/lib/ai/ollama";

/**
 * Who has Inventory, and whether label photos may be read by a model.
 *
 * INVENTORY_BUSINESSES — the businesses Inventory is switched on for, as
 * organization ids, comma-separated. Empty (the default) means nobody: the nav
 * item is hidden and every inventory page and route answers 404, the same as
 * an address that does not exist. A deliberate list, like CHAT_BOSS_EMAILS,
 * changed only by whoever controls the app service's variables. Which
 * business a person's own stock lives in is their decision; nothing here
 * picks one.
 *
 * INVENTORY_VISION_MODEL — the Ollama model that reads label photos. Setting
 * it is the decision to send label photos to that model. On Ollama Cloud that
 * also needs OLLAMA_CLOUD_CLIENT_DATA=true, the owner's standing decision that
 * Ollama Cloud may be sent client material (lib/ai/engine/registry.ts); a
 * server of our own (OLLAMA_SELF_HOSTED=true) needs only the model. Unset, or
 * not allowed, nothing is sent anywhere and the review form is filled in by
 * hand.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function inventoryBusinesses(): Set<string> {
  return new Set(
    (process.env.INVENTORY_BUSINESSES ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter((id) => UUID.test(id)),
  );
}

export function inventoryEnabledFor(businessId: string | null | undefined): boolean {
  return !!businessId && inventoryBusinesses().has(businessId.toLowerCase());
}

export function visionModel(): string | null {
  return env("INVENTORY_VISION_MODEL") ?? null;
}

/** Why label photos will not be read by a model on this server, or null when they will. */
export function visionUnavailability(): string | null {
  if (!visionModel()) return "No model is set to read labels (INVENTORY_VISION_MODEL).";
  const why = ollamaUnavailability();
  if (why) return why;
  if (!ollamaConfig().selfHosted && env("OLLAMA_CLOUD_CLIENT_DATA") !== "true") {
    return "Label photos stay in 10XiD: Ollama Cloud is not allowed client material (OLLAMA_CLOUD_CLIENT_DATA).";
  }
  return null;
}
