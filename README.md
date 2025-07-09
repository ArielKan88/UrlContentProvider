# URL Content Provider

A production-ready NestJS microservice system for scalable URL content scraping with comprehensive HTTP error handling, intelligent retry mechanisms, and redirect-aware duplicate detection.

## Architecture

**Two Independent Services:**
- **API Service** - NestJS REST API with MongoDB storage and RabbitMQ messaging
- **Scraper Service** - NestJS Puppeteer-based web scraper with error handling

**No shared packages** - eliminates npm workspace complexity and deployment dependencies.

## Quick Start

```bash
# Start all services
docker-compose up -d

# Services available at:
# API: http://localhost:3000
# Swagger: http://localhost:3000/api/docs
# RabbitMQ: http://localhost:15672 (admin/admin123)
```

## Design Principles

### Efficiency Optimizations

**URL Normalization:**
- `ynet.co.il`, `https://ynet.co.il`, `http://www.ynet.co.il/` treated as identical
- Canonical URL storage (`https://` prefix, no `www`, no trailing slash)
- Prevents duplicate scraping of same content

**Redirect-Aware Duplicate Detection:**
- If `ynet.co.il` redirects to `www.ynet.co.il`, requesting `www.ynet.co.il` directly is skipped
- MongoDB index on `redirectChain` array for efficient queries
- Reduces unnecessary scraping of already-reached content

**Database Indexes:**
- Composite indexes on `(url, status)` and `(httpStatus, status)`
- Time-based index on `fetchedAt` for efficient recent queries
- Redirect chain index for fast redirect duplicate detection

### Concurrency Control:**
- RabbitMQ with `prefetch(1)` for load balancing across scrapers
- Configurable concurrent scrapers (default: 3)
- Multiple scraper instances via Docker replicas

**Performance Optimizations:**
- **Fast wait strategy**: `domcontentloaded` instead of slow `networkidle2`
- **Reduced timeout**: 15 seconds instead of 60 seconds
- **Optional image blocking**: Skip images for 3-5x faster loading
- **Flexible wait strategies**: Choose speed vs completeness trade-off
- **Performance logging**: Track navigation and content extraction times

### Retry Mechanism

**Smart Error Classification:**

```
// Retryable (up to MAX_RETRIES=3)
- net::ERR_CONNECTION_REFUSED (server temporarily down)
- net::ERR_CONNECTION_TIMED_OUT
- HTTP 5xx server errors (500, 502, 503, 504)
- HTTP 429 (Too Many Requests)

// Non-Retryable (fail immediately)  
- net::ERR_NAME_NOT_RESOLVED (DNS failure)
- net::ERR_CERT_* (SSL certificate errors)
- HTTP 4xx client errors (400, 401, 403, 404)
```

**Retry Flow:**
1. `PENDING` → `PROCESSING` → failure → `PENDING` (retryCount++)
2. Continue until `retryCount >= MAX_RETRIES` 
3. Final state: `FAILED` with reason

### Database Considerations

**Data Consistency Rules:**
- `SUCCESS`: Has content, NO errorMessage
- `FAILED`: Has errorMessage, NO content
- `PENDING`: Clean state, may have retry context
- `PROCESSING`: Temporary state during scraping

**Storage Efficiency:**
- Content compression via contentHash (SHA256)
- Removed unused fields (`isArchived` eliminated)
- TTL on RabbitMQ messages (1 hour) prevents accumulation

## API Reference

### Submit URLs for Scraping
```bash
POST /api/url-content
Content-Type: application/json

{
  "urls": ["https://example.com", "https://news.ycombinator.com"]
}
```

**Response:**
```json
{
  "submitted": ["https://example.com"],
  "skipped": [
    {
      "url": "https://news.ycombinator.com",
      "reason": "Successfully scraped within 60 minutes",
      "lastScrapedAt": "2025-07-09T19:30:00.000Z",
      "nextAvailableAt": "2025-07-09T20:30:00.000Z"
    }
  ],
  "queued": ["686ec1e200c2137ab7d5c276"]
}
```

### Get All Results
```bash
GET /api/url-content?limit=10&offset=0
```

