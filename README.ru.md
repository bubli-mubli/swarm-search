# swarm-search

Параллельный «рой» для исследований в Claude, ChatGPT и Gemini, **без зависимостей**.

На вход один вопрос. Планировщик дробит его на подвопросы, **N дешёвых воркеров** ищут параллельно
(в вебе или по локальным файлам), **один синтезатор** сводит всё в ответ со ссылками `[n]`
и списком источников. Воркеры по умолчанию — **Claude Haiku** через подписку Claude Code;
GPT (Codex CLI / OpenAI API) и Gemini (Antigravity CLI / Gemini CLI / Gemini API) включаются одним
флагом, а `provider: "mixed"` раскидывает воркеров по разным семействам моделей, чтобы в итоге
было видно, где они расходятся.

Поставляется как:

- **плагин Claude Code** (`/swarm-search`, скилл, MCP-сервер),
- **MCP-сервер по stdio** для Claude Desktop, Codex CLI / Codex в приложении ChatGPT, Antigravity, Gemini CLI,
- **MCP-сервер по Streamable HTTP** для коннекторов ChatGPT и любых удалённых клиентов,
- **CLI** (`swarm-search run "..."`).

[English version](./README.md)

---

## Как работает

```
вопрос ──► планировщик (1 вызов) ──► N подвопросов (N выбирает планировщик, 1–8)
                                        │
                  ┌─────────────────────┼─────────────────────┐
                  ▼                     ▼                     ▼
            воркер 1 (веб)        воркер 2 (веб)   ...  воркер N (веб)     ← Haiku / GPT / Gemini
                  └─────────────────────┼─────────────────────┘
                                        ▼
              необязательный раунд 2: дозакрытие пробелов  или  перекрёстная критика
                                        ▼
                             синтезатор (1 вызов) ──► ответ + источники [n]
```

**Кто решает, сколько воркеров?** По умолчанию планировщик: он читает вопрос и возвращает
по одному подвопросу на каждый реально независимый угол. Узкий факт стоит одного воркера,
сравнение пяти вариантов получает пять. `workers: N` фиксирует число принудительно.

**Общаются ли воркеры между собой?** В первом раунде нет: независимость и позволяет синтезу
ловить ошибки. С `rounds: 2` общаются, но постфактум:

- `round2: "gaps"` (по умолчанию) — аудитор читает все отчёты первого раунда, выписывает
  противоречия и неотвеченные части, и несколько целевых воркеров закрывают именно их.
  Дёшево: 1 + до 4 вызовов.
- `round2: "critique"` — каждый воркер видит обезличенные отчёты остальных и отвечает
  Confirmed / Disputed / Retracted / Missing с источниками. N дополнительных вызовов. Сильнее всего
  с `provider: "mixed"`, где Claude, GPT и Gemini проверяют друг друга.

В **режиме files** (передан `paths`) вместо подвопросов режется корпус: каждый воркер получает
свой кусок файлов с номерами строк и отчитывается ссылками `path:line`, синтезатор сводит.
Второй раунд в files-режиме перечитывает шарды, где были находки, уже с уточняющими вопросами.

## Требования

- Node.js ≥ 20
- хотя бы один бэкенд для воркеров:

| id провайдера | что использует | что нужно | модель по умолчанию |
|---|---|---|---|
| `claude-cli` | `claude -p` (Claude Code CLI) | подписка Claude, `claude` в PATH | `haiku` |
| `codex-cli` | `codex exec` (OpenAI Codex CLI) | подписка ChatGPT, `codex` в PATH | дефолт из конфига Codex |
| `agy-cli` | `agy -p` (Google Antigravity CLI) | логин Antigravity, `agy` в PATH | `gemini-3.8-flash-low` |
| `gemini-cli` | `gemini -p` (Gemini CLI) | логин Google / `GEMINI_API_KEY` | `gemini-2.5-flash` |
| `anthropic` | Messages API | `ANTHROPIC_API_KEY` | `claude-haiku-4-5` |
| `openai` | Responses API | `OPENAI_API_KEY` | `gpt-5-mini` |
| `google` | Gemini API | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `gemini-2.5-flash` |
| `openrouter` | chat/completions | `OPENROUTER_API_KEY` | `anthropic/claude-haiku-4.5` |

`swarm-search providers` показывает, что доступно на машине. `auto` берёт первый доступный
в порядке таблицы; любую модель по умолчанию можно переопределить через `SWARM_<PROVIDER>_MODEL`.

## Установка

### Claude Code (плагин)

```bash
claude plugin marketplace add jumpleGo/swarm-search
claude plugin install swarm-search@jumplego
```

Дальше в любой сессии:

```
/swarm-search что нового в Node.js 24 LTS по сравнению с 22, переезжать ли сейчас?
/swarm-search где обрабатываются таймауты запросов --files src,server --workers 6
```

или просто попроси «сделай swarm search» — скилл в плагине подскажет Claude, когда звать
инструмент `swarm_search`.

### Claude Desktop, Codex, Antigravity, Gemini CLI (MCP по stdio)

```bash
git clone https://github.com/jumpleGo/swarm-search ~/swarm-search
cd ~/swarm-search
node bin/swarm-search.mjs install claude-desktop --write   # или: codex | agy | gemini-cli | claude-code
```

Без `--write` команда только печатает сниппет конфига. Сервер регистрируется так:

