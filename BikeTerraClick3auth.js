// click2auth.js - Game Controller Version (V8.9 - Reactive Auth Handling)
// Installation: npm i @abandonware/noble axios robotjs
// Build: pkg . --targets node18-win-x64 --output BikeTerraZwift-click-proxy.exe

const path = require('path');
const fs = require('fs');
const axios = require("axios");
const crypto = require("crypto");
const os = require("os");

// Path logic: Uses EXE folder if packaged, otherwise script folder
const baseDir = typeof process.pkg !== 'undefined' 
    ? path.dirname(process.execPath) 
    : __dirname;

// ==========================================
// ====== NATIVE MODULE LOADER ==============
// ==========================================
let robot = null;
let noble = null;

function loadNativeModules() {
    try {
        if (typeof process.pkg !== 'undefined') {
            console.log("📦 EXE mode active. Initializing driver injection...");

            const robotPath = path.resolve(baseDir, 'robotjs.node');
            if (fs.existsSync(robotPath)) {
                robot = require(robotPath);
                console.log("✅ RobotJS driver successfully loaded.");
            } else {
                throw new Error("robotjs.node missing in EXE folder!");
            }

            const noblePath = path.resolve(baseDir, 'noble.node');
            if (!fs.existsSync(noblePath)) {
                throw new Error("noble.node missing in EXE folder! (Please rename binding.node)");
            }

            const nativeBindings = require(noblePath);
            const NobleEngine = require("@abandonware/noble/lib/noble");
            
            if (typeof NobleEngine === 'function') {
                noble = new NobleEngine(nativeBindings);
                console.log("✅ Bluetooth driver successfully injected.");
            } else {
                const nobleModule = require("@abandonware/noble");
                nobleModule._bindings = nativeBindings;
                noble = nobleModule;
                console.log("✅ Bluetooth driver injected via Singleton.");
            }
        } else {
            robot = require("robotjs");
            noble = require("@abandonware/noble");
            console.log("⌨️ Development mode (Script) active.");
        }
    } catch (e) {
        console.error("❌ DRIVER ERROR:", e.message);
        process.exit(1);
    }
}

// ==========================================
// ====== CONFIGURATION (INI) ===============
// ==========================================
let ZWIFT_USER = "USER_EMAIL"; 
let ZWIFT_PASS = "PASSWORD";      
let DYNAMIC_MAP = {}; 
const DEBOUNCE_MS = 25; 

const KEY_NAMES = { "0x57": "w", "0x41": "a", "0x53": "s", "0x44": "d", "0x50": "p", "0x49": "i", "0x4C": "l", "0x4B": "k", "0x58": "x", "0x4D": "m", "0x20": "space" };

function loadConfig() {
    const iniPath = path.join(baseDir, 'credentials.ini');
    if (fs.existsSync(iniPath)) {
        try {
            const content = fs.readFileSync(iniPath, 'utf-8');
            content.split(/\r?\n/).forEach(line => {
                const cleanLine = line.trim();
                if (!cleanLine || cleanLine.startsWith('#') || cleanLine.startsWith('[')) return;
                const [key, ...rest] = cleanLine.split('=');
                if (!rest.length) return;
                const k = key.trim().toLowerCase();
                const v = rest.join('=').trim();
                if (k === 'username' || k === 'user') ZWIFT_USER = v;
                else if (k === 'password' || k === 'pass') ZWIFT_PASS = v;
                else if (!isNaN(k)) DYNAMIC_MAP[parseInt(k)] = v.toLowerCase();
            });
            console.log(`📁 Configuration loaded for: ${ZWIFT_USER}`);
        } catch (e) { console.error("Error reading INI:", e.message); }
    }
}

const sendKeyUpdate = (key, isDown) => {
    if (!key) return;
    try {
        robot.keyToggle(key === "space" ? "space" : key, isDown ? "down" : "up");
        console.log(`  ${isDown ? '⬇️ [PRESS]' : '⬆️ [RELEASE]'} Key: ${key}`);
    } catch (e) { console.error("Input error:", e.message); }
};

// ==========================================
// ====== ZWIFT AUTH & BLE LOGIC ============
// ==========================================
const ST_IDLE = 0;
const ST_ACTIVE = 3;    
let currentStatus = ST_IDLE;
let lastPressed32 = 0;
let lastChangeTimes = new Array(32).fill(0);
let zwiftToken = null;
const connectedIds = new Set();
const norm = (u) => (u || "").replace(/-/g, "").toLowerCase().trim();
const GLOBAL_ID = crypto.createHash('sha256').update(os.hostname() + "zproxy").digest('hex').substring(0, 32);

