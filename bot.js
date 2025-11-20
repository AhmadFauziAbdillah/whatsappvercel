import { default as makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import express from 'express';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());

let sock;
let qrGenerated = false;
let isConnected = false;
let currentQR = null;
let connectionAttempts = 0;
const MAX_RETRY_ATTEMPTS = 3;

// Pastikan folder auth ada
const authFolder = join(__dirname, 'auth_info_baileys');
if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true });
    console.log('✅ Auth folder created');
}

// Setup WhatsApp Connection with better error handling
async function connectToWhatsApp() {
    try {
        connectionAttempts++;
        console.log(`🔄 Connection attempt ${connectionAttempts}/${MAX_RETRY_ATTEMPTS}`);
        
        // Fetch latest version for compatibility
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`📦 Using Baileys v${version.join('.')} (Latest: ${isLatest})`);
        
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        
        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['Warranty Bot', 'Chrome', '4.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            getMessage: async (key) => {
                return { conversation: '' };
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('📱 QR Code generated!');
                console.log('QR Length:', qr.length);
                
                qrcode.generate(qr, { small: true });
                
                currentQR = qr;
                qrGenerated = true;
                isConnected = false;
                connectionAttempts = 0;
            }
            
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log('❌ Connection closed');
                console.log('   Status Code:', statusCode);
                console.log('   Should Reconnect:', shouldReconnect);
                
                isConnected = false;
                
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('🚪 Logged out - clearing auth');
                    currentQR = null;
                    qrGenerated = false;
                    try {
                        const files = fs.readdirSync(authFolder);
                        for (const file of files) {
                            fs.unlinkSync(join(authFolder, file));
                        }
                        console.log('✅ Auth folder cleared');
                    } catch (err) {
                        console.error('Error clearing auth:', err);
                    }
                }
                
                if (shouldReconnect) {
                    if (connectionAttempts < MAX_RETRY_ATTEMPTS) {
                        const delay = Math.min(5000 * connectionAttempts, 15000);
                        console.log(`⏳ Reconnecting in ${delay/1000}s...`);
                        setTimeout(() => {
                            connectToWhatsApp();
                        }, delay);
                    } else {
                        console.log('❌ Max retry attempts reached. Clearing state...');
                        connectionAttempts = 0;
                        try {
                            const files = fs.readdirSync(authFolder);
                            for (const file of files) {
                                fs.unlinkSync(join(authFolder, file));
                            }
                            console.log('✅ Auth cleared, retrying with fresh state...');
                            setTimeout(() => connectToWhatsApp(), 5000);
                        } catch (err) {
                            console.error('Error clearing auth:', err);
                        }
                    }
                }
            } else if (connection === 'open') {
                console.log('✅ WhatsApp Bot Connected Successfully!');
                console.log(`📱 Bot Number: ${sock.user.id.split(':')[0]}`);
                console.log(`📛 Bot Name: ${sock.user.name || 'N/A'}`);
                currentQR = null;
                qrGenerated = false;
                isConnected = true;
                connectionAttempts = 0;
            } else if (connection === 'connecting') {
                console.log('🔄 Connecting to WhatsApp...');
            }
        });

        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('messages.upsert', async ({ messages }) => {
            // Handle incoming messages if needed
        });
        
    } catch (error) {
        console.error('❌ Error in connectToWhatsApp:', error.message);
        
        if (connectionAttempts < MAX_RETRY_ATTEMPTS) {
            console.log('⏳ Retrying connection...');
            setTimeout(() => connectToWhatsApp(), 10000);
        } else {
            console.log('❌ Max attempts reached. Please check your setup.');
            connectionAttempts = 0;
        }
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

// Root endpoint - Landing page
app.get('/', (req, res) => {
    const qrData = currentQR ? JSON.stringify(currentQR).replace(/'/g, "\\'") : null;
    
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>WhatsApp Bot API</title>
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
            .connecting { background: #f59e0b; color: white; }
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
            .qr-section {
                text-align: center;
                margin: 20px 0;
                padding: 25px;
                background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
                border-radius: 15px;
                border: 2px solid #10b981;
            }
            #qrcode {
                margin: 20px auto;
                padding: 20px;
                background: white;
                display: inline-block;
                border-radius: 10px;
                box-shadow: 0 4px 6px rgba(0,0,0,0.1);
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
            .btn-danger {
                background: #ef4444;
            }
            .btn-danger:hover {
                background: #dc2626;
            }
            .loading {
                background: #fef3c7;
                padding: 20px;
                border-radius: 10px;
                margin: 20px 0;
                text-align: center;
            }
            .success-box {
                background: #d1fae5;
                padding: 15px;
                border-radius: 8px;
                margin: 10px 0;
                color: #065f46;
                border-left: 4px solid #10b981;
            }
            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }
            .pulse {
                animation: pulse 2s infinite;
            }
            .warning {
                background: #fef3c7;
                padding: 15px;
                border-radius: 8px;
                margin: 10px 0;
                color: #92400e;
                border-left: 4px solid #f59e0b;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🤖 WhatsApp Bot API</h1>
            <div class="status ${isConnected ? 'connected' : qrGenerated ? 'connecting' : 'disconnected'}" id="status">
                ${isConnected ? '✅ Connected' : qrGenerated ? '🔄 Waiting for scan' : '❌ Disconnected'}
            </div>
            
            ${!isConnected && qrGenerated && qrData ? `
            <div class="qr-section">
                <h3>📱 Scan QR Code dengan WhatsApp</h3>
                <p style="margin: 10px 0; color: #059669; font-weight: 500;">
                    Buka WhatsApp → Settings → Linked Devices → Link a Device
                </p>
                <div id="qrcode"></div>
                <div class="success-box">
                    ✅ QR Code aktif! Scan sekarang untuk connect.
                </div>
                <button onclick="window.location.reload()">🔄 Refresh QR</button>
            </div>
            ` : ''}
            
            ${!isConnected && !qrGenerated ? `
            <div class="loading">
                <div class="pulse">
                    <h3>⏳ Menunggu QR Code...</h3>
                    <p style="margin: 10px 0; color: #92400e;">
                        Sedang connecting ke WhatsApp servers...
                    </p>
                </div>
                <div class="warning" style="margin-top: 15px;">
                    <strong>⚠️ Jika QR tidak muncul dalam 30 detik:</strong><br>
                    <button onclick="clearAuth()" class="btn-danger" style="margin-top: 10px;">
                        🗑️ Clear Auth & Restart
                    </button>
                </div>
            </div>
            ` : ''}
            
            ${isConnected ? `
            <div class="success-box">
                <strong>🎉 Bot berhasil terhubung!</strong>
                <p style="margin-top: 8px;">Sekarang kamu bisa mengirim pesan via API</p>
            </div>
            ` : ''}
            
            <div class="info">
                <p><strong>📡 Server:</strong> <span style="color: #10b981;">● Online</span></p>
                <p><strong>🔗 Bot Number:</strong> ${isConnected && sock?.user ? sock.user.id.split(':')[0] : 'Not connected'}</p>
                <p><strong>📛 Bot Name:</strong> ${isConnected && sock?.user?.name ? sock.user.name : 'N/A'}</p>
                <p><strong>⏰ Uptime:</strong> ${Math.floor(process.uptime())} seconds</p>
                <p><strong>🔒 Status:</strong> ${isConnected ? '✅ Connected' : qrGenerated ? '⏳ Waiting for scan' : '❌ Disconnected'}</p>
                <p><strong>🔄 Attempts:</strong> ${connectionAttempts}/${MAX_RETRY_ATTEMPTS}</p>
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
                    <p style="margin: 8px 0; color: #666;">Get bot connection status and info</p>
                </div>
                
                <div class="endpoint">
                    <strong>GET /qr</strong>
                    <p style="margin: 8px 0; color: #666;">Get current QR code data</p>
                </div>
                
                <div class="endpoint">
                    <strong>POST /clear-auth</strong>
                    <p style="margin: 8px 0; color: #666;">Clear authentication and restart</p>
                </div>
            </div>
        </div>
        
        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
        
        <script>
            ${qrGenerated && qrData ? `
            try {
                const qrData = ${qrData};
                console.log('🔍 Rendering QR Code...');
                
                const qrContainer = document.getElementById('qrcode');
                qrContainer.innerHTML = '';
                
                new QRCode(qrContainer, {
                    text: qrData,
                    width: 280,
                    height: 280,
                    colorDark: '#000000',
                    colorLight: '#ffffff',
                    correctLevel: QRCode.CorrectLevel.M
                });
                
                console.log('✅ QR Code rendered');
            } catch (error) {
                console.error('❌ QR Error:', error);
            }
            ` : ''}
            
            function clearAuth() {
                if (confirm('Clear authentication dan restart bot?')) {
                    fetch('/clear-auth', { method: 'POST' })
                        .then(r => r.json())
                        .then(data => {
                            alert(data.message);
                            setTimeout(() => window.location.reload(), 2000);
                        })
                        .catch(err => alert('Error: ' + err));
                }
            }
            
            let checkCount = 0;
            setInterval(() => {
                fetch('/status')
                    .then(r => r.json())
                    .then(data => {
                        const statusEl = document.getElementById('status');
                        
                        if (data.connected && !${isConnected}) {
                            window.location.reload();
                        } else if (data.qrAvailable && !${qrGenerated}) {
                            checkCount++;
                            if (checkCount > 3) window.location.reload();
                        }
                    })
                    .catch(err => console.error('Status check failed'));
            }, 3000);
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

// API: Clear Auth
app.post('/clear-auth', (req, res) => {
    try {
        console.log('🗑️ Clearing auth folder...');
        const files = fs.readdirSync(authFolder);
        for (const file of files) {
            fs.unlinkSync(join(authFolder, file));
        }
        
        currentQR = null;
        qrGenerated = false;
        isConnected = false;
        connectionAttempts = 0;
        
        if (sock) {
            sock.end();
            sock = null;
        }
        
        console.log('✅ Auth cleared, reconnecting...');
        setTimeout(() => connectToWhatsApp(), 2000);
        
        res.json({ 
            success: true, 
            message: 'Auth cleared. Reconnecting...' 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// API: Get QR Code
app.get('/qr', (req, res) => {
    if (currentQR) {
        res.json({
            success: true,
            qr: currentQR,
            message: 'Scan this QR code with WhatsApp',
            length: currentQR.length
        });
    } else {
        res.json({
            success: false,
            message: isConnected ? 'Already connected' : 'QR not available yet',
            connected: isConnected
        });
    }
});

// API: Send Message
app.post('/send-message', async (req, res) => {
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
            error: 'WhatsApp bot is not connected',
            hint: 'Please scan QR code first at ' + req.protocol + '://' + req.get('host')
        });
    }

    try {
        const formattedPhone = formatPhoneNumber(phone);
        const jid = `${formattedPhone}@s.whatsapp.net`;
        
        const [exists] = await sock.onWhatsApp(jid);
        if (!exists) {
            return res.status(404).json({
                success: false,
                error: 'Phone number not registered on WhatsApp',
                phone: formattedPhone
            });
        }
        
        const result = await sock.sendMessage(jid, { text: message });
        
        console.log(`✅ Message sent to ${formattedPhone}`);
        
        res.json({
            success: true,
            message: 'Message sent successfully',
            to: formattedPhone,
            messageId: result.key.id,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Send error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// API: Status
app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        status: isConnected ? 'connected' : 'disconnected',
        qrRequired: qrGenerated,
        qrAvailable: !!currentQR,
        botNumber: sock?.user?.id ? sock.user.id.split(':')[0] : null,
        botName: sock?.user?.name || null,
        uptime: Math.floor(process.uptime()),
        connectionAttempts: connectionAttempts,
        maxAttempts: MAX_RETRY_ATTEMPTS,
        timestamp: new Date().toISOString()
    });
});

// API: Health Check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'whatsapp-bot',
        connected: isConnected,
        timestamp: new Date().toISOString() 
    });
});

// Graceful Shutdown
const shutdown = async (signal) => {
    console.log(`⚠️ ${signal} received, shutting down gracefully...`);
    if (sock) {
        try {
            await sock.end();
            console.log('✅ Socket closed');
        } catch (err) {
            console.error('Error closing socket:', err);
        }
    }
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start Server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(60));
    console.log('🚀 WhatsApp Bot Server Started');
    console.log('='.repeat(60));
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`⏰ Started: ${new Date().toLocaleString()}`);
    console.log(`📁 Auth folder: ${authFolder}`);
    console.log('='.repeat(60));
    
    connectToWhatsApp();
});

server.on('error', (error) => {
    console.error('❌ Server error:', error);
    process.exit(1);
});