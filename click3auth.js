// click2auth.js
// Installation: npm i noble-winrt axios
// Start: node .\click2auth.js

const cp = require('child_process');
const path = require('path');
const fs = require('fs');

// === EXE PATCH START ===
const originalSpawn = cp.spawn;
cp.spawn = function (command, args, options) {
    if (typeof command === 'string' && command.includes('BLEServer.exe') && typeof process.pkg !== 'undefined') {
        const exeDir = path.dirname(process.execPath);
        const localBLE = path.join(exeDir, 'BLEServer.exe');
        return originalSpawn.apply(this, [localBLE, args, options]);
    }
    return originalSpawn.apply(this, [command, args, options]);
};
// === EXE PATCH ENDE ===

const noble = require("noble-winrt");
const axios = require("axios");
const crypto = require("crypto");
const os = require("os");
const https = require("https");

// ==========================================
// ====== KONFIGURATION LADEN (INI) ======
// ==========================================
let ZWIFT_USER = "YOUR_ZWIFT_LOGIN_MAIL"; 
let ZWIFT_PASS = "YOUR_ZWIFT_PASS";      
let TARGET_SERIAL = ""; // Startet leer für Auto-Erkennung

let DYNAMIC_MAP = {
    0: "j", 1: "i", 2: "l", 3: "k", 4: "a", 5: "w", 6: "s", 8: "x", 9: "m", 13: "d"
};

function loadConfig() {
    const baseDir = typeof process.pkg !== 'undefined' ? path.dirname(process.execPath) : __dirname;
    const iniPath = path.join(baseDir, 'credentials.ini');

    if (fs.existsSync(iniPath)) {
        try {
            const content = fs.readFileSync(iniPath, 'utf-8');
            const lines = content.split(/\r?\n/);
            lines.forEach(line => {
                const cleanLine = line.trim();
                if (!cleanLine || cleanLine.startsWith('#') || cleanLine.startsWith('[')) return;
                if (cleanLine.includes('=')) {
                    const [key, ...rest] = cleanLine.split('=');
                    const k = key.trim().toLowerCase();
                    const v = rest.join('=').trim();

                    if (k === 'username' || k === 'user') ZWIFT_USER = v;
                    else if (k === 'password' || k === 'pass') ZWIFT_PASS = v;
                    else if (k === 'serial') TARGET_SERIAL = v; 
                    else if (!isNaN(k)) DYNAMIC_MAP[parseInt(k)] = v;
                }
            });
            if (TARGET_SERIAL) {
                console.log(`📁 Konfiguration geladen. Target-Serial: ${TARGET_SERIAL}`);
            } else {
                console.log(`📁 Konfiguration geladen. Modus: AUTO-SERIAL (erster Click gewinnt)`);
            }
        } catch (e) {
            console.error(`⚠️ Fehler beim Lesen der credentials.ini: ${e.message}`);
        }
    }
}

loadConfig();

const PROFILE_IKJLM = {
    name: "Click_Deutsch_v99_FinalAuth", 
    map: DYNAMIC_MAP, 
};

const GLOBAL_MACHINE_ID = crypto.createHash('sha256').update(os.hostname() + "zwift-proxy").digest('hex').substring(0, 32);

// ==========================================
// ====== STATUSMANAGEMENT ======
// ==========================================
const ST_IDLE = 0;
const ST_AUTH_SENT = 1; 
const ST_ACTIVE = 3;    

let currentStatus = ST_IDLE;
let lastDataTime = Date.now();
let lastPressed32 = 0;
let cycle = 0;
let zwiftToken = null;
let errorCooldown = 0;

const norm = (u) => (u || "").replace(/-/g, "").toLowerCase().trim();
const offsetMemory = new Map();

async function getZwiftToken() {
    try {
        console.log(`🌐 Login-Versuch für: ${ZWIFT_USER}...`);
        const res = await axios.post(
            "https://secure.zwift.com/auth/realms/zwift/tokens/access/codes", 
            new URLSearchParams({
                "client_id": "Zwift_Mobile_Link",
                "username": ZWIFT_USER,
                "password": ZWIFT_PASS,
                "grant_type": "password"
            }), 
            { 
                headers: { "User-Agent": "Zwift/1.5 (iPhone; iOS 9.0.2; Scale/2.00)" },
                timeout: 7000
            }
        );
        if (res.data && res.data.access_token) {
            console.log("✅ Login erfolgreich!");
            return res.data.access_token;
        }
        return null;
    } catch (e) {
        console.error("❌ Login-Fehler:", e.message);
        return null;
    }
}

