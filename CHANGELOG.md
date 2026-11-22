# Changelog

## 0.1.1

- `CustomerConversationView.customerLastReadSeq`: the newest seq the customer has read on any device, so unread counts agree across browsers.
- `subscribe()` reuses the session from `connect()` / `identify()` instead of opening a second one on every page load.
- Docs: the customer channel's events are `message.created` and `restriction.updated` (never `conversation.updated`); sends are not retried automatically.

## 0.1.0

First public release: `ReponlyClient` (sessions, identify, history, messages, files, contact email, read receipts, real-time events), `ReponlyError`, and the customer API's types.
