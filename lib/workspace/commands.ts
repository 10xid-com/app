/**
 * The workspace's modes and commands, and exactly what each one does.
 *
 * Client-safe on purpose: the composer shows these same words before anything
 * is sent, and the receipts panel shows them after. A command is a recorded
 * choice with a fixed, visible instruction — never a hidden prompt slipped in
 * behind the person's back.
 */

export type WorkspaceMode = "ask" | "plan";

export const MODE_SPECS: Record<
  WorkspaceMode | "build",
  { label: string; summary: string; instruction: string; enabled: boolean }
> = {
  ask: {
    label: "Ask",
    summary: "Reads the client's records and answers with citations. Changes nothing.",
    instruction:
      "MODE: ASK. Answer the question using the 10XiD records you can look up with your tools and any context provided. " +
      "Cite every fact you take from a record as [JOB ROT-0001] using its reference. If the records do not contain the " +
      "answer, say so plainly instead of guessing. You cannot change anything, and must not offer to.",
    enabled: true,
  },
  plan: {
    label: "Plan",
    summary: "Inspects the context and writes a step-by-step plan. Changes nothing.",
    instruction:
      "MODE: PLAN. Produce an implementation plan: numbered steps, and for each step the file or record it concerns, " +
      "what changes and why, and how to check it worked. Cite records as [JOB ROT-0001]. Nothing is changed in this " +
      "mode — write the plan only, and say which facts you could not confirm.",
    enabled: true,
  },
  build: {
    label: "Build",
    summary: "Will propose patches on an isolated branch. Disabled until approval, audit and rollback exist.",
    instruction: "",
    enabled: false,
  },
};

export type CommandId = "review" | "explain" | "plan" | "test";

export const COMMAND_SPECS: Record<
  CommandId,
  { label: string; summary: string; instruction: string; switchesTo?: WorkspaceMode }
> = {
  review: {
    label: "/review",
    summary: "Reviews the selected context for bugs, risks and unclear parts.",
    instruction:
      "COMMAND: REVIEW. Review the material in context. List concrete problems — bugs, risks, missing cases, unclear " +
      "parts — most serious first, each with where it is and why it matters. Say plainly if you found nothing serious.",
  },
  explain: {
    label: "/explain",
    summary: "Explains how the selected context works, in plain language.",
    instruction:
      "COMMAND: EXPLAIN. Explain how the material in context works, in plain language for a non-specialist, from the " +
      "overall purpose down to the important details. Define any term you have to use.",
  },
  plan: {
    label: "/plan",
    summary: "Switches this conversation to Plan mode and asks for a plan.",
    instruction: "COMMAND: PLAN. Write the plan described by Plan mode for the request below.",
    switchesTo: "plan",
  },
  test: {
    label: "/test",
    summary: "Proposes the tests that would prove the selected context works.",
    instruction:
      "COMMAND: TEST. Propose the tests that would show the material in context works: what each test checks, the " +
      "input, the expected result, and which failure it would catch. Do not claim any test has been run.",
  },
};

/** "/review tighten the copy" → { command: "review", rest: "tighten the copy" }. */
export function parseCommand(text: string): { command: CommandId | null; rest: string } {
  const match = /^\/(review|explain|plan|test)\b\s*/i.exec(text.trimStart());
  if (!match) return { command: null, rest: text };
  return { command: match[1]!.toLowerCase() as CommandId, rest: text.trimStart().slice(match[0].length) };
}
