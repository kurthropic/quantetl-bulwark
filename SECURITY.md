# Security

Bulwark handles sensitive data, so please report security problems privately. Don't open a public issue.

- **How to report:** email info@quantetl.com with "SECURITY" in the subject.
- **What to include:** the version (`bulwark --version`), the steps to reproduce, and what you expected.
- **What happens next:** we aim to acknowledge reports within 3 working days, and to agree a disclosure date with
  you.

## Design and what it does not promise

- **No network:** every command runs on the local computer and opens no network connections. The one exception is
  `depot`, which talks only to a server you name.
- **Signatures and integrity:**
  - Manifests and share packages are signed with Ed25519 keys kept in `~/.bulwark/keys`.
  - The activity record is a SHA-256 hash chain.
  - Both detect changes; neither hides data.
- **What Bulwark is not:**
  - an accredited system for classified data;
  - FIPS 140 validated;
  - certified under CMMC, FedRAMP or any other scheme.

  Markings are handling labels.
- **Purge on SSDs:** `purge` overwrites and deletes, but SSDs can keep old blocks. Keep sensitive data on encrypted
  volumes.
