# syntax=docker/dockerfile:1

# The frontend image. Multi-stage so the shipped layer carries the built app and
# its traced runtime deps, and none of the toolchain that produced them.
ARG NODE_VERSION=24-alpine

FROM node:${NODE_VERSION} AS base
# Next's native deps (and sharp) are glibc-linked; alpine is musl.
RUN apk add --no-cache libc6-compat
# pnpm comes from corepack, which reads the `packageManager` field in
# package.json — so the image uses the exact version the lockfile was written
# with, without pinning it a second time here where it could drift.
RUN corepack enable
WORKDIR /app


# --- deps -------------------------------------------------------------------
# Its own stage so that a source-only change does not reinstall the tree. Only
# the two files that can invalidate the install are copied in.
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile


# --- builder ----------------------------------------------------------------
FROM base AS builder

# The backend address, and a build arg rather than a runtime env var because
# Next resolves `rewrites()` during `next build` and writes the destination into
# .next/routes-manifest.json. Setting API_ORIGIN on the *container* would do
# nothing at all — the value is already compiled in — and that failure is
# invisible: the app boots fine and every /api call 404s at whatever address was
# baked. Change it here, and rebuild.
#
# The default matches the Containerfile's PORT=5001 and assumes host networking,
# where the backend really is on this container's own loopback.
ARG API_ORIGIN=http://127.0.0.1:5001
ENV API_ORIGIN=${API_ORIGIN}
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `public/` is empty today, so git does not track it and a fresh clone has no
# such directory — which would fail the COPY in the runner stage. Guarantee it.
RUN mkdir -p public

RUN pnpm build


# --- runner -----------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Matches docker-compose.yml's WEB_PORT default, so `docker run` on this image
# alone lands where the compose deployment does. 3000 is avoided deliberately:
# it is every Node dev server's default and the likeliest port to be taken.
ENV PORT=5000
# Bind all interfaces. The standalone server defaults to localhost, which under
# bridge networking answers only inside the container and looks like a dead port
# from outside.
ENV HOSTNAME=0.0.0.0

# Unprivileged. The app writes nothing to disk — it is a proxy and a renderer.
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

# `output: "standalone"` emits a server plus only the node_modules actually
# reached by the trace, but deliberately excludes the static assets and public
# files, which have to be placed alongside it by hand.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 5000

# No curl in this image, and adding it just to poll a port is a package and a
# CVE surface for something node already does. Checks the app itself, not the
# backend: "is the frontend up" and "is the API up" are separate questions and
# collapsing them would mark the UI unhealthy whenever Sonos discovery is.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