async function getZwiftToken() {
    try {
        console.log(`🌐 Logging into Zwift...`);
        const res = await axios.post("https://secure.zwift.com/auth/realms/zwift/tokens/access/codes", 
            new URLSearchParams({"client_id": "Zwift_Mobile_Link", "username": ZWIFT_USER, "password": ZWIFT_PASS, "grant_type": "password"}), 
            { headers: { "User-Agent": "Zwift/1.5" }, timeout: 7000 });
        if (res.data?.access_token) {
            console.log("✅ Zwift login successful.");
            return res.data.access_token;
        }
    } catch (e) { console.error("❌ Login failed. Check credentials in the INI file."); }
    return null;
}

async function proxyAuth(data, token) {
    try {
        const payload = data.slice(3);
        const res = await axios.post("https://us-or-rly101.zwift.com/api/d-lock-service/device/authenticate", 
            payload, { 
                headers: { 
                    "Content-Type": "application/x-protobuf-lite",
                    "Authorization": `Bearer ${token}`, 
                    "X-Machine-Id": GLOBAL_ID 
                }, 
                responseType: 'arraybuffer', 
                timeout: 5000 
            });

        if (res.status === 200 || res.status === 204) {
            const header = Buffer.from([0xff, 0x04, 0x00]);
            const responseData = res.data ? Buffer.from(res.data) : Buffer.alloc(0);
            return Buffer.concat([header, responseData]);
        }
    } catch (e) {}
    return null;
}

const RX_UUID = norm("00000002-19ca-4651-86e5-fa29dcdd09d1");
const TX_UUID = norm("00000003-19ca-4651-86e5-fa29dcdd09d1");

async function connectClick(peripheral) {
    if (connectedIds.has(peripheral.id)) return;
    connectedIds.add(peripheral.id);
    try {
        console.log(`🔗 Click found! Connecting...`);
        await peripheral.connectAsync();
        const { characteristics: chars } = await peripheral.discoverAllServicesAndCharacteristicsAsync();
        const rx = chars.find(c => norm(c.uuid) === RX_UUID);
        const tx = chars.find(c => norm(c.uuid) === TX_UUID);
        if (!rx || !tx) return peripheral.disconnect();
        
        console.log(`🟢 Connection established.`);
        noble.stopScanning();

        rx.on("data", (data) => {
            if (data[0] === 0x47) return; 
            
            // Phase 1 & 2: Auth Handshake
            // REACTIVE: We respond to auth requests even if we think we are active.
            if (data[0] === 0xff && data[1] === 0x03 && zwiftToken) {
                if (currentStatus === ST_ACTIVE) {
                    console.log("🔄 Device requested re-authentication...");
                    currentStatus = ST_IDLE; // Reset status to allow re-initialization
                }
                proxyAuth(data, zwiftToken).then(reply => { 
                    if (reply) tx.write(reply, true); 
                });
            }

            // Unlock Signal - Triggers final initialization commands
            if (data[0] === 0x19 && data[1] === 0x10) {
                if (currentStatus !== ST_ACTIVE) {
                    console.log("🎯 Hardware unlocked!");
                    currentStatus = ST_ACTIVE;
                    tx.write(Buffer.from([0xac, 0x01]), true);
                    setTimeout(() => tx.write(Buffer.from([0xb6, 0x40]), true), 100);
                }
            }

            // Key press processing
            if (data[0] === 0x23) {
                const now = Date.now();
                const p32 = ((~data[2] & 0xff) | ((~data[3] & 0xff) << 8) | ((~data[4] & 0xff) << 16) | ((~data[5] & 0xff) << 24)) >>> 0;
                for (let i = 0; i < 32; i++) {
                    const bit = (1 << i);
                    if (((p32 & bit) !== 0) !== ((lastPressed32 & bit) !== 0)) {
                        if (now - lastChangeTimes[i] > DEBOUNCE_MS) {
                            sendKeyUpdate(DYNAMIC_MAP[i], (p32 & bit) !== 0);
                            lastChangeTimes[i] = now;
                        }
                    }
                }
                lastPressed32 = p32;
            } 
        });

        await rx.subscribeAsync();
        
        const nudge = () => {
            tx.write(Buffer.from([0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e, 0x02, 0x03]), true);
            setTimeout(() => tx.write(Buffer.from([0xac, 0x03]), true), 200);
        };
        nudge();
        
        setInterval(() => {
            if (peripheral.state !== 'connected') return;
            if (currentStatus === ST_IDLE) nudge();
            else tx.write(Buffer.from([0x47, 0x00]), true); 
        }, 10000);

    } catch (e) { 
        console.error("Connection error:", e.message);
        connectedIds.delete(peripheral.id); 
    }
}

async function main() {
    loadConfig();
    loadNativeModules();
    zwiftToken = await getZwiftToken();
    if (!zwiftToken) return;
    
    console.log("🔍 Searching for Zwift Click...");
    noble.on("stateChange", s => s === "poweredOn" ? noble.startScanning([], true) : null);
    noble.on("discover", p => {
        if ((p.advertisement.localName || "").toLowerCase().includes("click")) connectClick(p);
    });
}

main();
