# Imagen de ejecución de baileys_esam.
# Multi-stage: compila TypeScript y luego deja solo lo necesario para correr.
#
# Uso (en el servidor, con el contexto ya preparado):
#   docker build -t <repo>:<tag> .
#
# Nota: la carpeta public/ incluye recursos de la plantilla Velzon que no se
# versionan (licencia comercial). El contexto de build debe traerlos; ver
# el procedimiento de despliegue.

FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY public ./public
COPY scripts ./scripts

# El volumen de datos se monta aquí; el usuario de la app debe poder escribir.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 2785 8020 8030

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 2785) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "dist/index.js"]
