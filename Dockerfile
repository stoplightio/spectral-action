FROM node:10-slim

LABEL com.github.actions.name="Spectral checks"
LABEL com.github.actions.description="Lint your JSON and OAS2/3 files"
LABEL com.github.actions.icon="code"
LABEL com.github.actions.color="yellow"

LABEL maintainer="Vincenzo Chianese <vincenz.chianese@icloud.com>"

ENV NODE_ENV production
COPY package.json package.json
RUN npm install --production
COPY src src

ENTRYPOINT [ "npm", "start"]
