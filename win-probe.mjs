// Temporary: how sharply Windows can tell two processes apart by their start time, and what a lookup costs.
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const ps = (cmd) =>
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const start = (pid) => ps(`(Get-Process -Id ${pid}).StartTime.Ticks`);
const timed = (label, fn) => {
  const t = process.hrtime.bigint();
  let r;
  try {
    r = JSON.stringify(fn());
  } catch (e) {
    r = `ERROR ${String(e.message).split("\n")[0]}`;
  }
  console.log(`${label}: ${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(0)} ms -> ${r}`);
};

writeFileSync("wait.mjs", "setTimeout(() => {}, 30_000);\n");
const spawnKid = () => spawn(process.execPath, ["wait.mjs", "--user-data-dir=C:\\some profile\\dir"], { stdio: "ignore" });

console.log("== five children spawned back to back ==");
const kids = [0, 1, 2, 3, 4].map(spawnKid);
await new Promise((r) => setTimeout(r, 400));
const ticks = kids.map((k) => start(k.pid));
for (let i = 0; i < kids.length; i++) console.log(`  pid ${kids[i].pid} start ${ticks[i]}${i ? ` (+${Number(BigInt(ticks[i] || 0) - BigInt(ticks[i - 1] || 0)) / 10_000} ms)` : ""}`);
console.log(`  distinct: ${new Set(ticks).size} of ${ticks.length}`);
for (const k of kids) k.kill();

console.log("== children spaced apart ==");
let prev;
for (const gap of [0, 1, 5, 20, 100]) {
  await new Promise((r) => setTimeout(r, gap));
  const k = spawnKid();
  await new Promise((r) => setTimeout(r, 250));
  const t = start(k.pid);
  console.log(`  after ${gap} ms: pid ${k.pid} start ${t}${prev ? ` (+${Number(BigInt(t || 0) - BigInt(prev)) / 10_000} ms)` : ""}`);
  prev = t || prev;
  k.kill();
}

console.log("== batching, and the shape of the value ==");
const live = [0, 1, 2].map(spawnKid);
await new Promise((r) => setTimeout(r, 300));
timed("one pid", () => start(live[0].pid));
timed("three pids in one call", () => ps(`Get-Process -Id ${live.map((k) => k.pid).join(",")} | ForEach-Object { "$($_.Id) $($_.StartTime.Ticks)" }`));
timed("three pids, one of them gone", () => ps(`Get-Process -Id ${[live[0].pid, 999999, live[1].pid].join(",")} | ForEach-Object { "$($_.Id) $($_.StartTime.Ticks)" }`));
console.log(`  value contains ':' or '|': ${/[:|]/.test(start(live[0].pid))}`);
console.log(`  full path: ${ps(`(Get-Process -Id ${live[0].pid}).Path`)}`);
for (const k of live) k.kill();

console.log("== powershell without PATH, and its own startup ==");
timed("full path to Windows PowerShell", () =>
  execFileSync(`${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ["-NoProfile", "-NonInteractive", "-Command", "$PID"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim(),
);
console.log(`  version: ${ps("$PSVersionTable.PSVersion.ToString()")}`);
