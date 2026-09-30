"use strict";

const HOST_NAME = "com.local.discord_multi_account";
const MAX_INVITE_PROFILES = 20;
const RESPONSE_TIMEOUT_MS = 30_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{2,64}$/;
const MIN_HOST_VERSION = [1, 7, 0];

let activeBatch = null;

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return actualKeys.length === sortedExpected.length &&
    actualKeys.every((key, index) => key === sortedExpected[index]);
}

function isValidBatchRequest(message) {
  if (!hasExactKeys(message, ["action", "inviteCode", "profileIds"]) ||
      message.action !== "startInviteBatch" ||
      typeof message.inviteCode !== "string" ||
      !INVITE_CODE_PATTERN.test(message.inviteCode) ||
      !Array.isArray(message.profileIds) ||
      message.profileIds.length === 0 ||
      message.profileIds.length > MAX_INVITE_PROFILES) {
    return false;
  }

  const ids = new Set();
  for (const profileId of message.profileIds) {
    if (typeof profileId !== "string" ||
        !UUID_PATTERN.test(profileId) ||
        ids.has(profileId)) {
      return false;
    }
    ids.add(profileId);
  }
  return true;
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

function createBatchController(profileIds, inviteCode) {
  let port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch {
    return null;
  }

  let currentIndex = 0;
  let opened = 0;
  let failed = 0;
  let responseTimer = null;
  let settled = false;
  let expectedDisconnect = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function clearResponseTimer() {
    if (responseTimer !== null) {
      clearTimeout(responseTimer);
      responseTimer = null;
    }
  }

  function finish(reason) {
    if (settled) return;
    settled = true;
    clearResponseTimer();
    expectedDisconnect = true;
    try {
      port.disconnect();
    } catch {
      // The native port may already be closed.
    }
    resolveDone({ reason, opened, failed, total: profileIds.length });
  }

  function postCurrentProfile() {
    if (settled) return;
    try {
      port.postMessage({
        action: "launchInvite",
        profileId: profileIds[currentIndex],
        inviteCode
      });
      responseTimer = setTimeout(() => {
        finish("timeout");
      }, RESPONSE_TIMEOUT_MS);
    } catch {
      finish("transport");
    }
  }

  port.onMessage.addListener((response) => {
    if (settled) return;
    clearResponseTimer();

    if (!response ||
        typeof response.ok !== "boolean" ||
        !hasSupportedHostVersion(response.version) ||
        (response.ok && typeof response.isNewProfile !== "boolean")) {
      finish("protocol");
      return;
    }

    if (response.ok) {
      opened += 1;
    } else {
      failed += 1;
    }

    currentIndex += 1;
    if (currentIndex >= profileIds.length) {
      finish("complete");
      return;
    }
    postCurrentProfile();
  });

  port.onDisconnect.addListener(() => {
    // Reading lastError prevents an unchecked runtime warning.
    void chrome.runtime.lastError;
    if (!expectedDisconnect && !settled) {
      finish("transport");
    }
  });

  return {
    done,
    start: postCurrentProfile
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const expectedPopupUrl = chrome.runtime.getURL("popup.html");
  if (sender?.id !== chrome.runtime.id || sender?.url !== expectedPopupUrl) {
    sendResponse({ ok: false, error: "Rejected extension sender." });
    return false;
  }
  if (!isValidBatchRequest(message)) {
    sendResponse({ ok: false, error: "Invalid invite batch request." });
    return false;
  }
  if (activeBatch !== null) {
    sendResponse({ ok: false, error: "Another invite batch is already running." });
    return false;
  }

  const profileIds = [...message.profileIds];
  const controller = createBatchController(profileIds, message.inviteCode);
  if (controller === null) {
    sendResponse({ ok: false, error: "Native helper is not connected." });
    return false;
  }

  activeBatch = controller;
  controller.done.finally(() => {
    if (activeBatch === controller) {
      activeBatch = null;
    }
  });

  sendResponse({ ok: true, total: profileIds.length });
  controller.start();
  return false;
});
