# Website Prototype Tool

Desktop-only private tool. No login for now. Capture pipeline ready for Cloudflare Pages + R2 + GitHub Actions.

## Current state
- Desktop only. A phone shows a message and the app stays closed.
- No sign-in. Jobs stay on this computer.
- Paste a link in the chat, confirm rights, then preview, edit, download, or host a link.
- Capture script, Worker, Functions, and workflow are structured and ready

## Run it locally
```
npm install
npx playwright install chromium --prefix capture
npm start
```
Open http://127.0.0.1:8787 on a computer. There is no login. Captures run on this machine. If `GITHUB_TOKEN` and `GITHUB_REPO` are set, jobs are dispatched to GitHub Actions instead.

## To deploy captures to Cloudflare
1. Push this repo to GitHub.
2. Deploy `/app` + `/functions` to Cloudflare Pages.
3. Deploy `/worker-preview` as a Worker with R2 + KV bindings.
4. Add the secrets from `.env` to Cloudflare Pages and the Worker.
5. Create a fine-grained GitHub token that can dispatch the capture workflow.
