# Security model

This project intentionally does **not** accept, import, read, copy, store, log, or inject Discord tokens.

Each account is opened in a separate Chrome user-data directory. The user signs in through Discord's official login page. Chrome necessarily stores the resulting cookies and local session data inside that isolated profile; the extension and native helper never inspect those files.

## Narrow permissions and capabilities

- The extension has only the `nativeMessaging` permission.
- It has no content scripts, Discord host access, cookie access, tab access, or remote code.
- The native helper stores only a local label, up to two optional local tags, a random UUID, a creation timestamp, archive state, and an optional tiny local avatar.
- The native helper accepts only `ping`, `list`, `create`, `rename`, `setAvatar`, `setTags`, `launch`, `launchInvite`, `archive`, `restore`, and `delete`.
- The helper validates the exact extension origin. On Windows it accepts only Chrome's optional `--parent-window=<unsigned decimal>` launch argument; all other production arguments are rejected.
- `create` commits metadata atomically before the popup is allowed to launch Chrome. A missing label is assigned the next unused `Account N` name inside the same metadata lock.
- New token-shaped labels are rejected without being saved. Suspicious labels from older versions remain readable for compatibility but are masked everywhere in the popup.
- `rename` changes only the local label under the same metadata lock. It preserves the UUID, creation timestamp, archive state, profile directory, and browser session.
- `setAvatar` accepts only a canonical, opaque 64×64 WebP data URL under a strict byte cap. It rejects external URLs, SVG, animation, extra metadata chunks, malformed Base64, wrong dimensions, and oversized data. It changes no session or profile fields.
- `setTags` changes only the selected profile's local tags under the metadata lock. It accepts an explicit array of zero to two distinct tags, normalizes each tag, and limits tags to 16 letters, numbers, spaces, hyphens, or underscores. Empty arrays clear tags. Tags are plaintext local reminders and must not contain secrets or email addresses.
- `launch` accepts only a canonical UUID. It never accepts a path, URL, executable, or command-line flags.
- The destination URL is fixed to `https://discord.com/login` and opens in a separate Chrome window.
- `launchInvite` accepts exactly one known profile UUID plus one 2–64 character ASCII invite code matching `[A-Za-z0-9_-]`. It rejects full URLs, paths, ports, query text, extra fields, and every code outside that allowlist without echoing the input.
- The helper constructs `https://discord.com/invite/<escaped-code>` internally and opens only that fixed Discord destination. It never accepts an arbitrary destination URL. The archived-profile exception applies only to `launchInvite`; normal `launch` still requires restoring an archived profile first.
- The popup takes one explicit confirmation and sends only a validated code plus at most 20 distinct active-profile UUIDs to the extension's Manifest V3 background worker. Archived/removed profiles are excluded before the request is created. The worker revalidates the exact message, accepts messages only from this extension's popup, and owns the batch so closing the popup cannot cancel it.
- The background worker holds one `connectNative` port and sends exactly one active-profile UUID per native `launchInvite` message. It never retries after a disconnect or timeout because a retry could duplicate a window whose response was lost. It closes the port after completion and does not persist invite data.
- The original link and any query or fragment are discarded before the worker is called. The extension never clicks `Join Server`; the user must review and confirm membership manually in every Discord window.
- The Native Messaging manifest allows exactly one stable extension ID.
- `archive` only hides a profile from the active list. It can be restored later and never touches its Chrome profile folder.
- `delete` accepts only a canonical UUID of a profile that is already archived; active profiles are refused. The popup always asks first, and its confirmation starts with Cancel focused.
- Before deleting, the helper moves `Profiles\<uuid>` aside inside the same `Profiles` folder. Windows refuses that move while Chrome still has files open there, so a profile that is in use is refused and nothing changes. A profile folder that is a junction or symbolic link, or a `Profiles` folder that is one, is refused without touching the link target.
- After the move, the helper removes the metadata entry and then deletes the moved folder without following nested links. If some files are still busy, the helper reports it and finishes the cleanup the next time the list loads. It only ever cleans up folders whose names match the exact pattern it created.
- Deleting a profile removes its local copy of the Discord session. It does not sign that session out on Discord's servers; use **User Settings → Devices** in Discord to log out a device you no longer use.

## Local trust boundary

Chrome protects its stored browser sessions using the current Windows account's security model. Malware or an administrator running on the same Windows account may still be able to interfere with browser sessions. This tool does not claim to defend against a compromised PC.

If a Discord token was previously pasted into an unknown website, script, or extension, change the Discord password and review/revoke active sessions before using this project.
