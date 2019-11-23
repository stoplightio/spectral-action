FROM node:12 as builder

COPY package* ./
RUN yarn

COPY src ./src
COPY tsconfig.json tsconfig.json

RUN ./node_modules/.bin/tsc

FROM node:12 as installer

ENV NODE_ENV production
COPY package.json package.json
RUN yarn --production

FROM node:12 as runtime
ENV NODE_ENV production
COPY package.json /action/package.json
COPY --from=builder dist /action/dist
COPY --from=installer node_modules /action/node_modules

ENTRYPOINT ["node", "/action/dist/index.js"]
