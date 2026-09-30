"use strict";

const HOST_NAME = "com.local.discord_multi_account";
const MAX_LABEL_LENGTH = 40;
const MAX_TAGS = 2;
const MAX_TAG_LENGTH = 16;
const MAX_TAG_PROMPT_LENGTH = 80;
const MAX_INVITE_PROFILES = 20;
const MAX_INVITE_INPUT_LENGTH = 512;
const MAX_AVATAR_DATA_LENGTH = 2959;
const MAX_AVATAR_BYTES = 2200;
const MAX_AVATAR_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_AVATAR_SOURCE_DIMENSION = 4096;
const AVATAR_DIMENSION = 64;
const AVATAR_TONE_COUNT = 8;
const INVITE_PREVIEW_AVATARS = 5;
const SEARCH_THRESHOLD = 6;
const NOTICE_TIMEOUT_MS = 5000;
const UNDO_NOTICE_TIMEOUT_MS = 8000;
const MIN_HOST_VERSION = [1, 8, 0];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DISCORD_TOKEN_LABEL_PATTERN = /^(?:mfa\.[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*)$/;
const AVATAR_DATA_PATTERN = /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/;
const TAG_ALLOWED_PATTERN = /^[\p{L}\p{N} _-]+$/u;
const TAG_UNSUPPORTED_PATTERN = /[\p{Cc}\p{Cf}]/u;
const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{2,64}$/;
const INVITE_LINK_PATTERN = /^(?:https:\/\/)?(?:discord\.gg\/([A-Za-z0-9_-]{2,64})|discord\.com\/invite\/([A-Za-z0-9_-]{2,64}))(?:\?[^#\s\u0000-\u001f\u007f]*)?(?:#[^\s\u0000-\u001f\u007f]*)?$/i;

const tabList = document.querySelector("#tabs");
const profilesTab = document.querySelector("#tab-profiles");
const inviteTab = document.querySelector("#tab-invite");
const profilesPanel = document.querySelector("#panel-profiles");
const invitePanel = document.querySelector("#panel-invite");
const newProfileButton = document.querySelector("#new-profile");
const searchBox = document.querySelector("#search");
const searchInput = document.querySelector("#account-search");
const accountList = document.querySelector("#account-list");
const accountCount = document.querySelector("#account-count");
const noResults = document.querySelector("#no-results");
const emptyState = document.querySelector("#empty-state");
const emptyTitle = emptyState.querySelector("p");
const emptyHint = emptyState.querySelector("small");
const emptyCreateButton = document.querySelector("#empty-create");
const archivedSection = document.querySelector("#archived-section");
const archivedList = document.querySelector("#archived-list");
const archivedCount = document.querySelector("#archived-count");
const inviteForm = document.querySelector("#invite-form");
const inviteInput = document.querySelector("#invite-input");
const inviteFeedback = document.querySelector("#invite-feedback");
const inviteAvatars = document.querySelector("#invite-avatars");
const inviteTargets = document.querySelector("#invite-targets");
const inviteSubmitButton = document.querySelector("#invite-submit");
const notice = document.querySelector("#notice");
const noticeActionButton = document.querySelector("#notice-action");
const noticeCloseButton = document.querySelector("#notice-close");
const helperDot = document.querySelector("#helper-dot");
const helperStatus = document.querySelector("#helper-status");
const checkHelperButton = document.querySelector("#check-helper");
const sheet = document.querySelector("#sheet");
const sheetForm = document.querySelector("#sheet-form");
const sheetTitle = document.querySelector("#sheet-title");
const sheetMessage = document.querySelector("#sheet-message");
const sheetField = document.querySelector("#sheet-field");
const sheetLabel = document.querySelector("#sheet-label");
const sheetInput = document.querySelector("#sheet-input");
const sheetHint = document.querySelector("#sheet-hint");
const sheetCancelButton = document.querySelector("#sheet-cancel");
const sheetConfirmButton = document.querySelector("#sheet-confirm");

let accounts = [];
let hasLoadedAccounts = false;
let animateNextRender = true;
let expandedAccountId = null;
let avatarPickerGeneration = 0;
let inviteBatchInFlight = false;
let noticeTimer = null;
let noticeAction = null;
let sheetRequest = null;

class HostTransportError extends Error {}
class BackgroundTransportError extends Error {}
class AvatarInputError extends Error {}

function cleanLabel(value) {
  return value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeDiscordToken(value) {
  return DISCORD_TOKEN_LABEL_PATTERN.test(value.normalize("NFC").trim());
}

function parseDiscordInviteCode(rawValue) {
  if (typeof rawValue !== "string" ||
      rawValue.length === 0 ||
      rawValue.length > MAX_INVITE_INPUT_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(rawValue)) {
    throw new Error("Enter a valid Discord invite code or link.");
  }

  const value = rawValue.trim();
  if (INVITE_CODE_PATTERN.test(value)) {
    return value;
  }

  const match = INVITE_LINK_PATTERN.exec(value);
  const code = match?.[1] ?? match?.[2] ?? null;
  if (!code || !INVITE_CODE_PATTERN.test(code)) {
    throw new Error("Enter a valid Discord invite code or link.");
  }
  return code;
}

function normalizeTag(value) {
  if (typeof value !== "string" || TAG_UNSUPPORTED_PATTERN.test(value)) {
    return null;
  }
  const normalized = value
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0 ||
      normalized.length > MAX_TAG_LENGTH ||
      !TAG_ALLOWED_PATTERN.test(normalized) ||
      looksLikeDiscordToken(normalized)) {
    return null;
  }
  return normalized;
}

function parseTagPrompt(rawValue) {
  if (rawValue.length > MAX_TAG_PROMPT_LENGTH || TAG_UNSUPPORTED_PATTERN.test(rawValue)) {
    throw new Error("Tags contain unsupported text.");
  }
  if (rawValue.trim().length === 0) {
    return [];
  }
  if (looksLikeDiscordToken(rawValue)) {
    throw new Error("Do not use tokens, passwords, emails, or recovery codes as tags.");
  }

  const parts = rawValue.split(",");
  if (parts.length > MAX_TAGS) {
    throw new Error(`Use at most ${MAX_TAGS} tags.`);
  }

  const tags = parts.map(normalizeTag);
  if (tags.some((tag) => tag === null)) {
    throw new Error(
      `Each tag must be 1-${MAX_TAG_LENGTH} characters using letters, numbers, spaces, hyphens, or underscores.`
    );
  }

  const normalizedTags = tags;
  const uniqueTags = new Set(normalizedTags.map((tag) => tag.toLowerCase()));
  if (uniqueTags.size !== normalizedTags.length) {
    throw new Error("Use two different tags.");
  }
  return normalizedTags;
}

function isValidTags(value) {
  if (value === undefined || value === null) {
    return true;
  }
  if (!Array.isArray(value) || value.length > MAX_TAGS) {
    return false;
  }

  const seen = new Set();
  for (const tag of value) {
    const normalized = normalizeTag(tag);
    const key = typeof tag === "string" ? tag.toLowerCase() : "";
    if (normalized !== tag || seen.has(key)) {
      return false;
    }
    seen.add(key);
  }
  return true;
}

function getTags(account) {
  return Array.isArray(account.tags) ? account.tags : [];
}

function safeDisplayLabel(account) {
  if (looksLikeDiscordToken(account.label)) {
    return `Sensitive label hidden - ${account.id.slice(-4)}`;
  }
  return account.label;
}

function validateProfileLabel(rawLabel, allowEmpty) {
  if (looksLikeDiscordToken(rawLabel)) {
    return {
      error: "Do not paste a Discord token. Enter a short name, then sign in on discord.com with password, QR, or MFA.",
      clear: true
    };
  }
  const label = cleanLabel(rawLabel);
  if (label.length === 0 && !allowEmpty) {
    return { error: "Enter a profile name." };
  }
  if (label.length > MAX_LABEL_LENGTH) {
    return { error: `Profile names can contain at most ${MAX_LABEL_LENGTH} characters.` };
  }
  return { value: label };
}

function isValidAvatarData(value) {
  return value === undefined || value === null || Boolean(
    typeof value === "string" &&
    value.length <= MAX_AVATAR_DATA_LENGTH &&
    AVATAR_DATA_PATTERN.test(value)
  );
}

function avatarDataByteLength(value) {
  const payload = value.slice("data:image/webp;base64,".length);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return (payload.length * 3) / 4 - padding;
}

function canonicalizeWebPDataUrl(value) {
  const prefix = "data:image/webp;base64,";
  if (!value.startsWith(prefix)) {
    return null;
  }

  let bytes;
  try {
    const binary = atob(value.slice(prefix.length));
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }

  const fourCc = (offset) => String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3]
  );
  if (bytes.length < 30 || fourCc(0) !== "RIFF" || fourCc(8) !== "WEBP") {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) {
    return null;
  }

  let offset = 12;
  let vp8Chunk = null;
  while (offset + 8 <= bytes.length) {
    const chunkType = fourCc(offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const paddedEnd = offset + 8 + chunkSize + (chunkSize % 2);
    if (paddedEnd > bytes.length) {
      return null;
    }
    if (["ALPH", "ANIM", "ANMF", "VP8L"].includes(chunkType)) {
      return null;
    }
    if (chunkType === "VP8 ") {
      if (vp8Chunk !== null) {
        return null;
      }
      vp8Chunk = bytes.slice(offset, paddedEnd);
    }
    offset = paddedEnd;
  }

  if (offset !== bytes.length || vp8Chunk === null) {
    return null;
  }

  const canonical = new Uint8Array(12 + vp8Chunk.length);
  canonical.set([82, 73, 70, 70], 0);
  new DataView(canonical.buffer).setUint32(4, canonical.length - 8, true);
  canonical.set([87, 69, 66, 80], 8);
  canonical.set(vp8Chunk, 12);

  let canonicalBinary = "";
  for (const byte of canonical) {
    canonicalBinary += String.fromCharCode(byte);
  }
  return prefix + btoa(canonicalBinary);
}

// Success and info notices fade on their own; errors stay until dismissed or replaced.
function showNotice(message = "", kind = "", action = null) {
  clearTimeout(noticeTimer);
  noticeTimer = null;
  notice.textContent = message;
  if (kind) {
    notice.dataset.kind = kind;
  } else {
    delete notice.dataset.kind;
  }

  noticeAction = message ? action : null;
  noticeActionButton.hidden = noticeAction === null;
  noticeActionButton.textContent = noticeAction?.label ?? "";

  if (message && kind !== "error") {
    noticeTimer = setTimeout(() => {
      showNotice();
    }, noticeAction ? UNDO_NOTICE_TIMEOUT_MS : NOTICE_TIMEOUT_MS);
  }
}

function setBusy(button, busy) {
  button.disabled = busy;
  if (busy) {
    button.setAttribute("aria-busy", "true");
  } else {
    button.removeAttribute("aria-busy");
  }
}

function setFieldFeedback(element, input, message = "", state = "") {
  element.textContent = message;
  if (state) {
    element.dataset.state = state;
  } else {
    delete element.dataset.state;
  }
  if (state === "error") {
    input.setAttribute("aria-invalid", "true");
  } else {
    input.removeAttribute("aria-invalid");
  }
}

// One reusable bottom sheet replaces window.prompt/confirm. It resolves with the
// validated field value, true for a plain confirmation, or null when dismissed.
// A "danger" sheet starts with Cancel focused so Enter never destroys anything.
function openSheet({ kind, title, message, confirmLabel, field = null, tone = "" }) {
  finishSheet(null);
  sheet.dataset.kind = kind;
  if (tone) {
    sheet.dataset.tone = tone;
  } else {
    delete sheet.dataset.tone;
  }
  sheetTitle.textContent = title;
  sheetMessage.textContent = message;
  sheetConfirmButton.textContent = confirmLabel;
  sheetField.hidden = field === null;
  sheetLabel.textContent = field?.label ?? "";
  sheetInput.value = field?.value ?? "";
  sheetInput.placeholder = field?.placeholder ?? "";
  sheetInput.maxLength = field?.maxLength ?? MAX_TAG_PROMPT_LENGTH;
  const hint = field?.hint ?? "";
  setFieldFeedback(sheetHint, sheetInput, hint);

  return new Promise((resolve) => {
    sheetRequest = {
      resolve,
      hint,
      validate: field?.validate ?? null,
      returnFocus: document.activeElement ?? null
    };
    sheet.showModal();
    if (field) {
      sheetInput.focus();
      sheetInput.select();
    } else if (tone === "danger") {
      sheetCancelButton.focus();
    } else {
      sheetConfirmButton.focus();
    }
  });
}

function finishSheet(result) {
  const request = sheetRequest;
  if (request === null) {
    return;
  }
  sheetRequest = null;
  if (sheet.open) {
    sheet.close();
  }
  if (request.returnFocus?.isConnected) {
    request.returnFocus.focus();
  }
  request.resolve(result);
}

function sendToHost(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new HostTransportError(chrome.runtime.lastError.message));
        return;
      }

      if (!response || typeof response.ok !== "boolean") {
        reject(new HostTransportError("Helper returned an invalid response."));
        return;
      }

      resolve(response);
    });
  });
}

