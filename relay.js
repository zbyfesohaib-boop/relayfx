// ============================================================================
// FEMFX House -- multiplayer relay server (zero dependencies, Node.js stdlib)
//
//   node relay.js [PORT]        (default 8080)
//
// WHAT IT DOES
// ------------
// Two game clients cannot reach each other through home routers (NAT), so both
// connect OUT to this server instead. It pairs exactly two sockets per room and
// pipes traffic between them. It never inspects or interprets game data.
//
//   Host   -> {"t":"host","code":"ABCD"}   registers the room
//   Client -> {"t":"join","code":"ABCD"}   joins it
//   Relay  -> {"t":"ok",...}               to each on success
//           {"t":"err", ...}              on failure
//           {"t":"peer"} / {"t":"peer_left"} when the other side arrives/leaves
//
// After pairing, EVERY frame a socket sends is forwarded verbatim to its peer
// (binary game packets included). Control JSON is only accepted while a socket
// is unpaired, so game traffic can never be mistaken for commands.
//
// WEBSOCKETS WITHOUT `npm install`
// --------------------------------
// This file implements the small slice of RFC 6455 it needs: the HTTP upgrade
// handshake (SHA-1 accept token via the built-in crypto module), frame
// parsing with client masking, fragmentation, ping/pong and close. That keeps
// the deploy story to "copy one file" on any host with Node.
//
// DEPLOYING
// ---------
// * fly.io (CURRENT public deployment): see relay/DEPLOY.md. Fly terminates
//   TLS at the edge; the endpoint is wss://relayfx.fly.dev. Keep exactly one
//   machine -- rooms live in this process's memory.
// * Any VPS / your own PC:      node relay.js            (plain ws:// on :8080)
//
// The game defaults to wss://relayfx.fly.dev; pass --relay to the viewer to
// point it somewhere else.
// ============================================================================

'use strict';

const http = require('http');
const crypto = require('crypto');

// CLI arg wins, then the platform-injected PORT (Render/fly/Heroku style),
// then the dev default.
const PORT = parseInt(process.argv[2], 10)
          || parseInt(process.env.PORT, 10)
          || 8080;

// Room codes are 4 uppercase letters. Ambiguous glyphs (I/O) are excluded so a
// code read aloud over voice chat cannot be misheard.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 4;

// Disconnect sockets that have not completed a WS ping/pong cycle in 60s.
const HEARTBEAT_MS = 30000;

/** code -> { host: Conn|null, client: Conn|null } */
const rooms = new Map();

function makeRoomCode() {
    for (;;) {
        let code = '';
        for (let i = 0; i < CODE_LENGTH; i++) {
            code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
        }
        if (!rooms.has(code)) return code;
        // collision: loop and draw again
    }
}

function roomLabel(room) {
    for (const [code, r] of rooms) if (r === room) return code;
    return '????';
}

// ----------------------------------------------------------------------------
// Minimal RFC 6455 WebSocket implementation
// ----------------------------------------------------------------------------

class WsConn {
    constructor(socket) {
        this.socket = socket;
        this.buf = Buffer.alloc(0);
        // Optimistic until proven dead: the heartbeat only terminates a
        // connection after it has failed to answer a FULL ping cycle. Starting
        // at false here would kill every socket at its very first heartbeat
        // tick, before it ever had a ping to answer.
        this.alive = true;
        this.onMessage = null;       // (opcode: 'text'|'binary', payload: Buffer)
        this.onClose = null;
        socket.setNoDelay(true);
        socket.on('data', (d) => this.#feed(d));
        socket.on('close', () => this.#dead());
        socket.on('error', () => this.#dead());
    }

    #dead() {
        if (this.closed) return;
        this.closed = true;
        if (this.onClose) this.onClose();
        try { this.socket.destroy(); } catch (_) {}
    }

    // Accumulate bytes and peel off complete frames.
    #feed(d) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
        for (;;) {
            const frame = this.#parseFrame();
            if (!frame) return;
            if (frame === 'protocol-error') { this.close(1002); return; }
            this.#handleFrame(frame);
        }
    }

    // Returns null (need more bytes), 'protocol-error', or a frame object.
    #parseFrame() {
        const b = this.buf;
        if (b.length < 2) return null;

        const fin    = (b[0] & 0x80) !== 0;
        const opcode = b[0] & 0x0f;
        const masked = (b[1] & 0x80) !== 0;
        let len      = b[1] & 0x7f;
        let off      = 2;

        if (len === 126) {
            if (b.length < 4) return null;
            len = b.readUInt16BE(2); off = 4;
        } else if (len === 127) {
            if (b.length < 10) return null;
            const big = b.readBigUInt64BE(2);
            if (big > 32n * 1024n * 1024n) return 'protocol-error'; // sanity cap
            len = Number(big); off = 10;
        }

        let maskKey = null;
        if (masked) {
            if (b.length < off + 4) return null;
            maskKey = b.subarray(off, off + 4); off += 4;
        }
        if (b.length < off + len) return null;

        let payload = b.subarray(off, off + len);
        if (masked && len > 0) {
            payload = Buffer.from(payload); // copy before unmasking
            for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
        }
        this.buf = b.subarray(off + len);
        return { fin, opcode, payload };
    }

