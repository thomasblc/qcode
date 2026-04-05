const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

export const log = {
  info: (msg: string) => console.log(`${DIM}${ts()}${RESET} ${CYAN}info${RESET}  ${msg}`),
  warn: (msg: string) => console.log(`${DIM}${ts()}${RESET} ${YELLOW}warn${RESET}  ${msg}`),
  error: (msg: string) => console.error(`${DIM}${ts()}${RESET} ${RED}error${RESET} ${msg}`),
  ok: (msg: string) => console.log(`${DIM}${ts()}${RESET} ${GREEN}ok${RESET}    ${msg}`),
  raw: (msg: string) => process.stdout.write(msg),
};
