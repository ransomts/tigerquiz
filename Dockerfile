# tigerquiz — self-hosted live quiz server
#
# node:sqlite is a built-in module, so this needs Node 22+ and no native build
# toolchain. Runs as an unprivileged uid matching the host owner of the
# bind-mounted quizzes/ and data/ directories.

# Pinned by digest so a rebuild cannot silently move Node version. This is
# node:24-alpine; re-pin with:
#   docker pull node:24-alpine && docker inspect node:24-alpine --format '{{index .RepoDigests 0}}'
FROM node@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

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
# contents so the image also runs standalone
COPY quizzes ./quizzes
RUN mkdir -p data

EXPOSE 3000

# never run as root; compose overrides this to match the host owner of the
# mounted quizzes/ and data/ directories
USER node

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
