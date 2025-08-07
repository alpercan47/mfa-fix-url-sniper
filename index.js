
const WebSocket = require('ws');
const http2 = require('http2');
const tls = require('tls');

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

const listToken = "";        
const guildId = "";          
const password = "";         
const channelId = "";        

let mfaToken = null;
let savedTicket = null;
let lastSequence = null;
let heartbeatInterval = null;

const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Content-Type': 'application/json',
    'X-Super-Properties': 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiRmlyZWZveCIsImRldmljZSI6IiIsInN5c3RlbV9sb2NhbGUiOiJ0ci1UUiIsImJyb3dzZXJfdXNlcl9hZ2VudCI6Ik1vemlsbGEvNS4wIChXaW5kb3dzIE5UIDEwLjA7IFdpbjY0OyB4NjQ7IHJ2OjEzMy4wKSBHZWNrby8yMDEwMDEwMSBGaXJlZm94LzEzMy4wIiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTMzLjAiLCJvc192ZXJzaW9uIjoiMTAiLCJyZWZlcnJlciI6Imh0dHBzOi8vd3d3Lmdvb2dsZS5jb20vIiwicmVmZXJyaW5nX2RvbWFpbiI6Ind3dy5nb29nbGUuY29tIiwic2VhcmNoX2VuZ2luZSI6Imdvb2dsZSIsInJlZmVycmVyX2N1cnJlbnQiOiIiLCJyZWZlcnJpbmdfZG9tYWluX2N1cnJlbnQiOiIiLCJyZWxlYXNlX2NoYW5uZWwiOiJjYW5hcnkiLCJjbGllbnRfYnVpbGRfbnVtYmVyIjozNTYxNDAsImNsaWVudF9ldmVudF9zb3VyY2UiOm51bGwsImhhc19jbGllbnRfbW9kcyI6ZmFsc2V9'
};

const guilds = new Map();
const sessions = new Map();
const MAX_SESSIONS = 20;
let sessionIndex = 0;

function createSession(index) {
    const session = http2.connect("https://canary.discord.com", {
        settings: {
            enablePush: false,
            initialWindowSize: 1073741824,
            maxConcurrentStreams: 1000
        },
        createConnection: () => tls.connect(443, 'canary.discord.com', {
            rejectUnauthorized: false,
            secureContext: tls.createSecureContext({
                secureProtocol: 'TLSv1_2_method'
            }),
            ALPNProtocols: ['h2']
        })
    });

    session.on('error', () => {
        sessions.delete(index);
        setTimeout(() => createSession(index), 500);
    });

    session.on('close', () => {
        sessions.delete(index);
        setTimeout(() => createSession(index), 500);
    });

    sessions.set(index, session);
}

for (let i = 0; i < MAX_SESSIONS; i++) createSession(i);

async function fastHttp2Request(method, path, customHeaders = {}, body = null) {
    try {
        const currentSessionIndex = sessionIndex;
        sessionIndex = (sessionIndex + 1) % MAX_SESSIONS;
        const session = sessions.get(currentSessionIndex);

        if (!session || session.destroyed || session.closed) throw new Error();

        const headers = {
            ...BASE_HEADERS,
            Authorization: listToken,
            ...customHeaders,
            ":method": method,
            ":path": path,
            ":authority": "canary.discord.com",
            ":scheme": "https"
        };

        return await new Promise((resolve, reject) => {
            const stream = session.request(headers, { endStream: !body });
            const chunks = [];
            stream.on("data", chunk => chunks.push(chunk));
            stream.on("end", () => resolve(Buffer.concat(chunks).toString()));
            stream.on("error", reject);
            if (body) stream.end(Buffer.from(body));
        });
    } catch {
        return "{}";
    }
}

function sendMessageToChannel(vanity) {
    const socket = tls.connect({ host: "canary.discord.com", port: 443 });

    const body = JSON.stringify({
        content: `@everyone GUILD_UPDATE (${vanity})`
    });

    const headers = [
        `POST /api/v10/channels/${channelId}/messages HTTP/1.1`,
        `Host: canary.discord.com`,
        `Authorization: ${listToken}`,
        `Content-Type: application/json`,
        `Content-Length: ${Buffer.byteLength(body)}`,
        ``,
        ``
    ].join("\r\n");

    socket.write(headers + body);

    socket.on("data", () => {
        socket.end();
    });

    socket.on("error", () => {
        socket.end();
    });
}

