# swarm-search

Параллельный «рой» для исследований в Claude, ChatGPT и Gemini, **без зависимостей**.

На вход один вопрос. Планировщик дробит его на подвопросы, **N дешёвых воркеров** ищут параллельно
(в вебе или по локальным файлам), **один синтезатор** сводит всё в ответ со ссылками `[n]`
и списком источников. Воркеры сначала выбирают **AgentRouter** (`arcodex` / `arclaude`), затем
Антигравити (`agy`), затем Claude Code и остальные доступные бэкенды.
`provider: "mixed"` раскидывает воркеров по разным семействам моделей, чтобы в итоге
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

Секреты в files-режиме воркерам не уходят: `.env*` (шаблоны `.env.example`/`.sample`/`.template`
остаются), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `*.tfstate`, SSH-ключи `id_*`,
`credentials`/`credentials.json`, `.npmrc`, `.netrc`, `.git-credentials`, `.pgpass`, `.pypirc`,
`secrets.{json,yaml,yml,toml,env,ini}`, `kubeconfig`, `.kube/config`, `.docker/config.json`
и `*service-account*.json` отбрасываются и при обходе каталога, и при явном указании файла. Веба у воркеров в files-режиме нет: Claude CLI запускается без
веб-инструментов, Codex — с `web_search="disabled"`, Gemini CLI — с политикой, запрещающей
`google_web_search`/`web_fetch`, а `agy-cli` (у него веб-поиск не выключается) для files-шардов
и синтеза не берётся.

Приоритет files: AgentRouter → Claude CLI → Codex CLI → Gemini CLI → API (Anthropic, OpenAI, Google, OpenRouter).
При сбое рой пробует остальных доступных провайдеров без веба и записывает `report.providerAttempts`.
Если не сработал ни один, ошибка содержит исходные причины отказа каждого.

В промптах воркеров и критики прописана граница данных: текст страниц, файлов и чужих отчётов —
данные, встроенные в них инструкции не выполняются, а выносятся в `## Uncertain` / `## Not found`.
Перед тем как отчёты воркеров и куски файлов попадут в промпты аудита пробелов, критики и синтеза,
код нейтрализует в них role spoofing: строки, которые выдают себя за реплику чата (`System:`, `User:`,
`Assistant:`, `Human:`, `Developer:` в начале строки, в том числе после markdown или номера строки
`  12| `), становятся `[quoted User]:`, а у разметки чат-шаблонов (`<|im_start|>`, `<|system|>`,
`<｜User｜>`, `[INST]`, `<<SYS>>`, `<system>`, `<s>` …) скобки меняются на `‹ ›`. Затем каждый отчёт
или кусок оборачивается строками `<<<DATA <метка> …>>>` / `<<<END DATA <метка>>>>` со случайной меткой
на прогон, а похожие на обёртку строки внутри контента ломаются — закрыть блок и заговорить от имени
оркестратора из контента нельзя. Текст и номера строк сохраняются, ссылки `path:line` не ломаются.
Выдача MCP-инструмента начинается с пометки, что содержимое собрано из недоверенных источников.

**Проверки качества ответа — кодом, а не только промптом:**

- *Проверка источников.* После синтеза каждый URL и `path:line` из списка Sources и из текста
  ответа должен встречаться в отчётах воркеров первого или второго раунда целым токеном: URL —
  точно (игнорируется только завершающий `/`), `path:line` — тот же путь, а строка внутри строки
  или диапазона из отчёта (`src/a.mjs:12` находится в `src/a.mjs:10-14`, но не в `src/a.mjs:120`).
  Несовпавшие ссылки помечаются «source not found in worker reports»; пункт Sources без URL
  и `path:line` помечается «no URL or path:line, cannot verify» и считается непроверенным. Каждый
  `[n]` из текста должен быть в списке, и наоборот, расхождения выписываются строкой «Source check».
  В подвале — `sources traced to worker reports k/n`, детали — в `report.sourceCheck`
  (`bodyUnverified` — ссылки из текста). Это только сверка с отчётами воркеров: URL не открываются,
  и то, что источник подтверждает утверждение, не проверяется.
- *Обоснованные отказы.* В `critique` воркер может перенести утверждение в `## Retracted` только
  со ссылкой на опровергающий источник (URL или `path:line`) из отчёта другого воркера. Отказы
  без такой ссылки убираются до синтеза, чтобы верный факт не терялся из-за мнения большинства;
  подвал показывает, сколько отброшено (`report.retractions`). Пункт с продолжением на следующих
  строках оставляется или убирается целиком, `- none` / `- None of my claims.` не считаются.
