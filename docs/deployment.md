# Deployment & Identity

## Stages

1. **Local** — `npm run dev`. Vite on :5173. Data served from `public/data/`.
2. **GitHub Pages** — push to `main`, Actions builds and deploys. Free, HTTPS, fine for a data-only static site.
3. **Custom domain** — point DNS at Pages, or move to Cloudflare Pages / Netlify.

`vite.config.ts` reads `base` from an env var so the same build works under a Pages project subpath (`/DataMap/`) and at a bare domain (`/`).

## Payload budget

GitHub Pages soft-limits repos to ~1 GB and recommends sites under 1 GB, with a 100 MB per-file hard cap. The whole Columbus dataset is a few MB, so this is not close to binding — but note that **committed data files accumulate history**. If metric JSON is regenerated on a schedule, every version stays in the git history forever. Two mitigations, if it ever matters:

- Regenerate data only when a new ACS vintage lands (once a year), not on a timer.
- Or build data in CI and deploy it as an artifact without committing it. Costs reproducibility; not worth it yet.

## Keeping identity separate

The Census key is a build-time secret and never ships — that part is handled by architecture. The identity exposure is different and worth setting up correctly **before the first push**, because git history is very hard to scrub later.

**1. Commit email.** Git commits embed an email address that is permanently public. Turn on GitHub's *Settings → Emails → Keep my email address private*, then:

```bash
git config user.email "<id>+<username>@users.noreply.github.com"
```

Set this **per-repo before the first commit**. Verify with `git log --format='%ae'` after committing — rewriting later means rewriting every commit.

**2. Account.** The repo owner's profile is public. If the project name should not link back to a personal profile, create a separate GitHub account (or a free organization) to own it. Deciding this before the first push avoids a migration.

**3. Domain WHOIS.** Registration data is published by default. Use a registrar with free permanent WHOIS privacy — Cloudflare Registrar and Porkbun both include it at no cost. Some TLDs (notably `.us`) **forbid WHOIS privacy** — avoid `.us` for this.

**4. Hosting origin.** GitHub Pages with a custom domain still requires a public repo on the free tier, and the repo is discoverable. Cloudflare Pages fronts the origin and lets the repo stay private — a reasonable step at the point where the site is shared broadly.

**5. Analytics.** If any are added, prefer a privacy-preserving option (Cloudflare Web Analytics, Plausible) — no cookie banner required, which also keeps the UI clean.

## GitHub Actions secret

Store the key at *Settings → Secrets and variables → Actions → New repository secret*, named `CENSUS_API_KEY`. It is only needed by the data-refresh workflow, not by the deploy build (which consumes already-committed JSON).
