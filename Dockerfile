# tigerquiz — self-hosted live quiz server
#
# node:sqlite is a built-in module, so this needs no native build toolchain.
# Runs as an unprivileged uid matching the host owner of the bind-mounted
# quizzes/ and data/ directories.
#
# Keep the major in step with .node-version, which is what CI reads: the
# TypeScript definitions in @types/node are pinned to the same major, and types
# ahead of the runtime would accept APIs that are not there at run time.

# Pinned by digest so a rebuild cannot silently move Node version. This is
# node:26-alpine (v26.8.2); re-pin with:
#   docker pull node:26-alpine && docker inspect node:26-alpine --format '{{index .RepoDigests 0}}'
FROM node@sha256:ef24c5053d50fdc3e4e56eb4e7ddb7861874ab0fdc797046ba897581deb8e868

ENV NODE_ENV=production
WORKDIR /app

# dependencies first, so editing the app does not reinstall them
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY tools ./tools

# quizzes/ and data/ are bind-mounted in compose; these are the fallback
# contents so the image also runs standalone.
#
# Both have to be writable by the unprivileged user set below: the report
# database is created in data/ at startup, and saving a quiz or building a
# review quiz writes into quizzes/. Without the chown the image starts as root,
# switches to node, and dies on "unable to open database file".
COPY quizzes ./quizzes
RUN mkdir -p data && chown -R node:node data quizzes

EXPOSE 3000

# never run as root; compose overrides this to match the host owner of the
# mounted quizzes/ and data/ directories
USER node

CMD ["node", "server.js"]
