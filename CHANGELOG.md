# Changelog

## 0.1.3

- `watchPresence({ projectKey, baseUrl, visitorKey, onPreview, canShowPreview })`: live visitors for custom UIs. Reports the visitor's page while the tab is visible (every 15 s and on client-side navigation), stops when live visitors are off, and hands over the newest agent reply they haven't read. `previewSeen()` keeps a reply from coming back.
- `getVisitorKey(projectKey, storage?)`: this browser's visitor key, stored under the same name the hosted widget uses. Pass it to `ReponlyClient` as `visitorKey`.
- Types: `PresencePreview`, `PresenceHeartbeatView`.

## 0.1.2

- `sendMessage({ welcomeShown: true })`: tell Reponly your UI showed the welcome text, so it is kept as the conversation's greeting and agents see what the visitor answered.
- `watchTriggers(config.triggers, { projectKey, onShow, canShow })`: show automatic messages with the hosted widget's rules (path, delay, audience, once per visitor, never after the chat was opened). `chatOpened()` returns the trigger to send as `triggerId`. `pickTrigger` is the matching rule on its own.

## 0.1.1

- `CustomerConversationView.customerLastReadSeq`: the newest seq the customer has read on any device, so unread counts agree across browsers.
- `subscribe()` reuses the session from `connect()` / `identify()` instead of opening a second one on every page load.
- Docs: the customer channel's events are `message.created` and `restriction.updated` (never `conversation.updated`); sends are not retried automatically.

## 0.1.0

First public release: `ReponlyClient` (sessions, identify, history, messages, files, contact email, read receipts, real-time events), `ReponlyError`, and the customer API's types.
