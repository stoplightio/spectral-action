FROM node:10 as builder

LABEL com.github.actions.name="Spectral checks"
LABEL com.github.actions.description="Lint your JSON and OAS2/3 files"
LABEL com.github.actions.icon="code"
LABEL com.github.actions.color="yellow"

LABEL maintainer="Vincenzo Chianese <vincenz.chianese@icloud.com>"


COPY package* ./
RUN npm ci

COPY src ./src
COPY tsconfig.json ./tsconfig.json

RUN ./node_modules/.bin/tsc

FROM node:10 as installer

ENV NODE_ENV production
COPY package.json package.json
RUN npm install --production

FROM node:10 as runtime
ENV NODE_ENV production
COPY package.json package.json
COPY --from=builder ./dist ${GITHUB_WORKSPACE:-./}dist
COPY --from=installer ./node_modules ${GITHUB_WORKSPACE:-./}node_modules

ENTRYPOINT [ "npm", "start"]
