import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const popupSource = fs.readFileSync(path.join(root, "extension", "popup.js"), "utf8");

const secretLabel = `${"A".repeat(20)}.${"B".repeat(6)}.${"C".repeat(12)}`;
const accountId = "11111111-1111-4111-8111-111111111111";
const archivedAccountId = "22222222-2222-4222-8222-222222222222";
const HOST_VERSION = "1.8.0";
const safeLabel = "Sensitive label hidden - 1111";
const avatarData = "data:image/webp;base64,UklGRlAAAABXRUJQVlA4IEQAAADQAwCdASpAAEAAPnk8m0qkoyKhoggAkA8JaQB2AAAgbqagCvELcgAA/uHDf//pNn/IM/8gz8/f/13i0mbzCWyhAAAAAA==";
const chromeCanvasAvatarData = "data:image/webp;base64,UklGRjICAABXRUJQVlA4WAoAAAAgAAAAPwAAPwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggRAAAANADAJ0BKkAAQAA+eTybSqSjIqGiCACQDwlpAHYAACBupqAK8QtyAAD+4cN//+k2f8gz/yDPz9//XeLSZvMJbKEAAAAA";
const textHistory = [];
const attributeHistory = [];
const confirmationHistory = [];
const promptHistory = [];
const nativeRequestHistory = [];
const backgroundRequestHistory = [];
const confirmationResults = [];

class MockElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toLowerCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.disabled = false;
    this.hidden = false;
    this.type = "";
    this.value = "";
    this._textContent = "";
    this._title = "";
  }

  set textContent(value) {
    this._textContent = String(value);
    textHistory.push(this._textContent);
  }

  get textContent() {
    return this._textContent;
  }

  set title(value) {
    this._title = String(value);
    attributeHistory.push(this._title);
  }

  get title() {
    return this._title;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(name, value) {
    const cleanValue = String(value);
    this.attributes.set(name, cleanValue);
    attributeHistory.push(cleanValue);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async dispatch(type) {
    const event = { preventDefault() {} };
    for (const listener of this.listeners.get(type) ?? []) {
      await listener(event);
    }
    await settle();
  }

  focus() {}

  select() {}

  querySelector(selector) {
    const matches = (element) => {
      if (selector.startsWith(".")) {
        return element.className.split(/\s+/).includes(selector.slice(1));
      }
      if (selector === "button[type='submit']") {
        return element.tagName === "button" && element.type === "submit";
      }
      return element.tagName === selector.toLowerCase();
    };

    const queue = [...this.children];
    while (queue.length > 0) {
      const element = queue.shift();
      if (matches(element)) return element;
      queue.push(...element.children);
    }
    return null;
  }
}

const byId = new Map();
function element(id, tagName = "div") {
  const item = new MockElement(tagName);
  byId.set(id, item);
  return item;
}

element("tabs", "div");
element("tab-profiles", "button");
element("tab-invite", "button");
element("panel-profiles", "section");
element("panel-invite", "section");
element("new-profile", "button");
element("search", "div");
element("account-search", "input");

const accountList = element("account-list", "ul");
element("account-count", "span");
element("no-results", "p");
const emptyState = element("empty-state", "div");
emptyState.append(new MockElement("p"), new MockElement("small"));
element("empty-create", "button");
element("archived-section", "details");
const archivedList = element("archived-list", "ul");
element("archived-count", "span");
const inviteForm = element("invite-form", "form");
const inviteInput = element("invite-input", "input");
const inviteFeedback = element("invite-feedback", "p");
element("invite-avatars", "div");
element("invite-targets", "span");
const inviteSubmitButton = element("invite-submit", "button");
inviteSubmitButton.type = "submit";
inviteForm.append(inviteInput, inviteSubmitButton);
const notice = element("notice", "p");
const noticeActionButton = element("notice-action", "button");
element("notice-close", "button");
element("helper-dot", "span");
element("helper-status", "span");
element("check-helper", "button");

// The popup asks for names, tags, and confirmations through an in-page sheet.
// This mock records what the sheet shows and answers it the way a user would.
const sheet = element("sheet", "dialog");
const sheetForm = element("sheet-form", "form");
const sheetTitle = element("sheet-title", "h2");
const sheetMessage = element("sheet-message", "p");
const sheetField = element("sheet-field", "div");
element("sheet-label", "label");
const sheetInput = element("sheet-input", "input");
element("sheet-hint", "p");
const sheetCancel = element("sheet-cancel", "button");
element("sheet-confirm", "button");
sheet.open = false;
sheet.showModal = function showModal() {
  this.open = true;
  const shownText = `${sheetTitle.textContent}\n${sheetMessage.textContent}`;
  const hasField = !sheetField.hidden;
  if (hasField) {
    promptHistory.push([shownText, sheetInput.value]);
  } else {
    confirmationHistory.push(shownText);
  }
  queueMicrotask(async () => {
    if (!hasField) {
      const accepted = confirmationResults.length > 0 ? confirmationResults.shift() : true;
      await (accepted ? sheetForm : sheetCancel).dispatch(accepted ? "submit" : "click");
      return;
    }
    sheetInput.value = this.dataset.kind === "tags" ? "Main, Backup" : "Recovered profile";
    await sheetForm.dispatch("submit");
  });
};
sheet.close = function close() {
  this.open = false;
  for (const listener of this.listeners.get("close") ?? []) {
    listener({});
  }
};

const document = {
  querySelector(selector) {
    if (!selector.startsWith("#")) return null;
    return byId.get(selector.slice(1)) ?? null;
  },
  createElement(tagName) {
    return new MockElement(tagName);
  }
};

let account = {
  id: accountId,
  label: secretLabel,
  createdAt: "2026-07-14T01:00:00.0000000+00:00",
  archived: false,
  avatarData,
  tags: ["Main", "Gaming"]
};
const archivedAccount = {
  id: archivedAccountId,
  label: "Backup profile",
  createdAt: "2026-07-14T01:01:00.0000000+00:00",
  archived: true,
  tags: ["Backup"]
};

const chrome = {
  runtime: {
    lastError: undefined,
    sendMessage(request, callback) {
      backgroundRequestHistory.push(JSON.stringify(request));
      callback({ ok: true, total: request.profileIds.length });
    },
    sendNativeMessage(_hostName, request, callback) {
      nativeRequestHistory.push(JSON.stringify(request));
      switch (request.action) {
        case "ping":
          callback({ ok: true, message: "Helper ready.", version: HOST_VERSION });
          return;
        case "list":
          callback({ ok: true, message: "Accounts loaded.", version: HOST_VERSION, accounts: [account, archivedAccount] });
          return;
        case "launch":
          callback({ ok: true, message: "Discord profile opened.", version: HOST_VERSION, isNewProfile: false });
          return;
        case "rename":
          account = { ...account, label: request.label };
          callback({ ok: true, message: "Profile renamed.", version: HOST_VERSION, account });
          return;
        case "setTags":
          account = { ...account, tags: request.tags };
          callback({ ok: true, message: "Profile tags saved.", version: HOST_VERSION, account });
          return;
        case "archive":
          account = { ...account, archived: true };
          callback({ ok: true, message: "Profile moved to Archived.", version: HOST_VERSION, account });
          return;
        case "restore":
          account = { ...account, archived: false };
          callback({ ok: true, message: "Profile restored to the list.", version: HOST_VERSION, account });
          return;
        case "delete":
          callback({ ok: true, message: "Profile deleted.", version: HOST_VERSION, filesRemoved: true });
          return;
        default:
          callback({ ok: false, message: "Unexpected test request.", version: HOST_VERSION });
      }
    }
  }
};

// Native dialogs must not be used; the in-page sheet replaces them.
const window = {
  confirm() {
    throw new Error("popup must not call window.confirm");
  },
  prompt() {
    throw new Error("popup must not call window.prompt");
  }
};

// Notice auto-dismiss timers are not needed for these checks.
const setTimeout = () => 0;
const clearTimeout = () => {};

const context = { atob, btoa, chrome, console, document, window, setTimeout, clearTimeout };
vm.runInNewContext(
  `${popupSource}\nglobalThis.__avatarCodec = { avatarDataByteLength, canonicalizeWebPDataUrl };\n` +
    "globalThis.__tagHelpers = { parseTagPrompt, isValidTags };\n" +
    "globalThis.__inviteHelpers = { parseDiscordInviteCode, setAccounts(value) { accounts = value; renderAccounts(); } };",
  context,
  { filename: "popup.js" }
);
await settle();

assert.equal(context.__avatarCodec.canonicalizeWebPDataUrl(chromeCanvasAvatarData), avatarData);
assert.equal(context.__avatarCodec.avatarDataByteLength(avatarData), 88);
assert.equal(context.__avatarCodec.canonicalizeWebPDataUrl("data:image/webp;base64,SGVsbG8="), null);
assert.deepEqual(Array.from(context.__tagHelpers.parseTagPrompt("Main, Backup")), ["Main", "Backup"]);
assert.deepEqual(Array.from(context.__tagHelpers.parseTagPrompt("")), []);
assert.throws(() => context.__tagHelpers.parseTagPrompt("Main,,Backup"), /at most 2 tags/i);
assert.throws(() => context.__tagHelpers.parseTagPrompt("Same, same"), /different tags/i);
assert.throws(() => context.__tagHelpers.parseTagPrompt(secretLabel), /tokens|passwords/i);
assert.equal(context.__tagHelpers.isValidTags(["Main", "Backup"]), true);
assert.equal(context.__tagHelpers.isValidTags(["same", "Same"]), false);

for (const [input, expected] of [
  ["Ab_12-x", "Ab_12-x"],
  ["discord.gg/Ab_12-x", "Ab_12-x"],
  ["https://discord.gg/Ab_12-x", "Ab_12-x"],
  ["discord.com/invite/Ab_12-x", "Ab_12-x"],
  ["https://discord.com/invite/Ab_12-x", "Ab_12-x"],
  ["https://discord.gg/Ab_12-x?utm_source=test#fragment", "Ab_12-x"]
]) {
  assert.equal(context.__inviteHelpers.parseDiscordInviteCode(input), expected);
}
for (const input of [
  "",
  "a",
  "http://discord.gg/Ab_12-x",
  "//discord.gg/Ab_12-x",
  "https://discord.gg.evil.test/Ab_12-x",
  "https://discord.com.evil.test/invite/Ab_12-x",
  "https://user@discord.gg/Ab_12-x",
  "https://discord.gg:443/Ab_12-x",
  "https://discord.gg/Ab_12-x/",
  "https://discord.gg/Ab_12-x/extra",
  "https://discord.com/channels/Ab_12-x",
  "https://discord.com/invite/Ab_12-x/extra",
  "https://discord.gg/Ab%2F12",
  "https://discord.gg/Ab_12-x?bad query",
  `https://discord.gg/${"A".repeat(65)}`,
  "https://dіscord.gg/Ab_12-x"
]) {
  assert.throws(
    () => context.__inviteHelpers.parseDiscordInviteCode(input),
    /valid Discord invite/i
  );
}

assert.equal(accountList.children.length, 1);
assert.equal(archivedList.children.length, 1);
assert.equal(accountList.children[0].querySelector(".account-label")?.textContent, safeLabel);
assert.equal(accountList.children[0].querySelector(".rename-button")?.textContent, "Rename");
assert.equal(accountList.children[0].querySelector(".tags-button")?.textContent, "Tags");
assert.equal(
  accountList.children[0].querySelector(".delete-button"),
  null,
  "active profiles must be archived before they can be deleted"
);
assert.equal(archivedList.children[0].querySelector(".delete-button")?.textContent, "Delete");
assert.deepEqual(
  accountList.children[0].querySelector(".account-tags")?.children.map((item) => item.textContent),
  ["Main", "Gaming"]
);
assert.equal(accountList.children[0].querySelector(".profile-avatar-image")?.src, avatarData);
assertNoSecretLeak();

await accountList.children[0].querySelector(".tags-button").dispatch("click");
assert.match(promptHistory.at(-1)?.[0] ?? "", /^Edit tags\n.*"Sensitive label hidden - 1111"/);
assert.equal(promptHistory.at(-1)?.[1], "Main, Gaming");
assert.match(nativeRequestHistory.at(-1) ?? "", /"action":"setTags"/);
assert.deepEqual(
  accountList.children[0].querySelector(".account-tags")?.children.map((item) => item.textContent),
  ["Main", "Backup"]
);
assert.match(notice.textContent, /Tags saved for Sensitive label hidden - 1111/i);
assertNoSecretLeak();

await accountList.children[0].querySelector(".open-button").dispatch("click");
assert.match(notice.textContent, /Saved Chrome profile reopened/i);
assertNoSecretLeak();

const confirmationsBeforeArchive = confirmationHistory.length;
await accountList.children[0].querySelector(".remove-button").dispatch("click");
assert.equal(archivedList.children.length, 2);
assert.equal(
  confirmationHistory.length,
  confirmationsBeforeArchive,
  "archiving is reversible, so it offers Undo instead of a confirmation"
);
assert.match(notice.textContent, /Sensitive label hidden - 1111 moved to Archived/i);
assert.equal(noticeActionButton.hidden, false);
assert.equal(noticeActionButton.textContent, "Undo");
assertNoSecretLeak();

await archivedList.children[0].querySelector(".restore-button").dispatch("click");
assert.match(notice.textContent, /Sensitive label hidden - 1111 restored to the list/i);
assertNoSecretLeak();

await accountList.children[0].querySelector(".remove-button").dispatch("click");
assert.equal(accountList.children.length, 0);
await noticeActionButton.dispatch("click");
assert.equal(accountList.children.length, 1);
assert.equal(archivedList.children.length, 1);
assert.match(notice.textContent, /Sensitive label hidden - 1111 restored to the list/i);
assertNoSecretLeak();

await accountList.children[0].querySelector(".rename-button").dispatch("click");
assert.match(promptHistory.at(-1)?.[0] ?? "", /^Rename profile\n.*"Sensitive label hidden - 1111"/);
assert.equal(promptHistory.at(-1)?.[1], "", "a token-like label must never prefill the rename field");
assert.equal(accountList.children[0].querySelector(".account-label")?.textContent, "Recovered profile");
assert.match(notice.textContent, /renamed to Recovered profile/i);
assertNoSecretLeak();

const inviteRequestsBefore = backgroundRequestHistory.length;

inviteInput.value = "https://example.com/Ab_12-x";
await inviteForm.dispatch("submit");
assert.equal(
  backgroundRequestHistory.length,
  inviteRequestsBefore
);
assert.match(inviteFeedback.textContent, /valid Discord invite/i);
assert.equal(inviteFeedback.dataset.state, "error");

confirmationResults.push(false);
inviteInput.value = "discord.gg/Ab_12-x";
await inviteForm.dispatch("submit");
assert.equal(
  backgroundRequestHistory.length,
  inviteRequestsBefore
);

inviteInput.value = "https://discord.gg/Ab_12-x?utm_source=test#fragment";
await inviteForm.dispatch("submit");
const inviteRequests = backgroundRequestHistory.map((request) => JSON.parse(request));
assert.deepEqual(inviteRequests, [{
  action: "startInviteBatch",
  profileIds: [accountId],
  inviteCode: "Ab_12-x"
}]);
assert.equal(
  nativeRequestHistory.some((request) => JSON.parse(request).action === "launchInvite"),
  false,
  "popup must not own the native invite loop"
);
assert.match(confirmationHistory.at(-1) ?? "", /all 1 active profile/i);
assert.match(confirmationHistory.at(-1) ?? "", /confirm Join Server manually/i);
assert.equal((confirmationHistory.at(-1) ?? "").includes("Ab_12-x"), false);
assert.equal((confirmationHistory.at(-1) ?? "").includes("discord.gg"), false);
assert.equal(JSON.stringify(inviteRequests).includes("utm_source"), false);
assert.equal(JSON.stringify(inviteRequests).includes("fragment"), false);
assert.match(notice.textContent, /Opening the invite in 1 profile window in the background/i);
assert.match(notice.textContent, /Confirm Join Server manually/i);
assert.equal(inviteInput.value, "");
assert.equal(inviteSubmitButton.textContent, "Open all active (1)");
assert.equal(inviteSubmitButton.disabled, false);
assertNoSecretLeak();

const oversizedBatch = Array.from({ length: 21 }, (_unused, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  label: `Test profile ${index + 1}`,
  createdAt: "2026-07-14T02:00:00.0000000+00:00",
  archived: false
}));
context.__inviteHelpers.setAccounts(oversizedBatch);
const requestsBeforeOversizedBatch = nativeRequestHistory.length;
const backgroundRequestsBeforeOversizedBatch = backgroundRequestHistory.length;
const confirmationsBeforeOversizedBatch = confirmationHistory.length;
inviteInput.value = "Ab_12-x";
await inviteForm.dispatch("submit");
assert.equal(nativeRequestHistory.length, requestsBeforeOversizedBatch);
assert.equal(backgroundRequestHistory.length, backgroundRequestsBeforeOversizedBatch);
assert.equal(confirmationHistory.length, confirmationsBeforeOversizedBatch);
assert.match(notice.textContent, /at most 20 saved profiles/i);
context.__inviteHelpers.setAccounts([account, archivedAccount]);

