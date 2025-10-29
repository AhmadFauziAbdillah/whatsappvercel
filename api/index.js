import { default as makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Global variables untuk persistent connection
let sock = null;
let qrCode = null;
let isConnected = false;
let lastActivity = Date.now();
const CONNECTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// Auth folder di /tmp (ephemeral di Vercel)
const authFolder = join(tmpdir(), 'auth_info_baileys');

// Ensure auth folder exists
if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true });
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

// Connect to WhatsApp
async function connectToWhatsApp() {
    if (sock && isConnected) {
        lastActivity = Date.now();
        return sock;
    }

    try {
        console.log('🔄 Connecting to WhatsApp...');
        
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        
        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['Warranty Bot Vercel', 'Chrome', '4.0.0'],
            connectTimeoutMs: 30000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            getMessage: async (key) => ({ conversation: '' })
        });

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, 45000);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                if (qr) {
                    console.log('📱 QR Code generated');
                    qrCode = qr;
                    clearTimeout(timeout);
                    resolve({ qr, needsScan: true });
                }
                
                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    isConnected = false;
                    
                    if (statusCode === DisconnectReason.loggedOut) {
                        console.log('🚪 Logged out');
                        qrCode = null;
                        // Clear auth
                        try {
                            const files = fs.readdirSync(authFolder);
                            files.forEach(file => fs.unlinkSync(join(authFolder, file)));
                        } catch (err) {
                            console.error('Clear auth error:', err);
                        }
                    }
                    clearTimeout(timeout);
                    reject(new Error('Connection closed'));
                }
                
                if (connection === 'open') {
                    console.log('✅ Connected!');
                    isConnected = true;
                    qrCode = null;
                    lastActivity = Date.now();
                    clearTimeout(timeout);
                    resolve({ connected: true });
                }
            });

            sock.ev.on('creds.update', saveCreds);
        });
    } catch (error) {
        console.error('❌ Connection error:', error.message);
        throw error;
    }
}

// Keep connection alive
function keepAlive() {
    if (sock && isConnected) {
        const inactive = Date.now() - lastActivity;
        if (inactive > CONNECTION_TIMEOUT) {
            console.log('⚠️ Connection inactive, closing...');
            sock.end();
            sock = null;
            isConnected = false;
        }
    }
}

