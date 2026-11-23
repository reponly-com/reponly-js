# reponly

The JavaScript SDK for [Reponly](https://reponly.com) customer chat. Use it to build your own in-app support chat instead of the hosted widget. It handles sessions, token storage, expired-session recovery and real-time messages for you. When a send fails, retry it with the same `clientMessageId` so it is never delivered twice.

- No dependencies. It ships its own small real-time client.
- Works in any browser framework, or with none.
- TypeScript types included.

The hosted Reponly widget runs on this same SDK.

## Before you start

- A custom UI needs the **Pro** plan.
- Add your site's origin to **Allowed domains** in the product's settings. Otherwise browser calls fail with `403 origin_not_allowed`.
- Copy your **project key** (`pk_...`) and the **base URL** from the product's **Custom UI** tab.

## Install

```sh
npm install reponly
```

## Quick start

```ts
import { ReponlyClient, ReponlyError } from "reponly";

const chat = new ReponlyClient({
  projectKey: "pk_...",
  baseUrl: "https://reponly.com",
});

// Anonymous visitor. The customer token is kept in localStorage, so a returning
// visitor gets the same chat.
await chat.connect();

const config = await chat.getConfig(); // welcome text, availability, askForEmail, attachments

const off = chat.subscribe((event) => {
  if (event.type === "message.created") render(event.message);
  if (event.type === "message.updated") replace(event.message); // an agent edited it
  if (event.type === "message.deleted") remove(event.messageId); // an agent deleted it
  if (event.type === "connection" && event.state === "open") resync(); // after every reconnect
});

try {
  await chat.sendMessage("Hello!"); // sends the current page, language and time zone with it
} catch (error) {
  if (error instanceof ReponlyError && (error.isRateLimited || error.isRestricted)) {
    showNotice(error.message, error.retryAt);
  }
}
```

## Signed-in users

To give a signed-in user the same chat on every device, your backend asks Reponly for an identity token (`POST /api/v1/identify` with your secret key). The **Identify users** tab in Reponly has the exact steps. Pass the token to the SDK:

```ts
await chat.identify(identityToken);

// When your user signs out:
chat.logout();
```

## History

```ts
const conversations = await chat.listConversations();
const messages = await chat.getMessages(conversations[0].id);

// Only messages after a seq, e.g. to page through a long thread:
const newer = await chat.getMessages(conversationId, lastSeenSeq);
```

Agents can edit or delete messages they sent. Live, you get `message.updated` (replace the message with that `id`) and `message.deleted` (remove it). After a reconnect, fetch the whole conversation with `getMessages(id)` and replace your list rather than merging, so edits and deletions you missed show up; keep any of your own messages that are still sending. Show edited messages (`editedAt` set) with a small "edited" next to the time, and don't play a sound or count them as unread again.

Conversations come newest first; messages are ordered by `seq`. Each conversation carries `customerLastReadSeq`, the newest message the customer has read on any device, so you can count unread agent replies without storing anything yourself:

```ts
const unread = messages.filter((m) => m.senderType !== "customer" && m.seq > conversations[0].customerLastReadSeq).length;
```

Agent messages carry `senderName` (their first name) and `senderAvatarUrl` (their current photo, or `null`). Show both next to agent replies, so the visitor sees who they're talking to: use the photo only when it's an `https://` URL, and fall back to the name's initial. Automatic and system messages have neither.

For new agent replies that arrive live (a `message.created` event for a message you don't have yet, not history or a resync), play a short sound, at most once per burst, and give the chat a mute button that's remembered in localStorage. Browsers only allow sound after the visitor has clicked or typed on the page.

## Welcome text and automatic messages

If your chat shows `config.appearance.welcomeText` above the messages, say so when you send. Reponly keeps that text as the conversation's greeting, so the agent sees what the visitor was answering. Without it, the agent's inbox starts at the visitor's first message.

```ts
const welcome = config.appearance.welcomeText;
await chat.sendMessage(text, { welcomeShown: Boolean(welcome) });
```

Both only matter on the message that starts a conversation; sending them on every message is fine.

### Automatic messages (Pro)

`config.triggers` lists the product's automatic messages. The hosted widget shows one after `delaySeconds` on a page whose path contains `pathContains`, to the right `audience` (new or returning visitors), at most once per visitor each, and never again once they've opened the chat. `watchTriggers` applies the same rules for your UI, including client-side navigation:

```ts
import { watchTriggers } from "reponly";

const watcher = watchTriggers(config.triggers, {
  projectKey: "pk_...",
  onShow: (trigger) => showBubble(trigger.message), // e.g. a speech bubble by your chat button
  canShow: () => !chatIsOpen && launcherIsVisible,   // checked when scheduling and when the delay ends
});

// When the visitor opens your chat, from the bubble or any other way:
const trigger = watcher.chatOpened(); // stops the watcher for good
// Show trigger.message at the top of the chat instead of the welcome text, then:
await chat.sendMessage(text, { welcomeShown: true, triggerId: trigger?.id });
```

Only a new conversation takes the trigger as its greeting. If the visitor already has one, show the trigger's text, but there's no need to send `triggerId`. Call `watcher.refresh()` after `canShow()` turns true again, and `watcher.stop()` when your UI unmounts. `pickTrigger(triggers, { path, returning, isShown })` is the matching rule on its own, if you schedule things yourself.

## Live visitors (Pro)

The hosted widget reports which page each visitor is on, so they appear on the Live page and as "Online now" in the inbox, and agents can message them before they ever open the chat. A custom UI does the same with `watchPresence`. Run it on every page, not only while the chat is open:

```ts
import { getVisitorKey, ReponlyClient, watchPresence } from "reponly";

const visitorKey = getVisitorKey("pk_..."); // this browser's key on your site, kept in localStorage
const chat = new ReponlyClient({ projectKey: "pk_...", baseUrl: "https://reponly.com", visitorKey });

const presence = watchPresence({
  projectKey: "pk_...",
  baseUrl: "https://reponly.com",
  visitorKey,
  onPreview: (reply) => showBubble(reply.senderName, reply.text), // an agent reply they haven't read
  canShowPreview: () => !chatIsOpen && launcherIsVisible,
});

// When the visitor dismisses that bubble or opens your chat:
presence.previewSeen();
```

It reports while the tab is visible, every 15 seconds and on client-side navigation, and stops by itself when live visitors are off for the product (Free plan, switched off, or an origin outside the allowed ones). Pass the same `visitorKey` to `ReponlyClient`: that links the visit to the visitor's chat, and gives them the conversation an agent started from the Live page when they open it. Each reply is handed to `onPreview` once; after `previewSeen()` it doesn't come back on later pages. Call `presence.stop()` when your UI unmounts.

## Files

Upload first, then send the ids. A message can contain only files.

```ts
if (config.attachments) {
  const file = await chat.uploadAttachment(input.files[0]); // up to 10 MB
  await chat.sendMessage("", { attachmentIds: [file.id] }); // up to 5 per message
}
```

Show image attachments (`kind: "image"`) inline and other files as download links.

## Email fallback and read receipts

```ts
// Guests: after their first message, offer to email them the answer.
await chat.setContactEmail("maya@example.com");

// While your chat is visible, report what was read. Replies the customer
// already saw aren't emailed.
await chat.markRead(conversationId, lastSeq);
```

Check `config.askForEmail`:

- `"after_first_message"`: ask after the first message.
- `"before_first_message"`: ask first, and pass the address as `contactEmail` to `sendMessage`. Do the same when `config.paused` is true.
- `"never"`: don't ask.

## Errors

Every failed call throws a `ReponlyError` with `code`, `message`, `status` and `retryAt`. `message` is written to be shown to the user.

| Check | When |
| --- | --- |
| `isRateLimited` | Too many messages. `retryAt` says when the customer can send again. |
| `isRestricted` | The customer is blocked, either temporarily (`retryAt`) or permanently. |
| `isEmailRequired` | The product needs the customer's email first. |
| `isNetworkError` | The request didn't reach the server. Retry with the same `clientMessageId`. |

`sendMessage` creates a `clientMessageId` for you. Generate one yourself with `createClientMessageId()` and pass it in when you retry, so a retry never sends the same message twice.

## API

| Method | Description |
| --- | --- |
| `new ReponlyClient({ projectKey, baseUrl?, storage?, visitorKey? })` | `baseUrl` defaults to the current origin. `storage` defaults to localStorage, with an in-memory fallback. `visitorKey`: from `getVisitorKey`, for live visitors. |
| `getConfig()` | The product's public settings (cached). |
| `connect(identityToken?)` | Starts or resumes the session. |
| `identify(identityToken)` / `logout()` | Sign a user in or out. |
| `getStatus()` | Any restriction or cooldown on this customer. |
| `listConversations()` / `getMessages(id, afterSeq?)` | History, newest conversation first. |
| `sendMessage(content, options?)` | Options: `conversationId`, `clientMessageId`, `attachmentIds`, `contactEmail`, `context`, `welcomeShown`, `triggerId`. |
| `uploadAttachment(file, name?)` | Upload one file and get back an `AttachmentView`. |
| `setContactEmail(email)` | The address replies are emailed to. |
| `markRead(conversationId, seq)` | Read receipt. |
| `watchTriggers(triggers, options)` | Shows automatic messages with the hosted widget's rules. Returns `{ chatOpened, refresh, stop }`. |
| `getVisitorKey(projectKey, storage?)` | This browser's visitor key on your site, created once. |
| `watchPresence(options)` | Reports the visitor's page for live visitors and hands over unread agent replies. Returns `{ visitorKey, previewSeen, refresh, stop }`. |
| `subscribe(handler)` | Real-time events: `message.created`, `message.updated`, `message.deleted`, `restriction.updated` and `connection` (`open` after every (re)subscribe: refetch then). Reuses the session from `connect()`. Returns an unsubscribe function. |

## License

MIT
