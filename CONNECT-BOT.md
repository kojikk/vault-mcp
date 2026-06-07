# Подключение бота к Vault MCP

Бот (отдельный проект: durable-queue / API-agent) ходит в Vault MCP по **HTTP**
(Streamable HTTP, stateless), а не по stdio. Stdio — только для Claude Desktop.

## 1. Поднять MCP по HTTP

```bash
docker compose up -d        # vault-mcp + caddy
```

- Прямой эндпоинт (loopback): `POST http://127.0.0.1:8787/mcp`
- Через Caddy (единственный внешний вход): `POST http://<host>:8788/mcp`
- Health: `GET /healthz` (без авторизации)
- `GET`/`DELETE /mcp` → `405` (только POST)

Токен берётся из Docker secret (`MCP_TOKEN_FILE`). Сгенерировать:
`openssl rand -hex 32` (минимум 32 символа, иначе старт fail-closed).

## 2. Авторизация

Каждый запрос обязан нести заголовок:

```
Authorization: Bearer <MCP_TOKEN>
```

- Сверка в constant-time; нет токена/неверный → `401`.
- Rate-limit + лок-аут по IP при серии неудач.
- Токен только в заголовке (не в query), проверяется **до** парсинга тела.

## 3. Клиент в боте

Вариант А — родной MCP-клиент (TS):

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("http://127.0.0.1:8787/mcp"),
  { requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } } },
);
const client = new Client({ name: "bot", version: "0.1.0" });
await client.connect(transport);

await client.callTool({ name: "create_note", arguments: { path: "inbox/x.md", body: "..." } });
```

Вариант Б — мост `mcp-remote` (если у бота stdio-клиент):

```
npx -y mcp-remote@latest http://127.0.0.1:8787/mcp --allow-http \
  --header "Authorization:Bearer ${MCP_TOKEN}"
```

## 4. Идемпотентность (важно для очереди бота)

Повторная доставка из очереди не должна дублировать запись — передавай
`idempotency_key` в аргументах write-инструментов:

```jsonc
{ "name": "create_note",
  "arguments": { "path": "inbox/x.md", "body": "...", "idempotency_key": "<msg-id>" } }
```

Повтор с тем же ключом вернёт прежний результат, не создавая дубликат.

## 5. Структурные операции — dry-run → confirm

`move` / `promote` / `soft_delete` сначала зови без `confirm` (получишь план),
затем повтори с `confirm: true`. Hard-delete отсутствует — только `.trash`.

## Безопасность (что бот НЕ может)

Нет egress, нет shell, нет hard-delete, выход за `VAULT_ROOT` отклоняется
(realpath-confinement). Контент заметок возвращается обёрнутым как untrusted.
