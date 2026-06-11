# Vault MCP

**Тонкий MCP-сервер (без LLM внутри) — безопасный транспортный слой над одним Obsidian-вольтом.**
Это «руки» персонального второго мозга: AI-агент через MCP читает и пишет plain-Markdown заметки, а сам вольт остаётся обычными файлами без vendor lock-in.

---

## Философия: «idea file» Андрея Карпатого

Проект построен по принципу **Андрея Карпатого** (Andrej Karpathy) — метод *LLM Wiki* и идея *«idea file»*:

> В эпоху агентов делиться **идеей** (документом, который агент сам разворачивает) полезнее, чем делиться готовой реализацией. Знание не ищется заново при каждом запросе (RAG), а **компилируется один раз** при загрузке источника в постоянные Markdown-страницы и накапливается (compounding).
>
> *Источник: gist.github.com/karpathy/442a6bf555914893e9891c11519de94f (апрель 2026).*

Из этого следуют два свойства репозитория:

1. **Данные — plain Markdown.** Вольт переживёт любой инструмент; агент лишь поддерживает структуру.
2. **Этот README — сам «idea file».** Он написан так, чтобы AI-агент (Claude Code, Codex и др.), прочитав только его, мог самостоятельно развернуть, настроить и подключиться к серверу. Все команды и переменные ниже — исполнимые.

### Семантический слой (метод Карпатого)

Вольт делится на три зоны (полный протокол — в `_system/agent.md`):

- **Знание** — `Знания/<кластер>/` с **entity-страницами** (один концепт = одна страница, frontmatter `type: entity`). Сюда смотрит **Query** и здесь компилируется знание.
- **Сырьё** — `_raw/` (append-only исходники до переработки) и `_attachments/` (бинарники для эмбедов: PDF, картинки). **Ingest** превращает сырьё в знание, не теряя оригинал.
- **Служебное** — `_index`/`_hot`/`_log` + `_contradictions.md` (реестр противоречий, фиксируется при ingest, не перезаписывает старое знание).

Транспорт остаётся тупым: понимание контента делает мозг (агент мультимодален), MCP лишь двигает байты. Бинарники в вольт кладутся через ФС, не через MCP; исключение — `extract_pdf`, который локально достаёт текстовый слой PDF из `_attachments/` (pdfjs, без сети и OCR).

### Граф знаний (v0.2)