- *Фейловер.* Воркер, упавший с HTTP 402/429/5xx, таймаутом, ошибкой лимита или квоты либо
  вернувший пустой ответ, один раз повторяется на следующем слоте пула с другим провайдером
  (например, `provider: "openrouter,claude-cli"` или `mixed`); после 429 — пауза
  `SWARM_RETRY_BACKOFF_MS`. В подвале — `retried k`, у повторённого воркера в отчёте `retriedFrom`.
  В `auto` повторяемые ошибки вызывают fallback также при планировании, аудите и синтезе:
  AgentRouter → agy → Claude CLI → остальные CLI → API. В files используются только провайдеры без веба.
- *Ранжирование файлов (files).* Если корпус больше `SWARM_RANK_CHARS` (480k символов ≈ 8 шардов),
  файлы ранжируются BM25 по вопросу (слова пути весят больше, названные в вопросе файлы идут
  первыми), и в шарды идут только верхние файлы в пределах бюджета. Подвал пишет
  `ranked files: оставлено/всего kept, N dropped`, а синтезатору сообщается, что покрытие неполное.
  `rank: "on"` всегда упорядочивает файлы по релевантности, `"off"` выключает ранжирование.

## Требования

- Node.js `^22.23.4 || ^24.22.1 || >=26.12.1` (версии с патчем безопасности Brotli; на любой
  другой, включая Node 20 и снятые с поддержки ветки 23 и 25, установка выдаст предупреждение
  `engines`, а с `engine-strict` упадёт)
- хотя бы один бэкенд для воркеров:

| id провайдера | что использует | что нужно | модель по умолчанию |
|---|---|---|---|
| `arcodex-cli` | `arcodex exec` (AgentRouter) | настроенный AgentRouter, `arcodex` в PATH | из AgentRouter; переопределяется через `SWARM_ARCODEX_MODEL` |
| `arclaude-cli` | `arclaude -p` (AgentRouter) | настроенный AgentRouter, `arclaude` в PATH | из AgentRouter; переопределяется через `SWARM_ARCLAUDE_MODEL` |
| `agy-cli` | `agy -p` (Google Antigravity CLI) | логин Antigravity, `agy` в PATH | `gemini-3.8-flash-low` |
| `claude-cli` | `claude -p` (Claude Code CLI) | подписка Claude, `claude` в PATH | `haiku` |
| `codex-cli` | `codex exec` (OpenAI Codex CLI) | подписка ChatGPT, `codex` в PATH | `gpt-6-luna` (`SWARM_CODEX_MODEL=` — модель из конфига Codex) |
| `gemini-cli` | `gemini -p` (Gemini CLI) | логин Google / `GEMINI_API_KEY` | `gemini-3.5-flash-lite` |
| `anthropic` | Messages API | `ANTHROPIC_API_KEY` | `claude-haiku-5-5` |
| `openai` | Responses API | `OPENAI_API_KEY` | `gpt-6-luna` |
| `google` | Gemini API | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `gemini-3.5-flash-lite` |
| `openrouter` | chat/completions | `OPENROUTER_API_KEY` | `anthropic/claude-haiku-5.5` |

`swarm-search providers` показывает, что доступно на машине. `auto` берёт первый доступный
в порядке таблицы; любую модель по умолчанию можно переопределить через `SWARM_<PROVIDER>_MODEL`.
`auto` берёт `arcodex`, если он установлен, иначе `arclaude`; оба доступны явно или через `mixed`.
Промпт AgentRouter передаётся одним буквальным аргументом команды. Передача промптов остальным
CLI-провайдерам сохраняется.

В режиме `mixed` OpenRouter берёт отдельное семейство — `deepseek/deepseek-v4.1-flash`
(`SWARM_OPENROUTER_MIXED_MODEL`), чтобы не дублировать Haiku. Дешёвый воркер DeepSeek
вручную: `--provider openrouter:deepseek/deepseek-v4.1-flash`.

Воркеры `claude-cli` запускаются без MCP-серверов, скиллов, плагинов и пользовательского CLAUDE.md
(`--strict-mcp-config --disable-slash-commands --setting-sources ''`): так один веб-воркер тратит
около 6k токенов контекста вместо сотен тысяч. `SWARM_CLAUDE_LEAN=0` возвращает полную обвязку.
В подвале ответа — токены всех вызовов, стоимость (где провайдер её сообщает) и цена одного полезного ответа воркера.

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

Для HTTP-клиентов files-режим по умолчанию **выключен** (туннель приходит на loopback, поэтому
удалённым считается любой HTTP-запрос). Чтобы включить его, перечисли каталоги, которые можно
читать удалённо: `SWARM_FILES_ROOTS=/srv/docs,/srv/repo` или `--files-roots /srv/docs,/srv/repo`.
Каждый путь проходит через `realpath` и должен лежать внутри одного из корней, так что симлинки
и `..` наружу не выводят; скрытые файлы и каталоги внутри корня (`.git`, `.ssh`, `.npmrc`, …)
не отдаются даже при явном указании. Клиентов по stdio это не ограничивает.