// Main handler for Vercel
export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    keepAlive();

    const { pathname } = new URL(req.url, `http://${req.headers.host}`);

    try {
        // Route: Home/Status
        if (pathname === '/' || pathname === '/api') {
            return res.status(200).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>WhatsApp Bot API - Vercel</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <style>
                        * { margin: 0; padding: 0; box-sizing: border-box; }
                        body {
                            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            min-height: 100vh;
                            padding: 20px;
                        }
                        .container {
                            max-width: 800px;
                            margin: 40px auto;
                            background: white;
                            border-radius: 20px;
                            padding: 40px;
                            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                        }
                        h1 { color: #333; margin-bottom: 20px; }
                        .status {
                            padding: 12px 24px;
                            border-radius: 25px;
                            display: inline-block;
                            font-weight: bold;
                            margin: 15px 0;
                        }
                        .connected { background: #10b981; color: white; }
                        .disconnected { background: #ef4444; color: white; }
                        .info {
                            background: #f3f4f6;
                            padding: 20px;
                            border-radius: 10px;
                            margin: 20px 0;
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
                            padding: 8px;
                            border-radius: 4px;
                            display: block;
                            margin-top: 8px;
                            font-size: 0.9em;
                        }
                        .warning {
                            background: #fef3c7;
                            padding: 15px;
                            border-radius: 8px;
                            margin: 15px 0;
                            border-left: 4px solid #f59e0b;
                        }
                        button {
                            background: #667eea;
                            color: white;
                            border: none;
                            padding: 12px 24px;
                            border-radius: 8px;
                            cursor: pointer;
                            font-weight: bold;
                            margin: 5px;
                        }
                        button:hover { background: #5568d3; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>🤖 WhatsApp Bot API</h1>
                        <div class="status ${isConnected ? 'connected' : 'disconnected'}" id="status">
                            ${isConnected ? '✅ Connected' : '❌ Disconnected'}
                        </div>
                        
                        <div class="warning">
                            <strong>⚠️ Vercel Serverless Mode</strong>
                            <p>Bot berjalan dalam mode serverless. Koneksi akan timeout setelah 5 menit tidak aktif. 
                            Auth tersimpan di ephemeral storage (/tmp) dan akan hilang saat cold start.</p>
                        </div>

                        <div class="info">
                            <p><strong>📡 Status:</strong> <span id="connectionStatus">${isConnected ? 'Connected' : 'Disconnected'}</span></p>
                            <p><strong>📱 Bot Number:</strong> <span id="botNumber">-</span></p>
                            <p><strong>🔑 QR Available:</strong> <span id="qrStatus">${qrCode ? 'Yes' : 'No'}</span></p>
                        </div>

                        <div style="margin: 20px 0;">
                            <button onclick="checkStatus()">🔄 Refresh Status</button>
                            <button onclick="getQR()">📱 Get QR Code</button>
                            <button onclick="testMessage()" style="background: #10b981;">📤 Test Send</button>
                        </div>

                        <div id="qrDisplay" style="text-align: center; margin: 20px 0;"></div>

                        <h3 style="margin-top: 30px;">📚 API Endpoints</h3>
                        
                        <div class="endpoint">
                            <strong>GET /api/status</strong>
                            <p>Get connection status</p>
                        </div>

                        <div class="endpoint">
                            <strong>GET /api/qr</strong>
                            <p>Get QR code for pairing</p>
                        </div>

                        <div class="endpoint">
                            <strong>POST /api/connect</strong>
                            <p>Initialize connection</p>
                        </div>

                        <div class="endpoint">
                            <strong>POST /api/send</strong>
                            <p>Send WhatsApp message</p>
                            <code>{ "phone": "6281234567890", "message": "Hello!" }</code>
                        </div>

                        <div class="endpoint">
                            <strong>POST /api/clear</strong>
                            <p>Clear auth and reset</p>
                        </div>
                    </div>

                    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
                    <script>
                        async function checkStatus() {
                            const res = await fetch('/api/status');
                            const data = await res.json();
                            document.getElementById('connectionStatus').textContent = data.connected ? 'Connected ✅' : 'Disconnected ❌';
                            document.getElementById('qrStatus').textContent = data.qrAvailable ? 'Yes' : 'No';
                            document.getElementById('botNumber').textContent = data.botNumber || '-';
                            document.getElementById('status').className = 'status ' + (data.connected ? 'connected' : 'disconnected');
                            document.getElementById('status').textContent = data.connected ? '✅ Connected' : '❌ Disconnected';
                        }

                        async function getQR() {
                            const res = await fetch('/api/qr');
                            const data = await res.json();
                            
                            if (data.qr) {
                                const container = document.getElementById('qrDisplay');
                                container.innerHTML = '<h3>📱 Scan QR Code</h3><div id="qrcode"></div>';
                                new QRCode(document.getElementById('qrcode'), {
                                    text: data.qr,
                                    width: 256,
                                    height: 256
                                });
                            } else {
                                alert(data.message || 'QR not available');
                            }
                        }

                        async function testMessage() {
                            const phone = prompt('Enter phone number (e.g., 6281234567890):');
                            if (!phone) return;
                            
                            const res = await fetch('/api/send', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    phone: phone,
                                    message: 'Test message from Vercel bot!'
                                })
                            });
                            const data = await res.json();
                            alert(data.success ? '✅ Message sent!' : '❌ Error: ' + data.error);
                        }

                        // Auto refresh status
                        setInterval(checkStatus, 5000);
                        checkStatus();
                    </script>
                </body>
                </html>
            `);
        }

        // Route: Status
        if (pathname === '/api/status') {
            return res.status(200).json({
                connected: isConnected,
                qrAvailable: !!qrCode,
                botNumber: sock?.user?.id ? sock.user.id.split(':')[0] : null,
                lastActivity: lastActivity,
                timestamp: new Date().toISOString()
            });
        }

        // Route: Connect
        if (pathname === '/api/connect' && req.method === 'POST') {
            try {
                const result = await connectToWhatsApp();
                return res.status(200).json({
                    success: true,
                    ...result
                });
            } catch (error) {
                return res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }

        // Route: Get QR
        if (pathname === '/api/qr') {
            if (isConnected) {
                return res.status(200).json({
                    success: false,
                    message: 'Already connected'
                });
            }

            if (!qrCode) {
                try {
                    await connectToWhatsApp();
                } catch (err) {
                    // QR might be generated even if connection fails
                }
            }

            if (qrCode) {
                return res.status(200).json({
                    success: true,
                    qr: qrCode,
                    message: 'Scan this QR code with WhatsApp'
                });
            } else {
                return res.status(503).json({
                    success: false,
                    message: 'QR code not available yet. Try /api/connect first'
                });
            }
        }

        // Route: Send Message
        if (pathname === '/api/send' && req.method === 'POST') {
            const { phone, message } = req.body;

            if (!phone || !message) {
                return res.status(400).json({
                    success: false,
                    error: 'Phone and message are required'
                });
            }

            if (!isConnected || !sock) {
                return res.status(503).json({
                    success: false,
                    error: 'Bot not connected. Get QR code at /api/qr'
                });
            }

            try {
                const formattedPhone = formatPhoneNumber(phone);
                const jid = `${formattedPhone}@s.whatsapp.net`;

                const [exists] = await sock.onWhatsApp(jid);
                if (!exists) {
                    return res.status(404).json({
                        success: false,
                        error: 'Phone number not registered on WhatsApp'
                    });
                }

                const result = await sock.sendMessage(jid, { text: message });
                lastActivity = Date.now();

                return res.status(200).json({
                    success: true,
                    message: 'Message sent successfully',
                    to: formattedPhone,
                    messageId: result.key.id
                });
            } catch (error) {
                return res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }

        // Route: Clear Auth
        if (pathname === '/api/clear' && req.method === 'POST') {
            try {
                if (sock) {
                    sock.end();
                    sock = null;
                }
                isConnected = false;
                qrCode = null;

                const files = fs.readdirSync(authFolder);
                files.forEach(file => fs.unlinkSync(join(authFolder, file)));

                return res.status(200).json({
                    success: true,
                    message: 'Auth cleared successfully'
                });
            } catch (error) {
                return res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        }

        // 404
        return res.status(404).json({
            error: 'Endpoint not found',
            available: ['/api/status', '/api/qr', '/api/connect', '/api/send', '/api/clear']
        });

    } catch (error) {
        console.error('Handler error:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
}
