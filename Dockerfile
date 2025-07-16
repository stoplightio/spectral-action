###############################################################
FROM node:18 as builder

COPY package.json yarn.lock ./
RUN yarn

COPY src ./src
COPY tsconfig.json tsconfig.json

RUN yarn
RUN yarn build

###############################################################
FROM golang:1.18 as nodeprune

# Build node-prune from source
RUN go install github.com/tj/node-prune@latest

###############################################################
FROM node:18 as dependencies

ENV NODE_ENV production
COPY package.json yarn.lock ./
RUN yarn --production

# Copy node-prune binary built from source
COPY --from=nodeprune /go/bin/node-prune /usr/local/bin/node-prune
RUN node-prune

###############################################################
FROM node:18-alpine as runtime

ENV NODE_ENV production

COPY package.json /action/package.json

COPY --from=builder dist /action/dist
COPY --from=dependencies node_modules /action/node_modules

ENTRYPOINT ["node", "/action/dist/index.js"]