```json
{ "mcpServers": { "swarm-search": { "command": "node", "args": ["/abs/path/bin/swarm-search.mjs", "mcp"] } } }
```

Для Codex добавляется блок `[mcp_servers.swarm-search]` в `~/.codex/config.toml` (его же читает
режим Codex в десктопном ChatGPT). Antigravity регистрируется через `agy mcp add`.

### ChatGPT (удалённый MCP-коннектор)

ChatGPT подключается только к **удалённым HTTPS** MCP-серверам, поэтому поднимаем HTTP-транспорт
и выставляем его наружу:

```bash
SWARM_HTTP_TOKEN=$(openssl rand -hex 16) node bin/swarm-search.mjs mcp --http --port 8787
# в другом окне
ngrok http 8787          # или: cloudflared tunnel --url http://localhost:8787
```

В ChatGPT включи Developer mode в настройках и создай коннектор с URL
`https://<твой-туннель>/mcp` и авторизацией Bearer с этим токеном. Сервер stateless
(JSON-ответы на `POST /mcp`, проверка `GET /health`). Потребительское приложение Gemini
свои MCP-серверы не поддерживает — для Gemini используй Antigravity или Gemini CLI.

## Использование

### MCP-инструмент `swarm_search`

| аргумент | смысл |
|---|---|
| `query` | вопрос (обязателен) |
| `mode` | `auto` (по умолчанию) · `web` · `files` |
| `paths` | файлы/папки для сканирования → режим files |
| `workers` | фиксированное число воркеров (максимум 12); не передавай, чтобы планировщик выбрал сам |
| `rounds` | `1` (по умолчанию) или `2` |
| `round2` | `gaps` (по умолчанию) или `critique` |
| `provider` | `auto` · `mixed` · id провайдера · `id:model` · список через запятую для round-robin |
| `model` | модель воркеров |
| `synth_provider`, `synth_model` | более сильная модель только для финального синтеза |
| `angles` | свои подвопросы, планировщик пропускается |
| `language` | язык ответа |

`swarm_providers` показывает доступные бэкенды.

### CLI

```bash
swarm-search run "состояние WebGPU в 2026: поддержка браузеров, фреймворки, подводные камни" --workers 6
swarm-search run "где мы валидируем JWT?" --paths src,server --provider codex-cli
swarm-search run "готов ли Bun к продакшену?" --provider mixed --rounds 2 --round2 critique --synth-provider claude-cli:sonnet
swarm-search run "..." --json           # полный отчёт с выводом каждого воркера
```

### Переменные окружения

| переменная | по умолчанию | назначение |
|---|---|---|
| `SWARM_PROVIDER` | `auto` | провайдер по умолчанию |
| `SWARM_WORKERS` | не задано = auto | фиксированное число воркеров по умолчанию |
| `SWARM_MAX_AUTO_WORKERS` | `8` | верхняя граница для auto |
| `SWARM_ROUNDS` / `SWARM_ROUND2` | `1` / `gaps` | раунды и режим второго раунда по умолчанию |
| `SWARM_TIMEOUT_MS` | `180000` | таймаут одного вызова |
| `SWARM_SHARD_CHARS` | `60000` | максимум символов в одном шарде режима files |
| `SWARM_HTTP_TOKEN` | – | bearer-токен для `mcp --http` (обязателен при bind не на loopback) |
| `SWARM_HTTP_ALLOWED_ORIGINS` | – | браузерные origin через запятую, разрешённые помимо localhost (`mcp --http`) |
| `SWARM_CLAUDE_MODEL`, `SWARM_CODEX_MODEL`, `SWARM_AGY_MODEL`, `SWARM_GEMINI_MODEL`, `SWARM_ANTHROPIC_MODEL`, `SWARM_OPENAI_MODEL`, `SWARM_GOOGLE_MODEL`, `SWARM_OPENROUTER_MODEL` | см. таблицу | модель провайдера по умолчанию |

## Стоимость и время

Веб-прогон на 4 воркера — это 6 вызовов модели (1 план + 4 воркера + 1 синтез), 1–3 минуты
на CLI-бэкендах. Второй раунд добавляет 1 аудит + до 4 уточнений (`gaps`) или N критик (`critique`). CLI-провайдеры работают по подпискам, API-провайдеры тарифицируются по токенам.
Воркеры read-only: `claude -p` получает только WebSearch/WebFetch, `codex exec` идёт
с `-s read-only`, `agy`/`gemini` — в plan-режиме.

## Разработка

```bash
npm test                       # юнит-тесты, без сети
node bin/swarm-search.mjs providers
node bin/swarm-search.mjs run "..." --workers 2
```

Структура: `src/swarm.mjs` пайплайн · `src/providers/*` по файлу на бэкенд · `src/corpus.mjs`
нарезка файлов · `src/mcp.mjs` транспорты stdio + HTTP · `src/install.mjs` конфиги клиентов ·
`.claude-plugin/`, `commands/`, `skills/`, `.mcp.json` — поверхность плагина Claude Code.

Новый провайдер: экспортируй `{ id, family, kind, label, defaultModel, detect(), complete({ system, prompt, model, web, timeoutMs, signal }) → { text, usage? } }`
и добавь его в `PROVIDERS` в `src/providers/index.mjs`.

## Лицензия

MIT
