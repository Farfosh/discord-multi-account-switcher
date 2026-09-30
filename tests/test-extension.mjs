import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8")
);

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "1.8.0");
assert.equal(manifest.minimum_chrome_version, "105");
assert.deepEqual([...manifest.permissions].sort(), ["nativeMessaging"]);
assert.deepEqual(manifest.background, { service_worker: "background.js" });
assert.equal("host_permissions" in manifest, false);
assert.equal("content_scripts" in manifest, false);
assert.equal("externally_connectable" in manifest, false);
for (const iconPath of Object.values(manifest.icons)) {
  assert.equal(fs.existsSync(path.join(root, "extension", iconPath)), true);
}

const publicKey = Buffer.from(manifest.key, "base64");
const digest = crypto.createHash("sha256").update(publicKey).digest().subarray(0, 16);
const extensionId = [...digest]
  .map((byte) =>
    String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))
  )
  .join("");

assert.equal(extensionId, "ofnblgcbllibhicnkjhogibgpjmnpncf");

const popupHtml = fs.readFileSync(path.join(root, "extension", "popup.html"), "utf8");
const popupSource = fs.readFileSync(path.join(root, "extension", "popup.js"), "utf8");
const backgroundPath = path.join(root, "extension", "background.js");
assert.equal(fs.existsSync(backgroundPath), true);
const backgroundSource = fs.readFileSync(backgroundPath, "utf8");
assert.match(popupHtml, /does not copy the account open in your current tab/i);
assert.match(popupHtml, /Never paste a Discord token/i);
assert.match(popupHtml, /Server invite/i);
assert.match(popupHtml, /Archived profiles stay closed/i);
assert.match(popupHtml, /confirm Join Server manually/i);
assert.match(popupSource, /DISCORD_TOKEN_LABEL_PATTERN/);
assert.match(popupSource, /setAvatar/);
assert.match(popupSource, /setTags/);
assert.match(popupSource, /startInviteBatch/);
assert.doesNotMatch(popupSource, /action:\s*"launchInvite"/);
assert.doesNotMatch(popupSource, /connectNative/);
assert.match(popupSource, /MAX_INVITE_PROFILES = 20/);
assert.match(popupSource, /canonicalizeWebPDataUrl/);
assert.match(popupSource, /MIN_HOST_VERSION = \[1, 8, 0\]/);
assert.match(popupSource, /action: "delete"/);
assert.match(backgroundSource, /connectNative\(HOST_NAME\)/);
assert.match(backgroundSource, /action:\s*"launchInvite"/);
assert.match(backgroundSource, /MAX_INVITE_PROFILES = 20/);
assert.doesNotMatch(popupHtml, /Account session saved/i);
console.log(`Extension manifest checks passed (${extensionId}).`);
