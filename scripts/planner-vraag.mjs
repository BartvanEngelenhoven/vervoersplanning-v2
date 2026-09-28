// What the two scripts here share: the Worker's address (from config.js) and the
// planner's code, typed in without it showing on screen, and one question.
import fs from "node:fs";
import readline from "node:readline";
import { Writable } from "node:stream";

// WORKER_URL is for the tests, which run the scripts against a stand-in.
export const workerUrl = process.env.WORKER_URL || new URL(fs.readFileSync(new URL("../config.js", import.meta.url), "utf8").match(/dataUrl:\s*"([^"]+)"/)[1]).origin;

// One reader for the whole script: a second one would find the input already
// taken. What is typed shows on screen, except while the code is asked.
let muted = false;
const screen = new Writable({
  write(chunk, encoding, done) {
    if (!muted) process.stdout.write(chunk);
    done();
  },
});
const reader = readline.createInterface({ input: process.stdin, output: screen, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
// Lines are kept until asked for: pasted or piped in at once, none gets lost.
const lines = [];
let waiting = null;
reader.on("line", (line) => {
  if (waiting) {
    const answer = waiting;
    waiting = null;
    answer(line);
  } else {
    lines.push(line);
  }
});

export async function ask(question, { hidden = false } = {}) {
  process.stdout.write(question);
  muted = hidden;
  const answer = lines.length ? lines.shift() : await new Promise((resolve) => { waiting = resolve; });
  muted = false;
  if (hidden) process.stdout.write("\n");
  return String(answer).trim();
}

export function stop(code = 0) {
  reader.close();
  process.exit(code);
}

export async function callWorker(path, code, body) {
  const response = await fetch(`${workerUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-operator-key": code }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.log(response.status === 401 ? "Die code klopt niet." : `Niet gelukt: ${data.error || response.status}`);
    stop(1);
  }
  return data;
}
