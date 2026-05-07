# Browser Terminal E2E

This is the ctxparty version of Aiterator's WTerm/Agent Browser harness. It is
simpler because ctxparty is already a Node CLI: the PTY spawns
`node src/cli.js` directly instead of building a Go binary first.

Install once:

```bash
cd e2e/browser-terminal
npm install
npx agent-browser install
```

Run the Ctrl+C terminal regressions:

```bash
set CTXPARTY_E2E_BROWSER=1
set AGENT_BROWSER_HEADED=0
npm run e2e:browser
```

Artifacts are written to `e2e/browser-terminal/artifacts/`.