function connectWebSocket() {
    const socket = new WebSocket("wss://gateway-us-east1-b.discord.gg");

    socket.on('open', () => {
        socket.send(JSON.stringify({
            op: 2,
            d: {
                token: listToken,
                intents: 1,
                properties: { $os: "linux", $browser: "discord.js", $device: "mobile" }
            }
        }));
    });

    socket.on('message', async (data) => {
        const payload = JSON.parse(data);
        if (payload.s) lastSequence = payload.s;

        if (payload.op === 10) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN)
                    socket.send(JSON.stringify({ op: 1, d: lastSequence }));
            }, payload.d.heartbeat_interval);
        }

        if (payload.op === 1) {
            if (socket.readyState === WebSocket.OPEN)
                socket.send(JSON.stringify({ op: 1, d: lastSequence }));
        }

        if (payload.op === 0) {
            const { t: type, d: eventData } = payload;

            if (type === "GUILD_UPDATE") {
                const find = guilds.get(eventData.guild_id);
                if (find && find !== eventData.vanity_url_code) {
                    const requestBody = JSON.stringify({ code: find });

                    fastHttp2Request("PATCH", `/api/v10/guilds/${guildId}/vanity-url`, {
                        "Cookie": `__Secure-recent_mfa=${mfaToken}`,
                        "Content-Type": "application/json"
                    }, requestBody);

                    for (let i = 0; i < 10; i++) {
                        fastHttp2Request("PATCH", `/api/v10/guilds/${guildId}/vanity-url`, {
                            "Cookie": `__Secure-recent_mfa=${mfaToken}`,
                            "Content-Type": "application/json"
                        }, requestBody);
                    }

                    sendMessageToChannel(find);
                }
            } else if (type === "READY") {
                guilds.clear();
                eventData.guilds.forEach((guild) => {
                    if (guild.vanity_url_code) {
                        guilds.set(guild.id, guild.vanity_url_code);
                    }
                });
            }
        }

        if (payload.op === 7 || payload.op === 9) {
            if (payload.op === 9) lastSequence = null;
            socket.close();
        }
    });

    socket.on('close', () => {
        clearInterval(heartbeatInterval);
        setTimeout(connectWebSocket, 3000);
    });

    socket.on('error', () => {});
}

async function initialize() {
    try {
        const r = await fastHttp2Request("PATCH", `/api/v9/guilds/0/vanity-url`);
        const d = JSON.parse(r);
        if (d.code === 60003) {
            savedTicket = d.mfa.ticket;
            const res = await fastHttp2Request("POST", "/api/v9/mfa/finish", {
                "Content-Type": "application/json"
            }, JSON.stringify({
                ticket: savedTicket,
                mfa_type: "password",
                data: password
            }));

            const j = JSON.parse(res);
            if (j.token) {
                mfaToken = j.token;
            } else {
                setTimeout(initialize, 5000);
                return;
            }
        }
    } catch {
        setTimeout(initialize, 5000);
        return;
    }

    connectWebSocket();
    setInterval(refreshMfaToken, 300000);
}

async function refreshMfaToken() {
    try {
        const r = await fastHttp2Request("PATCH", `/api/v9/guilds/0/vanity-url`);
        const j = JSON.parse(r);
        if (j.code === 60003) {
            savedTicket = j.mfa.ticket;
            const res = await fastHttp2Request("POST", "/api/v9/mfa/finish", {
                "Content-Type": "application/json"
            }, JSON.stringify({
                ticket: savedTicket,
                mfa_type: "password",
                data: password
            }));
            const data = JSON.parse(res);
            if (data.token) mfaToken = data.token;
        }
    } catch {}
}

initialize();

setInterval(() => {
    fastHttp2Request("HEAD", "/");
}, 180000);