// Delete always asks first, shows only the masked name, and sends nothing when cancelled.
context.__inviteHelpers.setAccounts([
  { ...account, label: secretLabel, archived: true },
  archivedAccount
]);
assert.equal(accountList.children.length, 0);
const requestsBeforeDelete = nativeRequestHistory.length;
confirmationResults.push(false);
await archivedList.children[0].querySelector(".delete-button").dispatch("click");
assert.equal(nativeRequestHistory.length, requestsBeforeDelete, "a cancelled delete must not reach the helper");
assert.match(confirmationHistory.at(-1) ?? "", /^Delete "Sensitive label hidden - 1111" permanently\?/);
assert.equal(archivedList.children.length, 2);

await archivedList.children[0].querySelector(".delete-button").dispatch("click");
assert.equal(nativeRequestHistory.length, requestsBeforeDelete + 1);
assert.deepEqual(JSON.parse(nativeRequestHistory.at(-1)), { action: "delete", profileId: accountId });
assert.equal(archivedList.children.length, 1);
assert.equal(archivedList.children[0].dataset.accountId, archivedAccountId);
assert.match(notice.textContent, /^Sensitive label hidden - 1111 deleted\.$/);
assertNoSecretLeak();

console.log("Popup security, avatar, tag, invite, and delete checks passed.");

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setImmediate(resolve));
}

function assertNoSecretLeak() {
  const exposedSurfaces = [
    ...textHistory,
    ...attributeHistory,
    ...confirmationHistory,
    ...promptHistory.flat(),
    ...nativeRequestHistory,
    ...backgroundRequestHistory
  ];
  for (const value of exposedSurfaces) {
    assert.equal(value.includes(secretLabel), false, "legacy secret-like label reached a visible or outbound surface");
  }
  assert.equal(exposedSurfaces.some((value) => value.includes(safeLabel)), true);
}
