// click2auth.js - Game Controller Version (V2 Fix + Debouncing + Keep-Alive)
// Installation: npm i noble-winrt axios
// Start: node .\click2auth.js

const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const noble = require("noble-winrt");
const axios = require("axios");
const crypto = require("crypto");
const os = require("os");

// ==========================================
// ====== LOAD CONFIGURATION (INI) ==========
// ==========================================
let ZWIFT_USER = "YOUR_ZWIFT_LOGIN_MAIL"; 
let ZWIFT_PASS = "YOUR_ZWIFT_PASS";      
let TARGET_SERIAL = "YOUR_DEVICE_SERIAL"; 

let DYNAMIC_MAP = {}; 
const DEBOUNCE_MS = 20; 

const VK_NAMES = {
    "0x57": "W", "0x41": "A", "0x53": "S", "0x44": "D",
    "0x50": "P", "0x49": "I", "0x4C": "L", "0x4B": "K",
    "0x58": "X", "0x4D": "M", "0x20": "SPACE"
};

function parseToVk(val) {
    val = (val || "").trim();
    if (val.startsWith("0x")) return val; 
    if (val.length === 1) {
        const code = val.toUpperCase().charCodeAt(0);
        return "0x" + code.toString(16).toUpperCase();
    }
    return val;
}

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
                    else if (!isNaN(k)) DYNAMIC_MAP[parseInt(k)] = parseToVk(v);
                }
            });
            console.log(`📁 Configuration loaded from credentials.ini.`);
        } catch (e) { console.error(`⚠️ Error loading INI: ${e.message}`); }
    } else {
        console.log(`ℹ️ No credentials.ini found, using default placeholders.`);
    }
}
loadConfig();

// ==========================================
// ====== POWERSHELL BRIDGE (STABLE) ========
// ==========================================
let ps = null;
function startPS() {
    if (ps) try { ps.kill(); } catch(e) {}
    const psCommand = `
    $sig = @'
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);
'@
    try {
        Add-Type -MemberDefinition $sig -Name "Win32Key" -Namespace "Win32"
        Write-Host "PS_READY"
    } catch {}

    while($true) {
        $l = [Console]::In.ReadLine();
        if ($null -eq $l -or $l -eq '__quit__') { break };
        $p = $l.Split('|');
        if ($p.Count -eq 2) {
            try {
                $v = [Convert]::ToByte($p[0], 16);
                $f = if($p[1] -eq 'up'){2}else{0};
                [Win32.Win32Key]::keybd_event($v, 0, $f, 0);
            } catch {}
        }
    }
    `;
    ps = cp.spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand], 
        { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    
    ps.stdout.on('data', (d) => {
        if(d.toString().includes("PS_READY")) console.log("⌨️ Keyboard interface ready.");
    });
}
startPS();

const sendKeyUpdate = (vk, isDown) => {
    if (!vk) return;
    const name = VK_NAMES[vk] || vk;
    console.log(`  ${isDown ? '⬇️ [PRESS]' : '⬆️ [RELEASE]'} Key: ${name}`);
    try { ps.stdin.write(`${vk}|${isDown ? 'down' : 'up'}\n`); } catch(e) { startPS(); }
};

// ==========================================
// ====== ZWIFT AUTH & BLE LOGIC (V2) =======
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
        console.log(`🌐 Logging into Zwift for ${ZWIFT_USER}...`);
        const res = await axios.post("https://secure.zwift.com/auth/realms/zwift/tokens/access/codes", 
            new URLSearchParams({"client_id": "Zwift_Mobile_Link", "username": ZWIFT_USER, "password": ZWIFT_PASS, "grant_type": "password"}), 
            { headers: { "User-Agent": "Zwift/1.5 (iPhone; iOS 9.0.2; Scale/2.00)" }, timeout: 7000 });
        if (res.data?.access_token) {
            console.log("✅ Zwift login successful.");
            return res.data.access_token;
        }
    } catch (e) { console.error("❌ Zwift login error."); }
    return null;
}

async function proxyAuth(data, token) {
    // Stripping the ff0300 header (3 bytes) instead of brute-forcing offsets
    const payload = data.slice(3);
    
    try {
        const res = await axios.post("https://us-or-rly101.zwift.com/api/d-lock-service/device/authenticate", 
            payload, { 
                headers: { 
                    "Content-Type": "application/x-protobuf-lite",
                    "Authorization": `Bearer ${token}`, 
                    "X-Machine-Id": GLOBAL_ID 
                }, 
                responseType: 'arraybuffer', 
                timeout: 4000 
            });
        if (res.status === 200) {
            console.log("✅ Challenge solved by server.");
            return Buffer.concat([Buffer.from([0xff, 0x04, 0x00]), res.data]);
        }
    } catch (e) { 
        console.error(`❌ Authentication request failed: ${e.message}`);
    }
    return null;
}

