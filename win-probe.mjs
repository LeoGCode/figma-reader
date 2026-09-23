// Temporary: what Windows can answer about a process, and what asking costs.
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

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

const code = (pid) => {
  try {
    process.kill(pid, 0);
    return "ok";
  } catch (e) {
    return e.code;
  }
};

console.log("== process.kill(pid, 0) ==");
for (const pid of [0, 1, 4, 8, 100, process.pid, process.ppid, 999999]) console.log(`  ${pid} -> ${code(pid)}`);

const rows = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" })
  .split("\n")
  .map((l) => l.split('","'))
  .filter((r) => r.length > 2)
  .map((r) => [r[0].replace(/"/g, ""), Number(r[1])]);
console.log(`  running processes: ${rows.length}`);
const notOk = rows.filter(([, p]) => code(p) !== "ok");
console.log(`  not "ok": ${notOk.map(([n, p]) => `${p} ${n} ${code(p)}`).join(", ") || "(none)"}`);

const ps = (cmd) =>
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const wmic = (...args) => execFileSync("wmic", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

console.log("== cost of one lookup ==");
timed("powershell Get-Process StartTime.Ticks (cold)", () => ps(`(Get-Process -Id ${process.pid}).StartTime.Ticks`));
timed("powershell Get-Process StartTime.Ticks", () => ps(`(Get-Process -Id ${process.pid}).StartTime.Ticks`));
timed("powershell Get-Process StartTime.Ticks", () => ps(`(Get-Process -Id ${process.pid}).StartTime.Ticks`));
timed("powershell CIM CreationDate.Ticks", () => ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}").CreationDate.Ticks`));
timed("powershell CIM CommandLine", () => ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}").CommandLine`));
timed("powershell Get-Process both", () => ps(`$p=Get-Process -Id ${process.pid};"$($p.StartTime.Ticks)"`));
timed("wmic CreationDate", () => wmic("process", "where", `processid=${process.pid}`, "get", "CreationDate", "/value"));
timed("wmic CommandLine", () => wmic("process", "where", `processid=${process.pid}`, "get", "CommandLine", "/value"));
timed("tasklist one pid", () => execFileSync("tasklist", ["/FO", "CSV", "/NH", "/FI", `PID eq ${process.pid}`], { encoding: "utf8" }).trim());

console.log("== a pid that does not exist ==");
timed("powershell StartTime of 999999", () => ps("(Get-Process -Id 999999).StartTime.Ticks"));
timed("powershell CIM of 999999", () => ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=999999").CommandLine`));
timed("wmic of 999999", () => wmic("process", "where", "processid=999999", "get", "CreationDate", "/value"));

console.log("== a process this user did not start ==");
for (const [name, pid] of [["System", 4], ...notOk.slice(0, 3), ...rows.slice(0, 3)]) {
  timed(`  StartTime of ${pid} ${name}`, () => ps(`(Get-Process -Id ${pid}).StartTime.Ticks`));
  timed(`  CIM CreationDate of ${pid} ${name}`, () => ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.Ticks`));
}

console.log("== resolution, and the command line of a child we spawn ==");
writeFileSync("wait.mjs", "setTimeout(() => {}, 20_000);\n");
const kids = [0, 1].map(() => spawn(process.execPath, ["wait.mjs", "--user-data-dir=C:\\some profile\\dir"], { stdio: "ignore" }));
await new Promise((r) => setTimeout(r, 300));
for (const kid of kids) {
  console.log(`  pid ${kid.pid} start ${ps(`(Get-Process -Id ${kid.pid}).StartTime.Ticks`)}`);
  console.log(`  pid ${kid.pid} cmdline ${ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${kid.pid}").CommandLine`)}`);
  console.log(`  pid ${kid.pid} wmic cmdline ${wmic("process", "where", `processid=${kid.pid}`, "get", "CommandLine", "/value")}`);
}
for (const kid of kids) kid.kill();
console.log("== what a dead pid answers after it exits ==");
await new Promise((r) => setTimeout(r, 500));
console.log(`  kill(${kids[0].pid},0) -> ${code(kids[0].pid)}`);
timed("  StartTime of the exited child", () => ps(`(Get-Process -Id ${kids[0].pid}).StartTime.Ticks`));