**Response:**
```json
[
  {
    "_id": "686ec1e200c2137ab7d5c276",
    "url": "https://example.com",
    "status": "SUCCESS",
    "content": "<!DOCTYPE html>...",
    "contentType": "text/html",
    "httpStatus": 200,
    "finalUrl": "https://www.example.com/",
    "responseTime": 1247,
    "contentLength": 15632,
    "contentHash": "a1b2c3d4e5f6...",
    "userAgent": "Mozilla/5.0...",
    "redirectChain": ["https://example.com/", "https://www.example.com/"],
    "retryCount": 0,
    "fetchedAt": "2025-07-09T19:35:15.123Z",
    "createdAt": "2025-07-09T19:35:10.456Z",
    "updatedAt": "2025-07-09T19:35:15.123Z"
  }
]
```

### Get URL History
```bash
GET /api/url-content/by-url?url=https://example.com
```

**Response:**
```json
{
  "url": "https://example.com",
  "totalScrapes": 3,
  "scrapes": [
    {
      "id": "686ec1e200c2137ab7d5c276",
      "status": "SUCCESS",
      "scrapedAt": "2025-07-09T19:35:15.123Z",
      "httpStatus": 200,
      "contentLength": 15632
    }
  ]
}
```

### Get Latest Successful Result
```bash
GET /api/url-content/latest?url=https://example.com
```

### Get Specific Result
```bash
GET /api/url-content/686ec1e200c2137ab7d5c276
```

## Status Enum Values

Here's how the scraping lifecycle works through different statuses:

**PENDING** - Your URL is queued up and waiting for a scraper to pick it up. This is the starting point for every request. From here, it can move to `PROCESSING` when a worker grabs it, or jump straight to `FAILED` if something goes wrong early on.

**PROCESSING** - A scraper is actively working on your URL right now - loading the page, waiting for JavaScript, capturing content. This is the "in progress" state. After processing, it'll end up as `SUCCESS` if everything worked, `FAILED` if it couldn't be scraped, or back to `PENDING` if we need to retry it.

**SUCCESS** - We got your content! This is the final happy state where your URL has been successfully scraped and the content is stored. Once here, it stays here (unless you explicitly re-scrape it later).

**FAILED** - Couldn't scrape it after trying up to 3 times. This is the final "gave up" state for URLs that consistently fail due to network issues, 404s, timeouts, or other problems we can't work around.

## Redirect Handling

**Redirect Chain Tracking:**
- All redirects captured in `redirectChain` array
- Final URL stored in `finalUrl` field
- Original requested URL preserved in `url` field

**Smart Duplicate Detection:**
```bash
# Scenario: ynet.co.il → www.ynet.co.il
POST /api/url-content {"urls": ["ynet.co.il"]}
# Result: SUCCESS with redirectChain: ["ynet.co.il/", "www.ynet.co.il/"]

POST /api/url-content {"urls": ["www.ynet.co.il"]} 
# Result: SKIPPED "Already scraped via redirect"
```

**Performance:** MongoDB index on `redirectChain` enables efficient O(log n) lookups.

## Edge Cases Handled

### URL Normalization Edge Cases
- **Protocol variations**: `http://` vs `https://` → normalized to `https://`
- **Subdomain variations**: `www.` vs no `www.` → normalized without `www.`
- **Trailing slashes**: `example.com/` vs `example.com` → normalized without slash
- **Hostname case**: `Example.COM` → normalized to lowercase hostname only
- **Path case sensitivity**: `/User/Profile` vs `/user/profile` → preserved as-is (case-sensitive)
- **Query case sensitivity**: `?userId=ABC123` → preserved as-is (case-sensitive)
- **URL shorteners**: `shorturl.at/HD3G9` vs `shorturl.at/hd3g9` → treated as different URLs

### Retry Edge Cases
- **Network flaps**: Connection refused marked as retryable (temporary)
- **DNS issues**: Name resolution failures marked non-retryable (permanent)
- **Rate limiting**: HTTP 429 marked retryable with backoff
- **SSL problems**: Certificate errors marked non-retryable

### Data Consistency Edge Cases
- **Interrupted processing**: Stale PENDING requests cleaned up after 2 hours
- **Mixed success/error states**: Automatic consistency repair via `/fix-inconsistencies`
- **Redirect loops**: Puppeteer timeout prevents infinite redirects
- **Large content**: Configurable timeout prevents memory exhaustion

