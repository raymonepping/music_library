# --- Dependencies layer (cached) ---
FROM node:20-slim AS deps
WORKDIR /app

# Ensure reproducible installs; prefer npm ci if you have package-lock.json
COPY package*.json ./
# If you need dev deps at runtime, remove --omit=dev
RUN npm ci --omit=dev

# --- Runtime image (lean) ---
FROM node:20-slim AS runner
WORKDIR /app

# Good defaults for prod
ENV NODE_ENV=production \
    TZ=UTC

# Copy only what's needed at runtime
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# You’re listening on 3002 in the app
EXPOSE 3002

# Run as non-root (safer). If your app writes to the FS, ensure dirs are writable.
USER node

CMD ["npm", "start"]
