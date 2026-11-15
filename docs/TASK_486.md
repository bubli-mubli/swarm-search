# Задача 486: полные URL и честный SERP

## Шаг 0 — только чтение, до изменения кода

2026-11-15: `git ls-remote origin refs/heads/main` вернул
`bbcdf423e27040e5975670f5cc61178699355d2e`; HEAD и origin/main совпали.
Выражения ниже сняты через `git grep -n` и чтение файлов этого main.

| Место в main | Выражение / вход |
| --- | --- |
| `src/swarm.mjs:75` | `'Be concrete: facts, numbers, dates, names. Cite one source URL per finding. ' +` |
| `src/swarm.mjs:78` | `'Reply in this exact structure:\n## Findings\n- claim (URL) — Quote: "exact passage"\n## Uncertain\n- what you could not verify\n' +` |
| `src/swarm.mjs:568-570` | `complete(..., { system: job.system, prompt: job.prompt, web: job.web }, ...);` затем `verifyWorkerSources(res.text, { timeoutMs, signal })` |
| `src/providers/agy-cli.mjs:64` | `text: String(data.response ?? '')` |
| `src/providers/agentrouter-cli.mjs:35,41` | `const text = (await readFile(outFile, 'utf8').catch(() => '')).trim();` → `return { text };` |
| `src/providers/claude-cli.mjs:47` | `text: String(data.result ?? '')` |
| `src/web-verification.mjs:4` | ``export const URL_RE = /https?:\/\/(?:\[[\da-f:.]+\]|[^\s)\]>"'`<\[])+/gi;`` |
| `src/web-verification.mjs:7` | `const urlsIn = (text) => [...new Set((String(text).match(URL_RE) || []).map((u) => u.replace(/[.,;:!?]+$/, '')))];` |
| `src/swarm.mjs:253` | `urls.add(ref.replace(/\/+$/, ''));` |
| `src/swarm.mjs:583-594` | Отчёт сохраняет `text` и `sourceVerification`, но не структурированные URL, полноту адреса или SERP. |
| `src/providers/google-api.mjs:33-37` | `candidate?.groundingMetadata?.groundingChunks || []` → `.map((c) => c.web?.uri)` → `.map((u, i) => \`[${i + 1}] ${u}\`)` |
| `src/providers/anthropic-api.mjs:40-45` | `urls.add(c.url)` / `urls.add(r.url)` → `[...urls].map((u, i) => \`[${i + 1}] ${u}\`)` |

В логе `workspaces/vera/479/eval/479/20261114T225121Z/swarm-web.json`
воркер — `agy-cli`, синтез — `arcodex-cli`. В `report.workers[0].text`
уже стоят `https://appliner.pro`, `https://habr.com`, `https://ru.wikipedia.org`
и `UNRELIABLE(google_serp_positions)`. Это потеря конкретики в ответе модели,
которую допускают промпт и отсутствие проверки результата; код нормализации
не срезает путь до домена. Сырой ответ внутреннего search_web в логе отсутствует,
поэтому установить, дал ли он модели пути, по этому логу нельзя.

Текущие адаптеры не предоставляют подтверждённых позиций и региона SERP:
agy возвращает текст, API адаптеры — текст/источники. Индексы `[i + 1]`
в Google/Anthropic — номера цитат, не позиции Google. Вызовы провайдеров
при диагностике не выполнялись.

## Решение и проверка

Гипотеза: сохранение исходных URL страниц и явная недоступность позиций
устранят подмену страниц доменами при SEO-сравнении. Проверка после выкатки
остаётся Нике; локальные тесты не доказывают результат на проде.

Изменения совместимы с прежними оболочками: CLI возвращает `{markdown, report}`,
MCP сохраняет `content` и добавляет `structuredContent`. `--serp` / `--mode serp`
и MCP `mode: "serp"` принимают top-N (`--top-n` / `top_n`, 1–100, по умолчанию 10)
и регион. `report.serp.results` содержит только данные отдельного нативного
адаптера `searchSerp`: `{position, url, title, fetched_at}`. Запрошенный регион
требует подтверждения; отсутствующие, повторные и выдуманные позиции не принимаются.
Все нынешние LLM-адаптеры отвечают `unavailable` без вызовов модели.

Web-промпт требует полный URL, а источники из метаданных API добавляются в текст
воркера и `sources`. Исходная строка адреса сохраняется, включая путь, query и fragment.
`status: partial` и `sourceIssues` отмечают голые домены, неверные/отсутствующие URL.
Проверка консервативна и считает главную страницу недостаточным источником web-исследования.
Это не флаг подтверждения цитат; прежняя проверка HTTP/цитат не ослаблена.

Новый файл `test/serp.test.mjs` добавляет 13 тестов; существующие тесты не менялись.
Четыре теста на main `bbcdf423` падают: сохранение источников фейкового провайдера,
`unavailable` без позиций, `partial` для домена, сохранение метаданных API.
Прогон выполнен в копии main внутри `.scratch/486`, а не против внешних сервисов.
23 целевых теста (SERP + web verification + files source verification) прошли.

Пять изолированных мутаций каждая дали падение целевого теста:

1. `workerSources`: заменить исходный URL на `new URL(url).origin`.
2. `workerSources`: всегда возвращать `status: 'ok'`.
3. `serpSearch`: неподдерживаемому провайдеру вернуть `ok` вместо `unavailable`.
4. `serpSearch`: дописать отсутствующую позицию из индекса массива.
5. Google API: удалить структурированные источники (`sources: []`).

Логи: `.scratch/486/old-tests.log`, `.scratch/486/targeted-tests.log`,
`.scratch/486/mutation-*.log`. Копии main и мутантов удалены после проверки.
Все API-ответы в новых тестах подменены; CLI-проверка SERP не вызывает модель.
Новых зависимостей и платных вызовов нет.

Открытый вопрос: какой бесплатный нативный SERP-провайдер добавить отдельно?
По умолчанию — честный `unavailable`, без подмены источников ранжированием.
После выкатки Ника проверяет запрос #479 с `top_n: 3, region: "RU"` и отдельный
web-запрос: полные адреса либо `partial`; до этой проверки изменение не считается
подтверждённым на проде.