function startInviteBatch(profileIds, inviteCode) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      action: "startInviteBatch",
      profileIds,
      inviteCode
    }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new BackgroundTransportError(chrome.runtime.lastError.message));
        return;
      }
      if (!response || typeof response.ok !== "boolean") {
        reject(new BackgroundTransportError("Background worker returned an invalid response."));
        return;
      }
      resolve(response);
    });
  });
}

function setHelperState(state, message) {
  helperDot.dataset.state = state;
  helperStatus.textContent = message;
  helperStatus.title = message;
}

// Before the first successful load the list itself explains the problem;
// afterwards the list stays visible and the problem is shown as a toast.
function showHelperProblem(title, message) {
  if (hasLoadedAccounts) {
    showNotice(message, "error");
    return;
  }
  accountList.removeAttribute("aria-busy");
  accountList.replaceChildren();
  noResults.hidden = true;
  emptyState.dataset.variant = "offline";
  emptyTitle.textContent = title;
  emptyHint.textContent = message;
  emptyCreateButton.textContent = "Check again";
  emptyState.hidden = false;
}

function showTransportError(error) {
  console.error("Native helper transport error:", error);
  setHelperState("offline", "Helper not connected");
  showHelperProblem(
    "Helper not connected",
    "Run scripts\\install-native-host.cmd, then reload Chrome."
  );
}

