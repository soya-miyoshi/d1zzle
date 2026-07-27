# Releasing

Two packages, published in lockstep from one GitHub Release:

| package | directory | notes |
| --- | --- | --- |
| `d1zzle` | `.` | the library |
| `d1zzle-kit` | `kit/` | CLI; peer-depends on `d1zzle` |

They always share a version, and `d1zzle-kit`'s peer range is always `^<that
version>`. `.github/workflows/release.yml` refuses to publish if the tag and the two
`package.json` versions disagree — npm has no unpublish story worth relying on, so the
check runs before anything ships.

Authentication is npm **trusted publishing** (OIDC). There is no `NPM_TOKEN` and no secret
to rotate. Provenance attestations are generated automatically; do not add `--provenance`,
npm adds it for OIDC publishes itself.

## One-time setup

### 1. Push the repo

The repository has no commits and no remote yet, so nothing can run:

```bash
git add .
git commit -m "Initial commit"
gh repo create d1zzle --public --source=. --remote=origin --push
```

CI (`.github/workflows/ci.yml`) runs on every push and PR from that point on.

### 2. Bootstrap each package with a manual publish

npm attaches a trusted publisher to a package that **already exists**, so the first publish
of each name is done by hand. Both names were unclaimed as of 2026-07-27; that is worth
re-checking before you rely on it.

```bash
npm login
npm run check          # typecheck → build → test → kit typecheck → kit build

npm publish                      # d1zzle
cd kit && npm publish && cd ..   # d1zzle-kit — publish AFTER d1zzle
```

> `npm pack`/`publish` select the package by **working directory**. `--prefix kit` reads
> the root `package.json` and would publish `d1zzle` twice — use `cd kit`.

Order matters: `d1zzle-kit` peer-depends on `d1zzle`, so the dependency should be resolvable
before the dependent lands.

### 3. Configure the trusted publisher

On npmjs.com, for **each** package:

> Package → Settings → Trusted Publisher → GitHub Actions
> - Organization / repository: `<owner>/d1zzle`
> - Workflow filename: `release.yml`
> - Environment: *(leave empty)*

After this, every later release is automated and no token is involved.

## Cutting a release

```bash
npm run version:set 0.2.0   # both package.json files + kit's peer range
npm run check               # the same gate CI runs
git commit -am "Release 0.2.0"
git push
```

Then draft a GitHub Release with the tag `v0.2.0` (note the `v`; the workflow strips it) and
publish it. That fires `release.yml`, which:

1. upgrades npm — Node 22 ships npm 10.x, and trusted publishing needs ≥ 11.5.1;
2. checks the tag matches both versions and that the peer range admits them;
3. runs the full gate: typecheck → build → unit + workerd tests → kit typecheck → kit build;
4. prints both tarball manifests;
5. publishes `d1zzle`, then `d1zzle-kit`.

Publishes use `--ignore-scripts` because step 3 already ran the gate and built both
packages. Without it, `prepublishOnly` would run the entire test suite again per package,
and the kit's would rebuild against a `dist/` it does not own.

## Testing the pipeline without publishing

Actions → Release → **Run workflow**, leaving `dry_run` checked (the default). Everything
runs except the two publish steps. Uncheck it to publish from a manual run.

## If a release goes wrong

npm allows unpublishing only within 72 hours, and the version number is burned either way.
The recovery is to publish a patch, not to unpublish:

```bash
npm run version:set 0.2.1
```

If a bad version is already on the registry and should not be installed, deprecate it rather
than remove it — removal breaks anyone who already resolved it:

```bash
npm deprecate d1zzle@0.2.0 "Broken build; use 0.2.1"
```
