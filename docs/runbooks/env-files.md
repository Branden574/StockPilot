# Local env files live OUTSIDE the repo

As of 2026-06-26 the real local-dev secret env files were moved **out of the git
working tree** to keep secrets off-disk-inside-the-repo. They live at:

```
~/Developer/stockpilot-env/
  apps/web/.env.local
  apps/web/.env.local.prod
  apps/mobile/.env.local
```

and are **symlinked back** into their original repo paths, so `next dev` /
`expo start` load them transparently. The symlinks match `.gitignore` (`.env*`),
so nothing secret enters git. Full details + restore/revert commands are in
`~/Developer/stockpilot-env/README.md`.

Production secrets are NOT here — they live in **Vercel** (web) and
**EAS secrets / eas.json** (mobile). These files are local-dev only.

## On a fresh clone

The symlinks won't exist on a new clone. Recreate them (assuming the
`stockpilot-env` dir is present on the machine):

```bash
EXT="$HOME/Developer/stockpilot-env"; REPO="$HOME/Developer/InventorySystem"
for rel in apps/web/.env.local apps/web/.env.local.prod apps/mobile/.env.local; do
  ln -sf "$EXT/$rel" "$REPO/$rel"
done
```