function hasSupportedHostVersion(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    return false;
  }
  const parts = version.split(".").map(Number);
  for (let index = 0; index < MIN_HOST_VERSION.length; index += 1) {
    if (parts[index] > MIN_HOST_VERSION[index]) return true;
    if (parts[index] < MIN_HOST_VERSION[index]) return false;
  }
  return true;
}

function isValidAccount(item) {
  return Boolean(
    item &&
    typeof item.id === "string" &&
    UUID_PATTERN.test(item.id) &&
    typeof item.label === "string" &&
    item.label.length > 0 &&
    item.label.length <= MAX_LABEL_LENGTH &&
    typeof item.createdAt === "string" &&
    typeof item.archived === "boolean" &&
    isValidAvatarData(item.avatarData) &&
    isValidTags(item.tags)
  );
}

function acceptAccountList(candidate) {
  if (!Array.isArray(candidate)) {
    throw new Error("Helper returned an invalid account list.");
  }

  const ids = new Set();
  const labels = new Set();
  const accepted = [];
  for (const item of candidate) {
    const normalizedLabel = typeof item?.label === "string"
      ? item.label.toLowerCase()
      : "";
    if (!isValidAccount(item) || ids.has(item.id) || labels.has(normalizedLabel)) {
      throw new Error("Helper returned invalid or duplicate account data.");
    }
    ids.add(item.id);
    labels.add(normalizedLabel);
    accepted.push(item);
  }

  return accepted;
}

async function loadAccounts() {
  try {
    const response = await sendToHost({ action: "list" });
    if (!hasSupportedHostVersion(response.version)) {
      setHelperState("warning", "Helper is outdated");
      showHelperProblem(
        "Helper update required",
        "Run scripts\\install-native-host.cmd again to update the helper."
      );
      return;
    }
    if (!response.ok) {
      setHelperState("warning", "Helper connected, data error");
      showHelperProblem(
        "Could not load profiles",
        response.message || "Could not read the account list."
      );
      return;
    }

    accounts = acceptAccountList(response.accounts);
    hasLoadedAccounts = true;
    renderAccounts();
    if (accounts.some((account) => looksLikeDiscordToken(account.label))) {
      showNotice(
        "A saved name looked like a Discord token, so it was hidden. Treat that token as exposed and secure the Discord account.",
        "error"
      );
    }
  } catch (error) {
    if (error instanceof HostTransportError) {
      showTransportError(error);
    } else {
      setHelperState("warning", "Helper connected, data error");
      showHelperProblem("Could not load profiles", error.message);
    }
  }
}

function avatarTone(accountId) {
  let hash = 0;
  for (const character of accountId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash % AVATAR_TONE_COUNT;
}

function avatarInitial(account) {
  if (looksLikeDiscordToken(account.label)) {
    return "!";
  }
  return Array.from(safeDisplayLabel(account))[0] ?? "D";
}

function fillAvatar(target, account) {
  target.dataset.tone = String(avatarTone(account.id));
  if (!account.avatarData) {
    target.textContent = avatarInitial(account);
    return;
  }
  const avatarImage = document.createElement("img");
  avatarImage.className = "profile-avatar-image";
  avatarImage.alt = "";
  avatarImage.src = account.avatarData;
  avatarImage.addEventListener("error", () => {
    target.replaceChildren();
    target.textContent = avatarInitial(account);
  }, { once: true });
  target.append(avatarImage);
}

function describeCreatedAt(createdAt) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return "Saved";
  }
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return `Added ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric"
  })}`;
}

