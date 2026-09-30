import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const source = fs.readFileSync(path.join(root, "extension", "background.js"), "utf8");
const extensionId = "ofnblgcbllibhicnkjhogibgpjmnpncf";
const popupUrl = `chrome-extension://${extensionId}/popup.html`;
const activeId = "11111111-1111-4111-8111-111111111111";
const secondActiveId = "22222222-2222-4222-8222-222222222222";

let runtimeMessageListener = null;
let timerSequence = 0;
const timers = new Map();
const ports = [];
const nativeConnections = [];

function createPort() {
  const messageListeners = [];
  const disconnectListeners = [];
  const port = {
    disconnected: false,
    posts: [],
    onMessage: {
      addListener(listener) {
        messageListeners.push(listener);
      }
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.push(listener);
      }
    },
    postMessage(message) {
      if (port.disconnected) throw new Error("Port is closed.");
      port.posts.push(structuredClone(message));
    },
    disconnect() {
      if (port.disconnected) return;
      port.disconnected = true;
      for (const listener of disconnectListeners) listener();
    },
    emitMessage(message) {
      if (port.disconnected) throw new Error("Port is closed.");
      for (const listener of messageListeners) listener(structuredClone(message));
    },
    emitUnexpectedDisconnect() {
      if (port.disconnected) return;
      port.disconnected = true;
      chrome.runtime.lastError = { message: "Native host exited." };
      for (const listener of disconnectListeners) listener();
      chrome.runtime.lastError = undefined;
    }
  };
  ports.push(port);
  return port;
}

const chrome = {
  runtime: {
    id: extensionId,
    lastError: undefined,
    getURL(relativePath) {
      return `chrome-extension://${extensionId}/${relativePath}`;
    },
    onMessage: {
      addListener(listener) {
        runtimeMessageListener = listener;
      }
    },
    connectNative(hostName) {
      nativeConnections.push(hostName);
      return createPort();
    }
  }
};

const context = {
  chrome,
  clearTimeout(timerId) {
    timers.delete(timerId);
  },
  setTimeout(callback, delay) {
    const timerId = ++timerSequence;
    timers.set(timerId, { callback, delay });
    return timerId;
  }
};
vm.runInNewContext(source, context, { filename: "background.js" });
assert.equal(typeof runtimeMessageListener, "function");

const validSender = { id: extensionId, url: popupUrl };
const validRequest = {
  action: "startInviteBatch",
  inviteCode: "Ab_12-x",
  profileIds: [activeId, secondActiveId]
};

let popupChannelOpen = true;
const lifecycleResponses = [];
const listenerReturn = runtimeMessageListener(validRequest, validSender, (response) => {
  if (!popupChannelOpen) throw new Error("Popup response channel was already closed.");
  lifecycleResponses.push(structuredClone(response));
});
assert.equal(listenerReturn, false);
assert.deepEqual(lifecycleResponses, [{ ok: true, total: 2 }]);
assert.deepEqual(nativeConnections, ["com.local.discord_multi_account"]);
assert.equal(ports.length, 1);
assert.deepEqual(ports[0].posts, [
  { action: "launchInvite", profileId: activeId, inviteCode: "Ab_12-x" }
]);

popupChannelOpen = false;
ports[0].emitMessage({ ok: false, version: "1.7.0", message: "Profile could not open." });
assert.deepEqual(ports[0].posts, [
  { action: "launchInvite", profileId: activeId, inviteCode: "Ab_12-x" },
  { action: "launchInvite", profileId: secondActiveId, inviteCode: "Ab_12-x" }
]);
ports[0].emitMessage({ ok: true, version: "1.7.0", isNewProfile: false });
assert.equal(ports[0].disconnected, true);
await settle();
assert.equal(lifecycleResponses.length, 1, "worker must not use the closed popup channel again");
assert.equal(timers.size, 0);

