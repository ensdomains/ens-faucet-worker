# ens-faucet-worker

Testnet faucet cloudflaire worker for ENS testnet users

## Dev setup

- `gh repo clone ensdomains/ens-faucet-worker`
- `touch .dev.vars`
- Add ENS_GRAPH_URI
- `pnpm install`
- `yarn start`

## Deployment

```
wrangler secret put ENS_GRAPH_URI
yarn deploy
```