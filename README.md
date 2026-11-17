<p align="center"><img src="assets/bulwark-logo-banner.png" alt="QuantETL Bulwark v1.12 Beta Release 01" width="520"></p>

# QuantETL Bulwark

**Prepare, prove and move data entirely on your own machine.** Bulwark is the open-source engine and terminal app of
QuantETL: it profiles and cleans multi-GB CSV, JSONL and Parquet files, prepares AI training data (quality filters,
near-duplicate removal, personal-data redaction, leak checks), and signs everything it produces, with no network and
no dependencies beyond Node.js.

```
git clone <this repository> bulwark && cd bulwark
./scripts/install-bulwark.sh      # puts `bulwark` on your PATH
bulwark help
```

<p align="center"><img src="assets/bulwark-logo-banner.png" alt="QuantETL Bulwark v1.12 Beta Release 01" width="520"></p>

Version: **v1.12 Beta Release 01**.

The terminal edition of QuantETL, built for air-gapped and defence networks. It prepares, checks, signs and moves data
entirely on one computer, with the same engine as the console.

- **No network:** every command runs locally. The only exception is `depot`, which connects to a QuantETL server
  that you name.
- **Formats:** CSV, TSV, JSONL and Parquet, including multi-GB files, streamed row by row.
- **Requirements:** Node.js 22 or later, on macOS or Linux. There are no other dependencies, ever.

```
./scripts/install-bulwark.sh     # adds `bulwark` to your PATH
bulwark help                     # list commands
bulwark                          # interactive shell (tab completes commands and step names)
```

**Startup animation.** When the shell opens, the logo (`assets/bulwark-logo.txt`) slides in like a marquee, then
dissolves into the name and version. It plays on the terminal's alternate screen, so your scrollback is untouched.
Any key skips it, and `bulwark logo` replays it. Turn it off with `--no-splash` or `BULWARK_NO_SPLASH=1`. It never plays in
scripts, when input or output isn't a terminal, with `NO_COLOR`, or in windows under 40×12.

Bulwark keeps its state in `~/.bulwark` (set `BULWARK_HOME` to move it):
- one Ed25519 signing key per user;
- the activity record;
- classification markings;
- destruction records.

The signing identity is your macOS user name. Change it with `--as <name>` or `BULWARK_USER`.

## Modules

| Command | What it does |
|---|---|
| `census <file>` | Profiles every column with exact counts and gives a 0–100 quality score |
| `assay <file> [--column c]` | Training readiness: personal data, low-quality text, duplicates, languages, length |
| `veil scan <file>` / `veil protect <file> -o out` | Finds personal data and re-identification risk (k-anonymity); `protect` writes a protected copy |
| `crucible prepare <file> -o recipe.json` | Builds a recipe of recommended steps, each with its reason |
| `crucible ops` / `new` / `add` / `remove` / `show` | Inspects and edits recipes. Example: `crucible add r.json near_duplicates column=text threshold=0.85` |
| `crucible run <file> --recipe r.json -o out.parquet` | Runs the recipe over the whole file. Writes JSONL, Parquet or CSV, plus a removal ledger |
| `tripwire <train> --eval <file>` | Leak check: finds evaluation rows that also appear in the training data |
| `ledger <ledger.csv>` | Summarises what each step removed, and why |
| `signet sign <out> --source <in> --recipe r.json` / `signet verify <manifest> --output <out>` / `signet key` | Signed manifests of the source, steps and output, and verifying them |
| `cairn log` / `cairn verify` / `cairn export -o audit.jsonl` | The activity record. It is hash-chained, so an edited entry fails `verify`. Export is JSON Lines for a SIEM |
| `mark <file> CUI//NOFORN` / `mark default SECRET` / `mark show <file>` / `mark list` | Classification markings (see below) |
| `courier pack <file> …` / `courier approve <bundle>` / `courier verify <bundle>` | Sealed share packages, with an optional two-person release |
| `purge <file>` | Overwrites a file with random data, deletes it, and writes a signed destruction record |
| `depot login` / `list` / `publish` / `request` / `requests` / `approve` / `deny` / `fetch` | Depot, the Data Commons on a QuantETL server |
| `status` | Shows the signing key, the activity record status, and the network status (none) |

