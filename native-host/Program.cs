using System.Buffers.Binary;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace DiscordMultiAccountHost;

internal static class Program
{
    private const int MaxMessageBytes = 8 * 1024;
    private const int MaxMetadataBytes = 512 * 1024;
    private const int MaxAccounts = 100;
    private const int MaxTags = 2;
    private const int MaxTagLength = 16;
    private const int MaxInviteCodeLength = 64;
    private const int MaxAvatarDataLength = 2959;
    private const int MaxAvatarBytes = 2200;
    private const int AvatarDimension = 64;
    private const string ExpectedOrigin = "chrome-extension://ofnblgcbllibhicnkjhogibgpjmnpncf/";
    private const string HostVersion = "1.8.0";
    private const string MetadataMutexName = @"Local\DiscordMultiAccount_Metadata_v1";
    private const string PendingDeletionPrefix = ".deleting-";
    private static readonly Regex DiscordTokenLabelPattern = new(
        @"^(?:mfa\.[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*)$",
        RegexOptions.CultureInvariant);
    private static readonly Regex AvatarDataPattern = new(
        @"^data:image/webp;base64,(?<payload>[A-Za-z0-9+/]+={0,2})$",
        RegexOptions.CultureInvariant | RegexOptions.ExplicitCapture);
    private static readonly Regex ParentWindowArgumentPattern = new(
        @"^--parent-window=(?<handle>[0-9]{1,20})$",
        RegexOptions.CultureInvariant | RegexOptions.ExplicitCapture);
    private static readonly Regex InviteCodePattern = new(
        @"\A[A-Za-z0-9_-]{2,64}\z",
        RegexOptions.CultureInvariant);
    private static readonly Regex PendingDeletionNamePattern = new(
        @"\A\.deleting-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{32}\z",
        RegexOptions.CultureInvariant);

