FROM node:14 as builder

COPY package.json yarn.lock ./
RUN yarn

COPY src ./src
COPY tsconfig.json tsconfig.json

RUN yarn
RUN yarn build

###############################################################

FROM node:14 as dependencies

ENV NODE_ENV production
COPY package.json yarn.lock ./
RUN yarn --production

###############################################################

FROM node:14-alpine as runtime  

ENV NODE_ENV production

COPY package.json /action/package.json

COPY --from=builder dist /action/dist
COPY --from=dependencies node_modules /action/node_modules

ENTRYPOINT ["node", "/action/dist/index.js"]
