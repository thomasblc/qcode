import type { Tool } from "./types.js";

// Conversational reply. Use for small-talk, greetings, clarification questions,
// explaining something without touching files. This is the agent's way of
// "just talking back" without doing any real work.
//
// Returning a reply ends the turn (like done), but the UI renders it as an
// assistant chat bubble instead of a task summary.
export const reply: Tool = {
  name: "reply",
  description: "Reply to the user with plain text. Use for greetings, clarification questions, or answers that need no tool calls. Ends the turn. args: { text: string }",
  needsApproval: false,
  async run(args) {
    const text = String(args.text ?? "").trim();
    if (!text) return { ok: false, error: "reply text is empty" };
    return { ok: true, text };
  },
};
