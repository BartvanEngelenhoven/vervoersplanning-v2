// What the two scripts here share: the Worker's address (from config.js) and the
// planner's code, typed in without it showing on screen, and one question.
import fs from "node:fs";
import readline from "node:readline/promises";

export const workerUrl = new URL(fs.readFileSync(new URL("../config.js", import.meta.url), "utf8").match(/dataUrl:\s*"([^"]+)"/)[1]).origin;

export async function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (text) => write(text.startsWith(question) ? question : "");
  }
  const answer = await rl.question(question);
  rl.close();
  if (hidden) process.stdout.write("\n");
  return answer.trim();
}

export async function callWorker(path, code, body) {
  const response = await fetch(`${workerUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-operator-key": code }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.log(response.status === 401 ? "Die code klopt niet." : `Niet gelukt: ${data.error || response.status}`);
    process.exit(1);
  }
  return data;
}
