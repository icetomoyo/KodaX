# Client Integrations

`clients/` now keeps only one Phase 1 third-party host integration surface:

- [repointel/README.md](./repointel/README.md)

That folder contains:
- the installable skill directory
- the install script
- the demo script
- the doctor script

We intentionally keep those files together because they all belong to the same external-host integration unit.

The premium engine itself still lives in the companion `KodaX-private` repository (not publicly published).
