# iOS landing template

Copy this folder into a Significant Hobbies iOS repo as `site/`. It is
Indulge’s page set and story shape, with tokens and copy filled from one
config file.

```bash
cp -R foundry/ops/templates/ios-landing /path/to/app/site
cd /path/to/app/site
# edit src/site.config.ts
# add public/images/screens/*.jpg and a mark/favicon
pnpm install
pnpm check
```

Do not import this template at runtime. The product repo must own its
copy so it stays independently buildable.

## Fill in

1. `src/site.config.ts` — name, tokens, copy, legal, required-check fragments
2. `astro.config.mjs` — `site` URL
3. `public/images/screens/` — real iPhone captures
4. `public/favicon-32.png` and `favicon-64.png`
5. `PUBLIC_TESTFLIGHT_URL` only when it is a real `https://testflight.apple.com/` link
6. `appStoreUrl` / `appStoreId` only for a live `https://apps.apple.com/` product

## Apple marketing rules

- Privacy and support URLs are first-class pages. App Store listings need both.
- Never invent an App Store badge. The template loads Apple’s official badge
  only when `availability` is `app-store` and `appStoreUrl` is on
  `apps.apple.com`.
- Never claim “Available on the App Store” or emit a Smart App Banner until
  that ID exists.
- Do not use icons or product shots from apple.com.
- Screenshots must be the real app, not mocked marketing UI.
- TestFlight links must be `https://testflight.apple.com/…`.

## Routes

`/`, `/privacy/`, `/support/`, `/terms/`, `/accessibility/`,
`/testflight/`, `/index.md`, `/llms.txt`, `/api/ai`, `/robots.txt`,
`/sitemap.xml`.
