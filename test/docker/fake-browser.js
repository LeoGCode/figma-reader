// A browser as far as BrowserManager is concerned: it writes DevToolsActivePort into the profile it was given and
// answers /json/version. Enough to prove which executable a launch settled on, without a real Chromium and the
// sandbox arguments one needs in a container -- what is under test here is the choosing, not the browsing.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv.find((a) => a.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
if (!dir) process.exit(2);
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`, "User-Agent": "fake" }));
});
server.listen(0, "127.0.0.1", () => {
  mkdirSync(dir, { recursive: true });
  // Chromium's format: port on the first line, the browser's ws path on the second.
  writeFileSync(join(dir, "DevToolsActivePort"), `${server.address().port}\n/devtools/browser/fake\n`);
  // Name the process so the test can see which executable is running, the way SingletonLock names a real one.
  writeFileSync(join(dir, "started-by"), process.env.FAKE_BROWSER_NAME ?? "unknown");
});
