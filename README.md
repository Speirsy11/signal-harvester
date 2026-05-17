# Signal Harvester

Reusable data collection service for market, news, and sentiment datasets.

It gives you:

- source adapters for RSS/news now, with market/API adapters designed in
- persisted collection jobs
- versioned collected documents
- simple sentiment scoring
- a clean web UI to inspect jobs/data and start new collection jobs
- API endpoints that trading systems can consume without knowing source details

## Run locally

```bash
cp .env.example .env
pnpm install
pnpm docker:up
```

Open <http://localhost:3010>.

## First job

The app seeds a BTC news job using Google News, Cointelegraph, and CoinDesk RSS feeds. Run it from the UI or API:

```bash
curl -X POST http://localhost:3010/api/jobs/btc-news/run
```

## API

- `GET /api/jobs`
- `POST /api/jobs`
- `POST /api/jobs/:id/run`
- `GET /api/documents?topic=BTC&limit=50`
- `GET /api/sentiment/summary?topic=BTC&windowHours=24`
