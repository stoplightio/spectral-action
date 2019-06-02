FROM node:12 as builder

LABEL com.github.actions.name="Spectral checks"
LABEL com.github.actions.description="Lint your JSON and OAS2/3 files"
LABEL com.github.actions.icon="code"
LABEL com.github.actions.color="yellow"

LABEL repository="https://github.com/XVincentX/spectral-action"
LABEL homepage="https://stoplight.io"
LABEL maintainer="Vincenzo Chianese <vincenz.chianese@icloud.com>"


COPY package* ./
RUN npm ci

COPY src ./src
COPY tsconfig.json tsconfig.json

RUN ./node_modules/.bin/tsc

FROM node:12 as installer

ENV NODE_ENV production
COPY package.json package.json
RUN npm install --production

FROM node:12 as runtime
ENV NODE_ENV production
COPY package.json /action/package.json
COPY --from=builder dist /action/dist
COPY --from=installer node_modules /action/node_modules

ENTRYPOINT ["node", "/action/dist/index.js"]