function createActionButton(className, text, ariaLabel, onClick) {
  const button = document.createElement("button");
  button.className = `${className} action-button`;
  button.type = "button";
  button.textContent = text;
  button.setAttribute("aria-label", ariaLabel);
  button.addEventListener("click", onClick);
  return button;
}

function createAccountCard(account, isArchived) {
  const displayLabel = safeDisplayLabel(account);
  const hasSensitiveLabel = looksLikeDiscordToken(account.label);
  const isExpanded = account.id === expandedAccountId;
  const card = document.createElement("li");
  card.className = isArchived ? "account-card is-archived" : "account-card";
  card.dataset.accountId = account.id;
  card.dataset.expanded = String(isExpanded);

  const avatar = document.createElement("button");
  avatar.className = "account-avatar avatar-button";
  avatar.type = "button";
  avatar.title = "Choose a local profile picture";
  avatar.setAttribute("aria-label", `Choose a picture for ${displayLabel}`);
  fillAvatar(avatar, account);
  avatar.addEventListener("click", () => {
    chooseAvatar(account, avatar);
  });

  const accountInfo = document.createElement("div");
  accountInfo.className = "account-info";

  const label = document.createElement("span");
  label.className = "account-label";
  label.title = displayLabel;
  label.textContent = displayLabel;

  const titleRow = document.createElement("div");
  titleRow.className = "account-title-row";
  titleRow.append(label);

  const metaRow = document.createElement("div");
  metaRow.className = "account-meta-row";
  const profileTags = getTags(account);
  if (profileTags.length > 0) {
    const tagsRow = document.createElement("div");
    tagsRow.className = "account-tags";
    for (const tag of profileTags) {
      const chip = document.createElement("span");
      chip.className = "profile-tag";
      chip.textContent = tag;
      tagsRow.append(chip);
    }
    metaRow.append(tagsRow);
  }

  const accountState = document.createElement("span");
  accountState.className = "account-state";
  if (hasSensitiveLabel) {
    accountState.dataset.state = "warning";
    accountState.textContent = "Unsafe name hidden";
  } else {
    accountState.textContent = isArchived ? "Archived" : describeCreatedAt(account.createdAt);
  }
  metaRow.append(accountState);
  accountInfo.append(titleRow, metaRow);

  let primaryButton;
  if (isArchived) {
    primaryButton = document.createElement("button");
    primaryButton.className = "restore-button button soft small with-icon";
    primaryButton.type = "button";
    primaryButton.textContent = "Restore";
    primaryButton.setAttribute("aria-label", `Restore ${displayLabel} to the list`);
    primaryButton.addEventListener("click", async () => {
      await changeArchiveState(account, false, primaryButton);
    });
  } else {
    primaryButton = document.createElement("button");
    primaryButton.className = "open-button button soft small with-icon trailing";
    primaryButton.type = "button";
    primaryButton.textContent = "Open";
    primaryButton.setAttribute("aria-label", `Open ${displayLabel}`);
    primaryButton.addEventListener("click", async () => {
      await launchAccount(account, primaryButton);
    });
  }

  const actionsId = `actions-${account.id}`;
  const moreButton = document.createElement("button");
  moreButton.className = "more-button icon-button";
  moreButton.type = "button";
  moreButton.title = "More actions";
  moreButton.setAttribute("aria-label", `More actions for ${displayLabel}`);
  moreButton.setAttribute("aria-expanded", String(isExpanded));
  moreButton.setAttribute("aria-controls", actionsId);
  moreButton.addEventListener("click", () => {
    expandedAccountId = expandedAccountId === account.id ? null : account.id;
    syncExpandedCards();
  });

  const actions = document.createElement("div");
  actions.className = "account-actions";
  actions.id = actionsId;

  const renameButton = createActionButton("rename-button", "Rename", `Rename ${displayLabel}`, async () => {
    await renameAccount(account, renameButton);
  });
  const tagsButton = createActionButton("tags-button", "Tags", `Edit tags for ${displayLabel}`, async () => {
    await editTags(account, tagsButton);
  });
  const pictureButton = createActionButton("picture-button", "Picture", `Choose a picture for ${displayLabel}`, () => {
    chooseAvatar(account, avatar);
  });
  actions.append(renameButton, tagsButton, pictureButton);

  // Deleting is permanent, so it is only offered once a profile is archived.
  if (isArchived) {
    const deleteButton = createActionButton("delete-button", "Delete", `Delete ${displayLabel} permanently`, async () => {
      await deleteAccount(account, deleteButton);
    });
    actions.append(deleteButton);
  } else {
    const archiveButton = createActionButton("remove-button", "Archive", `Move ${displayLabel} to Archived`, async () => {
      await changeArchiveState(account, true, archiveButton);
    });
    actions.append(archiveButton);
  }

  const actionsWrap = document.createElement("div");
  actionsWrap.className = "account-actions-wrap";
  actionsWrap.append(actions);

  card.append(avatar, accountInfo, primaryButton, moreButton, actionsWrap);
  return card;
}

function syncExpandedCards() {
  for (const card of [...accountList.children, ...archivedList.children]) {
    const isExpanded = card.dataset.accountId === expandedAccountId;
    card.dataset.expanded = String(isExpanded);
    card.querySelector(".more-button")?.setAttribute("aria-expanded", String(isExpanded));
  }
}

function focusAccount(accountId, buttonSelector) {
  const allCards = [...accountList.children, ...archivedList.children];
  const targetCard = allCards.find((card) => card.dataset.accountId === accountId);
  targetCard?.querySelector(buttonSelector)?.focus();
}

