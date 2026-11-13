FROM node:22-alpine@sha256:ab07539e0988b63558ff621f5fbe1077054c39d9809112974fb79993949d41cd
WORKDIR /opt/rine
COPY package.json core.tgz cli.tgz ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force \
 && mkdir -p /state /creds && chown 10001:10001 /state
ENV PATH=/opt/rine/node_modules/.bin:$PATH \
    RINE_CONFIG_DIR=/creds
VOLUME ["/state", "/creds"]
USER 10001:10001
ENTRYPOINT ["rine", "org", "events", "tail"]
