import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const hostPath = process.env.DISCORD_HOST_PATH || path.join(
  root,
  "artifacts",
  "native-host",
  "DiscordMultiAccountHost.exe"
);
const hostSource = fs.readFileSync(path.join(root, "native-host", "Program.cs"), "utf8");
const validOrigin = "chrome-extension://ofnblgcbllibhicnkjhogibgpjmnpncf/";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const runMetadataTests = process.env.RUN_METADATA_TESTS === "1";
const testDataRoot = runMetadataTests
  ? path.join(os.tmpdir(), `DiscordMultiAccountHostTests-${crypto.randomUUID().replaceAll("-", "")}`)
  : null;
const protocolAccountsPath = testDataRoot !== null
  ? path.join(testDataRoot, "accounts.json")
  : path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "DiscordMultiAccount",
      "accounts.json"
    );

if (testDataRoot !== null) {
  fs.mkdirSync(testDataRoot);
}

function cleanupTestDataRoot() {
  if (testDataRoot === null || !fs.existsSync(testDataRoot)) {
    return;
  }

  const resolved = path.resolve(testDataRoot);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.match(path.basename(resolved), /^DiscordMultiAccountHostTests-[0-9a-f]{32}$/);
  fs.rmSync(resolved, { recursive: true, force: true });
}

process.on("exit", cleanupTestDataRoot);

function snapshotMetadata() {
  if (!fs.existsSync(protocolAccountsPath)) {
    return null;
  }
  const stat = fs.statSync(protocolAccountsPath, { bigint: true });
  return {
    bytes: fs.readFileSync(protocolAccountsPath),
    mtimeNs: stat.mtimeNs
  };
}

const VALID_AVATAR_DATA = "data:image/webp;base64,UklGRlAAAABXRUJQVlA4IEQAAADQAwCdASpAAEAAPnk8m0qkoyKhoggAkA8JaQB2AAAgbqagCvELcgAA/uHDf//pNn/IM/8gz8/f/13i0mbzCWyhAAAAAA==";
const fakeVp8x = Buffer.alloc(30);
fakeVp8x.write("RIFF", 0, "ascii");
fakeVp8x.writeUInt32LE(22, 4);
fakeVp8x.write("WEBPVP8X", 8, "ascii");
fakeVp8x.writeUInt32LE(10, 16);
fakeVp8x[24] = 63;
fakeVp8x[27] = 63;
const INVALID_VP8X_AVATAR_DATA = `data:image/webp;base64,${fakeVp8x.toString("base64")}`;

