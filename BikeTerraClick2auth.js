// click2auth.js - Game Controller Version (V8.4 - Direct Injection Fix)
// Installation: npm i @abandonware/noble axios robotjs
// Build: pkg . --targets node18-win-x64 --output BikeTerraZwift-click-proxy.exe

const path = require('path');
const fs = require('fs');
const axios = require("axios");
const crypto = require("crypto");
const os = require("os");

// Pfad-Logik für EXE (Basis-Verzeichnis auf der Festplatte)
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
            console.log("📦 EXE-Modus: Initialisiere Hardware-Einspeisung...");

            // 1. RobotJS Pfad auflösen
            const robotPath = path.resolve(baseDir, 'robotjs.node');
            if (fs.existsSync(robotPath)) {
                robot = require(robotPath);
                console.log("✅ RobotJS Treiber geladen.");
            }

            // 2. Noble (Bluetooth) Pfad auflösen
            const noblePath = path.resolve(baseDir, 'noble.node');
            if (!fs.existsSync(noblePath)) throw new Error(`noble.node fehlt in: ${baseDir}`);

            // Wir laden das Noble-Hauptmodul
            const nobleModule = require("@abandonware/noble");
            const nativeBindings = require(noblePath);

            /**
             * Noble Fix V8.4:
             * Wir injizieren die Bindings direkt in die Instanz.
             * Dies umgeht den "undefined" Fehler beim Konstruktor-Aufruf.
             */
            if (nobleModule && typeof nobleModule.on === 'function') {
                // Noble ist bereits eine Instanz (Singleton). Wir tauschen die Bindings aus.
                nobleModule._bindings = nativeBindings;
                noble = nobleModule;
                console.log("✅ Bluetooth Treiber erfolgreich injiziert.");
            } else {
                // Fallback: Falls nobleModule doch ein Konstruktor ist
                const NobleClass = require("@abandonware/noble/lib/noble");
                noble = new NobleClass(nativeBindings);
                console.log("✅ Bluetooth Treiber via Klasse injiziert.");
            }

        } else {
            // Standard Node.js Modus
            robot = require("robotjs");
            noble = require("@abandonware/noble");
            console.log("⌨️ Standard-Modus aktiv.");
        }
        
        if (!noble) throw new Error("Bluetooth-Engine konnte nicht initialisiert werden.");

    } catch (e) {
        console.error("❌ KRITISCHER TREIBER-FEHLER:");
        console.error(e.message);
        console.log("\n💡 LETZTE HILFE-SCHRITTE:");
        console.log("1. Hast du Node 18 (LTS) installiert? (WICHTIG!)");
        console.log("2. Hast du 'binding.node' wirklich in 'noble.node' umbenannt?");
        console.log("3. Lösche 'node_modules', führe 'npm install' neu aus (mit Node 18).");
        process.exit(1);
    }
}
loadNativeModules();

// ==========================================
// ====== KONFIGURATION =====================
// ==========================================
let ZWIFT_USER = "YOUR_ZWIFT_LOGIN_MAIL"; 
let ZWIFT_PASS = "YOUR_ZWIFT_PASS";      
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
            console.log(`📁 Config geladen für: ${ZWIFT_USER}`);
        } catch (e) {}
    }
}
loadConfig();

const sendKeyUpdate = (key, isDown) => {
    if (!key) return;
    try {
        robot.keyToggle(key === "space" ? "space" : key, isDown ? "down" : "up");
        console.log(`  ${isDown ? '⬇️ [DRUCK]' : '⬆️ [RELEASE]'} ${key}`);
    } catch (e) { console.error("Tastatur-Fehler:", e.message); }
};

// ==========================================
// ====== BLE CORE ==========================
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
        console.log(`🌐 Login bei Zwift...`);
        const res = await axios.post("https://secure.zwift.com/auth/realms/zwift/tokens/access/codes", 
            new URLSearchParams({"client_id": "Zwift_Mobile_Link", "username": ZWIFT_USER, "password": ZWIFT_PASS, "grant_type": "password"}), 
            { headers: { "User-Agent": "Zwift/1.5" }, timeout: 7000 });
        if (res.data?.access_token) return res.data.access_token;
    } catch (e) { console.error("❌ Zwift Login fehlgeschlagen."); return null; }
}

async function proxyAuth(data, token) {
    try {
        const res = await axios.post("https://us-or-rly101.zwift.com/api/d-lock-service/device/authenticate", 
            data.slice(3), { headers: { "Authorization": `Bearer ${token}`, "X-Machine-Id": GLOBAL_ID }, responseType: 'arraybuffer', timeout: 4000 });
        if (res.status === 200) return Buffer.concat([Buffer.from([0xff, 0x04, 0x00]), res.data]);
    } catch (e) { return null; }
}

const RX_UUID = norm("00000002-19ca-4651-86e5-fa29dcdd09d1");
const TX_UUID = norm("00000003-19ca-4651-86e5-fa29dcdd09d1");

async function connectClick(peripheral) {
    if (connectedIds.has(peripheral.id)) return;
    connectedIds.add(peripheral.id);
    try {
        console.log(`🔗 Suche beendet. Verbinde mit Click...`);
        await peripheral.connectAsync();
        const { characteristics: chars } = await peripheral.discoverAllServicesAndCharacteristicsAsync();
        const rx = chars.find(c => norm(c.uuid) === RX_UUID);
        const tx = chars.find(c => norm(c.uuid) === TX_UUID);
        if (!rx || !tx) return peripheral.disconnect();
        console.log(`🟢 Verbunden.`);
        noble.stopScanning();
        rx.on("data", (data) => {
            if (data[0] === 0x47) return; 
            if (data[0] === 0x19 && data[1] === 0x10) {
                currentStatus = ST_ACTIVE;
                tx.write(Buffer.from([0xac, 0x01]), true);
                setTimeout(() => tx.write(Buffer.from([0xb6, 0x40]), true), 100);
                console.log("🎯 Hardware freigeschaltet!");
            }
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
            if (data[0] === 0xff && zwiftToken && currentStatus === ST_IDLE) {
                proxyAuth(data, zwiftToken).then(r => r && tx.write(r, true));
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
    } catch (e) { connectedIds.delete(peripheral.id); }
}

async function main() {
    zwiftToken = await getZwiftToken();
    if (!zwiftToken) return;
    console.log("🔍 Suche Click...");
    noble.on("stateChange", s => s === "poweredOn" ? noble.startScanning([], true) : null);
    noble.on("discover", p => (p.advertisement.localName || "").toLowerCase().includes("click") && connectClick(p));
}
main();