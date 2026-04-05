// Build a compact "prior context" block to prepend to a continue task.
//
// Why this exists: Qwen 2.5 Coder 3B gets confused by multi-turn chat
// histories that contain assistant tool_call JSON. Even when we condense
// the history into clean user/assistant turns, the 3B model tends to
// replay the first action it sees ("user asked to write X → I wrote X")
// instead of responding to the latest user message.
//
// Solution: don't give the model a chat history at all. Give it ONE user
// message that contains a plain-text summary of what was done before,
// followed by the new task. The model sees a single question, so it
// cannot pattern-match on a prior turn.
//
// Produces text like:
//   Previously completed in this session:
//   1. Created examples/a.txt with "hello"
//   2. Listed src/tools entries
//
//   New task:
//   list files in src/
//
// If there is nothing prior, returns an empty string.

export interface Turn {
  task: string;
  summary: string;
}

export function buildPriorContext(turns: Turn[]): string {
  // Only include turns that have a summary (i.e. completed). Skip the
  // current turn (last entry) which has no summary yet.
  const completed = turns.filter(t => t.summary && t.summary.length > 0);
  if (completed.length === 0) return "";
  const lines = completed.map((t, i) => `${i + 1}. ${t.summary}`);
  return `Previously completed in this session:\n${lines.join("\n")}\n\nNew task:\n`;
}
