# Deploying the relay to Render

The game client speaks `wss://` natively (Windows Schannel, see
`src/net/TlsClient.h`), so Render's forced-HTTPS edge is not a problem.
Total setup time: about 5 minutes.

## One-time setup

1. Push this project to a GitHub/GitLab repo (only `relay/` matters to Render).

2. Go to https://dashboard.render.com -> **New +** -> **Web Service**.

3. Connect your Git provider and pick the repo.

4. Fill in the service settings:
   - **Name:** anything, e.g. `femfx-relay` (this becomes your URL)
   - **Language:** Node
   - **Region:** closest to you and your friend
   - **Branch:** main (or whatever you pushed)
   - **Root Directory:** `relay`
   - **Build Command:** leave empty (there is nothing to build -- zero deps)
   - **Start Command:** `node relay.js`
   - **Instance Type:** Free is fine for trying it; a paid tier avoids the
     idle spin-down described below.

5. Click **Create Web Service**. First deploy takes ~1 minute.

## Connecting from the game

Your relay URL is:

    wss://<your-service-name>.onrender.com

(no port number -- TLS runs on 443 behind Render's proxy)

Run the viewer like this:

    house_viewer.exe --relay wss://femfx-relay.onrender.com

One player presses **H** and shares the 4-letter code; the other presses
**J** and types it. Both must use the same `--relay` URL.

## Things worth knowing

- **Free tier spin-down:** free Render services sleep after ~15 minutes
  without inbound HTTP traffic. The first connection after a nap may fail or
  hang for up to ~50 seconds while the service wakes; just retry. The game's
  own WebSocket pings do NOT count as HTTP traffic once connected, but any
  reconnect attempt re-wakes it. If this annoys you, the $7/month starter
  tier stays awake.

- **Health checks:** Render considers the service live as soon as it accepts
  connections on its port. The relay also answers plain HTTPS GETs with a
  short text response, so visiting your URL in a browser should show
  "This is a WebSocket relay..." -- handy as a quick liveness check.

- **Logs:** Dashboard -> your service -> Logs tab shows connections, room
  creation, pairing and disconnects. Useful when debugging a failed join.

- **Updating:** push to the branch and Render redeploys automatically.
