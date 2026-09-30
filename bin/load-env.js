// Loads `.env` from the working directory into `process.env` as an `--import`
// preload, for the one script that cannot use `node --env-file=.env`: `dev:api`
// (issue #1051).
//
// Under `--watch`, Node also watches the file `--env-file` names, and on macOS it
// does that by recursively watching the file's *directory* — the checkout root.
// With `--watch-path` in play nothing filters those events, so `--watch-path=./src`
// did not narrow anything: `git status` rewriting `.git/index`, an editor saving a
// doc, or `npm install` restarted the API, failing every dashboard request in
// flight. `--env-file-if-exists` behaves the same. Loading the file here instead
// gives the process the same variables without handing the watcher a path.
//
// `process.loadEnvFile` has `--env-file`'s semantics: a variable already set in
// the environment wins, and a missing `.env` is a startup error rather than a
// silently unconfigured server.
process.loadEnvFile('.env');
