# The package as a stranger gets it: a machine with no repository, no node_modules and no npm cache of ours. A
# local install shares both with the checkout it was packed from, so it cannot see a dependency that is only ever
# resolved because it is already there, or a file the manifest forgets to ship.
FROM node:22-slim

WORKDIR /app
# Built and packed by the caller (npm pack), so this tests the artifact that would be published, not the source.
ARG TARBALL
COPY ${TARBALL} /tmp/package.tgz
COPY test/files/real-export.fig /app/real-export.fig

RUN npm install --omit=dev /tmp/package.tgz

# No browser is installed on purpose: everything here answers from a local .fig, and a call that needed figma.com
# would have to say so rather than hang.
CMD ["sh", "-c", "\
  set -e; \
  echo '--- the CLI is on PATH and self-describes ---'; \
  ./node_modules/.bin/figma-reader --help | head -3; \
  echo '--- it decodes a file ---'; \
  ./node_modules/.bin/figma-reader get-tree real-export.fig --depth 1; \
  echo '--- text, with the dating a supplied file gets ---'; \
  ./node_modules/.bin/figma-reader get-text real-export.fig | head -4; \
  echo '--- tokens ---'; \
  ./node_modules/.bin/figma-reader get-variables real-export.fig --format css | head -5; \
  echo '--- the MCP server answers tools/list ---'; \
  printf '%s\\n' \
    '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"smoke\",\"version\":\"1\"}}}' \
    '{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}' \
    '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}' \
  | ./node_modules/.bin/figma-reader-mcp | node -e '\
      let out = \"\"; \
      process.stdin.on(\"data\", (d) => (out += d)).on(\"end\", () => { \
        const line = out.split(\"\\n\").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m && m.id === 2); \
        if (!line) { console.error(\"no tools/list answer\"); process.exit(1); } \
        const names = line.result.tools.map((t) => t.name); \
        if (names.length < 10) { console.error(\"too few tools: \" + names.length); process.exit(1); } \
        console.log(names.length + \" tools, including \" + names.slice(0, 3).join(\", \")); \
      });'; \
  echo '--- types are shipped, so importing it is typed ---'; \
  test -f node_modules/@leogcode/figma-reader/dist/tools.d.ts; \
  echo OK \
"]
