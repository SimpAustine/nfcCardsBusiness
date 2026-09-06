# NFC Review Card

A simple GitHub-ready NFC Google Review Card system.

## Features

- Register NFC card IDs to businesses
- Store each business's Google review URL
- Public `/c/:cardId` redirect endpoint
- Scan/tap analytics
- Admin dashboard
- QR code generation in the browser
- SQLite for local development
- Environment variables for the admin key

## Important deployment note

This starter uses SQLite. Do **not** use SQLite on Render Free for permanent production data because Render's free web-service filesystem is ephemeral. For a real deployment, replace SQLite with a persistent hosted database such as Postgres.

## Local setup

```bash
npm install
cp .env.example .env
npm start
```

Open:

- http://localhost:3000
- http://localhost:3000/admin

Default admin key from `.env.example` is only a placeholder. Change it.

## Register a card

1. Open `/admin`.
2. Enter the admin key.
3. Add a business.
4. Enter the Google review URL supplied by the business.
5. Enter a unique NFC card ID.
6. Save.
7. Write `https://YOUR-DOMAIN/c/CARD-ID` to the NFC tag as an NDEF URL.

## Google review URL

Use the business's genuine Google review-request link. Do not gate customers based on whether they appear likely to leave a positive review.

## Deploy

Push the repository to GitHub and create a Render Web Service. Use:

Build command:
```text
npm install
```

Start command:
```text
npm start
```

Set `ADMIN_KEY` and `BASE_URL` as environment variables.

For persistent production data, migrate the database from SQLite to Postgres before relying on it for customer data.