### Classification markings

The levels are UNCLASSIFIED, CUI, CONFIDENTIAL, SECRET and TOP SECRET, with caveats after `//` (for example
`CUI//NOFORN`).
- **Banner:** every command that reads a marked file prints the marking as a colour banner.
- **Outputs:** take the highest marking of their inputs, and caveats add up.
- **Manifests and bundles:** record the marking.

Markings are labels for handling; Bulwark does not make a system accredited for classified data.

### Courier: share packages
```
bulwark courier pack corpus.jsonl --recipe recipe.json --license research-only \
  --contributor "Alice Ng, Unit 7" --i-have-the-rights --format parquet --two-person --as alice -o pkg.tar.gz
bulwark courier approve pkg.tar.gz --as bob -o pkg.released.tar.gz      # a second person, a different key
bulwark courier verify pkg.released.tar.gz
```

**Gate checks.** Packing is refused unless all of these pass:
- a license is chosen;
- the contributor confirms, by name, the right to share;
- no personal data is left, in columns or inside text;
- nobody can be singled out from quasi-identifiers (k ≥ 5).

**What the bundle holds:**
- the data;
- `README.md` (the dataset card);
- `LICENSE.txt`;
- `ATTESTATION.md`;
- `privacy_report.json`;
- `checks.json`;
- `removal_ledger.csv`;
- `manifest.json`: the SHA-256 of every file, signed.

**Two-person release.** The bundle isn't RELEASED until a second key approves it, and the same person can't approve
their own package. `verify` fails if any file changed.

### Depot: the Data Commons

The `depot` commands are a client for a QuantETL server, which is not part of this repository.

Depot runs on a QuantETL server: the organisation's own server on a closed network, or a shared hub. The flow:
1. A contributor lists a dataset, either from the console (Provenance → Contribute to Depot) or with
   `bulwark depot publish <released bundle>`. Every listing is a Courier package that passed the gate checks.
2. Others browse the listings and request access, giving a purpose.
3. The owner approves or denies each request.
4. Only approved requesters can download, and `fetch` verifies the package on arrival.

Every step is recorded in the server's activity record.

## Tested (2026-11-17, synthetic test corpus in `test-data/ai`)
- **Recipe run:** 19,600 rows in, 16,915 out, in 7.7 s, identical to the console. It removed 717 low-quality and
  1,968 duplicate documents, and wrote a 2,685-line ledger.
- **Tripwire:** 149 of 500 evaluation rows found in the cleaned data.
- **Signet:** the signature, source and output all verify.
- **Courier gate:** a raw file was refused (no license, no attestation, personal data). The redacted output packed.
- **Two-person release:** approval with the same key was refused; with a second key, the bundle verifies as
  RELEASED. A bundle with one edited file is NOT RELEASED.
- **Cairn:** an edited entry is detected ("Entry 1 was changed after it was written"); restoring it makes the
  chain intact again.
- **Depot:**
  - Contribute from the console: refused without the attestation, listed with it.
  - Requests: a second account requested access through Bulwark, and its download before approval was refused.
  - Approval and download: the owner approved in the console, and the download verified.
  - Publishing from Bulwark: a released Courier bundle published by Bulwark appears in the console with its marking,
    checks and card.

## Not claimed
- An accreditation (ATO), CMMC, FedRAMP or FIPS 140 validation.
- Approval for classified networks.
- That `purge` defeats SSD wear-levelling. On SSDs, keep data on FileVault volumes and destroy the key.

## License

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE). The QuantETL and Bulwark names and logos are trademarks
and are not covered by the license: see [TRADEMARKS.md](TRADEMARKS.md). Report security issues as described in
[SECURITY.md](SECURITY.md).
