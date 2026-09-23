# A machine laid out the way Ubuntu lays one out: /usr/bin/chromium is a link into a snap, and a native browser is
# installed beside it. No test machine has that shape -- /snap cannot be created without root -- so the ordering it
# decides is otherwise only testable as strings.
FROM node:22-slim

# The confined build: present, executable, and it exits without ever opening a DevTools port, which is what the
# real one does when it cannot reach a profile outside its sandbox.
RUN mkdir -p /snap/bin \
  && printf '#!/bin/sh\nexit 1\n' > /snap/bin/chromium \
  && chmod 755 /snap/bin/chromium \
  && ln -sf /snap/bin/chromium /usr/bin/chromium

WORKDIR /app
COPY test/docker/fake-browser.js /opt/fake-browser.js

# The native build, which starts. Named google-chrome-stable, which the preference order puts AFTER chromium: only
# the demotion can put it first, so the test cannot pass by accident of naming.
RUN printf '#!/bin/sh\nFAKE_BROWSER_NAME=native exec node /opt/fake-browser.js "$@"\n' > /usr/bin/google-chrome-stable \
  && chmod 755 /usr/bin/google-chrome-stable

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY test/docker/picker.test.ts ./test/docker/picker.test.ts

# Runs as root on purpose: several tests skip when a user can signal pid 1, and this is where that branch runs.
CMD ["node", "--test", "--test-timeout=30000", "test/docker/picker.test.ts"]
