# Open questions

- Описание MCP (`provider` в src/mcp.mjs) и навык skills/swarm-search/SKILL.md (README и skills в этой ветке не правились) надо обновить отдельной задачей. Новый порядок автовыбора:
  - если `arcodex` найден: `arcodex-cli` → `agy-cli` → `claude-cli`; авто-фолбэки идут только по этой цепочке из доступных (без codex, gemini и платных API-ключей);
  - если `arcodex` не найден: порядок как раньше (`claude-cli`, `anthropic`, `codex-cli`, `openai`, `agy-cli`, `google`, `gemini-cli`, `openrouter`), без изменений;
  - mode files: `agy-cli` пропускается (веб не отключается), остаётся `arcodex-cli` → `claude-cli`.
