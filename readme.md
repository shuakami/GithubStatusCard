# GitHub Stats Card with Xiaohei

Added **LuoXiaohei (罗小黑)** character peeking from the top-left corner of the stats card.

![GitHub Stats](https://githubstatus.sdjz.wiki/api?username=Shuakami&border_radius=12&commits_year=2025&rank_icon=github&ring_color=9b59b6)

![GitHub Stats](https://githubstatus.sdjz.wiki/api?username=Shuakami&border_radius=12&commits_year=2025&rank_icon=github&ring_color=9b59b6&theme=dark)


## Quick Start

```bash
npm install
node express.js
```

Visit: `http://localhost:9000/api/?username=YOUR_USERNAME`

## Deploy

Add `PAT_1` environment variable with your GitHub token on Vercel.

Optional: add `DATABASE_URL` (Neon Postgres connection string) to enable a persistent stats cache — past-year stats are cached for 30 days, current data refreshes every 6 hours, and stale data is served for up to 24 hours when GitHub requests fail. Without it, the card works exactly as before.

> Fork from [anuraghazra/github-readme-stats](https://github.com/anuraghazra/github-readme-stats)