const invalidRequests = [
  null,
  [],
  {},
  { action: "StartInviteBatch", inviteCode: "Ab_12-x", profileIds: [activeId] },
  { action: "startInviteBatch", inviteCode: "Ab_12-x" },
  { action: "startInviteBatch", inviteCode: "Ab_12-x", profileIds: [activeId], url: "https://discord.gg/Ab_12-x" },
  { action: "startInviteBatch", inviteCode: "https://discord.gg/Ab_12-x", profileIds: [activeId] },
  { action: "startInviteBatch", inviteCode: "a", profileIds: [activeId] },
  { action: "startInviteBatch", inviteCode: "A".repeat(65), profileIds: [activeId] },
  { action: "startInviteBatch", inviteCode: "Ab/12", profileIds: [activeId] },
  { action: "startInviteBatch", inviteCode: "Ab.12", profileIds: [activeId] },
  { action: "startInviteBatch", inviteCode: "éé", profileIds: [activeId] },
  { action: "startInviteBatch", inviteCode: "Ab\u0001", profileIds: [activeId] },
  { action: "startInviteBatch", inviteCode: "Ab_12-x", profileIds: [] },
  { action: "startInviteBatch", inviteCode: "Ab_12-x", profileIds: "not-an-array" },
  { action: "startInviteBatch", inviteCode: "Ab_12-x", profileIds: [activeId, activeId] },
  { action: "startInviteBatch", inviteCode: "Ab_12-x", profileIds: ["not-a-uuid"] },
  { action: "startInviteBatch", inviteCode: "Ab_12-x", profileIds: ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"] },
  {
    action: "startInviteBatch",
    inviteCode: "Ab_12-x",
    profileIds: Array.from({ length: 21 }, (_unused, index) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`)
  }
];

for (const request of invalidRequests) {
  const connectionsBefore = nativeConnections.length;
  const responses = [];
  const result = runtimeMessageListener(request, validSender, (response) => responses.push(response));
  assert.equal(result, false);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, false);
  assert.equal(nativeConnections.length, connectionsBefore);
  assert.equal(JSON.stringify(responses[0]).includes("Ab_12-x"), false);
}

const wrongSenderConnections = nativeConnections.length;
const wrongSenderResponses = [];
runtimeMessageListener(validRequest, { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", url: popupUrl },
  (response) => wrongSenderResponses.push(response));
assert.equal(wrongSenderResponses[0]?.ok, false);
assert.equal(nativeConnections.length, wrongSenderConnections);
const wrongUrlResponses = [];
runtimeMessageListener(validRequest, { id: extensionId, url: `chrome-extension://${extensionId}/other.html` },
  (response) => wrongUrlResponses.push(response));
assert.equal(wrongUrlResponses[0]?.ok, false);
assert.equal(nativeConnections.length, wrongSenderConnections);

const busyOne = send(validRequest);
assert.deepEqual(busyOne.responses, [{ ok: true, total: 2 }]);
const busyTwo = send(validRequest);
assert.equal(busyTwo.responses[0]?.ok, false);
assert.match(busyTwo.responses[0]?.error ?? "", /already running/i);
assert.equal(ports.at(-1).posts.length, 1);
ports.at(-1).emitUnexpectedDisconnect();
await settle();

const disconnectBatch = send(validRequest);
assert.equal(disconnectBatch.responses[0]?.ok, true);
const disconnectPort = ports.at(-1);
assert.equal(disconnectPort.posts.length, 1);
const connectionsBeforeDisconnect = nativeConnections.length;
disconnectPort.emitUnexpectedDisconnect();
await settle();
assert.equal(disconnectPort.posts.length, 1, "disconnect must stop without posting the next active target");
assert.equal(nativeConnections.length, connectionsBeforeDisconnect, "disconnect must not reconnect or retry");

const timeoutBatch = send(validRequest);
assert.equal(timeoutBatch.responses[0]?.ok, true);
const timeoutPort = ports.at(-1);
assert.equal(timeoutPort.posts.length, 1);
const pendingTimer = [...timers.values()][0];
assert.equal(pendingTimer.delay, 30_000);
pendingTimer.callback();
await settle();
assert.equal(timeoutPort.disconnected, true);
assert.equal(timeoutPort.posts.length, 1, "timeout must not retry");

const cleanupBatch = send({
  action: "startInviteBatch",
  inviteCode: "Ab_12-x",
  profileIds: [activeId]
});
assert.equal(cleanupBatch.responses[0]?.ok, true, "batch state must clear after failure");
const cleanupPort = ports.at(-1);
cleanupPort.emitMessage({ ok: false, version: "1.7.0", message: "Profile not found." });
await settle();
assert.equal(cleanupPort.disconnected, true);
assert.equal(timers.size, 0);

console.log("Background invite lifecycle and security checks passed.");

function send(message) {
  const responses = [];
  const returnValue = runtimeMessageListener(message, validSender, (response) => {
    responses.push(structuredClone(response));
  });
  return { responses, returnValue };
}

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setImmediate(resolve));
}