function createMiniAvatar(account) {
  const avatar = document.createElement("span");
  avatar.className = "mini-avatar";
  fillAvatar(avatar, account);
  return avatar;
}

function updateInviteControls() {
  const active = accounts.filter((account) => !account.archived);
  const count = active.length;
  inviteSubmitButton.disabled = inviteBatchInFlight || count === 0;
  inviteInput.disabled = inviteBatchInFlight;
  if (!inviteBatchInFlight) {
    inviteSubmitButton.textContent = count > 0
      ? `Open all active (${count})`
      : "Open all active";
  }

  const preview = active.slice(0, INVITE_PREVIEW_AVATARS).map(createMiniAvatar);
  if (count > INVITE_PREVIEW_AVATARS) {
    const more = document.createElement("span");
    more.className = "mini-avatar is-more";
    more.textContent = `+${count - INVITE_PREVIEW_AVATARS}`;
    preview.push(more);
  }
  inviteAvatars.replaceChildren(...preview);

  if (count === 0) {
    inviteTargets.textContent = "No active profiles yet. Create one on the Profiles tab first.";
  } else if (count > MAX_INVITE_PROFILES) {
    inviteTargets.textContent = `${count} active profiles. One batch can open at most ${MAX_INVITE_PROFILES}.`;
  } else {
    inviteTargets.textContent = `Opens in ${count} active ${count === 1 ? "profile" : "profiles"}.`;
  }
}

function matchesSearch(account, query) {
  if (!query) {
    return true;
  }
  return [safeDisplayLabel(account), ...getTags(account)]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function renderAccounts(focusTarget = null) {
  const active = accounts.filter((account) => !account.archived);
  const archived = accounts.filter((account) => account.archived);

  const searchable = accounts.length >= SEARCH_THRESHOLD;
  if (!searchable) {
    searchInput.value = "";
  }
  searchBox.hidden = !searchable;
  const query = searchInput.value.trim().toLowerCase();
  const visibleActive = active.filter((account) => matchesSearch(account, query));
  const visibleArchived = archived.filter((account) => matchesSearch(account, query));

  accountList.removeAttribute("aria-busy");
  if (animateNextRender) {
    accountList.dataset.animate = "true";
    animateNextRender = false;
  } else {
    delete accountList.dataset.animate;
  }
  accountList.replaceChildren(...visibleActive.map((account) => createAccountCard(account, false)));
  archivedList.replaceChildren(...visibleArchived.map((account) => createAccountCard(account, true)));

  accountCount.textContent = String(active.length);
  archivedCount.textContent = String(archived.length);
  emptyState.hidden = active.length > 0;
  noResults.hidden = active.length === 0 || visibleActive.length > 0;
  archivedSection.hidden = archived.length === 0;
  updateInviteControls();

  if (active.length === 0 && archived.length > 0) {
    emptyState.dataset.variant = "archived";
    emptyTitle.textContent = "There are no active profiles.";
    emptyHint.textContent = "You can restore a profile from Archived.";
    emptyCreateButton.textContent = "New profile";
    archivedSection.open = true;
  } else {
    emptyState.dataset.variant = "first-run";
    emptyTitle.textContent = "No saved accounts yet.";
    emptyHint.textContent = "Create a Chrome profile, then sign in inside the separate Discord window.";
    emptyCreateButton.textContent = "Create your first profile";
  }

  if (focusTarget) {
    focusAccount(focusTarget.id, focusTarget.selector);
  }
}

function replaceAccount(updated) {
  if (!isValidAccount(updated)) {
    throw new Error("Helper returned invalid account data.");
  }
  const index = accounts.findIndex((account) => account.id === updated.id);
  if (index < 0) {
    throw new Error("Profile not found in the interface.");
  }
  accounts[index] = updated;
}

function chooseAvatar(account, button) {
  const generation = ++avatarPickerGeneration;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp";
  input.hidden = true;

  const cleanup = () => {
    input.value = "";
    input.remove();
  };

  input.addEventListener("cancel", cleanup, { once: true });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) {
      cleanup();
      return;
    }

    setBusy(button, true);
    showNotice(`Preparing a picture for ${safeDisplayLabel(account)}...`);
    try {
      const avatarData = await encodeAvatar(file);
      if (generation !== avatarPickerGeneration ||
          !accounts.some((item) => item.id === account.id)) {
        return;
      }

      const response = await sendToHost({
        action: "setAvatar",
        profileId: account.id,
        avatarData
      });
      setHelperState("online", "Helper ready");
      if (!response.ok) {
        showNotice(response.message || "Could not save the profile picture.", "error");
        return;
      }
      if (!isValidAccount(response.account) || response.account.id !== account.id) {
        throw new Error("Invalid helper response.");
      }

      replaceAccount(response.account);
      renderAccounts({ id: account.id, selector: ".avatar-button" });
      showNotice(`Picture saved for ${safeDisplayLabel(response.account)}.`, "success");
    } catch (error) {
      if (error instanceof HostTransportError) {
        showTransportError(error);
      } else if (error instanceof AvatarInputError) {
        showNotice(error.message, "error");
      } else {
        showNotice("Could not process that picture. Choose another PNG, JPEG, or WebP image.", "error");
      }
    } finally {
      setBusy(button, false);
      cleanup();
    }
  }, { once: true });

  document.body.append(input);
  input.click();
}

