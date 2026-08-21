# Deploying the relay to fly.io

The relay is a single zero-dependency Node file (`relay.js`). Fly runs it as
an HTTP service and terminates TLS at their edge, so players connect to
`wss://relayfx.fly.dev` while the app itself only speaks plain WebSocket.

## One-time setup

    fly launch --no-deploy          # name: relayfx, pick ONE region near players
    fly deploy

## CRITICAL: exactly one machine

Rooms live in the process's memory. If fly starts more than one machine, two
players can land on different machines and see "no such room" even though the
host just registered. Pin it:

    fly scale count 1               # one machine total
    fly status                      # verify: Machines = 1, single region

## Updating after a code change

    fly deploy

Always redeploy from THIS directory after touching `relay.js`. The game
protocol expects the current version (it honours requested room codes).

## Verifying a deployment

    node test_relay.js              # tests a LOCAL instance
    # for the live one, host + join from the game; both windows must show
    # "[peer] STATE_CONNECTED" in femfx_net_<pid>.log (FEMFX_NET_DEBUG=1)

## Cost note

A shared-cpu-1x VM with 256 MB RAM handles this relay trivially; it idles at
essentially zero CPU. On Fly's pay-as-you-go this is roughly a couple of
dollars per month.