    #handleFrame(f) {
        switch (f.opcode) {
            case 0x0: // continuation -> hand to the fragment assembler
                if (this.fragOp === undefined) return this.close(1002);
                this.fragBuf = Buffer.concat([this.fragBuf, f.payload]);
                if (f.fin) {
                    const op = this.fragOp, data = this.fragBuf;
                    this.fragOp = undefined; this.fragBuf = null;
                    this.#deliver(op, data);
                }
                break;
            case 0x1: case 0x2: // text / binary
                if (f.fin) this.#deliver(f.opcode, f.payload);
                else { this.fragOp = f.opcode; this.fragBuf = Buffer.from(f.payload); }
                break;
            case 0x8: this.close(1000); break;                       // close
            case 0x9: this.sendFrame(0xA, f.payload); break;         // ping -> pong
            case 0xA: this.alive = true; break;                      // pong
            default:  this.close(1002); break;                       // reserved
        }
    }

    #deliver(opcode, data) {
        if (this.onMessage) {
            this.onMessage(opcode === 0x1 ? 'text' : 'binary', data);
        }
    }

    sendFrame(opcode, payload) {
        if (this.closed) return;
        const len = payload.length;
        let header;
        if (len < 126) {
            header = Buffer.from([0x80 | opcode, len]);             // FIN set, server never masks
        } else if (len < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x80 | opcode; header[1] = 126;
            header.writeUInt16BE(len, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x80 | opcode; header[1] = 127;
            header.writeBigUInt64BE(BigInt(len), 2);
        }
        try { this.socket.write(Buffer.concat([header, payload])); }
        catch (_) { this.#dead(); }
    }

    sendText(str) { this.sendFrame(0x1, Buffer.from(str, 'utf8')); }

    close(code) {
        if (this.closed) return;
        const body = Buffer.alloc(2);
        body.writeUInt16BE(code || 1000);
        this.sendFrame(0x8, body);
        this.#dead();
    }
}

// ----------------------------------------------------------------------------
// Rooms and pairing
// ----------------------------------------------------------------------------

function dropFromRooms(conn) {
    for (const [code, room] of rooms) {
        if (room.host !== conn && room.client !== conn) continue;

        const role = room.host === conn ? 'host' : 'client';
        const peer = room.host === conn ? room.client : room.host;

        if (role === 'host') {
            // The host IS the simulation. Without it the room is useless.
            rooms.delete(code);
            console.log(`[${code}] host left -- room closed`);
        } else {
            room.client = null;      // host keeps the room, a new client may join
            console.log(`[${code}] client left`);
        }
        if (peer && peer.onMessage) peer.sendText(JSON.stringify({ t: 'peer_left' }));
        return;
    }
}

function handleControl(conn, text) {
    let msg;
    try { msg = JSON.parse(text); } catch (_) { conn.close(1003); return; }

    // Already paired: everything from here on is game traffic, not commands.
    if (conn.room) { conn.close(1003); return; }

    const code = typeof msg.code === 'string' ? msg.code.toUpperCase() : '';

    if (msg.t === 'host') {
        // Honour a requested 4-letter code if it is free; otherwise (bad format
        // or already taken) assign a fresh one so hosting never fails outright.
        let outCode = code;
        if (outCode.length !== CODE_LENGTH || rooms.has(outCode)) outCode = makeRoomCode();

        const room = { host: conn, client: null };
        rooms.set(outCode, room);
        conn.room = room;
        conn.role = 'host';
        conn.sendText(JSON.stringify({ t: 'ok', role: 'host', code: outCode }));
        console.log(`[${outCode}] host registered (${rooms.size} room[s])`);

    } else if (msg.t === 'join') {
        const room = rooms.get(code);
        if (!room)            { conn.sendText(JSON.stringify({ t: 'err', msg: 'no such room' })); return; }
        if (room.client)      { conn.sendText(JSON.stringify({ t: 'err', msg: 'room full' }));    return; }

        room.client = conn;
        conn.room = room;
        conn.role = 'client';
        conn.sendText(JSON.stringify({ t: 'ok', role: 'client', code }));
        room.host.sendText(JSON.stringify({ t: 'peer' }));
        console.log(`[${code}] client joined -- relaying`);

    } else {
        conn.sendText(JSON.stringify({ t: 'err', msg: 'unknown message' }));
    }
}

// ----------------------------------------------------------------------------
// HTTP server: upgrade WebSockets, nothing else.
// ----------------------------------------------------------------------------

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const server = http.createServer((req, res) => {
    // Plain HTTP gets a hint rather than a hang.
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('This is a WebSocket relay. Connect with a WebSocket client.\n');
});

server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
        socket.destroy();
        return;
    }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n');

    const conn = new WsConn(socket);

    conn.onMessage = (kind, payload) => {
        if (!conn.room) {
            if (kind === 'text') handleControl(conn, payload.toString('utf8'));
            else conn.close(1003);          // binary before pairing is nonsense
            return;
        }
        // Paired: pipe verbatim to the peer. No parsing, no copying logic.
        const peer = conn.role === 'host' ? conn.room.client : conn.room.host;
        if (peer) peer.sendFrame(kind === 'text' ? 0x1 : 0x2, payload);
    };

    conn.onClose = () => dropFromRooms(conn);
});

// Heartbeat: kill half-open connections (laptops asleep, cables pulled).
// Each cycle: a connection that answered the previous ping stays, gets marked
// unanswered and is pinged; one that missed the ping is closed. A healthy
// socket therefore always has ~30s to answer -- never an impossible deadline.
setInterval(() => {
    const seen = new Set();
    for (const [, room] of rooms) {
        for (const c of [room.host, room.client]) {
            if (!c || seen.has(c)) continue;
            seen.add(c);
            if (!c.alive) { c.close(1001); continue; }
            c.alive = false;
            c.sendFrame(0x9, Buffer.alloc(0));   // ping
        }
    }
}, HEARTBEAT_MS);

server.listen(PORT, () => {
    console.log(`FEMFX relay listening on port ${PORT}`);
    console.log('Point the game at it with:  house_viewer.exe --relay ws://<this-host>:' + PORT);
});
