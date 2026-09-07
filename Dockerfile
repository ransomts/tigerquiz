# tigerquiz — self-hosted live quiz server
#
# node:sqlite is a built-in module, so this needs Node 22+ and no native build
# toolchain. Runs as an unprivileged uid matching the host owner of the
# bind-mounted quizzes/ and data/ directories.

FROM node:24-alpine

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

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
