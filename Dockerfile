# node:22-alpine has multi-arch manifests, so this builds unchanged on an
# x86_64 or arm64 VPS. There are no npm dependencies to install.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8888 \
    DATA_DIR=/data

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public

# The refresh token lives here. Owned by `node` so the unprivileged process can
# write it, which also sets the ownership of the named volume on first run.
RUN mkdir -p /data && chown -R node:node /data

USER node

EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8888)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/bin.js"]
