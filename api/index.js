import { default as makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode';
import { MongoClient } from 'mongodb';

// MongoDB untuk menyimpan session di Vercel (karena filesystem tidak persistent)
const MONGODB_URI = process.env.MONGODB_URI || 'your-mongodb-connection-string';
let cachedDb = null;
let sock = null;
let qrCodeData = null;
let isConnected = false;

// MongoDB Connection
async function connectToDatabase() {
    if (cachedDb) {
        return cachedDb;
    }

    const client = await MongoClient.connect(MONGODB_URI);
    const db = client.db('whatsapp_bot');
    cachedDb = db;
    return db;
}

// Custom Auth State untuk MongoDB
async function useMongoDBAuthState() {
    const db = await connectToDatabase();
    const collection = db.collection('auth_state');

    const writeData = async (data, key) => {
        await collection.updateOne(
            { key },
            { $set: { data, key, updatedAt: new Date() } },
            { upsert: true }
        );
    };

    const readData = async (key) => {
        const doc = await collection.findOne({ key });
        return doc ? doc.data : null;
    };

    const removeData = async (key) => {
        await collection.deleteOne({ key });
    };

    const state = {
        creds: await readData('creds') || undefined,
        keys: {
            get: async (type, ids) => {
                const data = {};
                for (const id of ids) {
                    const key = `${type}-${id}`;
                    const value = await readData(key);
                    if (value) data[id] = value;
                }
                return data;
            },
            set: async (data) => {
                for (const category in data) {
                    for (const id in data[category]) {
                        const key = `${category}-${id}`;
                        await writeData(data[category][id], key);
                    }
                }
            }
        }
    };

    const saveCreds = async () => {
        if (sock?.authState?.creds) {
            await writeData(sock.authState.creds, 'creds');
        }
    };

    return { state, saveCreds };
}

// Initialize WhatsApp Connection
async function initWhatsApp() {
    if (sock && isConnected) {
        return sock;
    }

    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMongoDBAuthState();

        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['Warranty Bot Vercel', 'Chrome', '4.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            getMessage: async (key) => {
                return { conversation: '' };
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCodeData = await qrcode.toDataURL(qr);
                console.log('QR Code generated');
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('Connection closed, reconnect:', shouldReconnect);
                
                isConnected = false;
                sock = null;
                
                if (shouldReconnect) {
                    setTimeout(() => initWhatsApp(), 5000);
                }
            } else if (connection === 'open') {
                console.log('WhatsApp Connected!');
                isConnected = true;
                qrCodeData = null;
            }
        });

        sock.ev.on('creds.update', saveCreds);

        return sock;
    } catch (error) {
        console.error('WhatsApp init error:', error);
        throw error;
    }
}

// Format phone number
function formatPhoneNumber(phone) {
    let formatted = phone.replace(/\D/g, '');
    if (formatted.startsWith('0')) {
        formatted = '62' + formatted.substring(1);
    } else if (!formatted.startsWith('62')) {
        formatted = '62' + formatted;
    }
    return formatted;
}

