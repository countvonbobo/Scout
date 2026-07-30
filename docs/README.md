# Scout documentation

Choose the path that matches what you are trying to do.

## I want to try Scout

1. Read the [five-minute quick start](QUICK_START.md).
2. Follow the installer guide for [Windows](INSTALL_WINDOWS.md), [macOS](INSTALL_MACOS.md), or [Linux](INSTALL_LINUX.md).
3. Complete the setup wizard and read [AI provider setup](AI_SETUP.md) if Scout cannot find your provider.
4. Use [troubleshooting](TROUBLESHOOTING.md) if setup or a scan fails.

Scout stores career data locally by default. Read [privacy and data handling](PRIVACY.md) before adding a CV or connecting a private backup repository.

## I want Scout to run on an always-on server

Start with the [VPS installation guide](INSTALL_VPS.md). It covers:

- private access through Tailscale;
- the web service and reboot persistence;
- the selected primary provider and an optional independent verification pass;
- encrypted private-repository backups; and
- health checks and recovery.

The [canonical VPS state and automatic backup guide](VPS_BACKUP_AND_STATE.md) covers the source-of-truth model, backup triggers, recovery drill, and multi-client safety boundary. The [private remote access guide](PRIVATE_REMOTE_ACCESS.md) explains the network and security model in more detail.

## I already use Scout

- [Configuration reference](CONFIGURATION.md)
- [AI providers](PROVIDERS.md)
- [Job sources and Adzuna](ADZUNA_AND_SOURCES.md)
- [Scheduled scans](AUTOMATION.md)
- [Upgrades and rollback](UPGRADES.md)
- [Known issues](KNOWN_ISSUES.md)
- [CV quality guidance](CV_QUALITY.md)

## I want to contribute

Read [CONTRIBUTING.md](../CONTRIBUTING.md), then use:

- [repository layout](REPOSITORY_LAYOUT.md) for public/private data boundaries;
- [operations context](OPERATIONS.md) for the maintained VPS topology and change path;
- [scan protocol](SCOUT_SCAN_PROTOCOL.md) for scan behaviour;
- [release process](RELEASE.md) for packaging and publishing;
- [release package verification and signing](SUPPLY_CHAIN_SECURITY.md) for checksums, attestations and platform-signing boundaries; and
- [documentation maintenance](DOCUMENTATION.md) whenever a change affects users, setup, operations, security, or support.

Historical release notes live in [`docs/releases`](releases/). They describe a release as it was and are not current setup instructions.