const RX_UUID = norm("00000002-19ca-4651-86e5-fa29dcdd09d1");
const TX_UUID = norm("00000003-19ca-4651-86e5-fa29dcdd09d1");

async function connectClick(peripheral) {
    if (connectedIds.has(peripheral.id)) return;
    connectedIds.add(peripheral.id);

    try {
        console.log(`🔗 Connecting to Click ${peripheral.id}...`);
        await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("Timeout")), 10000);
            peripheral.connect(e => { clearTimeout(t); e ? rej(e) : res(); });
        });
        
        const { characteristics: chars } = await new Promise((res, rej) => 
            peripheral.discoverAllServicesAndCharacteristics((e, s, c) => e ? rej(e) : res({characteristics: c})));

        const rx = chars.find(c => norm(c.uuid) === RX_UUID);
        const tx = chars.find(c => norm(c.uuid) === TX_UUID);
        if (!rx || !tx) {
            connectedIds.delete(peripheral.id);
            return peripheral.disconnect();
        }

        console.log(`🟢 Click connected.`);
        noble.stopScanning();

        rx.on("data", (data) => {
            const first = data[0];
            
            if (first === 0x47) return; 

            if (first === 0x19 && data[1] === 0x10 && data[2] === 0x50) {
                console.log("🎯 Hardware unlocked! Buttons active.");
                currentStatus = ST_ACTIVE;
                tx.write(Buffer.from([0xac, 0x01]), true);
                setTimeout(() => tx.write(Buffer.from([0xb6, 0x40]), true), 100);
                return;
            }

            if (first === 0x23 && data[1] === 0x08) {
                const now = Date.now();
                const p32 = ((~data[2] & 0xff) | ((~data[3] & 0xff) << 8) | ((~data[4] & 0xff) << 16) | ((~data[5] & 0xff) << 24)) >>> 0;
                
                for (let i = 0; i < 32; i++) {
                    const bit = (1 << i);
                    const isDown = (p32 & bit) !== 0;
                    const wasDown = (lastPressed32 & bit) !== 0;

                    if (isDown !== wasDown) {
                        if (now - lastChangeTimes[i] > DEBOUNCE_MS) {
                            sendKeyUpdate(DYNAMIC_MAP[i], isDown);
                            lastChangeTimes[i] = now;
                        }
                    }
                }
                lastPressed32 = p32;
                return;
            } 

            if (first === 0xff && data[1] === 0x03 && zwiftToken && currentStatus === ST_IDLE) {
                if (data.length === 85) {
                    console.log("🔑 Special Challenge (85b) detected.");
                    tx.write(Buffer.from([0xff, 0x04, 0x00]), true);
                } else {
                    console.log("🔑 Challenge detected. Calculating response...");
                    proxyAuth(data, zwiftToken).then(reply => {
                        if (reply) tx.write(reply, true);
                    });
                }
                return;
            }
        });

        await rx.subscribe();
        console.log("👂 Ready. Waiting for hardware handshake...");

        const nudge = () => {
            process.stdout.write("👉 Pinging Click... ");
            tx.write(Buffer.from([0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e, 0x02, 0x03]), true);
            setTimeout(() => tx.write(Buffer.from([0xac, 0x03]), true), 200);
        };

        nudge();

        const monitorInterval = setInterval(() => {
            if (peripheral.state !== 'connected') {
                clearInterval(monitorInterval);
                return;
            }

            if (currentStatus === ST_IDLE) {
                nudge();
            } else if (currentStatus === ST_ACTIVE) {
                // Keep-alive heartbeat (0x47 0x00) every 10 sec
                tx.write(Buffer.from([0x47, 0x00]), true);
            }
        }, 10000);

    } catch (e) { 
        if (!e.message.includes("already connected")) {
            console.error(`❌ Error: ${e.message}`);
        }
        connectedIds.delete(peripheral.id);
    }
}

async function main() {
    zwiftToken = await getZwiftToken();
    if (!zwiftToken) {
        console.log("❌ Program terminated: No Zwift token available.");
        return;
    }
    console.log("🔍 Searching for Click...");
    noble.on("stateChange", s => s === "poweredOn" ? noble.startScanning([], true) : process.exit());
    noble.on("discover", p => {
        if ((p.advertisement.localName || "").toLowerCase().includes("click")) {
            connectClick(p);
        }
    });
}

main();