async function encodeAvatar(file) {
  const acceptedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!acceptedTypes.has(file.type) || file.size <= 0 || file.size > MAX_AVATAR_SOURCE_BYTES) {
    throw new AvatarInputError("Choose a PNG, JPEG, or WebP image up to 5 MB.");
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new AvatarInputError("That image could not be decoded. Choose another PNG, JPEG, or WebP image.");
  }

  try {
    if (bitmap.width <= 0 || bitmap.height <= 0 ||
        bitmap.width > MAX_AVATAR_SOURCE_DIMENSION ||
        bitmap.height > MAX_AVATAR_SOURCE_DIMENSION) {
      throw new AvatarInputError("The image dimensions are too large. Use an image up to 4096 by 4096 pixels.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_DIMENSION;
    canvas.height = AVATAR_DIMENSION;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new AvatarInputError("The image could not be resized in this browser.");
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.fillStyle = "#171a2b";
    context.fillRect(0, 0, AVATAR_DIMENSION, AVATAR_DIMENSION);
    const cropSize = Math.min(bitmap.width, bitmap.height);
    const sourceX = (bitmap.width - cropSize) / 2;
    const sourceY = (bitmap.height - cropSize) / 2;
    context.drawImage(
      bitmap,
      sourceX,
      sourceY,
      cropSize,
      cropSize,
      0,
      0,
      AVATAR_DIMENSION,
      AVATAR_DIMENSION
    );

    for (const quality of [0.78, 0.66, 0.54, 0.42]) {
      const avatarData = canonicalizeWebPDataUrl(canvas.toDataURL("image/webp", quality));
      if (avatarData &&
          avatarData.length <= MAX_AVATAR_DATA_LENGTH &&
          AVATAR_DATA_PATTERN.test(avatarData) &&
          avatarDataByteLength(avatarData) <= MAX_AVATAR_BYTES) {
        return avatarData;
      }
    }
  } finally {
    bitmap.close();
  }

  throw new AvatarInputError("That picture could not be compressed enough. Choose a simpler image.");
}

async function createProfile(button) {
  const label = await openSheet({
    kind: "create",
    title: "New Discord profile",
    message: "Creates an isolated Chrome profile and opens Discord's login page in a separate window. Sign in there with password, QR, or MFA.",
    confirmLabel: "Create & open login",
    field: {
      label: "Profile name (optional)",
      placeholder: "Gaming, Work, Alt...",
      maxLength: MAX_LABEL_LENGTH,
      hint: "Leave blank to use Account 1, Account 2, and so on. Never paste a Discord token.",
      validate: (rawLabel) => validateProfileLabel(rawLabel, true)
    }
  });
  if (label === null) {
    return;
  }

  showNotice();
  const createRequest = label
    ? { action: "create", label }
    : { action: "create" };

  setBusy(button, true);
  try {
    const response = await sendToHost(createRequest);
    setHelperState("online", "Helper ready");
    if (!response.ok) {
      showNotice(response.message || "Could not create the profile.", "error");
      return;
    }
    if (!isValidAccount(response.account)) {
      throw new Error("Helper returned invalid account data.");
    }

    accounts.push(response.account);
    searchInput.value = "";
    renderAccounts({ id: response.account.id, selector: ".open-button" });

    const card = [...accountList.children].find(
      (item) => item.dataset.accountId === response.account.id
    );
    if (card) {
      card.dataset.fresh = "true";
    }
    const openButton = card?.querySelector(".open-button");
    if (openButton) {
      await launchAccount(response.account, openButton, true);
    }
  } catch (error) {
    if (error instanceof HostTransportError) {
      showTransportError(error);
    } else {
      showNotice(error.message, "error");
    }
  } finally {
    setBusy(button, false);
  }
}

async function renameAccount(account, button) {
  const oldDisplayLabel = safeDisplayLabel(account);
  const initialValue = looksLikeDiscordToken(account.label) ? "" : account.label;
  const label = await openSheet({
    kind: "rename",
    title: "Rename profile",
    message: `Choose a new local name for "${oldDisplayLabel}". The Discord account and its saved session stay the same.`,
    confirmLabel: "Save name",
    field: {
      label: "Profile name",
      value: initialValue,
      placeholder: "Gaming",
      maxLength: MAX_LABEL_LENGTH,
      hint: "Use a short local name. Never paste a Discord token.",
      validate: (rawLabel) => validateProfileLabel(rawLabel, false)
    }
  });
  if (label === null) {
    return;
  }
  if (label === account.label) {
    showNotice(`${oldDisplayLabel} already has that name.`);
    return;
  }

  setBusy(button, true);
  try {
    const response = await sendToHost({
      action: "rename",
      profileId: account.id,
      label
    });
    setHelperState("online", "Helper ready");
    if (!response.ok) {
      showNotice(response.message || "Could not rename the profile.", "error");
      return;
    }
    if (!isValidAccount(response.account) || response.account.id !== account.id) {
      throw new Error("Helper returned invalid account data.");
    }

    replaceAccount(response.account);
    const newDisplayLabel = safeDisplayLabel(response.account);
    renderAccounts({ id: account.id, selector: ".rename-button" });
    showNotice(`${oldDisplayLabel} renamed to ${newDisplayLabel}.`, "success");
  } catch (error) {
    if (error instanceof HostTransportError) {
      showTransportError(error);
    } else {
      showNotice(error.message, "error");
    }
  } finally {
    setBusy(button, false);
  }
}

async function editTags(account, button) {
  const displayLabel = safeDisplayLabel(account);
  const currentTags = getTags(account);
  const tags = await openSheet({
    kind: "tags",
    title: "Edit tags",
    message: `Add up to 2 short reminders to "${displayLabel}", separated by a comma. Leave the field blank to remove them.`,
    confirmLabel: "Save tags",
    field: {
      label: "Tags",
      value: currentTags.join(", "),
      placeholder: "Main, Backup",
      maxLength: MAX_TAG_PROMPT_LENGTH,
      hint: "Letters, numbers, spaces, hyphens, and underscores. Do not enter secrets.",
      validate: (rawValue) => {
        try {
          return { value: parseTagPrompt(rawValue) };
        } catch (error) {
          return { error: error.message, clear: looksLikeDiscordToken(rawValue) };
        }
      }
    }
  });
  if (tags === null) {
    return;
  }

  if (tags.length === currentTags.length &&
      tags.every((tag, index) => tag === currentTags[index])) {
    showNotice(`Tags for ${displayLabel} are unchanged.`);
    return;
  }

  setBusy(button, true);
  try {
    const response = await sendToHost({
      action: "setTags",
      profileId: account.id,
      tags
    });
    setHelperState("online", "Helper ready");
    if (!response.ok) {
      showNotice(response.message || "Could not save profile tags.", "error");
      return;
    }
    if (!isValidAccount(response.account) || response.account.id !== account.id) {
      throw new Error("Helper returned invalid account data.");
    }

    replaceAccount(response.account);
    renderAccounts({ id: account.id, selector: ".tags-button" });
    showNotice(
      tags.length === 0
        ? `Tags removed from ${displayLabel}.`
        : `Tags saved for ${displayLabel}.`,
      "success"
    );
  } catch (error) {
    if (error instanceof HostTransportError) {
      showTransportError(error);
    } else {
      showNotice(error.message, "error");
    }
  } finally {
    setBusy(button, false);
  }
}

async function deleteAccount(account, button) {
  const displayLabel = safeDisplayLabel(account);
  const confirmed = await openSheet({
    kind: "delete",
    tone: "danger",
    title: `Delete "${displayLabel}" permanently?`,
    message: "This removes the profile and its Chrome data from this PC, including the Discord login saved in it. It cannot be undone.",
    confirmLabel: "Delete profile"
  });
  if (confirmed !== true) {
    return;
  }

  setBusy(button, true);
  try {
    const response = await sendToHost({
      action: "delete",
      profileId: account.id
    });
    setHelperState("online", "Helper ready");
    if (!response.ok) {
      showNotice(response.message || "Could not delete the profile.", "error");
      return;
    }

    accounts = accounts.filter((item) => item.id !== account.id);
    if (expandedAccountId === account.id) {
      expandedAccountId = null;
    }
    renderAccounts();
    (archivedList.querySelector(".restore-button") || newProfileButton).focus();
    showNotice(
      response.filesRemoved === false
        ? `${displayLabel} deleted. Some files were still in use and will be removed later.`
        : `${displayLabel} deleted.`,
      "success"
    );
  } catch (error) {
    if (error instanceof HostTransportError) {
      showTransportError(error);
    } else {
      showNotice(error.message, "error");
    }
  } finally {
    setBusy(button, false);
  }
}

// Archiving is fully reversible, so it happens immediately and offers Undo
// instead of asking for confirmation first.
async function changeArchiveState(account, archive, button) {
  const displayLabel = safeDisplayLabel(account);
  setBusy(button, true);
  try {
    const response = await sendToHost({
      action: archive ? "archive" : "restore",
      profileId: account.id
    });
    setHelperState("online", "Helper ready");
    if (!response.ok) {
      showNotice(response.message || "Could not update the profile.", "error");
      return;
    }

    replaceAccount(response.account);
    if (expandedAccountId === account.id) {
      expandedAccountId = null;
    }
    if (archive) {
      renderAccounts();
      const firstActiveButton = accountList.querySelector(".open-button");
      (firstActiveButton || newProfileButton).focus();
      showNotice(`${displayLabel} moved to Archived.`, "success", {
        label: "Undo",
        run: (actionButton) => changeArchiveState(account, false, actionButton)
      });
    } else {
      renderAccounts({ id: account.id, selector: ".open-button" });
      showNotice(`${displayLabel} restored to the list.`, "success");
    }
  } catch (error) {
    if (error instanceof HostTransportError) {
      showTransportError(error);
    } else {
      showNotice(error.message, "error");
    }
  } finally {
    setBusy(button, false);
  }
}

async function launchAccount(account, button, isNewAccount = false) {
  const displayLabel = safeDisplayLabel(account);
  setBusy(button, true);
  const oldText = button.textContent;
  button.textContent = "Opening";
  showNotice(`Opening ${displayLabel}...`);

  try {
    const response = await sendToHost({
      action: "launch",
      profileId: account.id
    });
    setHelperState("online", "Helper ready");

    if (!response.ok) {
      const reason = response.message || "Chrome could not open the profile.";
      showNotice(
        isNewAccount
          ? `${displayLabel} was saved, but it could not be opened. ${reason}`
          : reason,
        "error"
      );
      return;
    }

    if (typeof response.isNewProfile !== "boolean") {
      throw new Error("Helper returned invalid profile status.");
    }

    showNotice(
      response.isNewProfile
        ? "New Chrome profile opened. Sign in to Discord in the separate window."
        : "Saved Chrome profile reopened. If Discord asks you to sign in, its session expired, was revoked, or login was not completed.",
      "success"
    );
  } catch (error) {
    if (error instanceof HostTransportError) {
      showTransportError(error);
    } else {
      showNotice(error.message, "error");
    }
  } finally {
    setBusy(button, false);
    button.textContent = oldText;
  }
}

async function checkHelper() {
  checkHelperButton.disabled = true;
  helperStatus.setAttribute("aria-busy", "true");
  helperStatus.textContent = "Checking helper...";
  delete helperDot.dataset.state;

  try {
    const response = await sendToHost({ action: "ping" });
    if (!hasSupportedHostVersion(response.version)) {
      setHelperState("warning", "Helper is outdated - update required");
      showHelperProblem(
        "Helper update required",
        "Run scripts\\install-native-host.cmd again to update the helper."
      );
      return false;
    }
    if (response.ok) {
      setHelperState("online", "Helper ready");
    } else {
      setHelperState("warning", response.message || "Helper connected, Chrome unavailable");
    }
    return true;
  } catch (error) {
    showTransportError(error);
    return false;
  } finally {
    helperStatus.removeAttribute("aria-busy");
    checkHelperButton.disabled = false;
  }
}

async function refreshFromHelper() {
  const connected = await checkHelper();
  if (connected) {
    await loadAccounts();
  }
}

function selectTab(name, moveFocus = false) {
  const showInvite = name === "invite";
  profilesTab.setAttribute("aria-selected", String(!showInvite));
  inviteTab.setAttribute("aria-selected", String(showInvite));
  profilesTab.tabIndex = showInvite ? -1 : 0;
  inviteTab.tabIndex = showInvite ? 0 : -1;
  profilesPanel.hidden = showInvite;
  invitePanel.hidden = !showInvite;
  tabList.dataset.active = name;
  if (moveFocus) {
    (showInvite ? inviteTab : profilesTab).focus();
  }
}

profilesTab.addEventListener("click", () => {
  selectTab("profiles");
});

inviteTab.addEventListener("click", () => {
  selectTab("invite");
});

tabList.addEventListener("keydown", (event) => {
  const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
  if (!keys.includes(event.key)) {
    return;
  }
  event.preventDefault();
  let next = tabList.dataset.active === "invite" ? "profiles" : "invite";
  if (event.key === "Home") next = "profiles";
  if (event.key === "End") next = "invite";
  selectTab(next, true);
});

newProfileButton.addEventListener("click", async () => {
  await createProfile(newProfileButton);
});

emptyCreateButton.addEventListener("click", async () => {
  if (emptyState.dataset.variant === "offline") {
    await refreshFromHelper();
  } else {
    await createProfile(emptyCreateButton);
  }
});

searchInput.addEventListener("input", () => {
  renderAccounts();
});

sheetForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const request = sheetRequest;
  if (request === null) {
    return;
  }
  if (request.validate === null) {
    finishSheet(true);
    return;
  }

  const result = request.validate(sheetInput.value);
  if ("error" in result) {
    if (result.clear) {
      sheetInput.value = "";
    }
    setFieldFeedback(sheetHint, sheetInput, result.error, "error");
    sheetInput.focus();
    return;
  }
  finishSheet(result.value);
});