async function proxyAuthToZwift(payload, token) {
    const pLen = payload.length;
    let offsetsToTry = [];
    if (offsetMemory.has(pLen)) offsetsToTry.push(offsetMemory.get(pLen));
    for (let i = 0; i < 15; i++) { if (payload[i] === 0x0a) offsetsToTry.push(i); }
    [3, 4, 2, 5].forEach(o => !offsetsToTry.includes(o) && offsetsToTry.push(o));

    for (const offset of offsetsToTry) {
        try {
            const cleanPayload = payload.slice(offset);
            const res = await axios.post(
                "https://us-or-rly101.zwift.com/api/d-lock-service/device/authenticate", 
                cleanPayload, 
                {
                    headers: { 
                        "Content-Type": "application/x-protobuf-lite",
                        "Authorization": `Bearer ${token}`, 
                        "X-Machine-Id": GLOBAL_MACHINE_ID
                    },
                    responseType: 'arraybuffer', 
                    timeout: 4000
                }
            );
            if (res.status === 200 && res.data) {
                if (!offsetMemory.has(pLen)) offsetMemory.set(pLen, offset);
                return Buffer.concat([Buffer.from([0xfe, res.data.length, 0x00]), res.data]);
            }
        } catch (e) { continue; }
    }
    return null;
}

let ps = null;
function startPS() {
    if (ps) try { ps.kill(); } catch(e) {}
    ps = cp.spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", 
        `Add-Type -AssemblyName System.Windows.Forms; while($true){$l=[Console]::In.ReadLine(); if($null -eq $l -or $l -eq '__quit__'){break}; try { [System.Windows.Forms.SendKeys]::SendWait($l) } catch {} }`
    ], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
}
startPS();

const sendKey = (k) => {
    console.log(`⌨️ Sende Taste: "${k}"`);
    try { ps.stdin.write(k + "\n"); } catch(e) { startPS(); }
};

const connectedIds = new Set();
const activeConnecting = new Set();

const RX_UUID = norm("00000002-19ca-4651-86e5-fa29dcdd09d1");
const TX_UUID = norm("00000003-19ca-4651-86e5-fa29dcdd09d1");
const UUID_SERIAL = norm("00002a25-0000-1000-8000-00805f9b34fb");

