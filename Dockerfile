FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04
WORKDIR /app
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun package.json ./
RUN mkdir -p /app/data /app/backups && chown -R bun:bun /app && chmod 700 /app/data /app/backups
USER bun
ENV HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/2du.sqlite
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:3000/health');process.exit(r.ok?0:1)"]
CMD ["bun", "run", "src/index.ts"]