sheetInput.addEventListener("input", () => {
  if (sheetRequest !== null && sheetHint.dataset.state === "error") {
    setFieldFeedback(sheetHint, sheetInput, sheetRequest.hint);
  }
});

sheetCancelButton.addEventListener("click", () => {
  finishSheet(null);
});

// Escape and programmatic closes both land here.
sheet.addEventListener("close", () => {
  finishSheet(null);
});

sheet.addEventListener("click", (event) => {
  if (event.target === sheet) {
    finishSheet(null);
  }
});

noticeActionButton.addEventListener("click", async () => {
  const action = noticeAction;
  if (action === null) {
    return;
  }
  showNotice();
  await action.run(noticeActionButton);
});

noticeCloseButton.addEventListener("click", () => {
  showNotice();
});

inviteInput.addEventListener("input", () => {
  if (inviteInput.value.trim().length === 0) {
    setFieldFeedback(inviteFeedback, inviteInput);
    return;
  }
  try {
    const code = parseDiscordInviteCode(inviteInput.value);
    setFieldFeedback(inviteFeedback, inviteInput, `Invite code ${code} is ready.`, "valid");
  } catch {
    if (inviteFeedback.dataset.state !== "error") {
      setFieldFeedback(inviteFeedback, inviteInput);
    }
  }
});

