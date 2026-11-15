# Задача 480: бесплатный `swarm-search doctor`

## Шаг 0 — свежий main, до кода

2026-11-15: `git fetch origin main`; `origin/main` и исходный HEAD —
`2f2193a21ecf679ecb09fb117dd00093567e8cef`. Рабочая ветка `hq/nika/480` чистая.

Выполненные выражения поиска:

```sh
git grep -n -E 'process\.argv|--mcp|case .*(search|providers)|createServer|McpServer|providers|cache' origin/main -- package.json bin src lib test tests .claude-plugin README.md README.ru.md
git grep -n -a -E 'process\.argv|case .*(mcp|providers|install)|engines|CLAUDE_PLUGIN_ROOT|BIN_PATH|mcpServers|detect:|OPENAI_BASE_URL|tmpdir\(|mkdtemp\(' origin/main -- package.json bin/swarm-search.mjs src/install.mjs src/providers .mcp.json
git grep -n -a -i 'cache' origin/main -- src bin README.md README.ru.md
```

Входы, скопированные из main:

| Место | Выражение |
| --- | --- |
| `bin/swarm-search.mjs:57` | `const [cmd, ...rest] = process.argv.slice(2);` |
| `bin/swarm-search.mjs:61,72,80` | `case 'mcp':`, `case 'providers':`, `case 'install':` — `doctor` отсутствует |
| `package.json:21` | `"node": "^22.23.4 || ^24.22.1 || >=26.12.1"` |
| `.mcp.json:4` | `"args": ["${CLAUDE_PLUGIN_ROOT}/bin/swarm-search.mjs", "mcp"]` |
| `src/install.mjs:10` | `export const BIN_PATH = resolve(here, '..', 'bin', 'swarm-search.mjs');` |
| `src/install.mjs:39` | `return { command: nodeCommand(), args: [BIN_PATH, 'mcp'] };` |
| `src/providers/anthropic-api.mjs:10` | `detect: () => Boolean(process.env.ANTHROPIC_API_KEY),` |
| `src/providers/openai-api.mjs:10,20` | `detect: () => Boolean(process.env.OPENAI_API_KEY),` / `const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';` |
| `src/providers/google-api.mjs:12` | `detect: () => Boolean(apiKey()),` — `GEMINI_API_KEY || GOOGLE_API_KEY` |
| `src/providers/openrouter-api.mjs:13` | `detect: () => Boolean(process.env.OPENROUTER_API_KEY),` |
| `src/providers/agentrouter-cli.mjs:29,32` | `detect: () => hasBinary('arcodex'),` / `const dir = await mkdtemp(join(tmpdir(), 'swarm-arcodex-')), outFile = join(dir, 'last.md');` |
| `src/providers/codex-cli.mjs:28` | `const dir = await mkdtemp(join(tmpdir(), 'swarm-codex-'));` |

Отдельного дискового кэша нет. Проверка `cache` по умолчанию относится к
фактическому каталогу временных файлов CLI (`os.tmpdir()`, включая `TMPDIR`).
`--cache-dir` позволяет проверить другой каталог, не меняя поведение `run`.

Гипотеза: один бесплатный вывод заменит ручной сбор состояния установки,
провайдеров, сети и прав на рабочий каталог. Продовую проверку после выкатки
проводит Ника; локальные тесты не означают, что изменение внедрено.

Существующие тесты не меняются. Новые интеграционные проверки запускают CLI
в изолированном окружении без настоящих ключей и с данными внутри рабочей копии.
Сетевая проверка использует только локальный TCP-сервер и проверяет отсутствие
HTTP-запросов и передачи ключа. Проверка CLI использует исполняемый файл-ловушку.

До реализации `node --test --test-name-pattern='FAILS_ON_OLD 480' test/doctor.test.mjs`
дал два падения: `Unknown command "doctor"`, код 2 вместо ожидаемых 0 и 1.
Лог: `.scratch/480/old-tests.log`. После реализации первые 11 новых тестов прошли.
Полный `npm test` запускается после коммита реализации.
