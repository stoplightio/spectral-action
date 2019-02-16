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

FROM node:10-slim

ENV NODE_ENV production
COPY --from=builder ./node_modules ./node_modules
COPY --from=builder ./dist ./dist
COPY package.json package.json

ENTRYPOINT [ "npm", "start"]
