# Сборка для Anthropic OSS Scanner (формат — templates/Dockerfile в anthropics/oss-scanner).
# Контекст сборки — корень репозитория. Сеть есть только на этапе сборки, аудит идёт офлайн.
# Внешних npm-зависимостей у проекта нет: нужен только Node.js из engines в package.json.
FROM node:24-bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git python3 curl \
    && rm -rf /var/lib/apt/lists/*

# Контракт сканера: исходники лежат в образе в /src.
COPY . /src
WORKDIR /src

# Быстрая проверка образа: тесты без сети и без LLM-провайдеров (провайдеры подменяются фейками).
# Падение тестов сборку не роняет.
RUN node bin/swarm-search.mjs providers || true
RUN npm test || echo "WARNING: npm test reported failures"