inviteInput.addEventListener("blur", () => {
  if (inviteInput.value.trim().length === 0) {
    return;
  }
  try {
    parseDiscordInviteCode(inviteInput.value);
  } catch (error) {
    setFieldFeedback(inviteFeedback, inviteInput, error.message, "error");
  }
});

inviteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (inviteBatchInFlight) {
    return;
  }

  showNotice();
  let inviteCode;
  try {
    inviteCode = parseDiscordInviteCode(inviteInput.value);
  } catch (error) {
    setFieldFeedback(inviteFeedback, inviteInput, error.message, "error");
    inviteInput.focus();
    return;
  }

  const targets = accounts.filter((account) => !account.archived);
  if (targets.length === 0) {
    showNotice("Create or restore at least one active profile first.", "error");
    return;
  }
  if (targets.length > MAX_INVITE_PROFILES) {
    showNotice(
      `This safety batch can open at most ${MAX_INVITE_PROFILES} saved profiles at once.`,
      "error"
    );
    return;
  }

  const profileWord = targets.length === 1 ? "profile" : "profiles";
  const confirmed = await openSheet({
    kind: "invite",
    title: `Open this invite in all ${targets.length} active ${profileWord}?`,
    message: "Each profile opens the invite page in its own window. " +
      "You will still confirm Join Server manually in each window.",
    confirmLabel: targets.length === 1 ? "Open 1 window" : `Open ${targets.length} windows`
  });
  if (confirmed !== true) {
    return;
  }

  inviteBatchInFlight = true;
  inviteSubmitButton.setAttribute("aria-busy", "true");
  updateInviteControls();
  inviteSubmitButton.textContent = `Opening ${targets.length} profiles...`;
  showNotice(
    `Starting ${targets.length} profile windows. This continues if the popup closes.`
  );

  try {
    const response = await startInviteBatch(
      targets.map((account) => account.id),
      inviteCode
    );
    if (!response.ok) {
      showNotice(response.error || "The invite batch could not be started.", "error");
      return;
    }
    if (!Number.isInteger(response.total) || response.total !== targets.length) {
      throw new BackgroundTransportError("Background worker returned an invalid batch status.");
    }
    inviteInput.value = "";
    setFieldFeedback(inviteFeedback, inviteInput);
    showNotice(
      `Opening the invite in ${response.total} profile ${response.total === 1 ? "window" : "windows"} ` +
      "in the background. Confirm Join Server manually in each window.",
      "success"
    );
  } catch (error) {
    if (error instanceof BackgroundTransportError) {
      showNotice("Reload this extension on chrome://extensions, then try again.", "error");
    } else {
      showNotice(error.message, "error");
    }
  } finally {
    inviteBatchInFlight = false;
    inviteSubmitButton.removeAttribute("aria-busy");
    updateInviteControls();
  }
});

checkHelperButton.addEventListener("click", refreshFromHelper);

refreshFromHelper();
