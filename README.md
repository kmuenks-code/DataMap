# DataMap — Columbus Area Explorer

An interactive map of the greater Columbus, OH area. Pick a metric — median household
income, poverty rate, home value — and every area is colored by how it compares to the
metro. Scrub the timeline to watch each area's position change relative to the metro
average over 2009–2023.

Data: US Census American Community Survey (5-year estimates) + TIGER/Line boundaries.

## Quick start

```bash
npm install
cp .env.example .env      # add a Census key (required, free, instant):
                          #   https://api.census.gov/data/key_signup.html
npm run etl:columbus      # build the data (one time; cached afterwards)
npm run dev
```

The Census key is only needed to *build* data. Running the site itself needs no key —
it reads static JSON committed under `public/data/`.

## How it works

All external API access happens at build time in `etl/`. The browser fetches only static
files from its own origin. That keeps the API key off the client, keeps runtime API usage
at exactly zero, and means the whole thing deploys to any static host.

See `CLAUDE.md` for architecture and `docs/` for data-source details, geography caveats,
and deployment notes.

## License

Code: MIT. Census data is public domain (cite the US Census Bureau).
