/**
 * A live check of the label reader against the configured Ollama server, with
 * a FABRICATED label only (scripts/fixtures/synthetic-label.jpg): no one's
 * stock, no database, no store, nothing written anywhere.
 *
 *   INVENTORY_VISION_MODEL=gemma4:31b OLLAMA_API_KEY=… npx tsx scripts/check-label-reader.ts
 *
 * or, with the app service's own variables and nothing pasted:
 *
 *   railway run npx tsx scripts/check-label-reader.ts
 *
 * It runs the code the portal runs (lib/inventory/label-reader.ts): whether
 * the model can see images, the reading request, how the answer is parsed and
 * held to the schema. It prints the request's shape, what was read, and whether
 * each field matches the fabricated label. It never prints the key.
 *
 * Exit 0 when the model sees images and every expected field matches; 1
 * otherwise; 2 when it is not configured.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { askModel, checkVision, fieldsFromReading, readingRequest, type ReaderServer } from "../lib/inventory/label-reader";

const env = (name: string) => process.env[name]?.trim() || undefined;

const model: string = env("INVENTORY_VISION_MODEL") ?? "";
const server: ReaderServer = {
  // The same variables, and the same defaults, as lib/ai/ollama.ts.
  baseUrl: (env("OLLAMA_BASE_URL") ?? "https://ollama.com").replace(/\/+$/, ""),
  apiKey: env("OLLAMA_API_KEY"),
  selfHosted: env("OLLAMA_SELF_HOSTED") === "true",
};
if (!model) {
  console.error("Set INVENTORY_VISION_MODEL (and OLLAMA_API_KEY for Ollama Cloud).");
  process.exit(2);
}

/** What the fabricated label says. */
const EXPECTED: Record<string, (value: unknown) => boolean> = {
  product_name: (v) => typeof v === "string" && /citric acid powder/i.test(v),
  brand: (v) => typeof v === "string" && /example pantry/i.test(v),
  manufacturer: (v) => typeof v === "string" && /example foods/i.test(v),
  net_quantity: (v) => JSON.stringify(v) === JSON.stringify({ amount: 250, unit: "g" }),
  lot_code: (v) => typeof v === "string" && /^(lot\s*)?test-1042$/i.test(v.trim()),
  expiry: (v) => (v as { date?: unknown } | null)?.date === "2028-03-31",
};

async function main(): Promise<number> {
  const image = (await readFile(join(__dirname, "fixtures", "synthetic-label.jpg"))).toString("base64");
  const shape = readingRequest(model, ["<1 synthetic image>"], server);
  console.log(`Server: ${server.baseUrl} (${server.selfHosted ? "self-hosted" : "Ollama Cloud"}), model ${model}`);
  console.log(
    `Request: stream=${shape.stream} think=${shape.think} temperature=${shape.options.temperature} format=${"format" in shape ? "JSON schema" : "none (schema in the prompt)"}`,
  );

  const started = Date.now();
  const vision = await checkVision(server, model, fetch);
  if (!vision.ok) {
    console.log(`FAIL  sees images: ${vision.reason}`);
    return 1;
  }
  console.log(`PASS  sees images (${vision.how === "capabilities" ? "/api/show lists vision" : "named the colour of a red test square"})`);

  let answer: unknown;
  try {
    answer = await askModel(server, model, [image], fetch);
  } catch (err) {
    console.log(`FAIL  reading: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const fields = fieldsFromReading(answer, ["synthetic-label"]);
  const byName = new Map(fields.map((f) => [f.field, f]));
  let ok = true;
  for (const [name, matches] of Object.entries(EXPECTED)) {
    const f = byName.get(name as never);
    const good = !!f && matches(f.value);
    ok &&= good;
    console.log(`${good ? "PASS" : "FAIL"}  ${name}: ${f ? JSON.stringify(f.value) : "(not read)"}${f?.confidence != null ? `  confidence ${f.confidence}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${fields.length} fields kept after validation, in ${Date.now() - started} ms`);
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
