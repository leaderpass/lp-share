# LP Share

The public app clients open LeaderPass share links in (`share.leaderpass.com`; formerly the Link Hub at `links.leaderpass.com`).

**LPOS is the source of truth.** Staff make shares in LPOS; LPOS pushes each share here and pulls client comments back. This app never calls LPOS. Videos play from Cloudflare Stream; downloads come from R2.

Full design: [`../docs/share-app-spec.md`](../docs/share-app-spec.md).

## Routes

| route | what |
|---|---|
| `/s/{token}` | a share: library, player, comments, transcript, downloads (as the share's switches allow) |
| `/v/{videoToken}` | one video, playback only (needs the share's Reshare on) |
| `/` | signed-in home: every share addressed to your email |
| `/h/{hubId}` | legacy Link Hub URL → redirects to the converted share |
| `/staff/start` · `/api/staff/callback` | staff pass via LPOS ("bounce through LPOS") |
| `/api/lpos/*` | LPOS only (`x-lpos-token`): push shares + comments, pull client comment changes |

## Run it

```bash
cp .env.example .env.local   # then edit
npm install
npm run dev                  # http://localhost:4310
```

## Branches

- `main` — the live Link Hub (links.leaderpass.com). Don't deploy share work here until cutover.
- `share` — LP Share, deployed as its own Railway service at share.leaderpass.com.
