# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| latest release | ✅ |
| older releases | ❌ — please upgrade |

## Reporting a vulnerability

Please do **not** open a public issue for security vulnerabilities.

Use GitHub's [private vulnerability reporting](https://github.com/ITGuyVV/CodeCockpit/security/advisories/new) to contact the maintainer directly. Please include:

- A description of the issue and its impact
- Steps to reproduce or a proof of concept
- The affected version(s)

You will get a response within a few days. Once a fix is released, you will be credited in the release notes unless you prefer otherwise.

## Scope notes

CodeCockpit is a desktop tool that spawns local CLI processes. Provider API keys are stored in plain text inside the app data directory — this is documented in the README, matches how the underlying CLIs store their own keys, and is considered documented behavior rather than a vulnerability. Anything that would let a remote attacker execute code or exfiltrate data through the app is in scope.
