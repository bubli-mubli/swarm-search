# Open questions

- Описание MCP (`provider` в src/mcp.mjs) и навык skills/swarm-search/SKILL.md (README и skills в этой ветке не правились) надо обновить отдельной задачей. Новый порядок автовыбора:
  - если `arcodex` найден: `arcodex-cli` → `agy-cli` → `claude-cli`; авто-фолбэки идут только по этой цепочке из доступных (без codex, gemini и платных API-ключей);
  - если `arcodex` не найден: порядок как раньше (`claude-cli`, `anthropic`, `codex-cli`, `openai`, `agy-cli`, `google`, `gemini-cli`, `openrouter`), без изменений;
  - Необязательное поле `provider` в действии `swarm_search` платформы (вариант по умолчанию: поле `provider` остаётся опциональным; при отсутствии провайдера в files-режиме автовыбор пропускает неподходящие движки без доступа к файлам и берёт первый подходящий по порядку arcodex-cli → … → claude-cli).
