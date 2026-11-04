# Iris documentation

Find instructions for the Iris source you are running. Start with
[installation](installation.md) to host an instance or the
[user guide](user-guide.md) to work on a project.

## Use Iris

| I want to… | Read |
| --- | --- |
| Sign in and create a project | [Choose your workspace](user-guide.md#sign-in-and-choose-your-workspace) |
| Upload files, edit source or use completion | [Files and editing](user-guide.md#files-and-editing) |
| Save work or take a snapshot | [Save and snapshot](user-guide.md#save-and-snapshot) |
| Compile LaTeX or LilyPond | [Compile a document or score](user-guide.md#compile-a-document-or-score) |
| Configure and run a Lua plugin | [Approve, inspect and run](lua-pipelines.md#approve-inspect-and-run) |
| Read output, errors and previous builds | [Preview and build history](user-guide.md#preview-and-build-history) |
| Jump between a PDF and its source | [PDF/source controls](user-guide.md#move-between-pdf-and-source) |
| Edit bibliography references | [Bibliographies](user-guide.md#bibliographies) |
| Share a project and edit together | [Sharing and live editing](user-guide.md#sharing-and-live-editing) |
| Restore a file or transfer a project | [History and portable projects](user-guide.md#history-retention-and-portable-projects) |
| Resolve a common error | [Common interruptions](user-guide.md#common-interruptions) |

## Run an instance

| I want to… | Read |
| --- | --- |
| Install on the host | [Native installation](installation.md#native-installation) |
| Use Docker or Podman | [Local container build](installation.md#local-container-build) |
| Configure paths, limits or authentication | [Configuration reference](configuration.md) |
| Create accounts or manage permissions | [Accounts and server roles](administration.md#accounts-and-server-roles) |
| Configure SSO | [OpenID Connect](administration.md#openid-connect) |
| Serve Iris through HTTPS | [Reverse proxy and HTTPS](administration.md#reverse-proxy-and-https) |
| Upgrade Iris | [Upgrade procedure](administration.md#upgrade-iris) |
| Back up or restore an instance | [Backup and restore](administration.md#backup-and-restore) |
| Recover an interrupted operation | [Recovery states](administration.md#recovery-states) |

## Develop and contribute

- [Development](development.md): setup, repository map, tests, packaging and
  persistence/collaboration/compiler contracts.
- [Editor languages](editor-languages.md): syntax support, language-service APIs,
  completion and safe edits.
- [Source navigation](source-navigation.md): API coordinates, native adapters
  and storage contracts.
- [Lua pipeline API](lua-pipelines.md#plugin-and-graph-api-version-1): author
  plugins, parameters, transforms and composition.
- [Interface colors](ui-colors.md) and [sizes and spacing](ui-measurements.md):
  shared UI tokens and component rules.
- [Translations](../TRANSLATING.md) and [project templates](../public/templates/README.md).
- [Capture documentation screenshots](images/README.md#reproduce-the-captures).
- [License](../LICENSE) and [third-party notices](../THIRD_PARTY_NOTICES.md).
