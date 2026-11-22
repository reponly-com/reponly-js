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

// After a reconnect, fetch only what you missed:
const newer = await chat.getMessages(conversationId, lastSeenSeq);
```

Conversations come newest first; messages are ordered by `seq`. Each conversation carries `customerLastReadSeq`, the newest message the customer has read on any device, so you can count unread agent replies without storing anything yourself:

```ts
const unread = messages.filter((m) => m.senderType !== "customer" && m.seq > conversations[0].customerLastReadSeq).length;
```

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
| `new ReponlyClient({ projectKey, baseUrl?, storage? })` | `baseUrl` defaults to the current origin. `storage` defaults to localStorage, with an in-memory fallback. |
| `getConfig()` | The product's public settings (cached). |
| `connect(identityToken?)` | Starts or resumes the session. |
| `identify(identityToken)` / `logout()` | Sign a user in or out. |
| `getStatus()` | Any restriction or cooldown on this customer. |
| `listConversations()` / `getMessages(id, afterSeq?)` | History, newest conversation first. |
| `sendMessage(content, options?)` | Options: `conversationId`, `clientMessageId`, `attachmentIds`, `contactEmail`, `context`. |
| `uploadAttachment(file, name?)` | Upload one file and get back an `AttachmentView`. |
| `setContactEmail(email)` | The address replies are emailed to. |
| `markRead(conversationId, seq)` | Read receipt. |
| `subscribe(handler)` | Real-time events: `message.created`, `restriction.updated` and `connection` (`open` after every (re)subscribe: refetch then). Reuses the session from `connect()`. Returns an unsubscribe function. |

## License

MIT