    private static string DataRoot = Path.GetFullPath(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "DiscordMultiAccount"));
    private static string AccountsFilePath = Path.Combine(DataRoot, "accounts.json");

    private static int Main(string[] args)
    {
        if (args.Length == 0 || !string.Equals(args[0], ExpectedOrigin, StringComparison.Ordinal))
        {
            Console.Error.WriteLine("Rejected native-messaging origin.");
            return 2;
        }

        if (!ConfigureDataRoot(args))
        {
            Console.Error.WriteLine("Rejected native-host arguments.");
            return 2;
        }

        using Stream input = Console.OpenStandardInput();
        using Stream output = Console.OpenStandardOutput();

        while (true)
        {
            byte[]? payload;
            try
            {
                payload = ReadMessage(input);
            }
            catch (Exception exception)
            {
                WriteMessage(output, NativeResponse.Fail($"Invalid request: {exception.Message}"));
                return 1;
            }

            if (payload is null)
            {
                return 0;
            }

            NativeResponse response;
            try
            {
                response = HandleMessage(payload);
            }
            catch (Exception exception)
            {
                response = NativeResponse.Fail(exception.Message);
            }

            WriteMessage(output, response);
        }
    }

    private static bool ConfigureDataRoot(string[] args)
    {
        if (args.Length == 1)
        {
            return true;
        }

        if (args.Length == 2)
        {
            Match match = ParentWindowArgumentPattern.Match(args[1]);
            return match.Success && ulong.TryParse(
                match.Groups["handle"].Value,
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out _);
        }

        if (args.Length != 3 || !string.Equals(args[1], "--test-data-root", StringComparison.Ordinal))
        {
            return false;
        }

        try
        {
            string candidate = Path.GetFullPath(args[2]).TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar);
            string tempRoot = Path.GetFullPath(Path.GetTempPath()).TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar);
            string? parent = Path.GetDirectoryName(candidate);
            string name = Path.GetFileName(candidate);

            if (!string.Equals(parent, tempRoot, StringComparison.OrdinalIgnoreCase)
                || !Regex.IsMatch(
                    name,
                    @"^DiscordMultiAccountHostTests-[0-9a-f]{32}$",
                    RegexOptions.CultureInvariant)
                || !Directory.Exists(candidate)
                || (File.GetAttributes(candidate) & FileAttributes.ReparsePoint) != 0)
            {
                return false;
            }

            DataRoot = candidate;
            AccountsFilePath = Path.Combine(DataRoot, "accounts.json");
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static NativeResponse HandleMessage(byte[] payload)
    {
        using JsonDocument document = JsonDocument.Parse(payload, new JsonDocumentOptions
        {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
            MaxDepth = 8
        });

        JsonElement root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException("Request must be a JSON object.");
        }

        string? action = null;
        string? profileId = null;
        string? label = null;
        string? avatarData = null;
        string? inviteCode = null;
        string[]? tags = null;
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (JsonProperty property in root.EnumerateObject())
        {
            if (!seen.Add(property.Name))
            {
                throw new InvalidOperationException($"Duplicate field: {property.Name}.");
            }

            switch (property.Name)
            {
                case "action":
                    action = ReadString(property, 16);
                    break;
                case "profileId":
                    profileId = ReadString(property, 36);
                    break;
                case "label":
                    label = ReadString(property, 80);
                    break;
                case "avatarData":
                    avatarData = ReadString(property, MaxAvatarDataLength);
                    break;
                case "inviteCode":
                    inviteCode = ReadString(property, MaxInviteCodeLength);
                    break;
                case "tags":
                    tags = ReadTags(property);
                    break;
                default:
                    throw new InvalidOperationException($"Unknown field: {property.Name}.");
            }
        }

        return action switch
        {
            "ping" when profileId is null && label is null && avatarData is null && inviteCode is null && tags is null => Ping(),
            "list" when profileId is null && label is null && avatarData is null && inviteCode is null && tags is null => ListAccounts(),
            "create" when profileId is null && avatarData is null && inviteCode is null && tags is null => CreateAccount(label),
            "rename" when profileId is not null && label is not null && avatarData is null && inviteCode is null && tags is null => RenameAccount(profileId, label),
            "setAvatar" when profileId is not null && label is null && avatarData is not null && inviteCode is null && tags is null => SetAvatar(profileId, avatarData),
            "setTags" when profileId is not null && label is null && avatarData is null && inviteCode is null && tags is not null => SetTags(profileId, tags),
            "launch" when profileId is not null && label is null && avatarData is null && inviteCode is null && tags is null => Launch(profileId),
            "launchInvite" when profileId is not null && label is null && avatarData is null && inviteCode is not null && tags is null => LaunchInvite(profileId, inviteCode),
            "archive" when profileId is not null && label is null && avatarData is null && inviteCode is null && tags is null => SetArchived(profileId, true),
            "restore" when profileId is not null && label is null && avatarData is null && inviteCode is null && tags is null => SetArchived(profileId, false),
            "delete" when profileId is not null && label is null && avatarData is null && inviteCode is null && tags is null => DeleteAccount(profileId),
            null => throw new InvalidOperationException("Missing action."),
            _ => throw new InvalidOperationException("Unsupported action or fields.")
        };
    }

    private static string ReadString(JsonProperty property, int maxLength)
    {
        if (property.Value.ValueKind != JsonValueKind.String)
        {
            throw new InvalidOperationException($"{property.Name} must be a string.");
        }

        string value = property.Value.GetString() ?? string.Empty;
        if (value.Length == 0 || value.Length > maxLength || value.Any(char.IsControl))
        {
            throw new InvalidOperationException($"Invalid {property.Name}.");
        }

        return value;
    }

    private static string[] ReadTags(JsonProperty property)
    {
        if (property.Value.ValueKind != JsonValueKind.Array ||
            property.Value.GetArrayLength() > MaxTags)
        {
            throw new InvalidOperationException("Tags must be an array containing at most two items.");
        }

        var values = new List<string>(property.Value.GetArrayLength());
        foreach (JsonElement item in property.Value.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String)
            {
                throw new InvalidOperationException("Each tag must be a string.");
            }

            string value = item.GetString() ?? string.Empty;
            if (value.Length == 0 || value.Length > MaxTagLength || value.Any(char.IsControl))
            {
                throw new InvalidOperationException("Each tag must contain between 1 and 16 characters.");
            }
            values.Add(value);
        }

        return NormalizeTags(values);
    }

    private static NativeResponse Ping()
    {
        _ = FindChromeExecutable();
        return NativeResponse.Success("Helper ready.", HostVersion);
    }

    private static NativeResponse ListAccounts()
    {
        List<StoredAccount> accounts = WithMetadataLock(() =>
        {
            CleanupPendingDeletions();
            return ReadAccounts();
        });
        accounts.Sort((left, right) =>
        {
            int archivedOrder = left.Archived.CompareTo(right.Archived);
            return archivedOrder != 0
                ? archivedOrder
                : string.Compare(left.CreatedAt, right.CreatedAt, StringComparison.Ordinal);
        });
        return NativeResponse.WithAccounts(accounts);
    }

    private static NativeResponse CreateAccount(string? rawLabel)
    {
        return WithMetadataLock(() =>
        {
            List<StoredAccount> accounts = ReadAccounts();
            if (accounts.Count >= MaxAccounts)
            {
                throw new InvalidOperationException($"You have reached the maximum of {MaxAccounts} profiles.");
            }

            string label = rawLabel is null
                ? GetNextAutomaticLabel(accounts)
                : NormalizeNewLabel(rawLabel);

            if (accounts.Any(account => string.Equals(account.Label, label, StringComparison.OrdinalIgnoreCase)))
            {
                throw new InvalidOperationException("That account name already exists, possibly in Archived.");
            }

            var account = new StoredAccount(
                Guid.NewGuid().ToString("D"),
                label,
                DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                false,
                null,
                null);
            accounts.Add(account);
            SaveAccounts(accounts);
            return NativeResponse.WithAccount("Profile created and saved.", account);
        });
    }

    private static string GetNextAutomaticLabel(IEnumerable<StoredAccount> accounts)
    {
        var usedLabels = new HashSet<string>(
            accounts.Select(account => account.Label),
            StringComparer.OrdinalIgnoreCase);
        for (int number = 1; number <= MaxAccounts; number++)
        {
            string candidate = $"Account {number}";
            if (!usedLabels.Contains(candidate))
            {
                return candidate;
            }
        }

        throw new InvalidOperationException("No automatic account name is available.");
    }

    private static NativeResponse RenameAccount(string profileId, string rawLabel)
    {
        string canonicalId = ParseProfileId(profileId);

        return WithMetadataLock(() =>
        {
            List<StoredAccount> accounts = ReadAccounts();
            int index = accounts.FindIndex(account => string.Equals(
                account.Id,
                canonicalId,
                StringComparison.Ordinal));
            if (index < 0)
            {
                throw new InvalidOperationException("Profile not found.");
            }

            string label = NormalizeNewLabel(rawLabel);
            if (string.Equals(accounts[index].Label, label, StringComparison.Ordinal))
            {
                return NativeResponse.WithAccount("Profile name unchanged.", accounts[index]);
            }

            if (accounts.Any(account =>
                    !string.Equals(account.Id, canonicalId, StringComparison.Ordinal) &&
                    string.Equals(account.Label, label, StringComparison.OrdinalIgnoreCase)))
            {
                throw new InvalidOperationException("That account name already exists, possibly in Archived.");
            }

            StoredAccount updated = accounts[index] with { Label = label };
            accounts[index] = updated;
            SaveAccounts(accounts);
            return NativeResponse.WithAccount("Profile renamed.", updated);
        });
    }

    private static NativeResponse SetAvatar(string profileId, string rawAvatarData)
    {
        string canonicalId = ParseProfileId(profileId);
        string avatarData = NormalizeAvatarData(rawAvatarData);

        return WithMetadataLock(() =>
        {
            List<StoredAccount> accounts = ReadAccounts();
            int index = accounts.FindIndex(account => string.Equals(
                account.Id,
                canonicalId,
                StringComparison.Ordinal));
            if (index < 0)
            {
                throw new InvalidOperationException("Profile not found.");
            }

            if (string.Equals(accounts[index].AvatarData, avatarData, StringComparison.Ordinal))
            {
                return NativeResponse.WithAccount("Profile picture unchanged.", accounts[index]);
            }

            StoredAccount updated = accounts[index] with { AvatarData = avatarData };
            accounts[index] = updated;
            SaveAccounts(accounts);
            return NativeResponse.WithAccount("Profile picture saved.", updated);
        });
    }

    private static NativeResponse SetTags(string profileId, IEnumerable<string> rawTags)
    {
        string canonicalId = ParseProfileId(profileId);
        string[] tags = NormalizeTags(rawTags);

        return WithMetadataLock(() =>
        {
            List<StoredAccount> accounts = ReadAccounts();
            int index = accounts.FindIndex(account => string.Equals(
                account.Id,
                canonicalId,
                StringComparison.Ordinal));
            if (index < 0)
            {
                throw new InvalidOperationException("Profile not found.");
            }

            string[] existingTags = accounts[index].Tags ?? [];
            if (existingTags.SequenceEqual(tags, StringComparer.Ordinal))
            {
                return NativeResponse.WithAccount("Profile tags unchanged.", accounts[index]);
            }

            StoredAccount updated = accounts[index] with
            {
                Tags = tags.Length == 0 ? null : tags
            };
            accounts[index] = updated;
            SaveAccounts(accounts);
            return NativeResponse.WithAccount(
                tags.Length == 0 ? "Profile tags removed." : "Profile tags saved.",
                updated);
        });
    }

    private static NativeResponse SetArchived(string profileId, bool archived)
    {
        string canonicalId = ParseProfileId(profileId);

        return WithMetadataLock(() =>
        {
            List<StoredAccount> accounts = ReadAccounts();
            int index = accounts.FindIndex(account => string.Equals(
                account.Id,
                canonicalId,
                StringComparison.Ordinal));
            if (index < 0)
            {
                throw new InvalidOperationException("Profile not found.");
            }

            StoredAccount updated = accounts[index] with { Archived = archived };
            accounts[index] = updated;
            SaveAccounts(accounts);
            return NativeResponse.WithAccount(
                archived ? "Profile moved to Archived." : "Profile restored to the list.",
                updated);
        });
    }

    private static NativeResponse DeleteAccount(string profileId)
    {
        string canonicalId = ParseProfileId(profileId);
        string profilesRoot = GetProfilesRoot();
        string profileDirectory = GetProfileDirectory(profilesRoot, canonicalId);

        return WithMetadataLock(() =>
        {
            List<StoredAccount> accounts = ReadAccounts();
            int index = accounts.FindIndex(account => string.Equals(
                account.Id,
                canonicalId,
                StringComparison.Ordinal));
            if (index < 0)
            {
                throw new InvalidOperationException("Profile not found.");
            }

            if (!accounts[index].Archived)
            {
                throw new InvalidOperationException("Move this profile to Archived before deleting it.");
            }

            // Moving the folder aside first proves Chrome is not using it: Windows refuses
            // to rename a folder while files inside it are open. A refused move changes nothing.
            string? pendingDirectory = null;
            if (Directory.Exists(profileDirectory))
            {
                EnsureRegularDirectory(profilesRoot);
                EnsureRegularDirectory(profileDirectory);
                pendingDirectory = Path.Combine(
                    profilesRoot,
                    $"{PendingDeletionPrefix}{canonicalId}-{Guid.NewGuid():N}");
                try
                {
                    Directory.Move(profileDirectory, pendingDirectory);
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    throw new InvalidOperationException(
                        "Close every Chrome window that uses this profile, then try again.");
                }
            }
            else if (File.Exists(profileDirectory))
            {
                throw new InvalidOperationException(
                    "The profile folder is not a normal folder, so nothing was deleted.");
            }

            accounts.RemoveAt(index);
            try
            {
                SaveAccounts(accounts);
            }
            catch
            {
                if (pendingDirectory is not null)
                {
                    try
                    {
                        Directory.Move(pendingDirectory, profileDirectory);
                    }
                    catch
                    {
                        // The folder stays aside; the profile entry still exists.
                    }
                }
                throw;
            }

            bool filesRemoved = pendingDirectory is null || TryDeleteDirectoryTree(pendingDirectory);
            return NativeResponse.Deleted(filesRemoved);
        });
    }

    private static void EnsureRegularDirectory(string path)
    {
        FileAttributes attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.Directory) == 0 ||
            (attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidOperationException(
                "The profile folder is a link or not a normal folder, so nothing was deleted.");
        }
    }

    private static bool TryDeleteDirectoryTree(string path)
    {
        try
        {
            var options = new EnumerationOptions
            {
                RecurseSubdirectories = true,
                AttributesToSkip = FileAttributes.ReparsePoint,
                IgnoreInaccessible = true
            };
            foreach (string file in Directory.EnumerateFiles(path, "*", options))
            {
                FileAttributes attributes = File.GetAttributes(file);
                if ((attributes & FileAttributes.ReadOnly) != 0)
                {
                    File.SetAttributes(file, attributes & ~FileAttributes.ReadOnly);
                }
            }

            // Directory.Delete removes nested links without following them.
            Directory.Delete(path, recursive: true);
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    // Finishes deletions whose files were still busy last time. Runs under the metadata lock.
    private static void CleanupPendingDeletions()
    {
        try
        {
            string profilesRoot = GetProfilesRoot();
            if (!Directory.Exists(profilesRoot) ||
                (File.GetAttributes(profilesRoot) & FileAttributes.ReparsePoint) != 0)
            {
                return;
            }

            foreach (string candidate in Directory.EnumerateDirectories(
                         profilesRoot,
                         PendingDeletionPrefix + "*"))
            {
                if (PendingDeletionNamePattern.IsMatch(Path.GetFileName(candidate)) &&
                    (File.GetAttributes(candidate) & FileAttributes.ReparsePoint) == 0)
                {
                    TryDeleteDirectoryTree(candidate);
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Leftovers are retried on the next list.
        }
    }

    private static string GetProfilesRoot() =>
        Path.GetFullPath(Path.Combine(DataRoot, "Profiles"));

    private static string GetProfileDirectory(string profilesRoot, string canonicalId)
    {
        string rootWithSeparator = profilesRoot.TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string profileDirectory = Path.GetFullPath(Path.Combine(profilesRoot, canonicalId));

        if (!profileDirectory.StartsWith(rootWithSeparator, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Profile path escaped its root.");
        }

        return profileDirectory;
    }

    private static NativeResponse Launch(string profileId) =>
        LaunchProfile(profileId, "https://discord.com/login", allowArchived: false);

    private static NativeResponse LaunchInvite(string profileId, string inviteCode)
    {
        if (!InviteCodePattern.IsMatch(inviteCode))
        {
            throw new InvalidOperationException("Invalid Discord invite code.");
        }

        string destinationUrl = "https://discord.com/invite/" + Uri.EscapeDataString(inviteCode);
        return LaunchProfile(profileId, destinationUrl, allowArchived: true);
    }

    private static NativeResponse LaunchProfile(
        string profileId,
        string destinationUrl,
        bool allowArchived)
    {
        string canonicalId = ParseProfileId(profileId);
        StoredAccount account = WithMetadataLock(() =>
        {
            StoredAccount? match = ReadAccounts().FirstOrDefault(item => string.Equals(
                item.Id,
                canonicalId,
                StringComparison.Ordinal));
            return match ?? throw new InvalidOperationException("Profile not found.");
        });

        if (account.Archived && !allowArchived)
        {
            throw new InvalidOperationException("Restore this profile from Archived before opening it.");
        }

        string chromeExecutable = FindChromeExecutable();
        string profileDirectory = GetProfileDirectory(GetProfilesRoot(), canonicalId);

        bool isNewProfile = !File.Exists(Path.Combine(profileDirectory, "Local State"));
        Directory.CreateDirectory(profileDirectory);

        var startInfo = new ProcessStartInfo
        {
            FileName = chromeExecutable,
            UseShellExecute = false,
            CreateNoWindow = false
        };
        startInfo.ArgumentList.Add($"--user-data-dir={profileDirectory}");
        startInfo.ArgumentList.Add("--no-first-run");
        startInfo.ArgumentList.Add("--no-default-browser-check");
        startInfo.ArgumentList.Add("--new-window");
        startInfo.ArgumentList.Add(destinationUrl);

        using Process? process = Process.Start(startInfo);
        if (process is null)
        {
            throw new InvalidOperationException("Chrome could not be started.");
        }

        return NativeResponse.Launched(isNewProfile);
    }

    private static string ParseProfileId(string profileId)
    {
        if (!Guid.TryParseExact(profileId, "D", out Guid parsedId))
        {
            throw new InvalidOperationException("Invalid profile ID.");
        }

        return parsedId.ToString("D");
    }

    private static string NormalizeLabel(string input)
    {
        string normalized = input.Normalize(NormalizationForm.FormC);
        if (normalized.Any(character =>
                char.IsControl(character) ||
                CharUnicodeInfo.GetUnicodeCategory(character) == UnicodeCategory.Format))
        {
            throw new InvalidOperationException("The account name contains unsupported characters.");
        }

        normalized = string.Join(
            ' ',
            normalized.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

        if (normalized.Length == 0 || normalized.Length > 40)
        {
            throw new InvalidOperationException("The account name must be between 1 and 40 characters.");
        }

        return normalized;
    }

    private static string NormalizeNewLabel(string input)
    {
        string normalized = NormalizeLabel(input);
        if (DiscordTokenLabelPattern.IsMatch(normalized))
        {
            throw new InvalidOperationException(
                "That looks like a secret. It was not saved; use a short name such as Gaming or Work.");
        }

        return normalized;
    }

    private static string[] NormalizeTags(IEnumerable<string> inputs)
    {
        var normalizedTags = new List<string>(MaxTags);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (string input in inputs)
        {
            if (normalizedTags.Count >= MaxTags)
            {
                throw new InvalidOperationException("A profile can have at most two tags.");
            }

            string normalized = input.Normalize(NormalizationForm.FormC);
            if (normalized.Any(character =>
                    char.IsControl(character) ||
                    CharUnicodeInfo.GetUnicodeCategory(character) == UnicodeCategory.Format))
            {
                throw new InvalidOperationException("A tag contains unsupported characters.");
            }

            normalized = string.Join(
                ' ',
                normalized.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

            if (normalized.Length == 0 || normalized.Length > MaxTagLength)
            {
                throw new InvalidOperationException("Each tag must contain between 1 and 16 characters.");
            }
            if (normalized.Any(character =>
                    character is not (' ' or '-' or '_') && !char.IsLetterOrDigit(character)))
            {
                throw new InvalidOperationException(
                    "Tags can use only letters, numbers, spaces, hyphens, and underscores.");
            }
            if (DiscordTokenLabelPattern.IsMatch(normalized))
            {
                throw new InvalidOperationException("That looks like a secret and was not saved.");
            }
            if (!seen.Add(normalized))
            {
                throw new InvalidOperationException("Tags on the same profile must be different.");
            }

            normalizedTags.Add(normalized);
        }

        return [.. normalizedTags];
    }

    private static string NormalizeAvatarData(string input)
    {
        if (input.Length == 0 || input.Length > MaxAvatarDataLength)
        {
            throw new InvalidOperationException("The profile picture is invalid or too large.");
        }

        Match match = AvatarDataPattern.Match(input);
        if (!match.Success)
        {
            throw new InvalidOperationException("The profile picture must be a local WebP image.");
        }

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(match.Groups["payload"].Value);
        }
        catch (FormatException)
        {
            throw new InvalidOperationException("The profile picture data is invalid.");
        }

        if (bytes.Length == 0 || bytes.Length > MaxAvatarBytes ||
            !string.Equals(
                Convert.ToBase64String(bytes),
                match.Groups["payload"].Value,
                StringComparison.Ordinal) ||
            !IsCanonicalAvatarWebP(bytes))
        {
            throw new InvalidOperationException(
                $"The profile picture must be a {AvatarDimension} by {AvatarDimension} WebP image.");
        }

        return input;
    }

    private static bool IsCanonicalAvatarWebP(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 30 ||
            bytes[0] != (byte)'R' || bytes[1] != (byte)'I' ||
            bytes[2] != (byte)'F' || bytes[3] != (byte)'F' ||
            bytes[8] != (byte)'W' || bytes[9] != (byte)'E' ||
            bytes[10] != (byte)'B' || bytes[11] != (byte)'P' ||
            BinaryPrimitives.ReadUInt32LittleEndian(bytes[4..8]) + 8u != (uint)bytes.Length ||
            bytes[12] != (byte)'V' || bytes[13] != (byte)'P' ||
            bytes[14] != (byte)'8' || bytes[15] != (byte)' ')
        {
            return false;
        }

        uint chunkSize = BinaryPrimitives.ReadUInt32LittleEndian(bytes[16..20]);
        long paddedLength = 20L + chunkSize + (chunkSize & 1u);
        if (chunkSize < 10 || paddedLength != bytes.Length ||
            ((chunkSize & 1u) != 0 && bytes[^1] != 0) ||
            (bytes[20] & 1) != 0 ||
            bytes[23] != 0x9d || bytes[24] != 0x01 || bytes[25] != 0x2a)
        {
            return false;
        }

        ushort widthHeader = BinaryPrimitives.ReadUInt16LittleEndian(bytes[26..28]);
        ushort heightHeader = BinaryPrimitives.ReadUInt16LittleEndian(bytes[28..30]);
        return (widthHeader & 0xc000) == 0 &&
               (heightHeader & 0xc000) == 0 &&
               (widthHeader & 0x3fff) == AvatarDimension &&
               (heightHeader & 0x3fff) == AvatarDimension;
    }

    private static T WithMetadataLock<T>(Func<T> action)
    {
        using var mutex = new Mutex(false, MetadataMutexName);
        bool acquired = false;
        try
        {
            try
            {
                acquired = mutex.WaitOne(TimeSpan.FromSeconds(5));
            }
            catch (AbandonedMutexException)
            {
                acquired = true;
            }

            if (!acquired)
            {
                throw new TimeoutException("The account list is busy. Try again.");
            }

            return action();
        }
        finally
        {
            if (acquired)
            {
                mutex.ReleaseMutex();
            }
        }
    }

    private static List<StoredAccount> ReadAccounts()
    {
        if (!File.Exists(AccountsFilePath))
        {
            return [];
        }

        var fileInfo = new FileInfo(AccountsFilePath);
        if (fileInfo.Length <= 0 || fileInfo.Length > MaxMetadataBytes)
        {
            throw new InvalidDataException("Account metadata size is invalid.");
        }

        byte[] payload = File.ReadAllBytes(AccountsFilePath);
        using JsonDocument document = JsonDocument.Parse(payload, new JsonDocumentOptions
        {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
            MaxDepth = 8
        });

        if (document.RootElement.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException("Account metadata must be an array.");
        }

        int count = document.RootElement.GetArrayLength();
        if (count > MaxAccounts)
        {
            throw new InvalidDataException("Too many account records.");
        }

        var accounts = new List<StoredAccount>(count);
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var labels = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (JsonElement item in document.RootElement.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidDataException("Invalid account record.");
            }

            string? id = null;
            string? label = null;
            string? createdAt = null;
            bool? archived = null;
            string? avatarData = null;
            string[]? tags = null;
            var fields = new HashSet<string>(StringComparer.Ordinal);

            foreach (JsonProperty property in item.EnumerateObject())
            {
                if (!fields.Add(property.Name))
                {
                    throw new InvalidDataException($"Duplicate account field: {property.Name}.");
                }

                switch (property.Name)
                {
                    case "id" when property.Value.ValueKind == JsonValueKind.String:
                        id = property.Value.GetString();
                        break;
                    case "label" when property.Value.ValueKind == JsonValueKind.String:
                        label = property.Value.GetString();
                        break;
                    case "createdAt" when property.Value.ValueKind == JsonValueKind.String:
                        createdAt = property.Value.GetString();
                        break;
                    case "archived" when property.Value.ValueKind is JsonValueKind.True or JsonValueKind.False:
                        archived = property.Value.GetBoolean();
                        break;
                    case "avatarData" when property.Value.ValueKind == JsonValueKind.String:
                        avatarData = property.Value.GetString();
                        break;
                    case "tags":
                        tags = ReadTags(property);
                        break;
                    default:
                        throw new InvalidDataException($"Invalid account field: {property.Name}.");
                }
            }

            string canonicalId = ParseProfileId(id ?? string.Empty);
            string cleanLabel = NormalizeLabel(label ?? string.Empty);
            string? cleanAvatarData = avatarData is null
                ? null
                : NormalizeAvatarData(avatarData);
            string[]? cleanTags = tags is null || tags.Length == 0
                ? null
                : NormalizeTags(tags);
            if (!DateTimeOffset.TryParseExact(
                    createdAt,
                    "O",
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.RoundtripKind,
                    out DateTimeOffset timestamp) ||
                archived is null)
            {
                throw new InvalidDataException("Incomplete account record.");
            }

            if (!ids.Add(canonicalId) || !labels.Add(cleanLabel))
            {
                throw new InvalidDataException("Duplicate account record.");
            }

            accounts.Add(new StoredAccount(
                canonicalId,
                cleanLabel,
                timestamp.ToString("O", CultureInfo.InvariantCulture),
                archived.Value,
                cleanAvatarData,
                cleanTags));
        }

        return accounts;
    }

    private static void SaveAccounts(IReadOnlyCollection<StoredAccount> accounts)
    {
        Directory.CreateDirectory(DataRoot);
        string temporaryPath = Path.Combine(
            DataRoot,
            $"accounts.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp");

        try
        {
            using (var stream = new FileStream(
                       temporaryPath,
                       FileMode.CreateNew,
                       FileAccess.Write,
                       FileShare.None,
                       4096,
                       FileOptions.WriteThrough))
            {
                using var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true });
                writer.WriteStartArray();
                foreach (StoredAccount account in accounts)
                {
                    WriteAccount(writer, account);
                }
                writer.WriteEndArray();
                writer.Flush();
                if (stream.Length > MaxMetadataBytes)
                {
                    throw new InvalidOperationException("Account metadata is too large.");
                }
                stream.Flush(true);
            }

            File.Move(temporaryPath, AccountsFilePath, true);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }

    private static string FindChromeExecutable()
    {
        string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);

        string?[] candidates =
        [
            Path.Combine(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
            Registry.GetValue(
                @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
                string.Empty,
                null) as string,
            Registry.GetValue(
                @"HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
                string.Empty,
                null) as string
        ];

        foreach (string? candidate in candidates)
        {
            if (string.IsNullOrWhiteSpace(candidate))
            {
                continue;
            }

            string fullPath;
            try
            {
                fullPath = Path.GetFullPath(candidate.Trim('"'));
            }
            catch
            {
                continue;
            }

            if (File.Exists(fullPath) &&
                string.Equals(Path.GetFileName(fullPath), "chrome.exe", StringComparison.OrdinalIgnoreCase))
            {
                return fullPath;
            }
        }

        throw new FileNotFoundException("Google Chrome was not found on this PC.");
    }

    private static byte[]? ReadMessage(Stream input)
    {
        byte[] lengthBytes = new byte[4];
        int firstByte = input.ReadByte();
        if (firstByte == -1)
        {
            return null;
        }

        lengthBytes[0] = (byte)firstByte;
        ReadExactly(input, lengthBytes, 1, 3);
        int length = BitConverter.ToInt32(lengthBytes, 0);

        if (length <= 0 || length > MaxMessageBytes)
        {
            throw new InvalidOperationException("Message length is outside the allowed range.");
        }

        byte[] payload = new byte[length];
        ReadExactly(input, payload, 0, length);
        return payload;
    }

    private static void ReadExactly(Stream input, byte[] buffer, int offset, int count)
    {
        while (count > 0)
        {
            int read = input.Read(buffer, offset, count);
            if (read == 0)
            {
                throw new EndOfStreamException("Unexpected end of input.");
            }

            offset += read;
            count -= read;
        }
    }

    private static void WriteMessage(Stream output, NativeResponse response)
    {
        using var payload = new MemoryStream();
        using (var writer = new Utf8JsonWriter(payload))
        {
            writer.WriteStartObject();
            writer.WriteBoolean("ok", response.Ok);
            writer.WriteString("message", response.Message);
            if (response.Version is not null)
            {
                writer.WriteString("version", response.Version);
            }
            if (response.Account is not null)
            {
                writer.WritePropertyName("account");
                WriteAccount(writer, response.Account);
            }
            if (response.Accounts is not null)
            {
                writer.WriteStartArray("accounts");
                foreach (StoredAccount account in response.Accounts)
                {
                    WriteAccount(writer, account);
                }
                writer.WriteEndArray();
            }
            if (response.IsNewProfile is not null)
            {
                writer.WriteBoolean("isNewProfile", response.IsNewProfile.Value);
            }
            if (response.FilesRemoved is not null)
            {
                writer.WriteBoolean("filesRemoved", response.FilesRemoved.Value);
            }
            writer.WriteEndObject();
            writer.Flush();
        }

        byte[] json = payload.ToArray();
        byte[] length = BitConverter.GetBytes(json.Length);
        output.Write(length, 0, length.Length);
        output.Write(json, 0, json.Length);
        output.Flush();
    }

    private static void WriteAccount(Utf8JsonWriter writer, StoredAccount account)
    {
        writer.WriteStartObject();
        writer.WriteString("id", account.Id);
        writer.WriteString("label", account.Label);
        writer.WriteString("createdAt", account.CreatedAt);
        writer.WriteBoolean("archived", account.Archived);
        if (account.AvatarData is not null)
        {
            writer.WriteString("avatarData", account.AvatarData);
        }
        if (account.Tags is { Length: > 0 })
        {
            writer.WriteStartArray("tags");
            foreach (string tag in account.Tags)
            {
                writer.WriteStringValue(tag);
            }
            writer.WriteEndArray();
        }
        writer.WriteEndObject();
    }

    private sealed record StoredAccount(
        string Id,
        string Label,
        string CreatedAt,
        bool Archived,
        string? AvatarData,
        string[]? Tags);

    private sealed record NativeResponse(
        bool Ok,
        string Message,
        string? Version = null,
        StoredAccount? Account = null,
        IReadOnlyList<StoredAccount>? Accounts = null,
        bool? IsNewProfile = null,
        bool? FilesRemoved = null)
    {
        public static NativeResponse Success(string message, string version) =>
            new(true, message, version);

        public static NativeResponse WithAccount(string message, StoredAccount account) =>
            new(true, message, HostVersion, account);

        public static NativeResponse WithAccounts(IReadOnlyList<StoredAccount> accounts) =>
            new(true, "Accounts loaded.", HostVersion, null, accounts);

        public static NativeResponse Launched(bool isNewProfile) =>
            new(true, "Discord profile opened.", HostVersion, null, null, isNewProfile);

        public static NativeResponse Deleted(bool filesRemoved) =>
            new(
                true,
                filesRemoved
                    ? "Profile deleted."
                    : "Profile deleted. Some files were still in use and will be removed later.",
                HostVersion,
                FilesRemoved: filesRemoved);

        public static NativeResponse Fail(string message) => new(false, message, HostVersion);
    }
}
