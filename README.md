# SZH Mail

SZH Mail is a polished temporary email application designed for Vercel. The frontend is served by Vercel and serverless API functions handle the mailbox session.

## Stack

- Plain HTML, CSS and JavaScript frontend
- Vercel Node.js Functions under `api/`
- Mail.gw for temporary mailbox delivery
- Encrypted, HTTP-only session cookie
- No database required for the current one-hour mailbox session

## Features

- Temporary mailbox generation
- Copyable email address
- Server-side mailbox session
- HTTP-only encrypted session cookie
- One-hour SZH Mail session timer
- Automatic inbox polling
- Sender, subject, preview, timestamp and unread state
- Full email reader
- Sandboxed HTML email rendering
- Attachment links
- Refresh and discard controls
- Responsive mobile layout
- Health endpoint at `/api/health`
- No API credentials shipped to the browser

## Vercel setup

1. Import this repository into Vercel.
2. Set the project framework to the default or Other. No build command is required.
3. Add an environment variable named `SZH_SESSION_SECRET`.
4. Set `SZH_SESSION_SECRET` to a long random value of at least 32 characters.
5. Deploy.
6. Open `/api/health` on the deployed site and confirm it returns JSON with `ok: true`.

For local development, copy `.env.example` to `.env.local` and set `SZH_SESSION_SECRET`, then run `npm run dev`.

## API architecture

The browser no longer calls Mail.gw directly. It calls the Vercel functions in `api/`. The server functions create the Mail.gw account, obtain the Mail.gw bearer token, encrypt the mailbox session, and store that encrypted session in an HTTP-only cookie. Mailbox and message requests are then handled by the server function using the stored credentials.

The browser never receives the Mail.gw bearer token or the Mail.gw account password.

## Important provider policy

Mail.gw currently documents that its API is free, needs no API key, has an 8 QPS general limit, requires visible attribution, and does not permit API proxy services. This Vercel server-side architecture therefore needs to be reviewed against Mail.gw's current terms before public production use. If Mail.gw does not permit this architecture, switch to a temporary-email provider that explicitly permits server-side proxying before publishing the service.

## Mailbox lifetime

Mail.gw exposes the account creation time but not a public mailbox expiration timestamp. SZH Mail therefore uses a one-hour application session lifetime and stores the expiration timestamp in the encrypted session cookie. The timer does not claim to be Mail.gw's own retention deadline.

## Security

Email HTML is sanitized before being placed inside a sandboxed iframe. Dangerous URL schemes, scripts, forms, embedded documents and event-handler attributes are removed. Disposable email should not be used for passwords, financial information, private documents, or other sensitive data.

## Deployment notes

This project intentionally does not include a GitHub Pages workflow. Vercel is the deployment target because the project now uses serverless functions.

## Attribution

Mail.gw requires projects using its API to link back to Mail.gw. SZH Mail includes a visible Mail.gw attribution link in the interface.


## NowTempMail setup

SZH Mail uses the NowTempMail server-side Developer API. Create a free API key from the NowTempMail developer dashboard and add it to Vercel as `NTM_API_KEY` in the Production environment. Keep the key server-side and never put it in frontend JavaScript.

The current free developer tier provides 50 mailboxes per day and 30 API requests per minute. SZH Mail keeps its own one-hour browser session lifetime even though the provider mailbox can live longer.