### Browser Edge Cases
- **JavaScript-heavy sites**: `networkidle2` wait condition
- **Anti-bot detection**: Realistic Chrome user agent rotation
- **Memory leaks**: Page cleanup in `finally` blocks
- **Crash recovery**: Browser reinitialization on errors

## Configuration

### Environment Variables
```bash
# API Service
MONGODB_URL=mongodb://localhost:27017/url_content_provider
RABBITMQ_URL=amqp://admin:admin123@localhost:5672
SCRAPE_INTERVAL_MINUTES=60  # Minimum time between same URL scrapes
MAX_RETRIES=3               # Maximum retry attempts

# Scraper Service  
CONCURRENT_SCRAPERS=3       # Parallel workers
PUPPETEER_TIMEOUT=15000     # Per-page timeout (ms) - reduced from 60s
MAX_RETRIES=3               # Maximum retry attempts

# Performance Tuning
WAIT_STRATEGY=fast          # Options: fast, basic, moderate, comprehensive
DISABLE_IMAGES=true         # Skip images for faster loading (3-5x speedup)
DISABLE_CSS=false           # Keep CSS for layout accuracy
DYNAMIC_WAIT_MS=0           # Additional wait for dynamic content
```

### Performance Strategies

| Strategy | Speed | Completeness | Use Case |
|----------|-------|--------------|----------|
| `fast` | ⚡⚡⚡ | Basic | News sites, blogs, simple content |
| `basic` | ⚡⚡ | Good | Most websites, e-commerce |
| `moderate` | ⚡ | Better | Heavy JavaScript sites |
| `comprehensive` | 🐌 | Best | Complex SPAs, dynamic content |

### Scaling Configuration
```yaml
# docker-compose.yml
scraper:
  deploy:
    replicas: 2           # Multiple scraper instances
  environment:
    CONCURRENT_SCRAPERS: 5  # More workers per instance
```

## Monitoring

### Health Checks
```bash
# API health
curl http://localhost:3000/api/url-content

# RabbitMQ management
curl -u admin:admin123 http://localhost:15672/api/queues
```

### Logs
```bash
# Real-time monitoring
docker-compose logs -f api scraper

# Retry monitoring
docker-compose logs api | grep "🔄 Retrying"
```

### Queue Status
```bash
# Check queue depths
curl -u admin:admin123 http://localhost:15672/api/queues | \
  jq '.[] | select(.name | startswith("scrape")) | {name, messages, consumers}'
```

## Performance Characteristics

- **Throughput**: ~100-300 URLs/minute per scraper instance (with fast strategy)
- **Latency**: 
  - Fast strategy: 1-3 seconds per page
  - Basic strategy: 2-5 seconds per page  
  - Comprehensive strategy: 5-15 seconds per page
- **Memory**: ~200MB per scraper instance
- **Storage**: ~10-50KB per scraped page (content dependent)
- **Duplicate detection**: O(log n) via MongoDB indexes

### Performance Tuning

**For Maximum Speed:**
```bash
WAIT_STRATEGY=fast
DISABLE_IMAGES=true
PUPPETEER_TIMEOUT=10000
CONCURRENT_SCRAPERS=5
```

**For Maximum Accuracy:**
```bash
WAIT_STRATEGY=comprehensive
DISABLE_IMAGES=false
PUPPETEER_TIMEOUT=30000
DYNAMIC_WAIT_MS=2000
```

## Development

### Local Development
```bash
# Start services
docker-compose up -d

# API development
cd api && npm run dev

# Scraper development  
cd scraper && npm run dev
```

### Testing
```bash
# Test retry mechanism
chmod +x test-retry-mechanism.sh && ./test-retry-mechanism.sh

# Test data consistency
chmod +x test-data-consistency.sh && ./test-data-consistency.sh

# Test URL normalization
chmod +x debug-fixes.sh && ./debug-fixes.sh
```

### Production Deployment
1. Configure environment variables
2. Scale scraper replicas based on load
3. Monitor queue depths and processing times
4. Set up log aggregation and alerting
5. Regular database maintenance for optimal performance