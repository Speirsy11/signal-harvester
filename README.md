# Data Harvester / Signal Harvester

Reusable data collection service for market, news, sentiment, and future signal datasets.

The original `signal-harvester` slice is now one collector type: RSS/news sentiment. Financial market data is another collector type, configured through the same jobs UI/API.

It gives you:

- pluggable source adapters: RSS/news sentiment and financial APIs today
- persisted collection jobs
- local provider credential storage with masked secrets in the UI/API responses
- versioned collected documents for news/sentiment data
- OHLCV-style market data storage for financial datasets, including derived higher-timeframe candles
- a clean web UI to add API keys, create jobs, inspect data, and run jobs
- API endpoints that trading systems can consume without knowing source details

## Run locally

```bash
cp .env.example .env
pnpm install
pnpm docker:up
```

Open <http://localhost:3010>.

## Collector types

### RSS/news sentiment

The app seeds a BTC news job using Google News, Cointelegraph, and CoinDesk RSS feeds. Run it from the UI or API:

```bash
curl -X POST http://localhost:3010/api/jobs/btc-news/run
```

### Financial market data

Use the **Provider setup** tab to add API credentials, then use **Market data** to create a financial collection job.

Supported now:

- `alpha-vantage` — requires an API key saved as a credential, default id `alpha-vantage`
- `binance` — public kline/OHLCV collection works without a key

Signal Harvester collects `1m` candles as source data, then derives closed higher-timeframe candles as new complete buckets become available: `5m`, `15m`, `1h`, `4h`, `1d`, `1W`, and `1M`. For example, when the first candle of a new hour arrives, the previous hour is rolled up from its 60 complete `1m` candles.

To bootstrap recent derived candles from `1m` data already stored before rollups were enabled:

```bash
curl -X POST http://localhost:3010/api/market-data/rollups/run \
  -H 'content-type: application/json' \
  -d '{"lookbackDays":45}'
```

For Binance `1m` jobs, the app also runs a throttled historical backfill loop. Live jobs keep the newest minute current, while backfill batches walk from Binance's first available 1m candle toward now. Tune it with:

- `MARKET_BACKFILL_ENABLED=0` to disable the loop.
- `MARKET_BACKFILL_INTERVAL_MS=300000` to control how often a batch runs; default is 5 minutes.
- `MARKET_BACKFILL_BATCH_SIZE=1000` to control candles per symbol per batch; max is Binance's 1000 kline limit.

Example API flow:

```bash
# Save an Alpha Vantage API key locally. Responses only expose masked secrets.
curl -X POST http://localhost:3010/api/credentials \
  -H 'content-type: application/json' \
  -d '{
    "id": "alpha-vantage",
    "provider": "alpha-vantage",
    "label": "Alpha Vantage",
    "apiKey": "YOUR_KEY"
  }'

# Create a BTC/USD 1m financial data job.
curl -X POST http://localhost:3010/api/financial-jobs \
  -H 'content-type: application/json' \
  -d '{
    "id": "btc-alpha-vantage-1m",
    "name": "BTC/USD 1m market data",
    "topic": "BTC",
    "provider": "alpha-vantage",
    "credentialId": "alpha-vantage",
    "symbols": ["BTCUSD"],
    "interval": "1m"
  }'

# Run it.
curl -X POST http://localhost:3010/api/jobs/btc-alpha-vantage-1m/run
```

## API

- `GET /api/jobs`
- `POST /api/jobs`
- `POST /api/jobs/:id/run`
- `GET /api/credentials`
- `POST /api/credentials`
- `POST /api/financial-jobs`
- `GET /api/documents?topic=BTC&limit=50`
- `GET /api/market-data?symbol=BTCUSD&interval=1m&limit=100`
- `GET /api/market-data?symbol=BTCUSD&interval=1h&limit=100`
- `GET /api/market-data/summary`
- `GET /api/market-data/coverage`
- `GET /api/market-data/backfills`
- `POST /api/market-data/backfills/run`
- `POST /api/market-data/rollups/run`
- `GET /api/sentiment/summary?topic=BTC&windowHours=24`
- `GET /api/context/events?topic=BTC`

## Notes on secrets

Provider keys are intended for a local/self-hosted instance. They are stored in Postgres so the service can run jobs without editing environment variables. API/UI reads return masked values only; do not commit `.env` or database dumps containing real credentials.