assert.match(hostSource, /ArgumentList\.Add\("--new-window"\)/);
assert.match(hostSource, /LaunchProfile\(profileId, "https:\/\/discord\.com\/login"/);
assert.match(hostSource, /ArgumentList\.Add\(destinationUrl\)/);
assert.equal(
  hostSource.includes('"https://discord.com/invite/" + Uri.EscapeDataString(inviteCode)'),
  true
);
assert.equal(hostSource.includes('@"\\A[A-Za-z0-9_-]{2,64}\\z"'), true);
assert.match(hostSource, /case "inviteCode"/);
assert.doesNotMatch(hostSource, /case "(?:url|inviteUrl)"/);
assert.match(hostSource, /Path\.Combine\(profileDirectory, "Local State"\)/);
assert.match(hostSource, /WriteBoolean\("isNewProfile"/);

function frame(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

function runHost(message, origin = validOrigin, nativeArguments = null) {
  return new Promise((resolve, reject) => {
    const hostArguments = [origin];
    if (nativeArguments !== null) {
      assert.equal(Array.isArray(nativeArguments), true);
      hostArguments.push(...nativeArguments);
    } else if (testDataRoot !== null) {
      hostArguments.push("--test-data-root", testDataRoot);
    } else {
      hostArguments.push("--parent-window=0");
    }

    const child = spawn(hostPath, hostArguments, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const raw = Buffer.concat(stdout);
      let response = null;
      if (raw.length >= 4) {
        const length = raw.readUInt32LE(0);
        assert.equal(raw.length, length + 4, "native response length must match its frame");
        response = JSON.parse(raw.subarray(4).toString("utf8"));
      }
      resolve({
        code,
        response,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdoutLength: raw.length
      });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(frame(message));
  });
}

function runHostMessages(messages, origin = validOrigin, nativeArguments = null) {
  return new Promise((resolve, reject) => {
    const hostArguments = [origin];
    if (nativeArguments !== null) {
      assert.equal(Array.isArray(nativeArguments), true);
      hostArguments.push(...nativeArguments);
    } else if (testDataRoot !== null) {
      hostArguments.push("--test-data-root", testDataRoot);
    } else {
      hostArguments.push("--parent-window=0");
    }

    const child = spawn(hostPath, hostArguments, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const raw = Buffer.concat(stdout);
      const responses = [];
      let offset = 0;
      while (offset < raw.length) {
        assert.equal(raw.length - offset >= 4, true, "native response header must be complete");
        const length = raw.readUInt32LE(offset);
        offset += 4;
        assert.equal(raw.length - offset >= length, true, "native response frame must be complete");
        responses.push(JSON.parse(raw.subarray(offset, offset + length).toString("utf8")));
        offset += length;
      }
      resolve({
        code,
        responses,
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.concat(messages.map(frame)));
  });
}

const ping = await runHost({ action: "ping" });
assert.equal(ping.code, 0);
assert.equal(ping.response?.ok, true);
assert.equal(ping.response?.version, "1.8.0");

const originOnlyPing = await runHost({ action: "ping" }, validOrigin, []);
assert.equal(originOnlyPing.code, 0);
assert.equal(originOnlyPing.response?.ok, true);

for (const handle of ["0", "12345", "18446744073709551615"]) {
  const parentWindowPing = await runHost(
    { action: "ping" },
    validOrigin,
    [`--parent-window=${handle}`]
  );
  assert.equal(parentWindowPing.code, 0);
  assert.equal(parentWindowPing.response?.ok, true);
  assert.equal(parentWindowPing.response?.version, "1.8.0");
}

for (const malformedArguments of [
  ["--parent-window="],
  ["--parent-window=-1"],
  ["--parent-window=+1"],
  ["--parent-window=0x10"],
  ["--parent-window= 1"],
  ["--parent-window=1 "],
  ["--parent-window=١"],
  ["--parent-window=18446744073709551616"],
  ["--parent-window", "1"],
  ["--Parent-Window=1"],
  ["--parent-window=1", "--parent-window=2"],
  ["--parent-window=1", "extra"],
  ["--test-data-root", os.tmpdir()],
  ["--parent-window=1", "--test-data-root", testDataRoot ?? os.tmpdir()]
]) {
  const rejectedArguments = await runHost(
    { action: "ping" },
    validOrigin,
    malformedArguments
  );
  assert.equal(rejectedArguments.code, 2);
  assert.equal(rejectedArguments.response, null);
  assert.equal(rejectedArguments.stdoutLength, 0);
  assert.match(rejectedArguments.stderr, /^Rejected native-host arguments\.\s*$/);
}

if (testDataRoot !== null) {
  assert.deepEqual(
    fs.readdirSync(testDataRoot),
    [],
    "parent-window compatibility checks must not touch the isolated data root"
  );
}

const list = await runHost({ action: "list" });
assert.equal(list.response?.ok, true);
assert.equal(Array.isArray(list.response?.accounts), true);

const accountsBeforeRejectedLabels = structuredClone(list.response.accounts);
const metadataBeforeRejectedRequests = snapshotMetadata();
let missingProfileId;
do {
  missingProfileId = crypto.randomUUID();
} while (list.response.accounts.some((account) => account.id === missingProfileId));

const missingInviteCode = await runHost({
  action: "launchInvite",
  profileId: missingProfileId
});
assert.equal(missingInviteCode.response?.ok, false);
assert.match(missingInviteCode.response?.message ?? "", /unsupported/i);

const inviteFieldSmuggling = await runHost({ action: "ping", inviteCode: "Ab_12-x" });
assert.equal(inviteFieldSmuggling.response?.ok, false);
assert.match(inviteFieldSmuggling.response?.message ?? "", /unsupported/i);

const inviteExtraField = await runHost({
  action: "launchInvite",
  profileId: missingProfileId,
  inviteCode: "Ab_12-x",
  label: "Not allowed"
});
assert.equal(inviteExtraField.response?.ok, false);
assert.match(inviteExtraField.response?.message ?? "", /unsupported/i);

const invalidInviteProfile = await runHost({
  action: "launchInvite",
  profileId: "not-a-uuid",
  inviteCode: "Ab_12-x"
});
assert.equal(invalidInviteProfile.response?.ok, false);
assert.match(invalidInviteProfile.response?.message ?? "", /profile ID/i);

for (const invalidInviteCode of [
  "",
  "a",
  "A".repeat(65),
  "discord.gg/Ab_12-x",
  "https://discord.gg/Ab_12-x",
  "Ab/12",
  "Ab.12",
  "Ab?12",
  "Ab#12",
  " Ab12",
  "Ab12 ",
  "Ab@12",
  "Ab%12",
  "Ab:12",
  "Ab\\12",
  "Ab\u0001",
  "éé",
  null,
  123,
  []
]) {
  const rejectedInvite = await runHost({
    action: "launchInvite",
    profileId: missingProfileId,
    inviteCode: invalidInviteCode
  });
  assert.equal(rejectedInvite.response?.ok, false);
  if (typeof invalidInviteCode === "string" && invalidInviteCode.length >= 8) {
    assert.equal((rejectedInvite.response?.message ?? "").includes(invalidInviteCode), false);
  }
}

const missingInviteProfile = await runHost({
  action: "launchInvite",
  profileId: missingProfileId,
  inviteCode: "Ab_12-x"
});
assert.equal(missingInviteProfile.response?.ok, false);
assert.match(missingInviteProfile.response?.message ?? "", /not found/i);

const persistentPortProtocol = await runHostMessages([
  { action: "ping" },
  { action: "list" },
  { action: "launchInvite", profileId: missingProfileId, inviteCode: "Ab_12-x" }
]);
assert.equal(persistentPortProtocol.code, 0);
assert.equal(persistentPortProtocol.responses.length, 3);
assert.equal(persistentPortProtocol.responses[0]?.ok, true);
assert.equal(Array.isArray(persistentPortProtocol.responses[1]?.accounts), true);
assert.equal(persistentPortProtocol.responses[2]?.ok, false);
assert.match(persistentPortProtocol.responses[2]?.message ?? "", /not found/i);
assert.equal(persistentPortProtocol.stderr, "");

for (const tokenShapedLabel of [
  `${"A".repeat(20)}.${"B".repeat(6)}.${"C".repeat(40)}`.slice(0, 40),
  `mfa.${"D".repeat(36)}`
]) {
  const rejectedLabel = await runHost({ action: "create", label: tokenShapedLabel });
  assert.equal(rejectedLabel.response?.ok, false);
  assert.match(rejectedLabel.response?.message ?? "", /secret/i);
  if (list.response.accounts.length > 0) {
    const rejectedRename = await runHost({
      action: "rename",
      profileId: list.response.accounts[0].id,
      label: tokenShapedLabel
    });
    assert.equal(rejectedRename.response?.ok, false);
    assert.match(rejectedRename.response?.message ?? "", /secret/i);
  }
}

const avatarTargetId = list.response.accounts[0]?.id ?? crypto.randomUUID();
for (const invalidAvatarData of [
  "data:image/png;base64,iVBORw0KGgo=",
  "data:image/webp;base64,SGVsbG8=",
  INVALID_VP8X_AVATAR_DATA,
  `${VALID_AVATAR_DATA}AA`
]) {
  const rejectedAvatar = await runHost({
    action: "setAvatar",
    profileId: avatarTargetId,
    avatarData: invalidAvatarData
  });
  assert.equal(rejectedAvatar.response?.ok, false);
  assert.equal((rejectedAvatar.response?.message ?? "").includes(invalidAvatarData), false);
}

for (const invalidTags of [
  "Main",
  null,
  [""],
  [" "],
  ["A".repeat(17)],
  ["One", "Two", "Three"],
  ["Same", "same"],
  ["Bad,Tag"],
  ["Bad@Tag"],
  ["Bad，Tag"],
  ["Bad\u0001Tag"],
  ["Bad\u200bTag"],
  ["Main", 2],
  [["Nested"]]
]) {
  const rejectedTags = await runHost({
    action: "setTags",
    profileId: avatarTargetId,
    tags: invalidTags
  });
  assert.equal(rejectedTags.response?.ok, false);
}

// Only refused delete requests run here, because this block may use real profile data.
const invalidDeleteId = await runHost({ action: "delete", profileId: "..\\..\\escape" });
assert.equal(invalidDeleteId.response?.ok, false);
assert.match(invalidDeleteId.response?.message ?? "", /profile ID/i);

const missingDeleteId = await runHost({ action: "delete" });
assert.equal(missingDeleteId.response?.ok, false);
assert.match(missingDeleteId.response?.message ?? "", /unsupported/i);

const deleteFieldSmuggling = await runHost({
  action: "delete",
  profileId: missingProfileId,
  label: "Not allowed"
});
assert.equal(deleteFieldSmuggling.response?.ok, false);
assert.match(deleteFieldSmuggling.response?.message ?? "", /unsupported/i);

const missingDeleteProfile = await runHost({ action: "delete", profileId: missingProfileId });
assert.equal(missingDeleteProfile.response?.ok, false);
assert.match(missingDeleteProfile.response?.message ?? "", /not found/i);

const listAfterRejectedLabels = await runHost({ action: "list" });
assert.deepEqual(
  listAfterRejectedLabels.response?.accounts,
  accountsBeforeRejectedLabels,
  "rejected labels, avatars, tags, and invites must not change metadata"
);
assert.deepEqual(
  snapshotMetadata(),
  metadataBeforeRejectedRequests,
  "rejected protocol requests must preserve metadata bytes and modification time"
);

const traversal = await runHost({ action: "launch", profileId: "..\\..\\escape" });
assert.equal(traversal.response?.ok, false);
assert.equal(traversal.response?.version, "1.8.0");
assert.match(traversal.response?.message ?? "", /profile ID/i);

const invalidRenameId = await runHost({ action: "rename", profileId: "not-a-uuid", label: "Gaming" });
assert.equal(invalidRenameId.response?.ok, false);
assert.match(invalidRenameId.response?.message ?? "", /profile ID/i);

const missingRenameLabel = await runHost({ action: "rename", profileId: crypto.randomUUID() });
assert.equal(missingRenameLabel.response?.ok, false);
assert.match(missingRenameLabel.response?.message ?? "", /unsupported/i);

const missingRenameProfile = await runHost({
  action: "rename",
  profileId: crypto.randomUUID(),
  label: "Gaming"
});
assert.equal(missingRenameProfile.response?.ok, false);
assert.match(missingRenameProfile.response?.message ?? "", /not found/i);

const missingAvatarData = await runHost({ action: "setAvatar", profileId: crypto.randomUUID() });
assert.equal(missingAvatarData.response?.ok, false);
assert.match(missingAvatarData.response?.message ?? "", /unsupported/i);

const avatarFieldSmuggling = await runHost({
  action: "ping",
  avatarData: VALID_AVATAR_DATA
});
assert.equal(avatarFieldSmuggling.response?.ok, false);
assert.match(avatarFieldSmuggling.response?.message ?? "", /unsupported/i);

const missingTags = await runHost({ action: "setTags", profileId: crypto.randomUUID() });
assert.equal(missingTags.response?.ok, false);
assert.match(missingTags.response?.message ?? "", /unsupported/i);

const tagsFieldSmuggling = await runHost({ action: "ping", tags: [] });
assert.equal(tagsFieldSmuggling.response?.ok, false);
assert.match(tagsFieldSmuggling.response?.message ?? "", /unsupported/i);

const invalidTagsProfile = await runHost({ action: "setTags", profileId: "not-a-uuid", tags: [] });
assert.equal(invalidTagsProfile.response?.ok, false);
assert.match(invalidTagsProfile.response?.message ?? "", /profile ID/i);

const missingTagsProfile = await runHost({
  action: "setTags",
  profileId: crypto.randomUUID(),
  tags: ["Main"]
});
assert.equal(missingTagsProfile.response?.ok, false);
assert.match(missingTagsProfile.response?.message ?? "", /not found/i);

const unknownField = await runHost({ action: "ping", url: "https://example.com" });
assert.equal(unknownField.response?.ok, false);
assert.match(unknownField.response?.message ?? "", /unknown field/i);

const unsupported = await runHost({ action: "run", profileId: crypto.randomUUID() });
assert.equal(unsupported.response?.ok, false);
assert.match(unsupported.response?.message ?? "", /unsupported action/i);

const wrongOrigin = await runHost(
  { action: "ping" },
  "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
  ["--parent-window=0"]
);
assert.equal(wrongOrigin.code, 2);
assert.equal(wrongOrigin.response, null);
assert.equal(wrongOrigin.stdoutLength, 0);
assert.match(wrongOrigin.stderr, /rejected/i);

if (runMetadataTests) {
  assert.notEqual(testDataRoot, null);
  const dataRoot = path.resolve(testDataRoot);
  const accountsPath = path.join(dataRoot, "accounts.json");
  const profilesPath = path.join(dataRoot, "Profiles");
  assert.equal(path.dirname(dataRoot), path.resolve(os.tmpdir()), "test data root must stay inside TEMP");
  assert.match(path.basename(dataRoot), /^DiscordMultiAccountHostTests-[0-9a-f]{32}$/);
  assert.equal(fs.existsSync(accountsPath), false, "refusing to overwrite existing account metadata");
  assert.equal(fs.existsSync(profilesPath), false, "refusing to run while account profiles exist");

  const rootExistedBefore = fs.existsSync(dataRoot);
  try {
    const automaticOne = await runHost({ action: "create" });
    assert.equal(automaticOne.response?.ok, true);
    assert.equal(automaticOne.response?.account?.label, "Account 1");
    assert.match(automaticOne.response?.account?.id ?? "", UUID_PATTERN);

    const accountOneId = automaticOne.response.account.id;
    const persistedBeforeLaunch = await runHost({ action: "list" });
    assert.equal(
      persistedBeforeLaunch.response?.accounts?.some((item) => item.id === accountOneId),
      true,
      "create must persist metadata before any launch"
    );

    const archived = await runHost({ action: "archive", profileId: accountOneId });
    assert.equal(archived.response?.ok, true);
    assert.equal(archived.response?.account?.archived, true);

    const automaticTwo = await runHost({ action: "create" });
    assert.equal(automaticTwo.response?.ok, true);
    assert.equal(automaticTwo.response?.account?.label, "Account 2");

    const renamedArchived = await runHost({
      action: "rename",
      profileId: accountOneId,
      label: "Archived Profile"
    });
    assert.equal(renamedArchived.response?.ok, true);
    assert.equal(renamedArchived.response?.account?.label, "Archived Profile");
    assert.equal(renamedArchived.response?.account?.archived, true);
    assert.equal(renamedArchived.response?.account?.createdAt, archived.response?.account?.createdAt);

    const accountTwoBeforeRename = automaticTwo.response.account;
    const renamedActive = await runHost({
      action: "rename",
      profileId: accountTwoBeforeRename.id,
      label: "Work Profile"
    });
    assert.equal(renamedActive.response?.ok, true);
    assert.equal(renamedActive.response?.account?.label, "Work Profile");
    assert.equal(renamedActive.response?.account?.id, accountTwoBeforeRename.id);
    assert.equal(renamedActive.response?.account?.createdAt, accountTwoBeforeRename.createdAt);
    assert.equal(renamedActive.response?.account?.archived, false);

    const caseOnlyRename = await runHost({
      action: "rename",
      profileId: accountTwoBeforeRename.id,
      label: "WORK PROFILE"
    });
    assert.equal(caseOnlyRename.response?.ok, true);
    assert.equal(caseOnlyRename.response?.account?.label, "WORK PROFILE");

    const activeAvatar = await runHost({
      action: "setAvatar",
      profileId: accountTwoBeforeRename.id,
      avatarData: VALID_AVATAR_DATA
    });
    assert.equal(activeAvatar.response?.ok, true);
    assert.equal(activeAvatar.response?.account?.avatarData, VALID_AVATAR_DATA);
    assert.equal(activeAvatar.response?.account?.id, accountTwoBeforeRename.id);
    assert.equal(activeAvatar.response?.account?.createdAt, accountTwoBeforeRename.createdAt);
    assert.equal(activeAvatar.response?.account?.archived, false);

    const archivedAvatar = await runHost({
      action: "setAvatar",
      profileId: accountOneId,
      avatarData: VALID_AVATAR_DATA
    });
    assert.equal(archivedAvatar.response?.ok, true);
    assert.equal(archivedAvatar.response?.account?.avatarData, VALID_AVATAR_DATA);
    assert.equal(archivedAvatar.response?.account?.archived, true);
    assert.equal(archivedAvatar.response?.account?.createdAt, archived.response?.account?.createdAt);

    const activeTags = await runHost({
      action: "setTags",
      profileId: accountTwoBeforeRename.id,
      tags: ["Main", "Gaming"]
    });
    assert.equal(activeTags.response?.ok, true);
    assert.deepEqual(activeTags.response?.account?.tags, ["Main", "Gaming"]);
    assert.equal(activeTags.response?.account?.avatarData, VALID_AVATAR_DATA);
    assert.equal(activeTags.response?.account?.label, "WORK PROFILE");
    assert.equal(activeTags.response?.account?.createdAt, accountTwoBeforeRename.createdAt);
    assert.equal(activeTags.response?.account?.archived, false);

    const idempotentTagsBefore = fs.readFileSync(accountsPath);
    const idempotentTags = await runHost({
      action: "setTags",
      profileId: accountTwoBeforeRename.id,
      tags: ["Main", "Gaming"]
    });
    assert.equal(idempotentTags.response?.ok, true);
    assert.deepEqual(fs.readFileSync(accountsPath), idempotentTagsBefore);

    const archivedSharedTag = await runHost({
      action: "setTags",
      profileId: accountOneId,
      tags: ["Main"]
    });
    assert.equal(archivedSharedTag.response?.ok, true);
    assert.deepEqual(archivedSharedTag.response?.account?.tags, ["Main"]);
    assert.equal(archivedSharedTag.response?.account?.avatarData, VALID_AVATAR_DATA);
    assert.equal(archivedSharedTag.response?.account?.archived, true);

    const clearedArchivedTags = await runHost({
      action: "setTags",
      profileId: accountOneId,
      tags: []
    });
    assert.equal(clearedArchivedTags.response?.ok, true);
    assert.equal("tags" in clearedArchivedTags.response.account, false);
    assert.equal(clearedArchivedTags.response?.account?.avatarData, VALID_AVATAR_DATA);

    const archivedTags = await runHost({
      action: "setTags",
      profileId: accountOneId,
      tags: ["Backup"]
    });
    assert.equal(archivedTags.response?.ok, true);
    assert.deepEqual(archivedTags.response?.account?.tags, ["Backup"]);

    const caseOnlyTags = await runHost({
      action: "setTags",
      profileId: accountTwoBeforeRename.id,
      tags: ["main", "Gaming"]
    });
    assert.equal(caseOnlyTags.response?.ok, true);
    assert.deepEqual(caseOnlyTags.response?.account?.tags, ["main", "Gaming"]);

    const collisionBefore = fs.readFileSync(accountsPath);
    const collision = await runHost({
      action: "rename",
      profileId: accountOneId,
      label: "work profile"
    });
    assert.equal(collision.response?.ok, false);
    assert.match(collision.response?.message ?? "", /already exists/i);
    assert.deepEqual(fs.readFileSync(accountsPath), collisionBefore);

    const invalidTagsBefore = fs.readFileSync(accountsPath);
    const invalidTagsMutation = await runHost({
      action: "setTags",
      profileId: accountTwoBeforeRename.id,
      tags: ["Duplicate", "duplicate"]
    });
    assert.equal(invalidTagsMutation.response?.ok, false);
    assert.deepEqual(fs.readFileSync(accountsPath), invalidTagsBefore);

    const custom = await runHost({ action: "create", label: "QA Profile" });
    assert.equal(custom.response?.ok, true);
    assert.equal(custom.response?.account?.label, "QA Profile");
    assert.equal("tags" in custom.response.account, false);

    const restored = await runHost({ action: "restore", profileId: accountOneId });
    assert.equal(restored.response?.ok, true);
    assert.equal(restored.response?.account?.archived, false);

    const persisted = await runHost({ action: "list" });
    assert.equal(persisted.response?.accounts?.length, 3);
    assert.deepEqual(
      persisted.response.accounts.find((item) => item.id === accountTwoBeforeRename.id)?.tags,
      ["main", "Gaming"]
    );
    assert.deepEqual(
      persisted.response.accounts.find((item) => item.id === accountOneId)?.tags,
      ["Backup"]
    );
    assert.equal(fs.existsSync(profilesPath), false, "metadata creation must not create a Chrome profile");

    const deleteTargetId = custom.response.account.id;
    const activeDeleteBefore = fs.readFileSync(accountsPath);
    const activeDelete = await runHost({ action: "delete", profileId: deleteTargetId });
    assert.equal(activeDelete.response?.ok, false);
    assert.match(activeDelete.response?.message ?? "", /Archived before deleting/i);
    assert.deepEqual(fs.readFileSync(accountsPath), activeDeleteBefore);

    assert.equal((await runHost({ action: "archive", profileId: deleteTargetId })).response?.ok, true);
    const deleteTargetFolder = path.join(profilesPath, deleteTargetId);
    fs.mkdirSync(path.join(deleteTargetFolder, "Default"), { recursive: true });
    fs.writeFileSync(path.join(deleteTargetFolder, "Local State"), "{}");
    const readOnlyFile = path.join(deleteTargetFolder, "Default", "Cookies");
    fs.writeFileSync(readOnlyFile, "session");
    fs.chmodSync(readOnlyFile, 0o444);

    // An open file inside the folder means Chrome may still be using it: refuse and change nothing.
    const busyBefore = fs.readFileSync(accountsPath);
    const busyHandle = fs.openSync(path.join(deleteTargetFolder, "Local State"), "r");
    let busyDelete;
    try {
      busyDelete = await runHost({ action: "delete", profileId: deleteTargetId });
    } finally {
      fs.closeSync(busyHandle);
    }
    assert.equal(busyDelete.response?.ok, false);
    assert.match(busyDelete.response?.message ?? "", /Close every Chrome window/i);
    assert.deepEqual(fs.readFileSync(accountsPath), busyBefore);
    assert.equal(fs.existsSync(path.join(deleteTargetFolder, "Local State")), true);

    const deleted = await runHost({ action: "delete", profileId: deleteTargetId });
    assert.equal(deleted.response?.ok, true);
    assert.equal(deleted.response?.version, "1.8.0");
    assert.equal(deleted.response?.filesRemoved, true);
    assert.equal(fs.existsSync(deleteTargetFolder), false, "delete must remove the Chrome profile folder");
    assert.deepEqual(
      fs.readdirSync(profilesPath).filter((name) => name.startsWith(".deleting-")),
      [],
      "a completed delete must not leave a pending folder"
    );
    const listAfterDelete = await runHost({ action: "list" });
    assert.equal(listAfterDelete.response?.accounts?.some((item) => item.id === deleteTargetId), false);
    assert.equal(listAfterDelete.response?.accounts?.length, 2);

    const repeatDelete = await runHost({ action: "delete", profileId: deleteTargetId });
    assert.equal(repeatDelete.response?.ok, false);
    assert.match(repeatDelete.response?.message ?? "", /not found/i);

    // A profile folder that is a junction must be refused without touching the link target.
    const linkedProfile = await runHost({ action: "create", label: "Linked Profile" });
    const linkedProfileId = linkedProfile.response.account.id;
    assert.equal((await runHost({ action: "archive", profileId: linkedProfileId })).response?.ok, true);
    const linkTarget = path.join(dataRoot, "outside-target");
    fs.mkdirSync(linkTarget);
    fs.writeFileSync(path.join(linkTarget, "keep.txt"), "keep");
    const linkedFolder = path.join(profilesPath, linkedProfileId);
    fs.symlinkSync(linkTarget, linkedFolder, "junction");
    try {
      const linkedDelete = await runHost({ action: "delete", profileId: linkedProfileId });
      assert.equal(linkedDelete.response?.ok, false);
      assert.match(linkedDelete.response?.message ?? "", /link/i);
      assert.equal(fs.readFileSync(path.join(linkTarget, "keep.txt"), "utf8"), "keep");
      assert.equal(
        (await runHost({ action: "list" })).response?.accounts?.some((item) => item.id === linkedProfileId),
        true
      );
    } finally {
      fs.unlinkSync(linkedFolder);
    }

    // Leftovers from a delete whose files were busy are removed on the next list.
    const leftover = path.join(profilesPath, `.deleting-${crypto.randomUUID()}-${"a".repeat(32)}`);
    const unrelated = path.join(profilesPath, ".deleting-not-ours");
    fs.mkdirSync(leftover);
    fs.writeFileSync(path.join(leftover, "Cookies"), "old");
    fs.mkdirSync(unrelated);
    assert.equal((await runHost({ action: "list" })).response?.ok, true);
    assert.equal(fs.existsSync(leftover), false, "list must finish pending deletions");
    assert.equal(fs.existsSync(unrelated), true, "list must ignore folders it did not create");
  } finally {
    if (fs.existsSync(accountsPath)) {
      const resolved = path.resolve(accountsPath);
      assert.equal(path.dirname(resolved), dataRoot);
      fs.unlinkSync(resolved);
    }
    if (!rootExistedBefore && fs.existsSync(dataRoot) && fs.readdirSync(dataRoot).length === 0) {
      fs.rmdirSync(dataRoot);
    }
  }
}

console.log("Native host protocol tests passed.");
