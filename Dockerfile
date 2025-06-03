FROM public.ecr.aws/docker/library/node:16 as builder

COPY package.json yarn.lock ./
RUN yarn

COPY src ./src
COPY tsconfig.json tsconfig.json

RUN yarn
RUN yarn build

###############################################################

FROM node:16 as dependencies

ENV NODE_ENV production
COPY package.json yarn.lock ./
RUN yarn --production

RUN curl -L https://github.com/tj/node-prune/releases/download/v1.0.1/node-prune_1.0.1_linux_amd64.tar.gz -o node-prune.tar.gz \
    && tar -xzf node-prune.tar.gz \
    && mv node-prune /usr/local/bin/node-prune \
    && chmod +x /usr/local/bin/node-prune \
    && rm -f node-prune.tar.gz \
    && node-prune


###############################################################

FROM node:16-alpine as runtime

ENV NODE_ENV production

COPY package.json /action/package.json

COPY --from=builder dist /action/dist
COPY --from=dependencies node_modules /action/node_modules

ENTRYPOINT ["node", "/action/dist/index.js"]
