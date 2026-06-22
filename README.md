# line-personal-linets-bot

Personal LINE account bot worker built on [`@evex/linejs`](https://github.com/zapabob/linejs).

This repository contains the **Node/LineTS-style worker** used by the personal LINE bridge:

- local HTTP API (`/health`, `/status`, `/events`, `/chats`, `/send`)
- auth-token / email-password / QR login flows
- group-only tag-triggered auto-replies
- dynamic reply webhook integration
- LINE reply threading via `relatedMessageId`
- lightweight group moderation commands (`kick`, `ban`, `unban`)
- log/output redaction for common secret patterns

## Safety

Do **not** commit these runtime files:

- `.env` / real credentials
- `linejs-storage.json`
- `linejs-group-banlist.json`
- `bridge.log` / `bridge.pid`
- `auth-backups/`
- `node_modules/`

The included `.gitignore` excludes them.

## Setup

```bash
npm install
cp .env.example .env
# edit .env or set environment variables in your supervisor
npm start
```

If using Git Bash on Windows, load environment variables with your preferred supervisor instead of committing `.env`.

## HTTP API

```text
GET  /health
GET  /status
GET  /events?limit=20
GET  /chats?limit=50
POST /send { "to": "<chat-mid>", "text": "hello", "relatedMessageId": "optional-message-id" }
```

`/send` accepts either `relatedMessageId` or `replyToMessageId` and sends a real LINE reply when supplied.

## Environment variables

Primary prefix: `LINEJS_PERSONAL_*`.

See `.env.example` for supported variables. Legacy `LINE_PERSONAL_*` fallback is gated by `LINEJS_PERSONAL_USE_LINE_PERSONAL_FALLBACK=1`.

## Verification

```bash
npm run check
npm audit --omit=dev
```

## Dependency security note

At the time this repository was exported, `npm audit` reports high-severity advisories through `@evex/linejs`'s transitive `thrift` dependency (`GHSA-r67j-r569-jrwp`, `GHSA-526f-jxpj-jmg2`). Keep this worker bound to localhost or a trusted private network, avoid exposing it directly to the public internet, and update `@evex/linejs` when an upstream release moves to a patched thrift version.

## Notes

This is a personal-account automation bridge. Use it only with accounts and chats you control or have permission to automate.