async function connectAndAssign(peripheral) {
    const id = peripheral.id;
    if (connectedIds.has(id) || activeConnecting.has(id)) return;
    activeConnecting.add(id);

    try {
        console.log(`🔗 Verbinde mit Click ${id}...`);
        await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("Timeout")), 10000);
            peripheral.connect(e => { clearTimeout(t); e ? rej(e) : res(); });
        });

        const { characteristics: chars } = await new Promise((res, rej) => 
            peripheral.discoverAllServicesAndCharacteristics((e, s, c) => e ? rej(e) : res({characteristics: c})));

        const rx = chars.find(c => norm(c.uuid) === RX_UUID);
        const tx = chars.find(c => norm(c.uuid) === TX_UUID);
        const chSerial = chars.find(c => norm(c.uuid) === UUID_SERIAL);

        if (!rx || !tx) {
            activeConnecting.delete(id);
            return peripheral.disconnect();
        }

        const rawSerial = await new Promise(res => chSerial.read((err, data) => res(data?.toString() || "")));
        const serial = rawSerial.trim();
        
        // AUTO-SERIAL LOGIK:
        // Wenn noch keine Serial feststeht, nimm die erste, die wir finden.
        if (!TARGET_SERIAL) {
            TARGET_SERIAL = serial;
            console.log(`✨ Auto-Lock: Nutze Serial ${TARGET_SERIAL} für diese Sitzung.`);
        }

        // FILTER: Nur das (jetzt feststehende) Gerät zulassen
        if (norm(serial) !== norm(TARGET_SERIAL)) {
            console.log(`⚠️ Fremdes Gerät (${serial}) ignoriert. Aktiv ist: ${TARGET_SERIAL}`);
            activeConnecting.delete(id);
            return peripheral.disconnect();
        }

        const profile = PROFILE_IKJLM;
        console.log(`🟢 Dein Gerät erkannt: ${profile.name} (${serial})`);
        connectedIds.add(id);
        activeConnecting.delete(id);

        const nudgeHybrid = (force = false) => {
            if (currentStatus !== ST_IDLE || Date.now() < errorCooldown) return;
            process.stdout.write(force ? "💥" : "❓");
            tx.write(Buffer.from([0xac, 0x03]), true); 
            if (force) {
                setTimeout(() => tx.write(Buffer.from([0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e, 0x02, 0x03]), true), 100);
            }
        };

        rx.on("data", (data) => {
            const firstByte = data[0];
            lastDataTime = Date.now(); 

            if (firstByte === 0x47) return; 

            if (firstByte === 0x19 && data[1] === 0x10) {
                if (data[2] === 0x50) {
                   console.log("\n🎯 HARDWARE-OK! Aktiviere Tasten...");
                   currentStatus = ST_ACTIVE;
                   tx.write(Buffer.from([0xac, 0x01]), true); 
                   setTimeout(() => {
                       tx.write(Buffer.from([0xb6, 0x40]), true);
                       tx.write(Buffer.from([0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e, 0x02, 0x03]), true);
                   }, 100);
                } else if (data[2] === 0x46) {
                   process.stdout.write("⚠️");
                   errorCooldown = Date.now() + 3000;
                   if (currentStatus !== ST_ACTIVE) currentStatus = ST_IDLE;
                }
                return;
            }

            if (firstByte === 0x23 && data[1] === 0x08) {
                if (currentStatus !== ST_ACTIVE) {
                    currentStatus = ST_ACTIVE;
                    console.log("\n✅ CLICK AKTIV!");
                }
                const pressed32 = ((~data[2] & 0xff) | ((~data[3] & 0xff) << 8) | ((~data[4] & 0xff) << 16) | ((~data[5] & 0xff) << 24)) >>> 0;
                const down = (pressed32 & ~lastPressed32) >>> 0;
                
                for (let i = 0; i < 32; i++) {
                    if (down & (1 << i)) {
                        const key = profile.map[i];
                        if (key) sendKey(key);
                    }
                }
                lastPressed32 = pressed32;
            } 
            else if (firstByte === 0xff && zwiftToken) {
                if (currentStatus !== ST_IDLE) return;
                if (data.length < 50) {
                    tx.write(Buffer.from([0xac, 0x03]), true);
                    return;
                }
                process.stdout.write(`\n🔑 Challenge gefunden... `);
                proxyAuthToZwift(data, zwiftToken).then(reply => {
                    if (reply) {
                        currentStatus = ST_AUTH_SENT;
                        setTimeout(() => tx.write(reply, true), 250);
                    }
                });
            }
        });

        setTimeout(async () => {
            console.log("👂 SilentStealth bereit. BITTE PLUS-TASTE DRÜCKEN!");
            await rx.subscribe();
            nudgeHybrid(true);
        }, 1500);

        setInterval(() => {
            if (!connectedIds.has(id)) return;
            if (Date.now() - lastDataTime > 10000 && Date.now() > errorCooldown) {
                tx.write(Buffer.from([0x47, 0x00]), true);
            }
        }, 1000);

        setInterval(() => {
            if (!connectedIds.has(id)) return;
            cycle = (cycle + 1) % 10; 
            const limit = (currentStatus === ST_AUTH_SENT) ? 60000 : 45000;
            if (Date.now() - lastDataTime > limit && currentStatus !== ST_ACTIVE) {
                console.log("\n🔄 Kanal-Refresh...");
                tx.write(Buffer.from([0xac, 0x00]), true); 
                setTimeout(() => {
                    currentStatus = ST_IDLE;
                    nudgeHybrid(true); 
                }, 1000);
                lastDataTime = Date.now();
            }
            if (currentStatus === ST_IDLE && cycle === 5) nudgeHybrid(false);
            if (cycle === 0) process.stdout.write(".");
        }, 500);

    } catch (e) {
        console.error(`❌ Fehler: ${e.message}`);
        activeConnecting.delete(id);
    }
}

async function main() {
    zwiftToken = await getZwiftToken();
    if (!zwiftToken) process.exit(1);
    
    console.log("🔍 Suche nach Click...");
    noble.on("stateChange", s => s === "poweredOn" ? noble.startScanning([], true) : process.exit());
    noble.on("discover", p => (p.advertisement.localName || "").toLowerCase().includes("click") && connectAndAssign(p));
}

main();

process.on("SIGINT", () => {
    try { ps.stdin.write("__quit__\n"); ps.kill(); } catch {}
    process.exit(0);
});