Поверх вольта живёт **запрашиваемый граф** — принципы взяты из [graphify](https://github.com/safishamsi/graphify) (IDF-сопоставление узлов, BFS с токен-бюджетом, confidence-теги, Louvain-сообщества), реализация нативная, без LLM и без сети:

- **derived-слой** — собирается детерминированно из `[[wikilinks]]`, эмбедов, тегов и frontmatter (`aliases`, `type: entity`). Не хранится: пересборка из файлов, расхождение с вольтом невозможно. Кэш на процесс, инвалидация на каждой мутации + TTL 60с (правки мимо MCP).
- **semantic-слой** — типизированные рёбра («использует», «противоречит», …) с confidence `extracted`/`inferred`/`ambiguous`. Пишет агент через `graph_upsert` на шаге ingest; хранится append-only в `_system/graph-edges.md` (JSONL внутри .md — без расширения write-allowlist). Ошибочное ребро гасится записью `relation: "retracted"`.

Запросы: `graph_query` (подграф по NL-вопросу — что существует и что читать), `graph_path` («что общего между X и Y»), `graph_neighbors`, `graph_stats` (god nodes, сообщества, мосты-одиночки = «неожиданные связи»). `read_hot` дописывает граф-дайджест, `lint` — секцию здоровья графа (битые рёбра, непокрытые entity, концепты-кандидаты). Лестница чтения агента: `read_hot → graph_query → read_index → страницы` (см. `_system/agent.md` §5; сервер отдаёт её и через MCP `instructions`).

---

## Что это и зачем

Три слоя «второго мозга»:

| Слой | Что | Где |
|---|---|---|
| **1 — Vault MCP** *(этот репозиторий)* | Тонкий MCP-сервер. Без LLM. Только файловые операции. | Docker / stdio |
| 2 — Мозг в файлах | `_system/agent.md` — инструкция-bootstrap для агента | в вольте |
| 3 *(опц.)* — Фасад | `brain.capture` / `brain.ask` — агентский луп на сервере | позже |

Поток: мысль → (Telegram-бот / Claude Desktop) → agent.md (мозг) → **Vault MCP (руки)** → вольт.

---

## Технический стек

| Слой | Выбор | Почему |
|---|---|---|
| Рантайм | **Node 22 LTS + TypeScript** (NodeNext, strict) | Самый зрелый `@modelcontextprotocol/sdk` |
| Протокол | **MCP** — Streamable HTTP (для бота) + stdio (для Desktop) | HTTP за reverse-proxy; stdio спавнится напрямую |
| Reverse-proxy | **Caddy** | Единая точка входа, rate-limit, HTTPS-ready |
| Поиск | **ripgrep** (`@vscode/ripgrep`) через `execFile` с arg-массивом | Единственный дочерний процесс, никаких shell-строк |
| Git | **isomorphic-git** (pure JS) | Без бинаря и без сети → нет RCE-поверхности |
| Локи | **proper-lockfile** + очередь записи | Best-effort межпроцессная конкуренция |
| Валидация | **zod** на каждый инструмент | Строгая граница на входе |
| Frontmatter | **gray-matter** | YAML-фронтматтер заметок |
| Граф | **graphology** + Louvain (pure JS) | Сообщества/god nodes без нативных бинарей |
| PDF | **pdfjs-dist** (pure JS, без воркеров и шрифтов) | Текстовый слой PDF локально, без сети |
| Секреты | **Docker secrets**, fail-closed конфиг | Токен не в образе и не в `.env` |

Контейнер: non-root (uid 1000), read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, единственный writable-маунт = вольт, сеть `internal: true` (нет egress). CI: `npm audit --audit-level=high` (блокирует), gitleaks, SHA-pinned actions, Dependabot.

---

## Принципы работы (security-модель: «разрыв смертельной триады»)

Prompt-injection из вставленного контента нельзя исключить полностью, поэтому опасны не сами инъекции, а их *последствия*. Сервер убирает две ноги триады из трёх:

1. **Нет канала эксфильтрации** — у контейнера нет исходящей сети вообще (`internal: true`; isomorphic-git без push/fetch; ни одного fetch/SSH/прокси в коде).
2. **Все действия обратимы** — `hard-delete` отсутствует; удаление = перенос в `.trash/` (восстановимо через git); каждая мутация атомарна (temp+rename), под локом, коммитится в git с записью в `_log.md`.
3. **Недоверенный контент маркируется** — вывод инструментов чтения обёрнут в `<<<UNTRUSTED_VAULT_CONTENT … >>>`.

Дополнительно: `vault-core` — единственная дверь к ФС (realpath-confinement, allowlist `.md`/`.canvas`, запрет служебных папок `.git`/`.obsidian`/`.trash`); fail-closed при невалидном `VAULT_ROOT`/`MCP_TOKEN`; Bearer-auth (constant-time + lockout) до парсинга тела.

**Тиринг подтверждений:** `additive`-инструменты (create/append/update) — автономны; `structural`/`destructive` (`move`/`promote`/`soft_delete`) — сначала dry-run, затем `confirm: true`.

---

## Инструменты (27)

| Категория | Инструменты |
|---|---|
| Чтение/навигация | `vault_tree`, `read_node`, `read_file`, `read_index`, `read_hot` (+граф-дайджест) |
| Поиск/дедуп | `search` (параметр `scope`: `all` / `knowledge` / `raw`), `ingest_planner` (read-only worksheet дедупа концептов) |
| Граф (read-only) | `graph_query`, `graph_neighbors`, `graph_path`, `graph_stats` |
| Аудит здоровья | `lint` (сироты, битые ссылки, устаревшие entity, несвязанное сырьё, противоречия, здоровье графа) |
| Запись (additive, есть `idempotency_key`) | `create_note`, `append_to_home`, `add_raw`, `update_memory`, `update_index`, `update_hot`, `mark_raw_ingested`, `append_contradiction`, `graph_upsert` |
| Правка (dry-run → `confirm`) | `edit_note` (якорная замена в существующем файле) |
| Структура (dry-run → `confirm`) | `create_node`, `move` (чинит backlinks), `promote`, `soft_delete` |
| Экстракция | `extract_pdf` (текстовый слой PDF из `_attachments/`, опция `save_raw` → `_raw/docs/`) |

---

## Развёртывание (для AI-агента: выполняй по шагам)

### Предварительно
- **Docker Desktop** (для HTTP-режима) и/или **Node ≥ 22** (для stdio-режима и сборки).
- `openssl` для генерации токена.
- Канонический Obsidian-вольт на хосте. Если вольта ещё нет — засей скелет: `cp -rn vault-skeleton/. /path/to/vault/`.

### Шаг 1 — секрет и переменные
```bash
# Токен (минимум 32 символа). Это Docker secret, в образ не попадает.
openssl rand -hex 32 > secrets/mcp_token

# Путь к вольту на хосте — для bind-mount docker-compose.
cp .env.example .env
# отредактируй .env: VAULT_HOST_PATH=<абсолютный путь к вольту>
```

### Шаг 2а — HTTP-режим (Docker, для Telegram-бота / LAN)
```bash
docker compose up -d --build
```
Поднимаются два контейнера: `vault-mcp` (порт 8787, наружу **не** публикуется) и `caddy` (`:8788 → :80`). Проверка:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8788/healthz          # → 200
TOK=$(cat secrets/mcp_token)
curl -s -X POST http://127.0.0.1:8788/mcp \
  -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# → SSE: event: message / data: {"result":{..."serverInfo":{"name":"vault-mcp"...
```
Без заголовка `Authorization` эндпоинт возвращает **401**.

### Шаг 2б — stdio-режим (Claude Desktop, локально)
```bash
npm ci && npm run build      # компилирует dist/stdio.js
```
Затем добавь сервер в конфиг Claude Desktop
(`%APPDATA%\Claude\claude_desktop_config.json` на Windows;
`~/Library/Application Support/Claude/claude_desktop_config.json` на macOS):
```jsonc
{
  "mcpServers": {
    "vault-mcp": {
      "command": "cmd",                       // Windows; на macOS/Linux → "node" без cmd /c
      "args": ["/c", "node", "<repo>/dist/stdio.js"],
      "env": {
        "VAULT_ROOT": "<абсолютный путь к вольту>",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```
> **Важно (gotcha):** Claude Desktop читает конфиг только при старте и перезаписывает файл из памяти во время работы. Редактируй конфиг **при полностью закрытом приложении** (трей → Quit), иначе правка будет затёрта. На Windows `command: "cmd"` надёжнее, чем `"node"` (гарантированно резолвится из `System32`).

stdio-режим не требует токена и сети — Claude Desktop спавнит процесс, протокол идёт по stdin/stdout, логи в stderr.

---

## Конфигурация (переменные окружения)

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `VAULT_ROOT` | — *(обязательно)* | Абсолютный путь к вольту. Резолвится через realpath; невалидный → отказ старта. |
| `MCP_TOKEN` / `MCP_TOKEN_FILE` | — *(обязательно для HTTP)* | Bearer-токен (≥32 симв.). `_FILE` = путь к Docker secret, имеет приоритет. |
| `BIND_HOST` | `127.0.0.1` | Адрес прослушивания (в Docker = `0.0.0.0`, наружу закрыт сетью). |
| `PORT` | `8787` | Порт HTTP-транспорта. |
| `BODY_LIMIT` | `1mb` | Лимит тела запроса. |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `60000` / `120` | Rate-limit. |
| `AUTH_LOCKOUT_THRESHOLD` / `AUTH_LOCKOUT_MS` | `10` / `900000` | Лок-аут по IP после серии неудачных авторизаций. |
| `SERVER_TIMEOUT_MS` | `30000` | Таймаут сервера. |
| `LOG_FILE` | — *(stderr)* | Путь к JSON-логу (0600, ротация 5 MiB); без значения — только stderr. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `vault-mcp` / `vault-mcp@localhost` | Идентичность локальных коммитов. |

В Docker эти переменные заданы в `docker-compose.yml`; для запуска без Docker — скопируй `.env.example` → `.env`.

---

## Подключение клиентов

### Telegram-бот / любой MCP-клиент (HTTP)
- Эндпоинт: `POST http://<host>:8788/mcp`
- Заголовки: `Authorization: Bearer <MCP_TOKEN>` и `Accept: application/json, text/event-stream` (ответ — **SSE**).
- Идемпотентность: передавай `idempotency_key` в write-инструментах, чтобы повтор из durable-очереди не задвоил запись.
- Пример клиента на TS (`StreamableHTTPClientTransport`) и через мост `mcp-remote` — см. [`CONNECT-BOT.md`](CONNECT-BOT.md).

### Claude Desktop (stdio)
См. «Шаг 2б» выше.

---

## Структура репозитория

```
src/
├── index.ts          — HTTP-точка входа (Express + StreamableHTTP)
├── stdio.ts          — stdio-точка входа (Claude Desktop)
├── config.ts         — fail-closed конфиг
├── auth.ts           — Bearer-middleware (constant-time + lockout)
├── server.ts logger.ts mcp.ts (mcp.ts отдаёт MCP `instructions` — лестница чтения для любого клиента)
├── core/             — vault-core: paths, atomic, lock, git, search, backlinks, lint
│   └── graph/        — linkparse, builder (derived), store (semantic), assemble, match (IDF),
│                       traverse (BFS+бюджет), communities (Louvain), render (санитизация)
└── tools/            — read / write / edit / structural / graph / pdf / untrusted-wrap / idempotency
test/                 — vitest: confinement, integration, auth, config, concurrency, graph, pdf
vault-skeleton/       — стартовый скелет вольта (_index/_hot/_log/_contradictions/_system/agent.md/
                        _templates/{entity,node-_home,node-_memory}/_raw/{articles,notes,docs}/_attachments)
Dockerfile  docker-compose.yml  Caddyfile
.github/              — CI (SCA + gitleaks) + Dependabot
```

---

## Локальная разработка

```bash
npm ci
npm run build        # tsc → dist/
npm test             # vitest (confinement, integration, auth, config, concurrency)
npm run dev          # tsx watch (HTTP-режим)
```

---

## Лицензия и статус

Персональный проект. Слой 1 (фазы 0–5) — готов и задеплоен. Слой 3 (внешний HTTPS, фасад `brain.*`) — отложен.