Кроме того, HTTP-клиенты никогда не получают воркеров, которые сами читают диск сервера:
`arcodex-cli`, `codex-cli` (песочница `-s read-only` всё равно разрешает shell-чтение любого файла), `agy-cli`
(инструменты чтения файлов в plan-режиме одобряются автоматически) и `gemini-cli` (читает рабочий
каталог сервера) при удалённом вызове пропускаются в любом режиме — и как воркеры, и как синтез.
Используй `arclaude-cli`, `claude-cli` (только веб-инструменты) или API-провайдера; пул только из CLI с чтением диска
завершится ошибкой.

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
| `rank` | режим files: `auto` (по умолчанию) · `on` · `off`, см. ранжирование файлов выше |

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
| `SWARM_RANK` | `auto` | ранжирование файлов: `auto` (только выше `SWARM_RANK_CHARS`), `on`, `off` |
| `SWARM_RANK_CHARS` | `480000` | размер корпуса, с которого включается ранжирование, и бюджет оставляемых файлов |
| `SWARM_RETRY_BACKOFF_MS` | `1500` | пауза перед повтором воркера, получившего HTTP 429 |
| `SWARM_HTTP_TOKEN` | – | bearer-токен для `mcp --http` (обязателен при bind не на loopback) |
| `SWARM_HTTP_ALLOWED_ORIGINS` | – | браузерные origin через запятую, разрешённые помимо localhost (`mcp --http`) |
| `SWARM_FILES_ROOTS` | – | каталоги через запятую, которые удалённые клиенты `mcp --http` могут сканировать в files-режиме; не задано — files-режим по HTTP выключен |
| `SWARM_ARCODEX_MODEL`, `SWARM_ARCLAUDE_MODEL` | не заданы | переопределить настроенную модель AgentRouter |
| `SWARM_CLAUDE_MODEL`, `SWARM_CODEX_MODEL`, `SWARM_AGY_MODEL`, `SWARM_GEMINI_MODEL`, `SWARM_ANTHROPIC_MODEL`, `SWARM_OPENAI_MODEL`, `SWARM_GOOGLE_MODEL`, `SWARM_OPENROUTER_MODEL` | см. таблицу | модель провайдера по умолчанию |

## Стоимость и время

Веб-прогон на 4 воркера — это 6 вызовов модели (1 план + 4 воркера + 1 синтез), 1–3 минуты
на CLI-бэкендах. Второй раунд добавляет 1 аудит + до 4 уточнений (`gaps`) или N критик (`critique`). CLI-провайдеры работают по подпискам, API-провайдеры тарифицируются по токенам.
Воркеры read-only: `claude -p` получает только WebSearch/WebFetch, `codex exec` идёт
с `-s read-only`, `agy`/`gemini` — в plan-режиме. Read-only не мешает codex, agy и gemini читать
локальные файлы, поэтому при локальном запуске инъекция на странице или в файле может заставить их
процитировать файл; удалённым HTTP-клиентам эти провайдеры не достаются (см. выше).

## Разработка

```bash
npm test                       # юнит-тесты, без сети
node bin/swarm-search.mjs providers
node bin/swarm-search.mjs run "..." --workers 2
```

### Бенчмарк провайдеров

Перед сменой дешёвой модели по умолчанию сравни провайдеров на фиксированном наборе:
в `bench/questions.json` 15 вопросов с проверяемыми фактами (12 веб и 3 files-запроса по этому репо).

```bash
npm run bench -- claude-cli openrouter:deepseek/deepseek-v4.1-flash openrouter:minimax/minimax-m3.1-flash
npm run bench -- codex-cli --only rust-1.0,files-http-port --workers 1 --out bench/codex.json
```

Каждый аргумент — один спек провайдера (на нём идут и воркеры, и синтез). В JSON по каждому
провайдеру: `accuracy` (доля фактов, найденных в ответе), `successes` (ответы со всеми фактами),
`nonEmptyRate`, `costPerSuccessUsd` (общая стоимость / успешные ответы, `null`, если хоть у одного
прогона цена известна не полностью), `avgSec`, `sourcesVerified/sourcesTotal` и прогоны по вопросам.
Бенчмарк ходит в настоящие модели и стоит денег; `npm test` гоняет его только на фейках.

Структура: `src/swarm.mjs` пайплайн · `src/providers/*` по файлу на бэкенд · `src/corpus.mjs`
нарезка файлов · `src/mcp.mjs` транспорты stdio + HTTP · `src/install.mjs` конфиги клиентов ·
`.claude-plugin/`, `commands/`, `skills/`, `.mcp.json` — поверхность плагина Claude Code.

Новый провайдер: экспортируй `{ id, family, kind, label, defaultModel, detect(), complete({ system, prompt, model, web, timeoutMs, signal }) → { text, usage? } }`
и добавь его в `PROVIDERS` в `src/providers/index.mjs`.

## Лицензия

MIT