// Main Handler untuk Vercel Serverless Functions
export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { pathname } = new URL(req.url, `http://${req.headers.host}`);

    try {
        // Root - Landing Page
        if (pathname === '/' && req.method === 'GET') {
            const html = generateLandingPage();
            res.setHeader('Content-Type', 'text/html');
            return res.status(200).send(html);
        }

        // Get QR Code
        if (pathname === '/qr' && req.method === 'GET') {
            if (!sock || !isConnected) {
                await initWhatsApp();
            }

            if (qrCodeData) {
                return res.status(200).json({
                    success: true,
                    qr: qrCodeData,
                    message: 'Scan this QR code with WhatsApp'
                });
            } else if (isConnected) {
                return res.status(200).json({
                    success: false,
                    message: 'Already connected',
                    connected: true
                });
            } else {
                return res.status(200).json({
                    success: false,
                    message: 'QR not available yet, please wait...',
                    connected: false
                });
            }
        }

        // Status Check
        if (pathname === '/status' && req.method === 'GET') {
            return res.status(200).json({
                status: isConnected ? 'connected' : 'disconnected',
                qrRequired: !isConnected && !qrCodeData,
                qrAvailable: !!qrCodeData,
                botNumber: sock?.user?.id ? sock.user.id.split(':')[0] : null,
                timestamp: new Date().toISOString()
            });
        }

        // Send Message
        if (pathname === '/send-message' && req.method === 'POST') {
            const { phone, message } = req.body;

            if (!phone || !message) {
                return res.status(400).json({
                    success: false,
                    error: 'Phone and message are required'
                });
            }

            if (!isConnected || !sock) {
                // Try to reconnect
                await initWhatsApp();
                
                if (!isConnected) {
                    return res.status(503).json({
                        success: false,
                        error: 'WhatsApp bot is not connected',
                        hint: 'Please scan QR code first'
                    });
                }
            }

            const formattedPhone = formatPhoneNumber(phone);
            const jid = `${formattedPhone}@s.whatsapp.net`;

            // Check if number exists
            const [exists] = await sock.onWhatsApp(jid);
            if (!exists) {
                return res.status(404).json({
                    success: false,
                    error: 'Phone number not registered on WhatsApp',
                    phone: formattedPhone
                });
            }

            // Send message
            const result = await sock.sendMessage(jid, { text: message });

            return res.status(200).json({
                success: true,
                message: 'Message sent successfully',
                to: formattedPhone,
                messageId: result.key.id,
                timestamp: new Date().toISOString()
            });
        }

        // Health Check
        if (pathname === '/health' && req.method === 'GET') {
            return res.status(200).json({
                status: 'ok',
                service: 'whatsapp-bot-vercel',
                connected: isConnected,
                timestamp: new Date().toISOString()
            });
        }

        // Not Found
        return res.status(404).json({
            success: false,
            error: 'Endpoint not found'
        });

    } catch (error) {
        console.error('Handler error:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
}

// Generate Landing Page HTML
function generateLandingPage() {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>WhatsApp Bot API - Vercel</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
            }
            .container {
                background: white;
                border-radius: 20px;
                padding: 40px;
                max-width: 600px;
                width: 100%;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            }
            h1 {
                color: #333;
                margin-bottom: 10px;
                font-size: 2em;
            }
            .status {
                display: inline-block;
                padding: 8px 16px;
                border-radius: 20px;
                font-weight: bold;
                margin: 20px 0;
            }
            .connected { background: #10b981; color: white; }
            .disconnected { background: #ef4444; color: white; }
            .info {
                background: #f3f4f6;
                padding: 20px;
                border-radius: 10px;
                margin: 20px 0;
            }
            .info p {
                margin: 10px 0;
                color: #666;
                font-size: 0.95em;
            }
            .endpoints {
                margin-top: 30px;
            }
            .endpoint {
                background: #f9fafb;
                padding: 15px;
                border-radius: 8px;
                margin: 10px 0;
                border-left: 4px solid #667eea;
            }
            .endpoint code {
                background: #e5e7eb;
                padding: 4px 8px;
                border-radius: 4px;
                font-size: 0.85em;
                word-break: break-all;
                display: block;
                margin-top: 8px;
            }
            button {
                background: #667eea;
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 8px;
                cursor: pointer;
                font-size: 1em;
                font-weight: bold;
                margin: 10px 5px;
                transition: all 0.3s;
            }
            button:hover {
                background: #5568d3;
                transform: translateY(-2px);
            }
            #qrcode {
                margin: 20px auto;
                padding: 20px;
                background: white;
                display: inline-block;
                border-radius: 10px;
            }
            .qr-section {
                text-align: center;
                margin: 20px 0;
                padding: 25px;
                background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
                border-radius: 15px;
                border: 2px solid #10b981;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🤖 WhatsApp Bot API</h1>
            <div class="status disconnected" id="status">Checking...</div>
            
            <div class="info">
                <p><strong>📡 Platform:</strong> Vercel Serverless</p>
                <p><strong>🔧 Runtime:</strong> Node.js</p>
                <p><strong>📦 Library:</strong> Baileys 6.5.0</p>
                <p><strong>💾 Storage:</strong> MongoDB</p>
            </div>
            
            <div class="endpoints">
                <h3 style="margin-bottom: 15px;">📚 Available Endpoints</h3>
                
                <div class="endpoint">
                    <strong>POST /send-message</strong>
                    <p style="margin: 8px 0; color: #666;">Send text message to WhatsApp number</p>
                    <code>{ "phone": "6281234567890", "message": "Hello from bot!" }</code>
                </div>
                
                <div class="endpoint">
                    <strong>GET /status</strong>
                    <p style="margin: 8px 0; color: #666;">Get bot connection status</p>
                </div>
                
                <div class="endpoint">
                    <strong>GET /qr</strong>
                    <p style="margin: 8px 0; color: #666;">Get QR code for authentication</p>
                </div>
                
                <div class="endpoint">
                    <strong>GET /health</strong>
                    <p style="margin: 8px 0; color: #666;">Health check endpoint</p>
                </div>
            </div>

            <div style="margin-top: 20px; text-align: center;">
                <button onclick="checkStatus()">🔄 Check Status</button>
                <button onclick="getQR()">📱 Get QR Code</button>
            </div>

            <div id="qr-container" style="display: none;"></div>
        </div>
        
        <script>
            async function checkStatus() {
                try {
                    const response = await fetch('/status');
                    const data = await response.json();
                    
                    const statusEl = document.getElementById('status');
                    if (data.status === 'connected') {
                        statusEl.className = 'status connected';
                        statusEl.textContent = '✅ Connected';
                    } else {
                        statusEl.className = 'status disconnected';
                        statusEl.textContent = '❌ Disconnected';
                    }
                    
                    alert(JSON.stringify(data, null, 2));
                } catch (error) {
                    alert('Error: ' + error.message);
                }
            }

            async function getQR() {
                try {
                    const response = await fetch('/qr');
                    const data = await response.json();
                    
                    if (data.success && data.qr) {
                        const qrContainer = document.getElementById('qr-container');
                        qrContainer.innerHTML = '<div class="qr-section"><h3>📱 Scan QR Code</h3><img src="' + data.qr + '" style="max-width: 300px; margin: 20px auto;"/><p style="color: #059669;">Open WhatsApp → Settings → Linked Devices → Link a Device</p></div>';
                        qrContainer.style.display = 'block';
                    } else {
                        alert(data.message);
                    }
                } catch (error) {
                    alert('Error: ' + error.message);
                }
            }

            // Auto check status on load
            window.onload = checkStatus;
        </script>
    </body>
    </html>
    `;
}

// Keep connection alive (Vercel has 10s timeout for serverless, but we can try)
setInterval(() => {
    if (sock && isConnected) {
        console.log('Keeping connection alive...');
    }
}, 30000);
