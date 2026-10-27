# Morrow repository handoff

Date: 2026-10-27. Source basis: deployed Morrow commit `4a15ffa324ec0b3e9e7832212a1b3ac721064ef7`.

The retired application has been removed from the server after checking Compose project labels, bind mounts and archive contents. Six stopped application/test containers and 33 application image tags were removed individually, without force or a global prune. Three unused project networks were removed. Shared base images and independent services were retained.

Old live application, historical release, database, backup and synthetic acceptance trees were removed. Nineteen release archives with confirmed frontend/backend contents were removed. Retired synchronization-only Nginx configurations were removed after checking their host/upstream ownership; configuration validation succeeded before a graceful reload. Main-site and independent-site routing was retained.

The earlier migration-backup directory was not deleted wholesale: it also contains Morrow initial configuration and mixed migration evidence. Those items remain private and untracked. Unclassified host artifacts were not deleted based on their names alone. Local Windows legacy data was outside this server cleanup scope.

Measured root filesystem allocation immediately before and after the main cleanup: 12,897,083,392 bytes and 11,802,992,640 bytes respectively; approximately 1.02 GiB reclaimed. Later filesystem usage may vary with logs and normal application writes.

Source export used only the deployed Git tracked tree, not a runtime directory copy. No environment file, database, upload, backup, provider configuration, SSH/TLS private key or production log was exported. Upstream license and notices remain present. Repository additions are documentation and ignore rules, not application behavior or persona changes.

Verification distinguishes service/interface checks from real model tests. The handoff does not itself establish mobile user acceptance or model quality, and does not request a paid model response. The memory audit separately lists code availability and unverified runtime behavior.

## Executed verification

- Compiled the exported tracked source with `python -m compileall -q .` in a new isolated directory: passed.
- Ran `python -m unittest discover -s tests -p 'test_*.py'` in that directory with synthetic authentication/signing values and an isolated database path: 369 tests, all passed, 57.643 seconds. No production database or environment file was copied. JavaScript tests were not run in this handoff.
- Authenticated HTTPS login and authentication check returned 200; session-list and memory-list APIs returned 200; unauthenticated session access returned 401. Credentials and cookies were held in memory only, never printed or stored in the repository.
- Production SQLite quick_check returned `ok`; session/message/memory row counts and schema fingerprint were unchanged across cleanup. No production reset, migration or restore occurred.
- Main site and two independent public sites returned HTTPS 200. Morrow and the two independent systemd services checked remained active. Independent container ownership and data mounts were retained.
- The export and additions contain 120 reviewed files. Sensitive-path/SQLite-signature checks and private-key, GitHub-token, provider-key, AWS-key and JWT pattern scans found no hits. This is a targeted publication review, not a guarantee that pattern matching detects every possible secret.
- No paid model call, message insertion, application restart or server reboot was performed. Full model streaming and reboot recovery were not re-tested; authenticated chat empty-request rejection is checked separately without creating history.
- Production credential values were compared in server memory against every deployed tracked source file, without displaying them: no exact matches. The authenticated empty chat request returned 400 before persistence. The deployed Git origin now points to the selected repository, while the former origin is retained as upstream; the running source tree was not pulled or reset.

The existing remote main was cleared by a normal commit, not by removing repository history. This handoff appends to that history without force-pushing. Historical legacy commits remain reachable; the publication scan covers the new source delivery and the current tree, not a full historical secret audit.
