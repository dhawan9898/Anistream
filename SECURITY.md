# Security

## Release signing
Every release APK is signed in CI (`.github/scripts/sign-apk.sh`). The signing keys exist only as
repository secrets (`KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `OLD_KEYSTORE_BASE64`,
`OLD_KEYSTORE_PASSWORD`, `OLD_KEY_ALIAS`, `LINEAGE_BASE64`); no key, keystore or password is kept in the
repository, and none may ever be committed. `.gitignore` blocks `*.jks`, `*.p12` and `*.keystore`.

The app's original signing key was committed to this repository early on and is therefore public. It
has been rotated: releases are now signed with a new key, and the old key stays in the signing chain only
so existing installs keep updating (Android 12 and older cannot see the new key). On Android 13 and later
the chain forbids going back to the old key. Retire the old key entirely by dropping the `OLD_*` secrets
and the lineage once old phones no longer matter.

Keep an offline copy of the new keystore: a repository secret cannot be read back, and a lost key means
nobody can update the app in place again.

## Reporting a problem
Open a private security advisory on GitHub (Security tab) rather than a public issue.
